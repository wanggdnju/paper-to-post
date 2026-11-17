#!/usr/bin/env node
/**
 * 回归集：跨文章、跨版本的对比视图。
 *
 *   node scripts/regress.mjs                      # 看所有文章的最新分数
 *   node scripts/regress.mjs --slug=dspine        # 看一篇的历史
 *   node scripts/regress.mjs --diff=a,b           # 对比两篇
 *
 * 与 score.mjs 的分工：
 *   score.mjs  算**一篇**的分（每次跑都写 score.json + 追加 history）
 *   regress.mjs 读所有历史，回答「改了提示词之后整体变好还是变坏」
 *
 * 没有这个工具，所有 prompt 调整都是盲调——你改了 spec，重跑一遍，
 * 分数从 68 到 71，但不知道另外两篇是不是从 80 掉到了 60。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));

const KEYS = [
  ['total', '总分'],
  ['number_accuracy', '数字准确率'],
  ['check_ratio', '自检通过率'],
  ['critic_high', 'critic high'],
  ['zh_chars', '字数'],
  ['variants_present', '变体'],
];

function loadHistory() {
  const p = join(ROOT, 'history/scores.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function fmt(value, key) {
  if (value === null || value === undefined) return '—';
  if (key === 'number_accuracy' || key === 'check_ratio') return `${(value * 100).toFixed(0)}%`;
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  return typeof value === 'number' ? value.toFixed(1) : String(value);
}

const history = loadHistory();

if (!history.length) {
  console.error('✗ history/scores.jsonl 是空的。先跑 `npm run score -- --slug=<slug> --record`');
  process.exit(1);
}

// ---- 每篇最新一次 ----
const latest = new Map();
for (const h of history) latest.set(h.slug, h);

if (args.diff) {
  const [a, b] = String(args.diff).split(',');
  const A = latest.get(a);
  const B = latest.get(b);
  if (!A || !B) {
    console.error(`✗ 找不到 ${!A ? a : b} 的评分记录。已有：${[...latest.keys()].join(', ')}`);
    process.exit(1);
  }
  console.log(`${a} → ${b}\n${'─'.repeat(52)}`);
  for (const [key, label] of KEYS) {
    const va = A.metrics?.[key] ?? A[key];
    const vb = B.metrics?.[key] ?? B[key];
    const delta = typeof va === 'number' && typeof vb === 'number' && key !== 'zh_chars'
      ? `（${vb >= va ? '+' : ''}${(vb - va).toFixed(key === 'number_accuracy' || key === 'check_ratio' ? 2 : 1)}）`
      : '';
    console.log(`  ${label.padEnd(12)} ${fmt(va, key).padStart(8)} → ${fmt(vb, key).padStart(8)} ${delta}`);
  }
  process.exit(0);
}

if (args.slug) {
  const rows = history.filter((h) => h.slug === String(args.slug));
  console.log(`${args.slug} 的评分历史（${rows.length} 次）\n${'─'.repeat(52)}`);
  console.log(['时间', ...KEYS.map(([, l]) => l)].join(' | '));
  for (const r of rows) {
    const t = new Date(r.scored_at).toLocaleString('zh-CN', { hour12: false });
    console.log([t, ...KEYS.map(([k]) => fmt(r.metrics?.[k] ?? r[k], k))].join(' | '));
  }
  process.exit(0);
}

// ---- 全局面板 ----
console.log(`全部文章最新分数（共 ${history.length} 条历史记录）\n${'─'.repeat(72)}`);
console.log(['slug'.padEnd(10), ...KEYS.map(([, l]) => l.padStart(10))].join(' '));
const sorted = [...latest.values()].sort((x, y) => (y.total ?? 0) - (x.total ?? 0));
for (const r of sorted) {
  console.log([
    String(r.slug).padEnd(10),
    ...KEYS.map(([k]) => fmt(r.metrics?.[k] ?? r[k], k).padStart(10)),
  ].join(' '));
}

// 平均分：整体趋势的唯一量化指标
const avg = sorted.reduce((a, r) => a + (r.total ?? 0), 0) / sorted.length;
console.log(`\n平均总分：${avg.toFixed(1)}（${sorted.length} 篇）`);
console.log('对比两篇：npm run regress -- --diff=a,b');
