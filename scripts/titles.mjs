#!/usr/bin/env node
/**
 * 标题候选 + 查重。
 *
 *   node scripts/titles.mjs --slug=dspine [--n=6] [--pick=2]
 *   → articles/<slug>/titles.json + titles.md
 *
 * 为什么单独做：标题决定点击率，但现在是在写稿时随手定的一个。
 * 而且**必须查重**——`research-platform.md` 里已经抓到知乎同题文章，
 * 标题撞车的后果是读者一眼认为「这篇我看过了」。
 *
 * 查重不调模型：用字级 Jaccard + 最长公共子串。
 * 中文没有空格，按字切比对英文按词切更准，代价是短标题容易误判，
 * 所以同时看「公共子串长度」——只有两个信号都高才算撞车。
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
  console.error('用法：node scripts/titles.mjs --slug=<slug> [--n=6] [--paper=path]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const meta = parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data;
const readIf = (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : '');
const outline = readIf('outline.json') ? JSON.parse(readIf('outline.json')) : null;
const articleRel = meta.files?.article || `articles/${slug}/article.md`;
const article = existsSync(join(ROOT, articleRel)) ? readFileSync(join(ROOT, articleRel), 'utf8') : '';
const paperPath = args.paper ? String(args.paper) : `/tmp/${slug}.txt`;
const paper = existsSync(paperPath) ? readFileSync(paperPath, 'utf8') : '';

// ---- 已有的同题标题（查重基准）----
const platformMd = readIf('research-platform.md');
const competitorTitles = [...platformMd.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1].trim());
// 公众号/知乎的既发标题也要避开（避免自己和自己撞）
const ownTitles = [];

/** 字级 Jaccard */
function jaccard(a, b) {
  const A = new Set([...a.replace(/[^一-龥A-Za-z0-9]/g, '')]);
  const B = new Set([...b.replace(/[^一-龥A-Za-z0-9]/g, '')]);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** 最长公共子串长度 */
function longestCommon(a, b) {
  const A = a.replace(/[^一-龥A-Za-z0-9]/g, '');
  const B = b.replace(/[^一-龥A-Za-z0-9]/g, '');
  let best = 0;
  const dp = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    let prev = 0;
    for (let j = 1; j <= B.length; j++) {
      const tmp = dp[j];
      dp[j] = A[i - 1] === B[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = tmp;
    }
  }
  return best;
}

/** 两个信号都高才算撞车：Jaccard ≥ 0.45 且 公共子串 ≥ 6 字 */
function collides(title, other) {
  const j = jaccard(title, other);
  const lcs = longestCommon(title, other);
  return { jaccard: j, lcs, hit: j >= 0.45 && lcs >= 6 };
}

// ---- 生成候选 ----
const llm = createLlm();
if (!llm.configured) {
  console.error('✗ LLM 未配置');
  process.exit(1);
}

const n = Number(args.n ?? 6);
const thesis = outline?.thesis ?? meta.digest ?? '';
const claims = outline?.sections?.map((s) => `${s.heading}：${s.claim}`).join('\n') ?? '';

const raw = await llm.complete({
  messages: [
    { role: 'system', content: '你是科技媒体的标题编辑。只输出 JSON。' },
    {
      role: 'user',
      content: `为下面这篇论文解读拟 ${n} 个标题候选。

# 论文
${meta.title ?? ''}（arXiv:${meta.arxiv_id ?? ''}）

# 全文论点
${thesis}

# 各节核心论断
${claims}

# 已发表的同题文章标题（**这些角度已经有人写过，尽量避开**）
${competitorTitles.length ? competitorTitles.map((t) => `- ${t}`).join('\n') : '（没有抓到同题文章）'}

# 要求
1. 每个标题 ≤ 28 字，中文；
2. 必须有具体信息：数字、机制、或一个判断。不要「XX 解读」「一文读懂」这类空标题；
3. 角度要分散：至少一个从「结果」切入、一个从「机制」切入、一个从「代价/局限」切入；
4. 不要用「颠覆」「炸裂」「史上最强」这类词；
5. 给每个标题标一个 angle（result / mechanism / cost / lineage）。

输出 JSON：
{"titles": [{"title": "...", "angle": "result", "why": "一句话说明这个标题想抓什么"}]}`,
    },
  ],
  maxTokens: 2500,
  temperature: 0.8,
  jsonMode: true,
});

const parsed = extractJson(raw);
const candidates = (parsed.titles ?? []).filter((t) => t.title);

// ---- 查重 ----
const scored = candidates.map((c) => {
  const checks = competitorTitles.map((other) => ({ other, ...collides(c.title, other) }));
  const worst = checks.sort((a, b) => b.jaccard - a.jaccard)[0] ?? null;
  const own = ownTitles.map((other) => ({ other, ...collides(c.title, other) }))
    .sort((a, b) => b.jaccard - a.jaccard)[0] ?? null;
  return {
    ...c,
    chars: (c.title.match(/[一-龥]/g) ?? []).length,
    collision: own?.hit ? own : (worst?.hit ? worst : null),
    nearest: own?.hit ? own : worst,
  };
});

// 按「不撞车 → 角度分散 → 长度合适」排
const seenAngles = new Set();
const ranked = [...scored].sort((a, b) => {
  if (Boolean(a.collision) !== Boolean(b.collision)) return a.collision ? 1 : -1;
  return 0;
}).filter((c) => {
  if (seenAngles.has(c.angle)) return false;   // 同角度只留第一个
  seenAngles.add(c.angle);
  return true;
});
// 补回被过滤掉的其他候选，排在后面
const rest = scored.filter((s) => !ranked.includes(s));
const finalList = [...ranked, ...rest];

const doc = {
  slug,
  generated_at: new Date().toISOString(),
  model: llm.model,
  competitor_titles: competitorTitles,
  candidates: finalList,
  recommended: finalList.filter((c) => !c.collision).slice(0, 2).map((c) => c.title),
};
writeFileSync(join(dir, 'titles.json'), JSON.stringify(doc, null, 1), 'utf8');

const md = [
  `# 标题候选：${meta.title ?? slug}`,
  '',
  `> ${doc.generated_at}　模型 ${llm.model}`,
  `> 查重基准：${competitorTitles.length} 篇知乎同题文章`,
  '',
  '| # | 标题 | 角度 | 字数 | 撞车检查 |',
  '| --- | --- | --- | --- | --- |',
  ...finalList.map((c, i) => [
    `| ${i + 1}`,
    c.title,
    c.angle ?? '—',
    c.chars,
    c.collision
      ? `⚠️ 与《${c.collision.other.slice(0, 20)}》重合（Jaccard ${c.collision.jaccard.toFixed(2)}，公共 ${c.collision.lcs} 字）`
      : `✓ 最接近的只有 Jaccard ${(c.nearest?.jaccard ?? 0).toFixed(2)}`,
  ].join(' | ') + ' |'),
  '',
  doc.recommended.length
    ? `**建议**：${doc.recommended.map((t) => `「${t}」`).join(' 或 ')}`
    : '**建议**：所有候选都有重合风险，需要人工重拟。',
  '',
].join('\n');
writeFileSync(join(dir, 'titles.md'), md, 'utf8');

console.log(md);
const blocked = finalList.filter((c) => c.collision).length;
if (blocked === finalList.length) {
  console.error(`\n⚠️  ${blocked} 个候选全部与已有文章重合，建议重跑或人工拟题。`);
  process.exit(1);
}
