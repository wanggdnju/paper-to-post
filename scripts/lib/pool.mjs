/**
 * 有上限的并发执行。写稿链路里所有「一批互不依赖的任务」都走这里，
 * 不要自己写 for + await（那是串行），也不要裸 Promise.all 一个几百项的大数组
 * （网关会被瞬时打爆，429 之后反而更慢）。
 *
 * 用法：
 *   const out = await mapPool(items, 8, async (item, i) => {...});
 *   // out 的顺序与 items 一致
 *
 * 为什么不用 p-limit：项目里没有一个「工具库」依赖，scripts/ 一直是零依赖直跑，
 * 为一个 30 行的信号量引入包不划算，也容易和现有 Semaphore 行为不一致。
 */

/**
 * @template T,R
 * @param {T[]} items
 * @param {number} limit 并发上限，<1 视为 1
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>} 与 items 同序的结果；fn 抛错时整体 reject
 */
export async function mapPool(items, limit, fn) {
  const list = [...items];
  const n = Math.max(1, Math.floor(limit) || 1);
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return results;
}

/**
 * 和 mapPool 一样，但**单点失败不中断**：返回 { ok, value, error } 列表。
 * 用于「批量处理 + 少数样本失败没关系」的场景（取图、逐段审稿）。
 */
export async function mapPoolSettled(items, limit, fn) {
  const list = [...items];
  const n = Math.max(1, Math.floor(limit) || 1);
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      try {
        results[i] = { ok: true, value: await fn(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return results;
}

/** 从 --jobs 或环境变量取并发数。 */
export function resolveJobs(explicit, fallback = 8) {
  const v = Number(explicit);
  if (Number.isFinite(v) && v >= 1) return Math.floor(v);
  const env = Number(process.env.PIPELINE_JOBS);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  return fallback;
}
