import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateKeys, classesCompatible, unitClass, valueKey } from './number-units.mjs';

test('× / x / 倍 是同一个单位类别', () => {
  assert.equal(unitClass('1.93×'), 'x');
  assert.equal(unitClass('1.93x'), 'x');
  assert.equal(unitClass('1.93倍'), 'x');
  assert.equal(valueKey('1.93×'), valueKey('1.93x'));
});

test('百分比与加速比是不同类别，裸数字自成一类', () => {
  assert.notEqual(unitClass('23.3%'), unitClass('1.93×'));
  assert.equal(unitClass('4.22'), '');
  // 4.22（接受长度）与 4.22×（加速比）必须是两个键
  assert.notEqual(valueKey('4.22'), valueKey('4.22×'));
});

test('valueKey 跳过正负号，取前导数字', () => {
  assert.equal(valueKey('+1.87'), '1.87|');
  assert.equal(valueKey('-0.18'), '0.18|');
  assert.equal(valueKey('−0.18'), '0.18|');
});

test('引用带单位时先找同类，再退回无单位', () => {
  // 表里抽出来的格子就是个裸 23.3，正文写「吞吐高 23.3%」
  assert.deepEqual(candidateKeys('23.3', '%'), ['23.3|%', '23.3|']);
  assert.deepEqual(candidateKeys('1.93', '×'), ['1.93|x', '1.93|']);
});

test('引用不带单位时不去认领带单位的格子', () => {
  // 正文写裸 4.22 时不许匹配表里明确的 4.22×：那正是接受长度和加速比互相顶替的来源
  assert.deepEqual(candidateKeys('4.22', ''), ['4.22|']);
  assert.ok(!candidateKeys('4.22', '').includes('4.22|x'));
});

test('舍入比对：同类可比，引用带单位时也接受无单位', () => {
  assert.ok(classesCompatible('%', '%'));
  assert.ok(classesCompatible('×', 'x'));
  assert.ok(classesCompatible('%', ''), '正文 23.3% 能对上表里裸 23.3');
  assert.ok(!classesCompatible('', 'x'), '正文裸 4.22 不能对上 4.22x');
  assert.ok(!classesCompatible('%', 'x'));
});
