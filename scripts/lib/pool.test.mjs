import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool, mapPoolSettled, resolveJobs } from './pool.mjs';

test('mapPool 保持输入顺序并真的并发', async () => {
  const order = [];
  const out = await mapPool([3, 1, 2], 3, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms * 5));
    order.push(i);
    return ms * 10;
  });
  assert.deepEqual(out, [30, 10, 20]);
  // 并发：最慢的(3)最先开始，最后结束
  assert.deepEqual(order, [1, 2, 0]);
});

test('mapPool 遵守并发上限', async () => {
  let active = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 2));
    active -= 1;
  });
  assert.ok(peak <= 4, `peak=${peak}`);
  assert.ok(peak >= 2, `peak=${peak}`);
});

test('mapPool 空数组不卡住', async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});

test('mapPoolSettled 收集失败而不是抛出', async () => {
  const out = await mapPoolSettled([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.equal(out[0].ok, true);
  assert.equal(out[0].value, 1);
  assert.equal(out[1].ok, false);
  assert.match(out[1].error.message, /boom/);
  assert.equal(out[2].value, 3);
});

test('resolveJobs 优先级：参数 > 环境变量 > 默认', () => {
  const old = process.env.PIPELINE_JOBS;
  process.env.PIPELINE_JOBS = '5';
  assert.equal(resolveJobs('3'), 3);
  assert.equal(resolveJobs(undefined), 5);
  assert.equal(resolveJobs('0'), 5);      // 0 视为无效
  if (old === undefined) delete process.env.PIPELINE_JOBS; else process.env.PIPELINE_JOBS = old;
});
