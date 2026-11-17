#!/usr/bin/env node
/**
 * 网关并发压测：找出「这台网关今晚能扛多少并发」。
 *
 *   node scripts/bench-llm.mjs [--n=16] [--jobs=8] [--max-tokens=1200]
 *
 * 为什么需要它：写稿链路现在默认 8 并发（generate / critic），这个数字不该拍脑袋。
 * 换网关、换模型、换时段（夜间限流更松）之后重跑一次，就知道还能不能再加。
 *
 * 输出：每个并发档位的墙钟、吞吐（请求/秒）、成功率。
 * 判据：**成功率 100% 且 qps 还在涨** 就继续加；出现 429 / 超时就把 --jobs 降一档。
 */
import process from 'node:process';
import { createLlm } from './lib/llm.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));

const n = Number(args.n ?? 16);
const jobs = Number(args.jobs ?? n);
const maxTokens = Number(args['max-tokens'] ?? 1200);
const prompt = args.prompt
  ? String(args.prompt)
  : '用中文写一段 600 字的技术说明，主题是投机解码中草稿模型为什么受限于层数。分三段，每段一个论点。';

const llm = createLlm({
  maxConcurrency: jobs,
  minIntervalMs: 0,
  maxTokensBudget: 1e9,
  maxCalls: 1e6,
});
if (!llm.configured) {
  console.error('✗ LLM 未配置：.env 需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  process.exit(1);
}

console.log(`压测：${n} 个请求 / 并发 ${jobs} / max_tokens ${maxTokens} / 模型 ${llm.model}`);
const started = Date.now();
const latencies = [];
let ok = 0;
let failed = 0;
const errors = new Map();

await Promise.all(Array.from({ length: n }, async () => {
  const t = Date.now();
  try {
    await llm.complete({ messages: [{ role: 'user', content: prompt }], maxTokens, temperature: 0.3 });
    ok += 1;
    latencies.push((Date.now() - t) / 1000);
  } catch (error) {
    failed += 1;
    const key = String(error.message).slice(0, 60);
    errors.set(key, (errors.get(key) ?? 0) + 1);
  }
}));

const wall = (Date.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]?.toFixed(1);
console.log(JSON.stringify({
  n, jobs,
  wall_s: +wall.toFixed(1),
  qps: +(ok / wall).toFixed(2),
  ok,
  failed,
  latency_s: { p50: pct(0.5), p90: pct(0.9), max: latencies.at(-1)?.toFixed(1) },
  completion_tokens: llm.usage.completionTokens,
  cache_read_tokens: llm.usage.cacheReadTokens,
}, null, 1));
for (const [msg, count] of errors) console.error(`  ✗ ${count}× ${msg}`);
process.exit(failed ? 1 : 0);
