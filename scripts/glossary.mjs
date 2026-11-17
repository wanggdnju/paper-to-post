#!/usr/bin/env node
/**
 * 术语表：从论文里抽出关键术语，定死中英文对照。
 *
 *   node scripts/glossary.mjs --slug=dspine [--write]
 *   → articles/<slug>/glossary.json
 *
 * 为什么需要：分节生成时，模型看不到别的节写了什么，术语一定漂移——
 * 同一节叫「并行草稿」，下一节叫「并行 draft 网络」，再下一节叫「候选生成器」。
 * 读者读到第三个名字就不知道在说什么了。
 *
 * 做法：先把论文里出现频率高的英文术语捞出来，再交给模型定中文名（只做一次，
 * 之后所有小节都注入同一份），所以叫法全程一致。**不调模型也能用**：--no-llm
 * 只输出候选英文术语，人工填中文。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createLlm, extractJson } from './lib/llm.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/glossary.mjs --slug=<slug> [--no-llm] [--paper=path]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const paperPath = args.paper ? String(args.paper) : `/tmp/${slug}.txt`;
if (!existsSync(paperPath)) {
  console.error(`✗ 找不到论文全文：${paperPath}（用 --paper= 指定）`);
  process.exit(1);
}
const rawPaper = readFileSync(paperPath, 'utf8');
// 参考文献区整段砍掉：那里有几百条论文标题和作者名，频率统计会把它排在术语前面。
// PDF 抽文本时 References 通常单独占一行，从它往后都不要。
const refCut = rawPaper.search(/^\s*(references|bibliography)\s*$/im);
const paper = (refCut > rawPaper.length * 0.4 ? rawPaper.slice(0, refCut) : rawPaper)
  // 去掉 URL、arXiv 编号、图表引用标记
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/\b(arxiv:\s*\d{4}\.\d{4,5}|doi:\s*\S+|et al\.?)/gi, ' ')
  .replace(/\b(fig|figure|table|eq|equation|sec|section|appendix)\.?\s*\d+/gi, ' ');

// ---- 候选术语：多词短语，出现 >= 3 次 ----
// 只看纯字母开头的词（排除数字、公式），长度 2–4 个词。
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'to', 'is', 'are', 'we', 'our', 'this', 'that', 'these', 'those', 'as', 'by', 'from', 'at', 'it', 'its', 'be', 'can', 'which', 'such', 'than', 'also', 'have', 'has', 'not', 'but', 'all', 'each', 'more', 'most', 'other', 'using', 'used', 'use', 'when', 'where', 'while', 'into', 'over', 'only', 'both', 'same', 'their']);
const counts = new Map();
for (const m of paper.matchAll(/\b([A-Za-z][A-Za-z-]{2,}(?:\s+[A-Za-z][A-Za-z-]{2,}){1,3})\b/g)) {
  const phrase = m[1].toLowerCase();
  // 换行、制表符、URL 残留都不是术语
  if (/[\n\t]/.test(m[1])) continue;
  const words = phrase.split(/\s+/);
  if (words.some((w) => STOP.has(w))) continue;             // 含虚词的不要
  if (words.every((w) => STOP.has(w))) continue;
  counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
}
// 保留原大小写形态（首字母大写的那种更容易是术语）
// 再加两条廉价的启发式：作者名（两三个词、全首字母大写）、机构/会议名（含这些词）
const INSTITUTION = /\b(conference|proceedings|journal|university|institute|systems|research|press|association|arxiv|preprint)\b/i;
const candidates = [...counts.entries()]
  .filter(([phrase, n]) => n >= 2 && !INSTITUTION.test(phrase))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 60)
  .map(([phrase, n]) => ({ en: phrase, count: n }));

if (args['no-llm']) {
  writeFileSync(join(dir, 'glossary.json'), JSON.stringify({ slug, terms: candidates.map((c) => ({ ...c, zh: '' })) }, null, 1), 'utf8');
  console.log(JSON.stringify(candidates.slice(0, 15), null, 1));
  console.log(`→ articles/${slug}/glossary.json（${candidates.length} 个候选，中文名留空待填）`);
  process.exit(0);
}

const llm = createLlm();
if (!llm.configured) {
  console.error('✗ LLM 未配置。可以用 --no-llm 只出候选，人工填中文名。');
  process.exit(1);
}

const raw = await llm.complete({
  messages: [
    { role: 'system', content: '你是技术编辑，负责统一术语译法。只输出 JSON。' },
    {
      role: 'user',
      content: `以下是论文里出现频率较高的英文术语。请为每个给出**中文定译**（一个词/短语，不要解释）。

${candidates.map((c) => `- ${c.en}（${c.count} 次）`).join('\n')}

要求：
1. 只保留这篇论文里**有技术含义**的术语，去掉 "large language model" 这类泛泛之词和 "this paper" 这类短语；
2. 中文译名要短（2–6 字），全篇统一，不要给多个选项；
3. 如果某个术语业界已有通行中文说法，用通行说法。

输出 JSON：
{"terms": [{"en": "speculative decoding", "zh": "投机解码", "note": "可选，一句话说明"}]}`,
    },
  ],
  maxTokens: 2000,
  temperature: 0.2,
  jsonMode: true,
});

const plan = extractJson(raw);
const terms = (plan.terms ?? []).filter((t) => t.en && t.zh);
writeFileSync(join(dir, 'glossary.json'), JSON.stringify({
  slug,
  generated_at: new Date().toISOString(),
  model: llm.model,
  terms,
}, null, 1), 'utf8');

console.log(`→ articles/${slug}/glossary.json（${terms.length} 条术语）`);
for (const t of terms.slice(0, 15)) console.log(`  ${t.en} → ${t.zh}${t.note ? `　（${t.note}）` : ''}`);
