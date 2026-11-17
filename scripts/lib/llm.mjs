/**
 * 最小 LLM 客户端：给 scripts/ 下的写稿链路用。
 *
 * 为什么不复用 apps/api/src/adapters/llm/gateway.ts：
 *   那个是 TypeScript 且依赖 api 的 config 模块，scripts/ 是纯 ESM、直接 node 跑。
 *   跨进程要求 tsx 编译，多一层依赖。这里的逻辑只保留「发一次请求 + 重试 + 限流」，
 *   API 端点与协议和那个 gateway 保持一致（同一套 LLM_* 环境变量）。
 *
 * 配置（都在 .env，绝不硬编码）：
 *   LLM_BASE_URL   网关地址，例如 https://ark.cn-beijing.volces.com/api/v3
 *   LLM_API_KEY    密钥（也接受 ARK_API_KEY 兜底）
 *   LLM_MODEL      模型 ID
 *   LLM_PROTOCOL   openai | anthropic，默认 openai
 *   LLM_TIMEOUT_MS 单次超时，默认 300000（长文生成很慢）
 *   LLM_MAX_TOKENS 单次输出上限，默认 8192
 *   LLM_MIN_INTERVAL_MS / LLM_MAX_CONCURRENCY  限流
 *   LLM_CACHE_PREFIX  true | false，默认 true —— 给稳定的长前缀打缓存标记
 *
 * 用法：
 *   const llm = createLlm();
 *   const text = await llm.complete({ messages, maxTokens: 8000, temperature: 0.3 });
 *
 * ── 关于 prompt cache（2026-11-12 实测）──
 * 网关支持 Anthropic 的 cache_control：把「所有调用都一样的长前缀」标上
 * `cache_control: {type:'ephemeral'}`，第二次起 input 只按 10% 计费，且首 token 更快。
 *
 * 实测（同一份 16k token 前缀连发三次）：第二次 `cache_read_input_tokens=15936`，
 * `input_tokens` 掉到 10。**但只在 messages 里打标记不够**——前缀必须逐字节相同，
 * 中间夹一个随小节变化的字段（比如「你在写第 3 节」）就会整段失效。
 * 所以写稿链路把稳定内容（论文全文 / 写作规范 / 术语表）放前缀，
 * 易变内容（本节要求）放后面，用 `cachePrefix` 显式切开。
 */
import process from 'node:process';
import { envGet } from './env.mjs';

class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  async acquire() {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }
  release() {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}

const trimSlash = (s) => s.replace(/\/+$/, '');

function readConfig() {
  const baseUrl = envGet('LLM_BASE_URL');
  const apiKey = envGet('LLM_API_KEY') || envGet('ARK_API_KEY');
  const model = envGet('LLM_MODEL');
  return {
    baseUrl,
    apiKey,
    model,
    protocol: (envGet('LLM_PROTOCOL') || 'openai').toLowerCase(),
    timeoutMs: Number(envGet('LLM_TIMEOUT_MS') || 300_000),
    maxTokens: Number(envGet('LLM_MAX_TOKENS') || 8192),
    minIntervalMs: Number(envGet('LLM_MIN_INTERVAL_MS') || 0),
    maxConcurrency: Number(envGet('LLM_MAX_CONCURRENCY') || 2),
    userAgent: envGet('HTTP_USER_AGENT') || 'paper-to-post',
    // 是否给可缓存的长前缀打 cache_control。默认开；网关不支持时会安静忽略。
    cachePrefix: (envGet('LLM_CACHE_PREFIX') || 'true').toLowerCase() !== 'false',
    // 预算上限：跑飞一次可能烧掉一整小时。默认给一个「明显不该超过」的数，
    // 超了直接抛错中断，而不是默默继续。
    maxTokensBudget: Number(envGet('LLM_MAX_TOKENS_BUDGET') || 400_000),
    maxCalls: Number(envGet('LLM_MAX_CALLS') || 200),
  };
}

