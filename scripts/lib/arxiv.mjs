/**
 * arXiv ID 归一化：把用户能粘出来的各种形态统一成裸 ID。
 *
 *   https://arxiv.org/abs/2609.36173v2   → 2609.36173
 *   https://arxiv.org/pdf/2609.36173.pdf → 2609.36173
 *   https://export.arxiv.org/abs/xxx     → xxx
 *   arxiv:2609.36173                     → 2609.36173
 *   2609.36173v1                         → 2609.36173
 *   hep-th/9901001                       → hep-th/9901001   （2007 年前的旧编号）
 *
 * 为什么单拎出来：之前每个脚本各写一行 replace(/^arxiv:/i,'')，只认裸 ID。
 * 用户按文档丢来一个 arXiv URL 时，publish.mjs 会把整个 URL 当 ID 存进 article.yaml，
 * 之后 fetch-figures / research-paper 全都取不到数据，**而且不报错**——
 * 标题静默变成空串，调研静默跳过。这类「跑完了但结果是错的」比直接报错难查得多。
 *
 * 收口到一个地方，任何脚本拿到的都必须是裸 ID，解析不了就抛。
 */

const NEW_ID = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
const OLD_ID = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/;
const BARE = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;

/**
 * @param {unknown} value 用户输入：URL、`arxiv:xxx`、裸 ID
 * @returns {{ id: string, version: string }} version 形如 `v2`，无版本时为空串
 * @throws 解析不出来时抛 Error（调用方应直接退出，不要静默降级）
 */
export function parseArxivId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('arXiv ID 为空');

  // 纯裸 ID：先做精确匹配，避免把别的数字串当 ID
  const bare = raw.match(BARE);
  if (bare) return { id: bare[1], version: bare[2] ?? '' };

  // 带 arxiv: 前缀或 URL：去掉查询串和扩展名再抓
  const cleaned = raw
    .replace(/^arxiv:\s*/i, '')
    .replace(/[?#].*$/, '')
    .replace(/\.pdf$/i, '')
    .replace(/\/+$/, '');

  const next = cleaned.match(NEW_ID) ?? cleaned.match(OLD_ID);
  if (next) return { id: next[1], version: next[2] ?? '' };

  throw new Error(`认不出 arXiv ID：${raw}（支持 https://arxiv.org/abs/XXXX.XXXXX、arxiv:XXXX.XXXXX、XXXX.XXXXXv2）`);
}

/** 只要裸 ID，解析失败返回空串（用于「有就用、没有就算了」的场合）。 */
export function tryParseArxivId(value) {
  try { return parseArxivId(value).id; } catch { return ''; }
}
