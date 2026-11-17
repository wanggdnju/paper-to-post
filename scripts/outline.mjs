#!/usr/bin/env node
/**
 * 写第一个产物：大纲（outline.json）。
 *
 *   node scripts/outline.mjs --slug=dspine [--model=...] [--dry]
 *   → articles/<slug>/outline.json  +  outline.md（给人审）
 *
 * 为什么先写大纲而不是直接写正文：
 *   1. **大纲决定上限**。每节的核心论断如果只是「介绍方法」，正文就一定平庸；
 *      如果写成「并行草稿病在位置之间没有条件化」，正文自然会往这个方向发力。
 *   2. **审阅成本差一个数量级**。一页大纲三十秒能看完，8000 字稿子要半小时。
 *      人工介入放在这里，改起来的代价也最小。
 *   3. 分节生成时每节只需要「大纲 + 邻节摘要 + 术语表 + 允许引用的 fact id」，
 *      上下文干净，不容易跑偏。
 *
 * 输出契约（generate.mjs 依赖这个结构，改字段要同步改两边）：
 *   {
 *     sections: [{ id, heading, claim, factIds[], figures[], words, notes }],
 *     thesis, targetReader
 *   }
 *
 * 不调模型也能用：--dry 会输出一份「空壳大纲」，只列出必需的 8 个小节和可用素材，
 * 方便先看看素材够不够写。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createLlm, extractJson } from './lib/llm.mjs';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/outline.mjs --slug=<slug> [--dry] [--sections=8]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const yamlPath = join(dir, 'article.yaml');
if (!existsSync(yamlPath)) {
  console.error(`✗ 没有 articles/${slug}/article.yaml，先 --stage=new`);
  process.exit(1);
}
const meta = parseArticle(readFileSync(yamlPath, 'utf8')).data;
const config = parseArticle(readFileSync(join(ROOT, 'publish/config.yaml'), 'utf8')).data;

const readIf = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
const briefing = readIf('briefing.md');
const briefingJson = readIf('briefing.json');
const factsRaw = readIf('facts.json');
const paperPath = args.paper ? String(args.paper) : `/tmp/${slug}.txt`;
const paper = existsSync(paperPath) ? readFileSync(paperPath, 'utf8') : '';

// ---- 可用素材清单 ----
const facts = factsRaw ? JSON.parse(factsRaw) : null;
// 事实表可能几百条，全给模型会淹没重点。按「每个方法 × 每列」抽样，
// 优先保留与 Overall/Avg 和主基准相关的行。
const factSample = facts ? selectFacts(facts.facts, 120) : [];
const figureJson = readIf('assets/figures.json');
const figures = figureJson ? JSON.parse(figureJson) : [];

const required = config.required_sections ?? ['TL;DR', '引言', '问题', '方法', '实验设置', '主要结果', '深入分析', '讨论与判断'];

function selectFacts(list, limit) {
  const preferred = list.filter((f) => /overall|avg|average|平均/i.test(f.column));
  const rest = list.filter((f) => !preferred.includes(f));
  return [...preferred, ...rest].slice(0, limit);
}

// ---- 素材够不够写，先判一次 ----
const blockers = [];
if (!facts) blockers.push('没有 facts.json —— 大纲里没法指定 factIds，数字校验会退化成事后补救');
if (!briefing) blockers.push('没有 briefing.md —— 「局限」和「实验设置」会写成复述摘要');
if (!paper) blockers.push(`没有论文全文（${paperPath}）—— 大纲只能靠简报猜，深度不够`);
if (blockers.length && !args.dry) {
  console.error('✗ 写大纲的素材不全：');
  for (const b of blockers) console.error(`    · ${b}`);
  console.error('  先补齐，或用 --dry 看空壳大纲。');
  process.exit(1);
}

// ---- 空壳大纲（--dry） ----
if (args.dry) {
  const shell = {
    slug,
    title: meta.title ?? '',
    dry: true,
    generated_at: new Date().toISOString(),
    thesis: '',
    sections: required.map((name, i) => ({
      id: `s${i + 1}`,
      heading: name,
      claim: '',
      factIds: [],
      figures: [],
      words: Math.round(6000 / required.length),
      notes: '',
    })),
    available: {
      facts: factSample.length,
      figures: figures.map((f) => f.file ?? f.name ?? '').slice(0, 20),
      hasBriefing: Boolean(briefing),
      hasPaper: Boolean(paper),
    },
  };
  writeFileSync(join(dir, 'outline.json'), JSON.stringify(shell, null, 1), 'utf8');
  console.log(`→ articles/${slug}/outline.json（空壳，${required.length} 节）`);
  console.log(JSON.stringify(shell.available, null, 1));
  process.exit(0);
}

// ---- 真正生成 ----
const llm = createLlm();
const factLines = factSample.map((f) =>
  `- ${f.id} | ${f.group ? f.group + ' / ' : ''}${f.method || '?'} | ${f.column} | ${f.value}`).join('\n');
const figureLines = figures.slice(0, 20).map((f, i) =>
  `- 图${i + 1}: ${f.file ?? f.name ?? ''}｜${(f.caption ?? '').slice(0, 120)}`).join('\n');

const prompt = `你在为一篇论文解读写大纲。读者是算法工程师，看得懂 Transformer，但没时间读全文。

# 论文
标题：${meta.title ?? ''}
arXiv：${meta.arxiv_id ?? ''}

# 必需小节（顺序固定，一个不能少）
${required.join(' → ')}

# 写作简报（决定写什么、哪里要小心）
${briefing}

# 可引用的事实（每条的 ID 必须原样写进 factIds）
${factLines || '（无）'}

# 可插入的图
${figureLines || '（无）'}

# 论文全文（节选，用于确定技术细节）
${paper.slice(0, 60000)}

# 任务
输出 JSON：
{
  "thesis": "全文的一句话论点，要具体到这篇论文的机制，不能是「提出了一种新方法」这种废话",
  "sections": [
    {
      "id": "s1",
      "heading": "小节标题（用中文，不要带编号）",
      "claim": "这一节要让读者记住的一句话。必须是判断，不是话题（反面：介绍方法；正面：并行草稿病在位置之间没有条件化）",
      "factIds": ["从上面事实表里原样复制的 ID"],
      "figures": ["文件名"],
      "words": 800,
      "notes": "写这一节要注意什么（可选）"
    }
  ]
}

硬性要求：
1. sections 必须覆盖上面所有必需小节，顺序一致；
2. 「方法」「主要结果」「深入分析」三节必须有 factIds，且 ID 必须从上面的清单里原样复制，不许编造；
3. claim 要写出「为什么值得这么说」，不能是目录式标题；
4. 总字数 5000–9000，按小节分配，主要结果和深入分析要占大头；
5. 只输出 JSON，不要解释。`;

const started = Date.now();
const raw = await llm.complete({
  messages: [
    { role: 'system', content: '你是技术文章的结构编辑，擅长把论文提炼成有判断力的大纲。只输出 JSON。' },
    { role: 'user', content: prompt },
  ],
  // 8 个小节 × (heading + claim + factIds + notes) 很容易超过 4000 token。
  // 截断的表现是「JSON 不完整」，之前会误判成提示词有问题。
  maxTokens: 8000,
  temperature: 0.3,
  jsonMode: true,
});
const plan = extractJson(raw);
const elapsed = Math.round((Date.now() - started) / 1000);

// ---- 校验：factIds 必须真实存在 ----
const factIds = new Set(facts.facts.map((f) => f.id));
const unknown = [];
for (const s of plan.sections ?? []) {
  for (const id of s.factIds ?? []) if (!factIds.has(id)) unknown.push(`${s.heading}: ${id}`);
}
if (unknown.length) {
  console.error('⚠️  大纲引用了不存在的事实 ID（多半是模型编的）：');
  for (const u of unknown.slice(0, 10)) console.error(`    · ${u}`);
}

const doc = {
  slug,
  title: meta.title ?? '',
  generated_at: new Date().toISOString(),
  model: llm.model,
  elapsed_seconds: elapsed,
  thesis: plan.thesis ?? '',
  sections: plan.sections ?? [],
  warnings: unknown.length ? [`${unknown.length} 个 factId 不在 facts.json 里`] : [],
};
writeFileSync(join(dir, 'outline.json'), JSON.stringify(doc, null, 1), 'utf8');

// 人审用的一页纸
const md = [
  `# 大纲：${meta.title ?? slug}`,
  '',
  `> ${doc.thesis}`,
  `> 生成于 ${doc.generated_at}，模型 ${llm.model}，耗时 ${elapsed}s`,
  '',
  '| # | 小节 | 要让读者记住的一句话 | 事实数 | 图 | 字数 |',
  '| --- | --- | --- | --- | --- | --- |',
  ...doc.sections.map((s, i) =>
    `| ${i + 1} | ${s.heading} | ${s.claim} | ${(s.factIds ?? []).length} | ${(s.figures ?? []).join(', ') || '—'} | ${s.words ?? '—'} |`),
  '',
  '> 审这一页就够了：claim 平庸的那几节，正文一定也平庸，让它重写那几节。',
].join('\n');
writeFileSync(join(dir, 'outline.md'), md, 'utf8');

console.log(`→ articles/${slug}/outline.json（${doc.sections.length} 节，${elapsed}s，$${(llm.usage.promptTokens + llm.usage.completionTokens).toLocaleString()} tokens）`);
console.log(`→ articles/${slug}/outline.md（人审这一页）`);
console.log(md);
