#!/usr/bin/env node
/**
 * 评分卡：给一篇文章打一组可比的分数，用于「改了提示词之后变好还是变坏」。
 *
 *   node scripts/score.mjs --slug=dspine [--record] [--compare=<slug>]
 *   → articles/<slug>/score.json
 *   → history/scores.jsonl（--record 时追加一行）
 *
 * 为什么必须有这个：所有 prompt / spec 调整都是盲调，除非有基准。
 * 没有分数的后果是——加了 critic、加了 best-of-N，你只能说「感觉好点了」，
 * 说不出「数字准确率从 97% 到 100%，但产出成本翻倍」。
 *
 * 分数全部来自已有产物，不额外调模型：
 *   - 自检通过项数（跑 publish-check）
 *   - 数字溯源（verify-numbers）
 *   - critic 的 high/medium 条数（如果有 critic.json）
 *   - 篇幅、结构完整度、变体一致性
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/score.mjs --slug=<slug> [--record] [--compare=<slug>]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const meta = parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data;
const articleRel = meta.files?.article || `articles/${slug}/article.md`;
const articlePath = join(ROOT, articleRel);

const score = { slug, scored_at: new Date().toISOString(), title: meta.title ?? '', metrics: {}, total: 0 };

// ---- 1. 机器自检 ----
const check = spawnSync(process.execPath, [join(ROOT, 'scripts/publish-check.mjs'), `--slug=${slug}`],
  { cwd: ROOT, encoding: 'utf8' });
const lines = (check.stdout ?? '').split('\n').filter((l) => /^[✅❌]\s*\[/.test(l));
const passed = lines.filter((l) => l.startsWith('✅')).length;
score.metrics.check_passed = passed;
score.metrics.check_total = lines.length;
score.metrics.check_ratio = lines.length ? passed / lines.length : 0;

// ---- 2. 数字溯源 ----
const verify = spawnSync(process.execPath, [join(ROOT, 'scripts/verify-numbers.mjs'), `--slug=${slug}`, '--json'],
  { cwd: ROOT, encoding: 'utf8' });
if (verify.status === 0 || verify.stdout) {
  try {
    const v = JSON.parse(verify.stdout);
    score.metrics.numbers_scanned = v.scanned ?? 0;
    score.metrics.numbers_unverified = v.unverified ?? 0;
    score.metrics.number_accuracy = v.scanned ? 1 - (v.unverified ?? 0) / v.scanned : null;
  } catch {
    score.metrics.number_accuracy = null;
  }
}

// ---- 3. critic ----
const criticPath = join(dir, 'critic.json');
if (existsSync(criticPath)) {
  const c = JSON.parse(readFileSync(criticPath, 'utf8'));
  score.metrics.critic_high = c.findings.filter((f) => f.severity === 'high').length;
  score.metrics.critic_medium = c.findings.filter((f) => f.severity === 'medium').length;
  score.metrics.critic_low = c.findings.filter((f) => f.severity === 'low').length;
  score.metrics.critic_paragraphs = c.paragraphs_reviewed;
}

// ---- 4. 篇幅与结构 ----
if (existsSync(articlePath)) {
  const body = readFileSync(articlePath, 'utf8');
  const zh = (body.match(/[一-龥]/g) ?? []).length;
  score.metrics.zh_chars = zh;
  // 目标区间来自 config.yaml
  const target = parseArticle(readFileSync(join(ROOT, 'publish/config.yaml'), 'utf8')).data.target_word_count ?? '';
  const [lo, hi] = String(target).split('-').map((n) => Number(n.trim()));
  score.metrics.length_in_target = lo && hi ? (zh >= lo && zh <= hi ? 1 : 0) : null;
  score.metrics.h2_count = (body.match(/^##\s/gm) ?? []).length;
  score.metrics.figures = (body.match(/^!\[/gm) ?? []).length;
  score.metrics.tables = (body.match(/^\|.*\|\n\|[\s:-]+/gm) ?? []).length;
}

// ---- 5. 变体一致性 ----
const variants = ['zhihu.md', 'xhs.md', 'xhs-article.md'];
score.metrics.variants_present = variants.filter((v) => existsSync(join(dir, v))).length;
// 变体里的数字是否都能在原文找到
const articleNums = existsSync(articlePath)
  ? new Set([...(readFileSync(articlePath, 'utf8').match(/\d+\.\d+/g) ?? [])])
  : new Set();
for (const v of variants) {
  const p = join(dir, v);
  if (!existsSync(p)) continue;
  const nums = new Set([...(readFileSync(p, 'utf8').match(/\d+\.\d+/g) ?? [])]);
  const extra = [...nums].filter((n) => !articleNums.has(n));
  score.metrics[`${v.replace('.md', '')}_extra_numbers`] = extra.length;
}

// ---- 加权总分（0–100）----
// 权重理由：数字准确最重要（错了就是造谣）；自检次之；critic high 直接扣重分。
let total = 0;
total += (score.metrics.number_accuracy ?? 1) * 40;
total += (score.metrics.check_ratio ?? 0) * 25;
total += Math.max(0, 20 - (score.metrics.critic_high ?? 0) * 10 - (score.metrics.critic_medium ?? 0) * 2);
total += (score.metrics.length_in_target ? 10 : 0);
total += Math.max(0, 5 - (score.metrics.variants_present < 3 ? 2 : 0));
score.total = Math.round(total * 10) / 10;

writeFileSync(join(dir, 'score.json'), JSON.stringify(score, null, 1), 'utf8');

// ---- 人读版 ----
console.log(`\n${score.title}`);
console.log('─'.repeat(60));
const m = score.metrics;
console.log(`总分 ${score.total}/100`);
console.log(`  数字准确率   ${m.number_accuracy === null ? '—' : (m.number_accuracy * 100).toFixed(0) + '%'}` +
  `（${m.numbers_scanned ?? 0} 个数字，${m.numbers_unverified ?? 0} 个无出处）`);
console.log(`  机器自检     ${m.check_passed}/${m.check_total}`);
console.log(`  critic       high ${m.critic_high ?? '—'} / medium ${m.critic_medium ?? '—'}`);
console.log(`  篇幅         ${m.zh_chars ?? '—'} 字${m.length_in_target ? '' : '（不在目标区间）'}`);
console.log(`  结构         ${m.h2_count ?? '—'} 个 h2、${m.figures ?? 0} 图、${m.tables ?? 0} 表`);
console.log(`  变体         ${m.variants_present}/3${['zhihu', 'xhs', 'xhs-article']
  .map((v) => m[`${v}_extra_numbers`] ? `　${v} 多出 ${m[`${v}_extra_numbers`]} 个数` : '')
  .join('')}`);

if (args.record) {
  const historyDir = join(ROOT, 'history');
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, 'scores.jsonl'),
    JSON.stringify({ ...score, article: articleRel }) + '\n', { flag: 'a' });
  console.log(`\n已记录到 history/scores.jsonl`);
}

if (args.compare) {
  const other = join(ROOT, 'articles', String(args.compare), 'score.json');
  if (existsSync(other)) {
    const prev = JSON.parse(readFileSync(other, 'utf8'));
    console.log(`\n与 ${args.compare} 对比：总分 ${prev.total} → ${score.total}（${score.total >= prev.total ? '+' : ''}${(score.total - prev.total).toFixed(1)}）`);
    for (const key of new Set([...Object.keys(prev.metrics), ...Object.keys(m)])) {
      if (prev.metrics[key] !== m[key]) console.log(`  ${key}: ${prev.metrics[key]} → ${m[key]}`);
    }
  }
}