export class LlmError extends Error {
  constructor(status, message, retryAfterMs = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * @param {object} [overrides] 覆盖 .env 里的配置（测试用）
 */
export function createLlm(overrides = {}) {
  const cfg = { ...readConfig(), ...overrides };
  const configured = Boolean(cfg.baseUrl && cfg.apiKey && cfg.model);
  const slots = new Semaphore(cfg.maxConcurrency || 2);
  let nextAllowedAt = 0;

  /** 累计用量，便于在产物里记录「这次花了多少」 */
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  /**
   * 把稳定前缀单独放进第一个 user message 的 content block，并打 cache_control。
   * 前缀必须是**逐字节相同**的长文本（论文全文、写作规范这类），否则缓存永远不命中。
   */
  function withCachePrefix(messages, cachePrefix) {
    if (!cachePrefix) return messages;
    const out = messages.map((m) => ({ ...m }));
    const i = out.findIndex((m) => m.role === 'user');
    if (i < 0) return out;
    const rest = Array.isArray(out[i].content)
      ? out[i].content
      : [{ type: 'text', text: String(out[i].content ?? '') }];
    out[i].content = [
      { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } },
      ...rest,
    ];
    return out;
  }

  /** 缓存读按 10% 计入预算（和计费口径一致），免得「用了缓存」反而被预算误杀。 */
  function recordUsage(body) {
    if (!body?.usage) return;
    const cached = body.usage.cache_read_input_tokens ?? 0;
    const written = body.usage.cache_creation_input_tokens ?? 0;
    usage.promptTokens += (body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0) + written;
    usage.completionTokens += body.usage.completion_tokens ?? body.usage.output_tokens ?? 0;
    usage.cacheReadTokens += cached;
    usage.cacheWriteTokens += written;
    usage.promptTokens += Math.round(cached * 0.1);
  }

  async function throttle() {
    const wait = nextAllowedAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAllowedAt = Date.now() + (cfg.minIntervalMs || 0);
  }

  function headers() {
    if (cfg.protocol === 'anthropic') {
      return { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, authorization: `Bearer ${cfg.apiKey}`, 'anthropic-version': '2023-06-01' };
    }
    return { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` };
  }

  async function callOpenAi(request) {
    const response = await fetch(`${trimSlash(cfg.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { ...headers(), 'user-agent': cfg.userAgent },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: request.maxTokens ?? cfg.maxTokens,
        temperature: request.temperature ?? 0.3,
        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        messages: request.messages,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000 || null;
      throw new LlmError(response.status, `LLM ${response.status}: ${(await response.text()).slice(0, 300)}`, retryAfter);
    }
    const body = await response.json();
    recordUsage(body);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : '')).join('');
    return '';
  }

  async function callAnthropic(request) {
    const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    let messages = request.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
    if (cfg.cachePrefix && request.cachePrefix) messages = withCachePrefix(messages, request.cachePrefix);
    const response = await fetch(`${trimSlash(cfg.baseUrl)}/v1/messages`, {
      method: 'POST',
      headers: { ...headers(), 'user-agent': cfg.userAgent },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: request.maxTokens ?? cfg.maxTokens,
        temperature: request.temperature ?? 0.3,
        ...(system ? { system } : {}),
        messages,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after')) * 1000 || null;
      throw new LlmError(response.status, `LLM ${response.status}: ${(await response.text()).slice(0, 300)}`, retryAfter);
    }
    const body = await response.json();
    recordUsage(body);
    return (body?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
  }

  return {
    configured,
    model: cfg.model,
    usage,
    async complete(request) {
      if (!configured) {
        throw new Error('LLM 未配置：.env 里需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
      }
      // 预算闸门：在发请求**之前**检查，避免「已经超了还继续打」。
      // 超预算属于程序设计问题，不该静默降级——直接抛，让调用方停下来看。
      const spent = usage.promptTokens + usage.completionTokens;
      if (spent >= cfg.maxTokensBudget) {
        throw new Error(`已超出 token 预算：${spent} / ${cfg.maxTokensBudget}。`
          + '调大 LLM_MAX_TOKENS_BUDGET，或减少生成节数/轮次。');
      }
      if (usage.calls >= cfg.maxCalls) {
        throw new Error(`已超出调用次数上限：${usage.calls} / ${cfg.maxCalls}。调大 LLM_MAX_CALLS。`);
      }
      for (let attempt = 1; ; attempt += 1) {
        await throttle();
        await slots.acquire();
        try {
          usage.calls += 1;
          return cfg.protocol === 'anthropic' ? await callAnthropic(request) : await callOpenAi(request);
        } catch (error) {
          const retryable = error instanceof LlmError && (error.status === 429 || error.status >= 500) && attempt < 4;
          if (!retryable) throw error;
          const delay = error.retryAfterMs ?? Math.min(30_000, 2000 * 2 ** (attempt - 1));
          nextAllowedAt = Date.now() + delay;
        } finally {
          slots.release();
        }
      }
    },
  };
}

/**
 * 从模型输出里抠 JSON。
 * 模型经常裹一层 ```json 围栏，或者在前后加解释——直接 JSON.parse 会炸。
 *
 * 输出被 maxTokens 截断时，错误信息要**明确说是截断**，否则会被当成
 * 「模型不会输出 JSON」去改提示词，实际上只是额度不够。
 */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const looksTruncated = (s) => {
    // 括号不配对 = 被截断（要跳过字符串内的括号，粗算即可）
    let depth = 0;
    let inStr = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' && s[i - 1] !== '\\') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{' || ch === '[') depth += 1;
      if (ch === '}' || ch === ']') depth -= 1;
    }
    return depth !== 0;
  };
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* 落到下面 */ }
    }
    if (looksTruncated(candidate)) {
      throw new Error(
        `模型输出被截断（JSON 括号不配对，共 ${candidate.length} 字符）。`
        + '调大 maxTokens 或让它少输出一点，不要改提示词的 JSON 要求。'
        + `\n尾部：…${candidate.slice(-120)}`,
      );
    }
    throw new Error(`模型输出不是合法 JSON：${candidate.slice(0, 200)}`);
  }
}
