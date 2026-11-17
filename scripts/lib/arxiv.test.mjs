#!/usr/bin/env node
/**
 * arXiv ID 归一化的回归测试。
 *
 *   node --test scripts/lib/arxiv.test.mjs
 *
 * 为什么值得单独测：这个函数被 publish / fetch:pdf / fetch:figures / research:paper 四个入口共用，
 * 而且**错了不报错**——早期版本粘 URL 进去会把整个 URL 当 ID，后续取图/调研静默返回空，
 * 稿子照常往下走。回归一次的成本远高于这几行断言。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArxivId, tryParseArxivId } from './arxiv.mjs';

test('abs URL', () => {
  assert.deepEqual(parseArxivId('https://arxiv.org/abs/2609.36173'), { id: '2609.36173', version: '' });
});

test('pdf URL 带 .pdf 后缀', () => {
  assert.deepEqual(parseArxivId('https://arxiv.org/pdf/2609.36173.pdf'), { id: '2609.36173', version: '' });
});

test('保留版本号', () => {
  assert.deepEqual(parseArxivId('https://arxiv.org/abs/2609.36173v2'), { id: '2609.36173', version: 'v2' });
});

test('查询串不影响解析', () => {
  assert.equal(parseArxivId('https://export.arxiv.org/abs/2609.36173v2?context=cs').id, '2609.36173');
});

test('arxiv: 前缀', () => {
  assert.equal(parseArxivId('arxiv:2609.36173').id, '2609.36173');
});

test('裸 ID 与裸 ID + 版本', () => {
  assert.equal(parseArxivId('2609.36173').id, '2609.36173');
  assert.equal(parseArxivId('2609.36173v1').version, 'v1');
});

test('2007 年前旧式编号', () => {
  assert.equal(parseArxivId('hep-th/9901001').id, 'hep-th/9901001');
  assert.equal(parseArxivId('https://arxiv.org/abs/hep-th/9901001v3').id, 'hep-th/9901001');
});

test('前后空白', () => {
  assert.equal(parseArxivId('  https://arxiv.org/pdf/2602.06036v3.pdf  ').id, '2602.06036');
});

test('解析不了要抛，不能返回半截字符串', () => {
  assert.throws(() => parseArxivId('not-an-id'));
  assert.throws(() => parseArxivId(''));
  assert.throws(() => parseArxivId(undefined));
});

test('tryParseArxivId 失败返回空串', () => {
  assert.equal(tryParseArxivId('not-an-id'), '');
  assert.equal(tryParseArxivId(''), '');
  assert.equal(tryParseArxivId('https://arxiv.org/abs/2609.36173'), '2609.36173');
});
