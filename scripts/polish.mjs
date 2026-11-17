#!/usr/bin/env node
/**
 * 润色：把分节生成的稿子合成一篇「读起来连贯、句子不绕」的文章。
 *
 *   node scripts/polish.mjs --slug=<slug> [--jobs=6] [--only=s3] [--dry] [--no-write]
 *   → 原地改写 articles/<slug>/article.md（先备份 article.before-polish-<ts>.md）
 *   → 报告写 articles/<slug>/polish.json
 *
 * 为什么需要这一步：
 *   分节生成保证的是「每节自己讲清楚了」，但节与节之间是各写各的——
 *   上一节末尾抛出的问题，下一节开头可能完全没接；同一个概念在两节各解释一遍；
 *   上一节说「后面会讲」，后面其实没讲。这些在单节自检里都看不出来。
 *   另外模型写技术文偏向「密度高、一句话塞三层修饰」，语法正确但读着费劲。
 *
 * 做两件事，分开验证：
 *   ① 连贯性：每节带上前后节的边界段落，要求接住上文、不重复邻节已解释过的内容；
 *              最后再机械删掉跨节逐字重复的段落。
 *   ② 可读性：拆长句、去嵌套、术语首次出现给一句白话、先结论后解释。
 *
 * **不改事实**。所有数字/表格/图片/公式/标题行都要原样保留，逐节机械校验，
 * 任一校验不过就保留该节原文——润色只允许让文章更好读，不允许让内容变样。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createLlm } from './lib/llm.mjs';
import { parseArticle } from './lib/frontmatter.mjs';
import { mapPoolSettled, resolveJobs } from './lib/pool.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/polish.mjs --slug=<slug> [--jobs=6] [--only=s3] [--dry] [--no-write]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const articlePath = join(dir, 'article.md');
if (!existsSync(articlePath)) {
  console.error(`✗ 没有 articles/${slug}/article.md`);
  process.exit(1);
}

const outlinePath = join(dir, 'outline.json');
const outline = existsSync(outlinePath) ? JSON.parse(readFileSync(outlinePath, 'utf8')) : null;
const glossaryPath = join(dir, 'glossary.json');
const glossary = existsSync(glossaryPath) ? JSON.parse(readFileSync(glossaryPath, 'utf8')) : null;
const meta = existsSync(join(dir, 'article.yaml'))
  ? parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data
  : {};

const md = readFileSync(articlePath, 'utf8');
const lines = md.split('\n');

// ---- 切块：前言（# 标题 + 元信息块）与各 h2 小节 ----
const sections = [];
let preambleEnd = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^##\s+/.test(lines[i])) {
    if (preambleEnd < 0) preambleEnd = i;
    sections.push({ heading: lines[i], start: i, end: lines.length });
    if (sections.length > 1) sections[sections.length - 2].end = i;
  }
}
const preamble = (preambleEnd < 0 ? lines : lines.slice(0, preambleEnd)).join('\n');

/** 小节正文（不含标题行） */
const sectionText = (s) => lines.slice(s.start + 1, s.end).join('\n');
/** 标题去掉编号后的小节名，用于和 outline / draft 文件对齐 */
const cleanHeading = (h) => h.replace(/^##\s+/, '').replace(/^\d+[.、]\s*/, '').trim();

// 小节的稳定 id：优先用大纲顺序，找不到就用序号
sections.forEach((s, i) => {
  const heading = cleanHeading(s.heading);
  const match = (outline?.sections ?? []).find((o) => o.heading && heading && (
    o.heading === heading || heading.startsWith(o.heading) || o.heading.startsWith(heading)
  ));
  s.id = match?.id ?? `h${i + 1}`;
  s.title = heading;
});

// ---- 可读性 / 连贯性指标 ----
const CJK = /[一-龥]/g;
function proseStats(text) {
  const prose = text.split('\n')
    .filter((l) => !/^\s*(\||!\[|\$\$|```|#{1,6}\s|>)/.test(l))
    .join('\n');
  const sents = prose.split(/(?<=[。！？；])/).map((x) => x.trim())
    .filter((x) => (x.match(CJK) ?? []).length > 3);
  const lens = sents.map((x) => (x.match(CJK) ?? []).length);
  if (!lens.length) return { sentences: 0, avg: 0, longRatio: 0, veryLongRatio: 0 };
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  return {
    sentences: lens.length,
    avg: Math.round(avg * 10) / 10,
    longRatio: Math.round((lens.filter((n) => n > 60).length / lens.length) * 1000) / 10,
    veryLongRatio: Math.round((lens.filter((n) => n > 90).length / lens.length) * 1000) / 10,
  };
}

// ---- 逐节润色 ----
// 编号/表格/图片/公式行必须原样保留；数字不许新增。
const PROTECTED = /^\s*(\||!\[|\$\$|```)/;

function numbersIn(text) {
  return new Set((text.match(/\d+(?:\.\d+)?/g) ?? []));
}

/**
 * 中文数量词：`两个核心动作` 被改成 `三个核心动作` 这类错误，阿拉伯数字校验抓不到。
 * 2026-11-13 实测撞到一次——「EAGLE 的两个核心动作」变「三个」，而下面的列表还是两条。
 *
 * 比对方式：只看「数词 + 量词 + 同一个名词」的组合。同一个名词前面的数字变了才算问题；
 * 润色时新写一句「有两个原因」而原文没提过「原因」，不算改事实。
 */
function countClaims(text) {
  const map = new Map(); // 名词（数词后 2 字）→ Set(数词)
  for (const m of text.matchAll(/([一二两三四五六七八九十百]+)[个条种张列次层维步]([一-龥]{2})/g)) {
    if (!map.has(m[2])) map.set(m[2], new Set());
    map.get(m[2]).add(m[1]);
  }
  return map;
}
function headingLines(text) {
  return text.split('\n').filter((l) => /^#{2,6}\s/.test(l)).map((l) => l.trim());
}

function glossaryBlock() {
  if (!glossary?.terms?.length) return '';
  return `# 术语表（统一用这里的译名）\n${glossary.terms.map((t) => `- ${t.en} → ${t.zh}`).join('\n')}\n`;
}

function neighborContext(index) {
  const prev = index > 0 ? sections[index - 1] : null;
  const next = index < sections.length - 1 ? sections[index + 1] : null;
  const tail = (s) => {
    if (!s) return '';
    const paras = sectionText(s).trim().split(/\n\s*\n/).filter(Boolean);
    return (paras.at(-1) ?? '').slice(-300);
  };
  const head = (s) => {
    if (!s) return '';
    const paras = sectionText(s).trim().split(/\n\s*\n/).filter(Boolean);
    return (paras[0] ?? '').slice(0, 300);
  };
  return [
    prev ? `# 上一节（${cleanHeading(prev.heading)}）的最后一段（只接住它，不要复述）\n${tail(prev)}` : '',
    next ? `# 下一节（${cleanHeading(next.heading)}）的第一段（本节结尾不要抢它的内容）\n${head(next)}` : '',
  ].filter(Boolean).join('\n\n');
}

const RULES = `# 改写要求（只改表达，不改事实）
1. **不许新增任何数字**。原文的数字、模型名、基准名、结论一律保留；表格行、图片行（![]）、公式行（$$）**原样照抄**；
2. **标题行原样保留**（\`##\` / \`###\` 一个字都不改）；
3. 拆长句：一句话超过 40 个中文字就拆成两句；一句话里不要套两层以上的「的」或括号解释；
4. **先给结论，再解释**。段落第一句说清这段要证明什么，别用「随着……的发展」这类铺垫；
5. 术语**第一次出现**时补一句白话解释（不超过 15 字），后文直接用；
6. 承接上文：本节第一段要能自然接住上一节最后一句；但**不要写「上一节我们讲了」**这类过渡语；
7. 删掉与邻节重复的解释，只留一句指代（如「同一个价值函数，见 3.1」）；
8. 不用「值得注意的是」「综上所述」「首先…其次…最后」「不是A而是B」；
9. 中文引号用「」，不要 ASCII 双引号；
10. 篇幅与原文相差不超过 ±20%；段落数可以变，但不要合并掉论点；
11. 只输出改写后的小节，从标题行开始，不要解释你改了什么。`;

let llm = null;
if (!args.dry) {
  llm = createLlm();
  if (!llm.configured) {
    console.error('✗ LLM 未配置：.env 需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
    process.exit(1);
  }
}

/** 机械校验：改写版是否只在「表达」上变了 */
function verifyRewrite(original, rewritten, title) {
  const problems = [];
  const origHeadings = headingLines(original);
  const newHeadings = headingLines(rewritten);
  if (origHeadings.join('\n') !== newHeadings.join('\n')) {
    problems.push('标题行被改动');
  }
  const protectedLines = (t) => t.split('\n').filter((l) => PROTECTED.test(l)).map((l) => l.trim());
  const oP = protectedLines(original);
  const nP = protectedLines(rewritten);
  if (oP.length !== nP.length) problems.push(`表格/图片/公式行数变了（${oP.length} → ${nP.length}）`);
  else if (oP.some((l, i) => l !== nP[i])) problems.push('表格/图片/公式行内容被改动');

  const allowed = numbersIn(original);
  const introduced = [...numbersIn(rewritten)].filter((n) => !allowed.has(n) && !/^\d{1,2}$/.test(n));
  if (introduced.length) problems.push(`新增了原文没有的数字：${introduced.slice(0, 5).join('、')}`);

  // 中文数量词：「两个核心动作」→「三个核心动作」这种改动校验阿拉伯数字抓不到。
  // 只在「同一个名词前面的数字变了」时才拦——润色新写一句「有两个原因」不算改事实。
  {
    const o = countClaims(original);
    const n = countClaims(rewritten);
    const changed = [];
    for (const [noun, nums] of n) {
      const before = o.get(noun);
      if (!before) continue;             // 原文没提过这个名词，属于新写的句子
      const added = [...nums].filter((x) => !before.has(x));
      if (added.length) changed.push(`${noun}：${[...before].join('/')} → ${[...nums].join('/')}`);
    }
    if (changed.length) problems.push(`中文数量词对不上：${changed.slice(0, 3).join('；')}`);
  }

  const oLen = (original.match(CJK) ?? []).length;
  const nLen = (rewritten.match(CJK) ?? []).length;
  // 短小节的百分比波动很大（「实验设置」只有两百字，多一句就 +20%），
  // 所以同时给一条绝对容差：差 40 字以内不算问题。
  if (oLen > 0 && Math.abs(nLen - oLen) > 40 && (nLen / oLen < 0.8 || nLen / oLen > 1.25)) {
    problems.push(`篇幅变化过大（${oLen} → ${nLen} 字）`);
  }
  if (/"/.test(rewritten.replace(/```[\s\S]*?```/g, ''))) problems.push('用了 ASCII 双引号');
  if (!rewritten.trim().startsWith('##')) problems.push('输出不是从标题行开始');
  return problems;
}

async function polishSection(section, index) {
  const original = `${section.heading}\n${sectionText(section)}`.trim();
  const prompt = `# 文章信息
标题：${meta.title ?? slug}
这一节：${section.title}

${neighborContext(index)}

# 术语表
${glossaryBlock() || '（无）'}

${RULES}

# 要改写的小节（原文）
${original}`;

  const out = (await llm.complete({
    messages: [
      { role: 'system', content: '你是中文技术编辑，只做表达层面的润色，不改事实、不改结构。只输出改写后的小节。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: Math.min(8192, Math.max(2000, Math.round((original.match(CJK) ?? []).length * 1.6))),
    temperature: 0.3,
  })).trim();

  const problems = verifyRewrite(original, out, section.title);
  return { id: section.id, title: section.title, original, rewritten: out, problems };
}

// ---- 主流程 ----
// 附录类小节（`## 附：问答`）不参与润色：它们由 scripts/qa.mjs 单独生成，
// 每条答案都经过数字溯源校验；再让润色改一遍，等于把刚校验过的文本重新掷一次骰子。
const editable = sections.filter((s) => !/^附[：:]/.test(cleanHeading(s.heading)));
const target = args.only
  ? editable.filter((s) => String(args.only).split(',').map((x) => x.trim()).includes(s.id))
  : editable;

if (args.dry) {
  console.log(`文章：${slug}　小节 ${sections.length} 个（将润色 ${target.length} 个）`);
  for (const s of target) {
    const st = proseStats(`${s.heading}\n${sectionText(s)}`);
    console.log(`  ${s.id.padEnd(4)} ${s.title.slice(0, 28).padEnd(30)} ${st.sentences} 句 / 平均 ${st.avg} 字 / >60 字 ${st.longRatio}%`);
  }
  process.exit(0);
}

const before = proseStats(md);
const jobs = resolveJobs(args.jobs, 6);
console.log(`润色 ${target.length} 节，并发 ${Math.min(jobs, target.length)}`);
const started = Date.now();
// 用 settled：某节模型调用失败时保留该节原文，不能让整篇润色失败
const settled = await mapPoolSettled(target, jobs, (s) => polishSection(s, sections.indexOf(s)));
const results = settled.map((r, i) => (r.ok
  ? r.value
  : { id: target[i].id, title: target[i].title, problems: [`模型调用失败：${r.error?.message?.slice(0, 80) ?? r.error}`] }));
const callFailures = settled.filter((r) => !r.ok).length;
const wall = Math.round((Date.now() - started) / 1000);

const accepted = new Map();
let rejected = 0;
for (const r of results) {
  if (r.problems.length) {
    rejected += 1;
    console.error(`✗ ${r.id} ${r.title}：${r.problems.join('；')}（保留原文）`);
  } else {
    accepted.set(r.id, r.rewritten);
    console.log(`✓ ${r.id} ${r.title}`);
  }
}

// 拼装：未润色的小节保持原样
let parts = sections.map((s) => accepted.get(s.id) ?? `${s.heading}\n${sectionText(s)}`.trim());
const dedupedRemoved = [];
{
  const seen = new Map();
  parts = parts.map((part, si) => {
    const paras = part.split(/\n\s*\n/);
    const kept = paras.filter((p) => {
      const key = p.replace(/[「」“”"'`*\s。，、；：！？]/g, '');
      if (key.length < 60 || /^\s*(\||!\[|\$\$|#{1,6}\s)/.test(p)) return true;
      if (seen.has(key)) {
        dedupedRemoved.push({ section: si, text: p.slice(0, 40) });
        return false;
      }
      seen.set(key, si);
      return true;
    });
    return kept.join('\n\n');
  });
}

const nextMd = [preamble.trim(), '', ...parts.map((p) => `${p.trim()}\n`)].join('\n').replace(/\n{3,}/g, '\n\n');
const after = proseStats(nextMd);

// 增幅保护：润色后比原文短 20% 以上，拒绝整篇覆盖
const beforeZh = (md.match(CJK) ?? []).length;
const afterZh = (nextMd.match(CJK) ?? []).length;
const report = {
  slug,
  polished_at: new Date().toISOString(),
  model: llm.model,
  wall_seconds: wall,
  wall_s: wall,
  sections_total: sections.length,
  sections_polished: accepted.size,
  sections_rejected: rejected,
  section_call_failures: callFailures,
  duplicate_paragraphs_removed: dedupedRemoved.length,
  chars_before: beforeZh,
  chars_after: afterZh,
  readability: { before, after },
  usage: llm.usage,
  rejected_detail: results.filter((r) => r.problems.length).map((r) => ({ id: r.id, problems: r.problems })),
};

if (args['no-write']) {
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

if (beforeZh > 500 && afterZh < beforeZh * 0.8) {
  const backup = join(dir, `article.before-polish-${Date.now()}.md`);
  writeFileSync(backup, md, 'utf8');
  console.error(`✗ 拒绝覆盖：润色后 ${afterZh} 字，原文 ${beforeZh} 字（不足 80%）。原文已备份：${backup}`);
  process.exit(1);
}

const backup = join(dir, `article.before-polish-${Date.now()}.md`);
writeFileSync(backup, md, 'utf8');
writeFileSync(articlePath, nextMd, 'utf8');
writeFileSync(join(dir, 'polish.json'), JSON.stringify(report, null, 1), 'utf8');

// 同步回 draft/<id>.md：否则以后重跑 generate 会用旧的分节文件把润色结果覆盖掉
// （formatArticle 会重新编号，带编号的标题写回去也安全——numberHeadings 会先剥掉旧编号）
const draftDir = join(dir, 'draft');
if (existsSync(draftDir)) {
  let synced = 0;
  sections.forEach((s, i) => {
    const file = join(draftDir, `${s.id}.md`);
    if (!existsSync(file)) return;
    writeFileSync(file, `${parts[i].trim()}\n`, 'utf8');
    synced += 1;
  });
  if (synced) console.log(`已同步 ${synced} 个小节到 draft/（避免重跑 generate 时被覆盖）`);
}

console.log(`\n润色完成：${accepted.size}/${target.length} 节，${rejected} 节保留原文，删重复段 ${dedupedRemoved.length} 处，${wall}s`);
console.log(`可读性：平均句长 ${before.avg} → ${after.avg} 字；>60 字长句 ${before.longRatio}% → ${after.longRatio}%`);
console.log(`字数：${beforeZh} → ${afterZh}`);
console.log(`备份：${backup}`);
if (llm.usage.cacheReadTokens) console.log(`缓存命中 ${llm.usage.cacheReadTokens} tokens`);
