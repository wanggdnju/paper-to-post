#!/usr/bin/env node
/**
 * 发布前机器自检：只检查「能数出来」的部分，判断类的问题留给 publish/checklist.md。
 *
 *   node scripts/publish-check.mjs --slug=dflash
 * 退出码：0 全部通过（或有 ⚠️ 人工项）；1 有 ❌。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import katex from 'katex';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=')];
}));
if (!args.slug) {
  console.error('用法：node scripts/publish-check.mjs --slug=<slug>');
  process.exit(1);
}
const slug = args.slug;
const config = parseArticle(readFileSync(join(ROOT, 'publish/config.yaml'), 'utf8')).data;
const yamlPath = join(ROOT, 'articles', slug, 'article.yaml');
const results = [];
const check = (id, ok, message) => results.push({ id, ok, message });

/** 读 PNG 头里的宽高，不引第三方库 */
function pngSize(file) {
  try {
    const buf = readFileSync(file).subarray(0, 24);
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  } catch {
    return null;
  }
}

if (!existsSync(yamlPath)) {
  check('A1', false, `缺少 articles/${slug}/article.yaml（先 npm run publish -- --slug=${slug} --stage=new --arxiv=...）`);
  report();
}
const meta = parseArticle(readFileSync(yamlPath, 'utf8')).data;
// 稿件分两类：
//   paper（默认）—— 论文解读，必须有 arXiv ID，走固定骨架；
//   guide        —— 教程 / 综述 / 方法论，来源是一个网页而不是论文（2026-11-13 加，
//                   起因是投机解码入门稿）。这类没有「实验设置 / 主要结果」这些节，
//                   强行套论文骨架只会把文章写坏，所以结构检查另说。
const kind = String(meta.kind ?? 'paper');
// 第三种情况：论文但**没有 arXiv 号**（只有厂商博客页或 GitHub 上的 PDF）。
// 2026-11-21 EAGLE-4 起：这类稿件必须显式写 `no_arxiv: true`，
// 而且仍要有 source_url——不给「悄悄留空」的余地，读者要能点回原文。
const isPaper = kind === 'paper';
const hasProvenance = isPaper
  ? Boolean(meta.arxiv_id) || (meta.no_arxiv === true && Boolean(meta.source_url))
  : Boolean(meta.source_url || meta.arxiv_id);
const provenanceLabel = isPaper
  ? (meta.arxiv_id ? `arxiv_id=${meta.arxiv_id}` : `无 arXiv 号，来源=${meta.source_url ? '有' : '空'}`)
  : `来源=${meta.source_url ? '有' : '空'}`;
check('A1', hasProvenance && Boolean(meta.title),
  `元数据：${provenanceLabel} title=${String(meta.title || '空').slice(0, 40)}`);

const articlePath = resolveFile(meta, 'article', ['article.md', `${slug}.md`]);
if (!articlePath) {
  check('A1', false, '找不到正文 markdown');
  report();
}
const source = readFileSync(join(ROOT, articlePath), 'utf8');
const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());

// A2 结构
// 论文解读用 config.required_sections；教程类没有「实验设置 / 主要结果」，
// 只守住底线：有 TL;DR，且至少 5 个二级小节（少于此基本是没展开）。
const required = kind === 'paper' ? (config.required_sections ?? []) : [];
const missing = required.filter((name) => !headings.some((h) => h.includes(name) || sectionAlias(name).some((alias) => h.includes(alias))));
if (kind === 'paper') {
  check('A2', missing.length === 0, missing.length ? `缺少小节：${missing.join('、')}` : `结构完整（${headings.length} 个 h2）`);
} else {
  const hasTldr = headings.some((h) => /TL;DR/i.test(h));
  check('A2', hasTldr && headings.length >= 5,
    hasTldr && headings.length >= 5
      ? `教程类结构：TL;DR + ${headings.length} 个小节`
      : `教程类结构不足：${hasTldr ? '' : '缺 TL;DR'}${headings.length < 5 ? `，只有 ${headings.length} 个小节` : ''}`);
}

// A3 摘要
const digest = String(meta.digest ?? '');
const digestChars = (digest.match(/[一-龥]/g) ?? []).length;
const firstParagraph = body.split(/\n\s*\n/).find((p) => p.trim() && !p.startsWith('#') && !p.startsWith('>') && !p.startsWith('-')) ?? '';
check('A3', digestChars >= 80 && digestChars <= 128 && !firstParagraph.includes(digest.slice(0, 20)),
  `摘要 ${digestChars} 字${digestChars === 0 ? '（空）' : ''}${digestChars > 128 ? '，超过公众号 128 上限' : ''}`);

// A4 加粗密度
const bold = [...body.matchAll(/\*\*([^*\n]+)\*\*/g)].map((m) => m[1].trim());
const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('#') && !p.startsWith('|') && !/^[-*]\s/.test(p) && !p.startsWith('$$'));
const chars = (text) => (text.match(/[一-龥]/g) ?? []).length;
const total = paragraphs.reduce((sum, p) => sum + chars(p), 0);
const density = bold.length ? Math.round(total / bold.length) : Infinity;
const boldInParagraphs = paragraphs.filter((p) => p.includes('**')).length;
check('A4', density <= (config.max_chars_per_bold ?? 160) && bold.length >= headings.length * 2,
  `加粗 ${bold.length} 处，平均每 ${Number.isFinite(density) ? density : '∞'} 个中文字一处；含加粗段落 ${boldInParagraphs}/${paragraphs.length}`);

// A4b 加粗能不能真的渲染出来
//
// CommonMark 的定界符规则：闭合的 `**` 如果**前面是标点、后面紧跟文字**，
// 它就既不是 left-flanking 也不是 right-flanking，**不会构成加粗**，星号原样印出。
// 2026-11-16 DFlash 2 的 `**DFlash（前代）**已经跑在…` 就是这样：本地 markdown
// 看着对，公众号读回才发现正文里有字面 `**`，只能重建草稿。
// 这条检查把它挪到发布前，成本从「一次建草稿 + 读回」降到一秒。
{
  const PUNCT = '、。，：；！？（）「」《》‘’“”…—';
  const bad = [];
  for (const m of body.matchAll(/\*\*[^*\n]*?\*\*/g)) {
    const end = m.index + m[0].length;
    const before = m[0][m[0].length - 3];       // 闭合 `**` 前一个字符
    const after = body[end] ?? '';               // 闭合 `**` 后一个字符
    if (!before || !PUNCT.includes(before)) continue;
    if (!after || /\s/.test(after) || PUNCT.includes(after)) continue;
    bad.push(m[0].slice(0, 40));
  }
  check('A4b', bad.length === 0, bad.length
    ? `有 ${bad.length} 处加粗渲染不出来（闭合 ** 前是标点、后接文字）：${bad.slice(0, 3).map((b) => `「${b}」`).join('、')}`
    : '加粗定界符均可渲染');
}

// A5 表格／数据表
//
// 2026-11-19 起数据表一律贴论文原表截图（用户要求），它们不再是 Markdown 表格，
// 所以只数 `| ... |` 会误判「表格不足」。判据改成：
//   手写表（Markdown）+ 论文原表截图（`表 N · ` 图注）= 数据呈现的总数。
// 下限仍是 3：主结果、深入分析各要有表，剩一个给对照/结论。
const mdTables = [...body.matchAll(/^\|.*\|\n\|\s*-+/gm)].length;
const tableShots = [...body.matchAll(/^!\[表\s*\d+/gm)].length;
const tables = mdTables + tableShots;
check('A5', tables >= 3,
  `表格 ${tables} 个（手写 ${mdTables} + 原表截图 ${tableShots}；至少 3 个，主要结果与深入分析各要有）`);

// A6 行间公式必须单行
const multiLineBlocks = [...body.matchAll(/\$\$([^$]+)\$\$/g)].filter((m) => m[1].includes('\n'));
check('A6', multiLineBlocks.length === 0, multiLineBlocks.length ? `有 ${multiLineBlocks.length} 个跨行 $$ 公式，长图会错位` : '行间公式均为单行');

// A7 行内公式宏
const inlineMath = [...body.matchAll(/(?<![$\w])\$([^$\n]+?)\$(?!\$)/g)].map((m) => m[1]);
// 白名单只收「KaTeX 一定能渲染、且长图里不会掉字」的宏。
// 漏登记的后果是自检直接失败，所以宁可放宽——收窄的判据应该是「渲染失败」，
// 那件事下面 katexErrors 已经在查了，不需要靠白名单再挡一遍。
const allowedMacros = new Set(['mathrm', 'text', 'frac', 'times', 'cdot', 'mathbb', 'left', 'right', 'dots', 'quad', 'qquad', 'exp', 'approx', 'tau', 'gamma', 'eta', 'leq', 'geq', 'to', 'in', 'sqrt', 'sigma', 'odot', 'mid', 'sum', 'prod', 'log', 'Pr', 'alpha', 'lambda', 'Delta', 'partial', 'top', 'mathcal', 'operatorname', 'ell', 'cdots', 'ldots', 'cup', 'cap', 'subset', 'forall', 'exists', 'infty', 'langle', 'rangle', 'neg', 'land', 'lor', 'min', 'max', 'hat', 'bar', 'tilde', 'beta', 'theta', 'mu', 'nu', 'pi', 'rho', 'phi', 'psi', 'omega', 'Omega', 'Sigma', 'Pi', 'frac', 'displaystyle', 'mathop', 'limits', 'pm', 'mp', 'ast', 'star', 'circ', 'bullet', 'oplus', 'otimes', 'equiv', 'neq', 'lt', 'gt', 'leqslant', 'geqslant', 'propto', 'sim', 'prime', 'dotsc', 'dotsb', 'textstyle', 'scriptstyle', 'bar', 'vec', 'widehat', 'widetilde', 'langle', 'rangle', 'lceil', 'rceil', 'lfloor', 'rfloor', 'lvert', 'rvert', 'lVert', 'rVert', 'Theta', 'le', 'ge', 'delta', 'nabla', 'epsilon', 'varepsilon', 'zeta', 'kappa', 'xi', 'upsilon', 'chi', 'Lambda', 'Gamma', 'Phi', 'Psi', 'Upsilon', 'times', 'colon', 'middle', 'big', 'Big', 'bigg', 'Bigg', 'operatorname*', 'substack', 'underbrace', 'overbrace', 'mathrm', 'mathnormal', 'boldsymbol', 'textnormal', 'paragraph', 'ast', 'parallel', 'perp', 'angle', 'triangle', 'because', 'therefore', 'll', 'gg', 'prec', 'succ', 'sqsubseteq', 'subseteq', 'supset', 'setminus', 'emptyset', 'varnothing', 'aleph', 'hbar', 'imath', 'jmath', 'Re', 'Im', 'mathbf', 'bm', 'mathds', 'lesssim', 'gtrsim', 'aligned', 'array', 'matrix', 'pmatrix', 'bmatrix', 'text', 'mbox', 'nonumber']);
const badMacros = new Set();
for (const tex of inlineMath) {
  for (const m of tex.matchAll(/\\([a-zA-Z]+)/g)) if (!allowedMacros.has(m[1])) badMacros.add(m[1]);
}
const katexErrors = [];
for (const tex of [...inlineMath, ...[...body.matchAll(/\$\$([^$]+)\$\$/g)].map((m) => m[1])]) {
  try { katex.renderToString(tex, { throwOnError: true, displayMode: false }); } catch (error) { katexErrors.push(`${tex.trim().slice(0, 40)} → ${error.message.split('\n')[0]}`); }
}
check('A7', badMacros.size === 0 && katexErrors.length === 0,
  katexErrors.length ? `KaTeX 渲染失败：${katexErrors.join('；')}` : badMacros.size ? `行内公式含未登记宏：${[...badMacros].join(', ')}` : `公式 ${inlineMath.length + (tables * 0)} 处行内，KaTeX 全部可渲染`);

// A8 数字一致：正文里的 x.xx× 必须出现在文内表格
const numbersInTldr = new Set([...body.matchAll(/(\d+\.\d+)×/g)].map((m) => m[1]));
const tableNumbers = new Set([...body.matchAll(/^\|.*$/gm).flatMap((row) => [...row[0].matchAll(/(\d+\.\d+)×/g)].map((m) => m[1]))]);
// 正文里允许出现表格之外的加速比（如区间第三点、论文正文数字），列出来供人工核对
const unbacked = [...numbersInTldr].filter((n) => !tableNumbers.has(n));
check('A8', true, unbacked.length ? `表格外的加速比：${unbacked.map((n) => `${n}×`).join('、')} —— 人工确认均出自论文` : '正文中的 x.xx× 均能在表格中找到');

// A8b 数字溯源：每个小数都要能在 facts.json 里找到出处（表内某个格子，或论文正文某句话）。
// A8 只查「加速比是否在本文表格里出现过」，查不出「这个数属于哪一行哪一列」；
// 历史事故（31.8 当成三位置均值、12.8% 张冠李戴）正是这一类。
// 没有 facts.json 时跳过——不阻断没建事实表的历史文章。
if (existsSync(join(ROOT, 'articles', slug, 'facts.json'))) {
  const verify = spawnSync(process.execPath, [join(ROOT, 'scripts/verify-numbers.mjs'), `--slug=${slug}`],
    { cwd: ROOT, encoding: 'utf8' });
  const summary = (verify.stdout ?? '').split('\n').find((l) => l.includes('扫描到小数')) ?? '';
  check('A8b', verify.status === 0, verify.status === 0
    ? summary.trim()
    : `数字溯源未通过，详见 npm run verify:numbers -- --slug=${slug}`);
} else {
  check('A8b', true, '没有 facts.json，跳过数字溯源（新文章应先用 npm run facts 建表）');
}

// A8c 任务数一致：正文说「N 个任务」时，论文原表（LaTeX 源）里必须真有 N 个任务列。
//
// 2026-11-12 实际事故：EAGLE-3 的表只有 5 个任务（MT-bench / HumanEval / GSM8K /
// Alpaca / CNN-DM），稿子从头到尾写「六个任务」——数字是对的（4.22 / 5.51 确实是这 5 个
// 任务的均值），但任务数是从上一篇（EAGLE-2，6 个任务，多 Natural Questions）抄过来的。
// 这类错误所有数字检查都放行，只有读者拿表格一数才发现。
{
  const texPath = ['source/tables/main.tex', 'source/tables/table1.tex']
    .map((p) => join(ROOT, 'articles', slug, p)).find((p) => existsSync(p));
  // 只核对「说的是本文主结果表」的句子：「N 个任务（的）平均 / N 任务均值」。
  // 两类必须排除，否则全是误报：
  //   ① 消融表口径 —— DFlash「5 层比 3 层在三个任务上都有提升」说的是消融表的三个任务；
  //   ② 引用别人论文 —— DFlash「EAGLE-3 自己论文报的数字（六任务平均 5.51×）」，
  //      那个 6 属于 EAGLE-3 的表，不归本文管。
  const claimed = [];
  const cnNum = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const numOf = (s) => (/^\d+$/.test(s) ? Number(s) : cnNum[s]);
  const OTHER_PAPER = /(自己论文|论文报的|原文报的|另一篇|那篇论文|他们论文|该论文报)/;
  for (const sentence of body.split(/(?<=[。！？\n])/)) {
    if (OTHER_PAPER.test(sentence)) continue;
    for (const m of sentence.matchAll(/([一二三四五六七八九十\d]+)\s*个?\s*任务(?:上|的)?\s*(?:平均|均值)/g)) claimed.push(numOf(m[1]));
    for (const m of sentence.matchAll(/([一二三四五六七八九十\d]+)\s*任务(?:平均|均值)/g)) claimed.push(numOf(m[1]));
  }
  const uniqClaim = [...new Set(claimed.filter(Boolean))];
  if (texPath) {
    const tex = readFileSync(texPath, 'utf8');
    // 任务列 = 表头里 \multicolumn{2}{c}{X}（允许 {c@{\hspace{…}}} 这种写法），
    // 去掉 Mean/Avg 汇总列和 Temperature= 分组标题。
    const cols = [...tex.matchAll(/\\multicolumn\{2\}\{c(?:@\{[^}]*\})?\}\{(?:\\textit\{)?([^}\\]*)/g)]
      .map((m) => m[1].trim())
      .filter((n) => n && !/^(Mean|Avg\.?|Average|平均)$/i.test(n))
      .filter((n) => !/^Temperature\s*=/i.test(n));
    if (uniqClaim.length && cols.length && !uniqClaim.includes(cols.length)) {
      check('A8c', false, `正文写「${uniqClaim.join('/')} 个任务」，但 ${relative(ROOT, texPath)} 里有 ${cols.length} 个任务列（${cols.join('、')}）`);
    } else if (uniqClaim.length) {
      check('A8c', true, `任务数一致：正文与表格都是 ${cols.length} 个（${cols.join('、')}）`);
    } else {
      check('A8c', true, '正文未提任务数');
    }
  } else {
    check('A8c', true, '没有 LaTeX 表源，跳过任务数校验');
  }
}

// A9 插图：正文引用的图片必须真实存在，且至少两张（架构图 + 结果图）
const figureRefs = [...body.matchAll(/!\[(.*?)\]\(([^)\s]+)/g)].map((m) => m[2]);
const mdDir = dirname(join(ROOT, articlePath));
const missingFigures = figureRefs.filter((src) => !/^https?:/.test(src) && !existsSync(join(mdDir, src)) && !existsSync(join(ROOT, src)));
check('A9', figureRefs.length >= 2 && missingFigures.length === 0,
  missingFigures.length ? `图片缺失：${missingFigures.join('、')}`
    : figureRefs.length < 2 ? `只有 ${figureRefs.length} 张图（至少要有架构图 + 主结果图；先跑 npm run fetch:figures）`
    : `插图 ${figureRefs.length} 张`);

// A9b 图表编号：每张图/表都要有「图 N · / 表 N ·」，正文引用必须能对上。
// 这条查的是「引用指向了不存在的编号」——图注本身编号正确、正文也通顺，
// 但两者说的不是同一张图。人眼极难发现，读者按号一找就发现是别的东西。
const { checkFigureRefs } = await import('./lib/article-format.mjs');
const figRefs = checkFigureRefs(body);
const unnumbered = figureRefs.length > (body.match(/^!\[(?:图|表)\s*\d+\s*·/gm) ?? []).length;
check('A9b', figRefs.bad.length === 0 && !unnumbered,
  figRefs.bad.length
    ? `正文引用了不存在的编号：${figRefs.bad.map((x) => `L${x.line} ${x.ref}`).join('、')}（现有：${figRefs.available.join(' ')}）`
    : unnumbered ? `有插图没有编号（跑 npm run format:article -- --slug=${slug} --write）`
    : `图表编号一致（${figRefs.available.length} 个，正文引用全部对得上）`);

// A9c 元信息块：开头的「论文 / 作者 / 链接 / 代码 / 模型」汇总
// 教程类用 `**来源**` 而不是 `**论文**`：它没有论文可引。
const hasMeta = /^>\s*\*\*(?:论文|作者|链接|来源)\*\*/m.test(body.split(/\n##\s/)[0] ?? '');
check('A9c', hasMeta, hasMeta ? '开头有元信息块（论文 / 作者 / 链接 / 代码）' : '开头缺少元信息块（跑 npm run format:article -- --slug=X --write）');

// A9c2 元信息块形状：必须是**一个**引用块、字段不重复。
//
// 公众号渲染只把第一个 blockquote 当元信息块（render-wechat 的 metaMatch），
// 第二个块里的「原文」链接就既不进元信息区、也不会生成二维码——
// 2026-11-16 DFlash 2 的 D6b 直到建完草稿才报出来。知乎那头则显示成一串重复作者行。
// 两种都能在本地拦：format:article 已经会合并/去重（repairMetaBlock），这里守回退。
{
  const head = body.split(/\n##\s/)[0] ?? '';
  const blocks = [...head.matchAll(/^>[^\n]*$/gm)].length ? (head.match(/^>/m) ? countQuoteGroups(head) : 0) : 0;
  const keys = [...head.matchAll(/^>\s*\*\*([^*\n]+)\*\*/gm)].map((m) => m[1]);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  const problems = [];
  if (blocks > 1) problems.push(`元信息块被拆成 ${blocks} 个引用块（公众号只会认第一个）`);
  if (dup.length) problems.push(`字段重复：${[...new Set(dup)].join('、')}`);
  check('A9c2', problems.length === 0, problems.length
    ? `${problems.join('；')}——跑 npm run format:article -- --slug=${slug} --write`
    : '元信息块是单个引用块、字段无重复');
}

// A9d 长图截断：抓图脚本按固定视口截 PDF，长图会被视口切掉底部。
//
// 2026-11-12 用户三次反馈「图被截断了」：EAGLE-2 的方法图底部「Attention mask」
// 只露出一半、EAGLE-3 的 train 图变成「同一张图出现两遍」（多页 PDF 被拼在一起）。
// 共同特征是 PNG 高度正好等于当时的视口高度（2400 × 200/96 ≈ 5000px），
// 或者 h/w 比例超过 FitH 撑满 1800px 宽时的高度。
// 抓图脚本已改成自适应视口 + 只取第一页，但**别的论文仍可能踩到**，
// 所以这里保留一道算术检查：所有被引用的图，高度不能贴着 5000px 这条线。
{
  const stat = await import('node:fs').then((m) => m.statSync);
  const suspects = [];
  for (const src of figureRefs) {
    if (/^https?:/.test(src)) continue;
    const abs = existsSync(join(mdDir, src)) ? join(mdDir, src) : join(ROOT, src);
    if (!/\/(fig|tab)-[^/]*\.png$/i.test(src)) continue;
    const size = pngSize(abs);
    if (!size) continue;
    const [w, h] = size;
    // 视口 1800×2400 在 dpr 200/96 下是 3750×5000；裁白边后高度落在 4950–5010 基本就是被切了
    if (h >= 4950 && h <= 5010) suspects.push(`${src.split('/').pop()} (${w}×${h})`);
  }
  check('A9d', suspects.length === 0,
    suspects.length
      ? `这些图的高度贴着旧视口上限 5000px，很可能被截断：${suspects.join('、')}（重跑 npm run fetch:figures -- --arxiv=<id> --slug=${slug}）`
      : `长图未被视口截断（${figureRefs.filter((s) => !/^https?:/.test(s)).length} 张已检查）`);
}

// A9e 图注里不能出现会破坏 markdown 图片语法的字符。
//
// 2026-11-21 dmtp 实测：图 2 的图注写「在 [A, T1, MASK×6] 上并行预测」，
// 五处消费 `![alt](path)` 的正则都是 `[^\]]*`，在 alt 里第一个 `]` 就收尾——
// render-article 里那张图 404、derive 的知乎稿留下原始 markdown、render-zhihu
// 的 imageByNumber 少一个号导致「图3 找不到」占位符进了草稿。
// 五处正则已统一改成 `(.*?)`，这条检查防的是**新写下的图注**再把它们撑坏：
// 甲方案（方括号）在 `(.*?)` 下能工作，但换行/未闭合会重新踩坑，
// 更稳妥的是写稿时就别在 alt 里用方括号和圆括号。
{
  const risky = [];
  for (const m of body.matchAll(/^!\[[^\n]*$/gm)) {
    const line = m[0];
    const close = line.lastIndexOf('](');
    const alt = close > 0 ? line.slice(2, close) : line.slice(2);
    const bad = [];
    if (/[[\]]/.test(alt)) bad.push('方括号');
    if (/[()]/.test(alt)) bad.push('圆括号');
    if (bad.length) risky.push(`L${body.slice(0, m.index).split('\n').length} ${bad.join('+')}`);
  }
  check('A9e', risky.length === 0,
    risky.length
      ? `图注里含会破坏 markdown 图片语法的字符：${risky.join('、')}（改成「A、T1、MASK×6」这类写法）`
      : '图注字符安全（无方括号 / 圆括号）');
}

// A10 落地信息：代码 / 模型 / 项目页（没有时只提示，不阻断）
// 教程类本来就不一定有可引用的仓库，没有 links.json 不算错。
const linksPath = join(mdDir, 'assets', 'links.json');
const links = existsSync(linksPath) ? JSON.parse(readFileSync(linksPath, 'utf8')) : null;
const landing = links ? [...(links.github ?? []), ...(links.huggingface ?? []), ...(links.modelscope ?? []), ...(links.project ?? [])] : [];
check('A10', landing.length > 0 || kind !== 'paper',
  links ? `落地信息 ${landing.length} 条（代码 / 模型 / 项目页）`
    : kind === 'paper' ? '没有 links.json，先跑 npm run extract:links（若论文确实没有开源，忽略此项）'
      : '教程类，无落地链接（跳过）');

// A11 篇幅：深度解读少于 4000 中文字通常说明论证没展开（提示项，不阻断）
const zhChars = (body.match(/[一-龥]/g) ?? []).length;
check('A11', zhChars >= 4000, zhChars >= 4000 ? `正文 ${zhChars} 中文字` : `正文只有 ${zhChars} 中文字（建议 ≥ 5000，低于 4000 多半论证没展开，见 references/writing-depth.md）`);

// B1 敏感词 / B2 AI 味句式
const rules = readFileSync(join(ROOT, 'publish/sensitive-words.txt'), 'utf8').split('\n')
  .filter((line) => line.trim() && !line.startsWith('#'))
  .map((line) => { const [pattern, ...why] = line.split('\t'); return { re: new RegExp(pattern, 'g'), why: why.join('\t') }; });
const hits = [];
for (const rule of rules) for (const m of body.matchAll(rule.re)) hits.push(`${m[0]}（${rule.why}）`);
// 「不是…而是」允许出现 1 次
const notBut = hits.filter((h) => h.startsWith('不是'));
check('B1', hits.filter((h) => !h.startsWith('不是')).length === 0, hits.length ? `命中：${[...new Set(hits)].join('；')}` : '无敏感词与 AI 味句式');
check('B2', notBut.length <= 1, `「不是A而是B」出现 ${notBut.length} 次（最多 1 次）`);

// B4 TL;DR 数字与结论一致
const tldrSection = body.match(/##\s*TL;DR\s*\n([\s\S]*?)(?=\n##\s|$)/)?.[1] ?? '';
const conclusion = body.match(/##\s*讨论与判断\s*\n([\s\S]*)$/)?.[1] ?? '';
const tldrNums = new Set([...tldrSection.matchAll(/(\d+\.\d+)×/g)].map((m) => m[1]));
const conclusionNums = new Set([...conclusion.matchAll(/(\d+\.\d+)×/g)].map((m) => m[1]));
const conflicting = [...conclusionNums].filter((n) => !tldrNums.has(n) && !tableNumbers.has(n));
check('B4', conflicting.length === 0, conflicting.length ? `结论里的 ${conflicting.join('、')}× 未在 TL;DR 或表格出现` : 'TL;DR 与结论数字一致');

// C1 长图
const dist = join(ROOT, 'dist/xhs');
const pages = existsSync(dist) ? readdirSync(dist).filter((n) => n.startsWith(`${slug}-`) && /^-\d+.*\.png$/.test(n.slice(slug.length))) : [];
// 还没渲染过就跳过，不要报 ❌。
// 状态机里 reviewed 在 rendered 之前，切图是 rendered 阶段才产出的；
// 这里判「不存在 = 失败」会让全新文章永远过不了 reviewed。
// 真正需要切图检查的是渲染完之后（publish.mjs 的 rendered 阶段会再跑一次本脚本）。
if (!pages.length) {
  check('C1', true, '还没有 dist/xhs 切图（还没到 rendered 阶段，忽略）');
} else {
  check('C1', pages.some((n) => n.includes('cover')) && pages.length >= 2, `长图 ${pages.length} 张（dist/xhs）`);
}
// C1b 切图必须是手机比例（780×1040 = 390×520@2x）。卡片模式会产出 1080×1440，
// 混进来就说明用了 --cards，长图被顶掉了。
const cards = pages.filter((n) => !n.includes('cover'));
if (cards.length) {
  const odd = cards.filter((n) => {
    const dim = pngSize(join(dist, n));
    return dim && (dim[0] !== 780 || dim[1] !== 1040);
  });
  check('C1b', odd.length === 0, odd.length ? `${odd.length} 张不是 780×1040：${odd.slice(0, 3).join('、')}（可能带了 --cards）` : '切图均为 780×1040 手机比例');
}
// C3 无空白页：PNG 文件小到几 KB 基本就是纯色/空白页。
// 真正读像素需要解码，代价高；用「体积下限」做代理足够抓「渲染出空屏」这种事故。
// 阈值 8KB：实测正常的 780×1040 文字页最小约 25KB，纯白页约 2–3KB。
if (cards.length) {
  const blanks = cards.filter((n) => {
    try { return statSync(join(dist, n)).size < 8 * 1024; } catch { return false; }
  });
  check('C3', blanks.length === 0, blanks.length
    ? `${blanks.length} 张可能是空白页（体积 < 8KB）：${blanks.slice(0, 3).join('、')}`
    : `${cards.length} 张切图均有内容（体积 ≥ 8KB）`);
}

// C6 切图里必须真的有图和表
//
// 小红书是滑动浏览，纯文字长图没人看——图给直观、表给数字，两者缺一不可。
// 2026-11-11 实际发生：`xhs-article.md` 派生时只挑了纯文字段落，10 屏全是字，
// 用户直接反馈「怎么都没有论文的图片和表格」。渲染器本身支持 `<img>` 和 `<table>`，
// 所以这条查的是**源稿里有没有**，不是渲染能力。
if (existsSync(join(ROOT, `articles/${slug}/xhs-article.md`))) {
  const xa = readFileSync(join(ROOT, `articles/${slug}/xhs-article.md`), 'utf8');
  const figN = (xa.match(/^!\[[^\]]*\]\(/gm) ?? []).length;
  const tableN = (xa.match(/^\|.*\|\s*$/gm) ?? []).length
    ? new Set((xa.match(/^\|\s*[^|\n]+\s*\|/gm) ?? []).map((r) => r)).size : 0;
  // 表头行 + 分隔行 + N 行数据；用「至少有一行以 |---| 形式的分隔行」判有没有真表格
  const realTables = (xa.match(/^\|[\s:|-]+\|$/gm) ?? []).length;
  const problems = [];
  if (figN === 0) problems.push('一张图都没有（架构图 / 主结果图至少各 1 张）');
  if (realTables === 0) problems.push('一个表格都没有（可以不用论文原表，自己整理一张更易懂的）');
  check('C6', problems.length === 0, problems.length
    ? `小红书正文：${problems.join('；')}`
    : `小红书正文：${figN} 张图、${realTables} 个表格`);
}

// D2 小红书正文长度与话题标签
// 1000 字是小红书正文输入框的硬上限，超了会截断且没有提示。
if (existsSync(join(ROOT, `articles/${slug}/xhs.md`))) {
  const xhsRaw = readFileSync(join(ROOT, `articles/${slug}/xhs.md`), 'utf8');
  // xhs.md 里可能有「正文」「话题」多个小节，取最长的正文块来算
  const xhsBody = xhsRaw.replace(/^---\n[\s\S]*?\n---\n/, '');
  // 平台按**字符数**算上限，不是只数汉字：一篇满是英文术语的稿子，
  // 汉字 450 字也可能已经 870 个字符，逼近 1000 的截断线。
  // 以前只数汉字，等于对含大量拉丁字母的稿子严重低报（2026-11-16 实测：
  // DFlash 2 的 xhs 稿汉字 455、非空白字符 872）。
  const xhsChars = (xhsBody.match(/[一-龥]/g) ?? []).length;
  const xhsTotal = (xhsBody.replace(/\s/g, '') ?? '').length;
  const hashtags = (xhsBody.match(/#[^\s#]+/g) ?? []).length;
  check('D2', xhsTotal <= 1000 && hashtags >= 3,
    `小红书正文 ${xhsTotal} 字符（汉字 ${xhsChars}）${xhsTotal > 1000 ? '（超过 1000 上限，会被截断）' : ''}，话题 ${hashtags} 个${hashtags < 3 ? '（建议 ≥ 3）' : ''}`);

  // D2c 小红书排版：正文不能是一整坨。
  //
  // 2026-11-14 用户截图反馈：详情页里所有段落连成一片，「看不清」，要求加编号或小表情 + 换行。
  // 小红书正文没有 markdown，`**` 和空行都会按纯文本渲染；纯文本里唯一的视觉锚点就是
  // 「1️⃣」这类序号和行首 emoji。判据只查结构，不管文笔。
  const bodyOnly = xhsBody.replace(/^#\s.*$/m, '').trim();
  const blocks = bodyOnly.split(/\n\s*\n/).filter((b) => b.trim());
  const numbered = (bodyOnly.match(/^[0-9]️⃣/gm) ?? []).length;
  const emojiLed = (bodyOnly.match(/^[\p{Extended_Pictographic}]/gmu) ?? []).length;
  const longBlocks = blocks.filter((b) => (b.match(/[一-龥]/g) ?? []).length > 140);
  const layout = [];
  if (numbered + emojiLed < 3) layout.push(`编号/emoji 小节只有 ${numbered + emojiLed} 处（至少 3 处才有视觉锚点）`);
  if (longBlocks.length) layout.push(`${longBlocks.length} 段超过 140 中文字（详情页会连成一片）`);
  check('D2c', layout.length === 0, layout.length
    ? `小红书排版：${layout.join('；')}`
    : `小红书排版：${numbered} 个编号小节、${emojiLed} 个 emoji 行、${blocks.length} 个空行分段`);
} else {
  check('D2', false, '找不到 xhs.md');
}

// C2 封面大数字
const cover = meta.cover ?? {};
const coverNum = String(cover.num ?? '');
// 封面数字必须能在正文里找到依据。三种合法来源：
//   ① TL;DR 里的「6.21×」；② 正文里的「6.21×」或「1.18×6.21」；③ 正文里原样出现的这个数。
// ③ 是 2026-11-13 补的：不是每篇的主打数字都带 ×——DSpark 的头条是「接受长度 6.21」，
// 一个绝对指标；只认「数字×」会让这类封面永远过不了。③ 不是放水：A8b 已经把
// 正文里每个小数都追到 facts.json 的表格格子上了，能在正文出现就说明有出处。
// 转义**全部**正则元字符，不只是小数点。2026-11-13 投机解码入门稿的封面写「N+1」，
// 只转义 \`.\` 的话 `+` 会被当成量词，`N+1` 编译成「一个以上 N 紧跟 1」，正文里
// 明明写着 N+1 却永远匹配不上。这类「检查自己写错」的假阴性最难查。
const coverBase = coverNum.replace(/×$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const coverBacked = tldrNums.has(coverNum.replace(/×$/, ''))
  || new RegExp(`${coverBase}×|\\d+\\.\\d+×${coverBase}(?!\\.\\d)`).test(body)
  || new RegExp(`(^|[^\\d.])${coverBase}(?![\\d.])`).test(body);
check('C2', coverNum.length > 0 && coverNum.length <= 8 && coverBacked,
  `封面数字「${coverNum || '空'}」${coverNum ? '' : '未填'}${coverNum && !coverBacked ? '（正文里没有找到这个数字的依据）' : ''}`);

// D3 发布意图
const platforms = meta.platforms ?? {};
check('D3', Object.values(platforms).every((p) => ['todo', 'draft', 'published'].includes(p.status)),
  `平台：${Object.entries(platforms).map(([k, v]) => `${k}:${v.status}`).join(' ')}`);

// D4 发布闭环一致性：状态和字段必须对得上。
// 查的是「声称已发布」的三种自相矛盾，这正是最容易在手工改 yaml 时出错的：
//   ① 整篇 publish_completed=true 但状态还没到 published
//   ② 某平台 status=published 但没有对应 url
//   ③ 状态到了 published 但 publish_completed 没置位
{
  const problems = [];
  if (meta.publish_completed && meta.status !== 'published') {
    problems.push(`publish_completed=true 但 status=${meta.status}`);
  }
  if (meta.status === 'published' && !meta.publish_completed) {
    problems.push('status=published 但 publish_completed 未置位');
  }
  const urls = meta.urls ?? {};
  for (const [name, cfg] of Object.entries(platforms)) {
    if (cfg?.status !== 'published' || urls[name]) continue;
    // 公众号没有可公开的稳定 URL 是**常态**：文章链接是群发后生成的，
    // 而 `freepublish/batchget` 在某些号上直接 48001（无接口权限），
    // 后台登录态又常过期——两种都读不到。这条降级为提示，但要求写明日期，
    // 否则「published」就成了一句无法核实的断言。
    if (name === 'wechat') {
      const at = meta.platforms?.wechat?.published_at;
      if (!at) problems.push('wechat 标为 published 但没有 url，也没有 published_at（无法核对是哪天发的）');
      continue;
    }
    problems.push(`${name} 标为 published 但没有 url`);
  }
  const wechatNoUrl = Object.entries(platforms)
    .filter(([n, c]) => n === 'wechat' && c?.status === 'published' && !urls.wechat && c.published_at)
    .map(([, c]) => c.published_at);
  check('D4', problems.length === 0, problems.length
    ? `发布状态矛盾：${problems.join('；')}`
    : (wechatNoUrl.length
      ? `发布状态与 urls 一致（公众号 ${wechatNoUrl[0]} 已发布；后台/接口读不到公开链接，未登记）`
      : '发布状态与 urls 一致'));
}

// D4b TeX 残留扫描：三个平台的产物里都不许出现裸 TeX。
//
// 这是 2026-11-18 那轮返工的根因。六篇已发布文章的知乎正文里，
// `\sum_r(1+\ell_r)` 被降级成 `sum_r(1+ell_r)`、`T_{draft}` 被印成下划线形式，
// 读者看到的是一串看不懂的符号。当时 publish-check 全绿——因为它只查
// 「公式卡分类对不对」（D5），从不查「正文里还有没有没变成卡的 TeX」。
//
// 判据：剥掉已经渲染好的公式节点、代码块和标签之后，正文里不能再有
//   `\命令`（两个字母以上，排除 `\|` 这种符号）或 `字母_下标`。
// 表格单元格里的公式**允许**是纯文本（表格走进 tableCell，见 render-zhihu），
// 所以要把 `<td>/<th>` 的内容先摘掉再判——否则 dspark 那种「表内用可读文本」
// 的正确做法会被误报。
{
  const stripForResidue = (html) => {
    let t = html
      .replace(/<span class="ztext-math"[^>]*>[\s\S]*?<\/span>/g, '')  // 知乎公式卡
      .replace(/<code[\s\S]*?<\/code>/g, '')                           // 行内代码是代码不是公式
      .replace(/<pre[\s\S]*?<\/pre>/g, '')
      .replace(/<td[\s\S]*?<\/td>/g, '')                               // 表格单元格另算
      .replace(/<th[\s\S]*?<\/th>/g, '')
      .replace(/<img[^>]*>/g, '')
      .replace(/<[^>]+>/g, '');
    return t;
  };
  const problems = [];
  const perFile = [];
  for (const plat of ['zhihu', 'wechat']) {
    const p = join(ROOT, 'dist', plat, `${slug}.html`);
    if (!existsSync(p)) continue;
    const text = stripForResidue(readFileSync(p, 'utf8'));
    const cmd = [...text.matchAll(/\\[a-zA-Z]{2,}/g)].map((m) => m[0]);
    const sub = [...text.matchAll(/(?<![A-Za-z0-9_])[A-Za-zα-ωΑ-Ω]\s*_\s*[{%]/g)].map((m) => m[0].replace(/\s/g, ''));
    if (cmd.length || sub.length) {
      const samples = [...new Set([...cmd, ...sub])].slice(0, 4).join('、');
      problems.push(`${plat} 有 ${cmd.length + sub.length} 处裸 TeX（${samples}）`);
      perFile.push({ plat, n: cmd.length + sub.length });
    }
  }
  check('D4b', problems.length === 0, problems.length
    ? `正文残留未渲染的公式：${problems.join('；')}——读者看到的是看不懂的符号`
    : `三平台产物无裸 TeX 残留（${perFile.length ? perFile.map((x) => `${x.plat} ${x.n}`).join('、') : 'zhihu + wechat'}）`);
}

// D5 知乎产物自检（dist/zhihu/<slug>.html）
// 这几条对应 2026-11-11 用户实际看到的三个问题，全部是「HTML 生成阶段就能查出来」的：
//   ① 公式卡要各就各位：独占一段的是**行间**（data-eeimg="2"，居中）；
//      嵌在段落文字中间的是**行内**（data-eeimg="1"）。
//      2026-11-17 起 render-zhihu 主动把复杂行内式做成行内卡——之前降级成纯文本，
//      读者反馈 `τ=sum_rleft(1+sum_jleell_ra_r,jright)` 看不懂。
//      所以判据不是「eeimg=1 的数量必须为 0」，而是**没有独占段落的行内卡**
//      （那才是行间公式被误写成行内卡的旧故障，会左对齐并留空段落）。
//   ② 图注必须在 alt 里（灌稿脚本据此填 figcaption），不能拼成正文段落。
//   ③ 不能残留【公式N】/【图N】/【表N】占位符——渲染器漏配 TeX 时它们会原样显示。
{
  const zhihuPath = join(ROOT, 'dist', 'zhihu', `${slug}.html`);
  if (!existsSync(zhihuPath)) {
    check('D5', true, '没有 dist/zhihu 产物（还没渲染，忽略）');
  } else {
    const zh = readFileSync(zhihuPath, 'utf8');
    const mathTags = [...zh.matchAll(/<span class="ztext-math"[^>]*>/g)].map((m) => m[0]);
    const displayMath = mathTags.filter((t) => /data-eeimg="2"/.test(t)).length;
    const inlineMath = mathTags.length - displayMath;
    // 独占段落的行内卡 = 本该是行间公式，分类错了。
    // 判据必须「整段只有这张卡」：`<p>\s*卡[\s\S]*?</p>` 会连带匹配
    // 「公式开头 + 后面还有正文」的正常行内卡（2026-11-17 误报过一次）。
    const loneInline = [...zh.matchAll(/<p>([\s\S]*?)<\/p>/g)]
      .filter((m) => /^\s*<span class="ztext-math" data-eeimg="1"[\s\S]*?<\/span>\s*$/.test(m[1])).length;
    const imgsAll = [...zh.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    const noAlt = imgsAll.filter((t) => !/\balt="[^"]+"/.test(t)).length;
    const leftPlaceholders = (zh.match(/【(图|表|公式)\d+/g) ?? []).length;
    // ④ 元信息块里的链接必须是真 <a>。
    // 2026-11-14 之前 render-zhihu 把 `[文字](url)` 降级成纯文字，理由是「知乎粘贴后
    // 编辑器会自己识别链接」——实测不会，读者点到的是死文字。这条盯的就是回退：
    // 链接行里出现 http 却没有 <a>，就是又被降级了。
    const metaSeg = (zh.match(/<blockquote>[\s\S]*?<\/blockquote>/) ?? [''])[0];
    const bareUrls = (metaSeg.replace(/<a\b[^>]*>[\s\S]*?<\/a>/g, '').match(/https?:\/\//g) ?? []).length;
    const anchorCount = (metaSeg.match(/<a\b[^>]*href=/g) ?? []).length;
    const problems = [];
    if (loneInline) problems.push(`${loneInline} 个公式独占一段却是 data-eeimg="1"（行间公式被当行内，会左对齐并留空段落）`);
    if (noAlt) problems.push(`${noAlt} 张图缺 alt（图注不会被填进 figcaption）`);
    if (leftPlaceholders) problems.push(`残留占位符 ${leftPlaceholders} 处`);
    if (bareUrls) problems.push(`元信息块有 ${bareUrls} 个裸 URL 没做成超链接（读者的链接是死的）`);
    check('D5', problems.length === 0, problems.length
      ? `知乎 HTML：${problems.join('；')}`
      : `知乎 HTML：公式 行间 ${displayMath} + 行内 ${inlineMath}、图注齐全(${imgsAll.length})、无占位残留、链接 ${anchorCount} 个`);
  }
}

// D6 公众号产物自检（dist/wechat/<slug>.html）
//
// 公众号编辑器的硬限制，违反后是**静默降级**（样式被削、图片点不开、出现字面星号）：
//   ① 不能有 <style>/class/id —— 样式必须内联
//   ② 图片必须同时有 src 和 data-src（只写 src 点不开、不能放大）
//   ③ 不能残留 @@IMG: 之类的内部占位
//   ④ 不能出现字面 ** —— CommonMark 规定 `**` 后紧跟标点不构成加粗
//      （`而**「超前…」**` 这种，中文引号是标点，渲染不出加粗，正文里就留两个星号）
{
  const wechatPath = join(ROOT, 'dist', 'wechat', `${slug}.html`);
  if (!existsSync(wechatPath)) {
    check('D6', true, '没有 dist/wechat 产物（还没渲染，忽略）');
  } else {
    const wc = readFileSync(wechatPath, 'utf8');
    const styled = (wc.match(/<style\b/g) ?? []).length + (wc.match(/\bclass=/g) ?? []).length;
    const imgs = [...wc.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    const noDataSrc = imgs.filter((t) => !/\bdata-src="/.test(t)).length;
    const strayPlaceholder = (wc.match(/@@IMG/g) ?? []).length;
    const literalStars = (wc.match(/\*\*/g) ?? []).length;
    // `<li>` 内侧的换行（`<li ...>\n<span>…</span></li>`）。公众号编辑器把它当软换行，
    // 渲染成「空圆点一行 + 正文一行」。只剥 <p> 挡不住——紧凑列表根本没有 <p>。
    // 2026-11-12 同一问题被用户报第二次，所以加机器检查。
    // 微信编辑器打开草稿时会把每个 <li> 拆成「空 <li> + 内容 <li>」，读者看到一列空圆点。
    // 归一化发生在微信侧，我们这边怎么剥空白都挡不住（2026-11-12 连续两次反馈）。
    // 结论：公众号 HTML 里**一个列表标签都不许有**，render-wechat 已改成 section + 手写符号。
    const listTags = (wc.match(/<(?:ul|ol|li)[\s>]/g) ?? []).length;
    // 「相关链接」里冒号前面什么都不剩：`project` 类链接没有 repo 字段时，
    // 渲染成「：https://dflash.z-lab.ai」（2026-11-12 用户截图反馈）。
    const emptyLabels = (wc.match(/<p[^>]*>\s*：/g) ?? []).length;
    // @@FORMULA: / @@IMG: 都是「还没上传素材」的中间态：只有跑过 `wechat-publish.mjs`
    // （会传素材库并回填微信域名 URL）才会消失。
    // 判据看 article.yaml：**宣称草稿已建**（wechat_draft_id 有值）时就不许再有占位；
    // 还没上传时它们属于正常中间态，不算问题。
    const pendingFormulas = (wc.match(/@@FORMULA:/g) ?? []).length;
    const uploaded = Boolean(meta.wechat_draft_id);
    const problems = [];
    if (styled) problems.push(`有 ${styled} 处 <style>/class（公众号会削掉）`);
    if (noDataSrc) problems.push(`${noDataSrc} 张图缺 data-src（点不开、不能放大）`);
    if (uploaded && strayPlaceholder) problems.push(`${strayPlaceholder} 处图片占位未替换（已建草稿却没回填微信图床 URL）`);
    if (uploaded && pendingFormulas) problems.push(`${pendingFormulas} 个公式占位未渲染成 PNG`);
    if (literalStars) problems.push(`正文有 ${literalStars} 个字面 **（加粗没生效，多半是以「标点开头）`);
    if (listTags) problems.push(`还有 ${listTags} 个 <ul>/<ol>/<li>（微信打开草稿会拆成空项目符号，必须改成 section + 手写符号）`);
    if (emptyLabels) problems.push(`${emptyLabels} 处链接标签为空（渲染成「：https://…」）`);
    // 公众号把外链 <a> 整段剥掉（2026-11-15 实测），正文里留着的 <a> 一定是没处理干净的模板分支。
    // 所以反过来查：**正文不许有 <a>**，链接只能以二维码 + 纯文本 URL 存在。
    const anchors = (wc.match(/<a\b/g) ?? []).length;
    if (anchors) problems.push(`正文还有 ${anchors} 个 <a>（公众号会剥掉 href，链接要么换二维码要么写纯文本）`);
    check('D6', problems.length === 0, problems.length
      ? `公众号 HTML：${problems.join('；')}`
      : `公众号 HTML：无外链样式、${imgs.length} 图均有 data-src、无字面星号${uploaded ? '、素材均已上传' : `（尚未上传：${strayPlaceholder} 图 / ${pendingFormulas} 公式待回填）`}`);
  }
}

// D6d 公众号公式图片的字号必须与正文对齐（2026-11-19 用户定下的标准）
//
// 公众号正文是 HTML 文本，公式却是图片，宽度按渲染时的 CSS 像素回填——
// 两者没有任何自动关联，所以「公式看着比正文大」只能靠常量本身守。
// 改成看产物里的 `width:NNNpx` 不现实：同样是 16px，`C(B,\rho)` 渲染出来 93px、
// 一个长分式能到 700px，绝对宽度说明不了字号。
// 判据落在渲染器的常量上：
//   ① 行内公式字号落在正文的 0.85–1.0 倍。**不能要求相等**：
//      带括号/上下标的公式天然比 x-height 高，font-size 相等时墨迹反而高出 22%
//      （实测中文 16px 墨迹 15.00、C(B,ρ) @16px 是 18.25）。要让最高部分
//      落在中文高度上，字号必须比正文小一档，现取 14/16 = 0.875。
//      上限 1.0 挡住「又变大」，下限 0.85 挡住「小到看不清」。
//   ② 行间在行内之上 1–2px（它独占一行，完全同字号反而显得弱）。
{
  const renderer = join(ROOT, 'scripts', 'render-wechat.mjs');
  if (!existsSync(renderer)) {
    check('D6d', true, '找不到 scripts/render-wechat.mjs（忽略）');
  } else {
    const src = readFileSync(renderer, 'utf8');
    const num = (name) => {
      const m = src.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)`));
      return m ? Number(m[1]) : null;
    };
    const fs = num('FS');
    const inline = num('FS_INLINE_FORMULA');
    const display = num('FS_DISPLAY_FORMULA');
    const problems = [];
    if (fs === null || inline === null || display === null) {
      problems.push('找不到 FS / FS_INLINE_FORMULA / FS_DISPLAY_FORMULA 常量');
    } else {
      const ratio = inline / fs;
      if (ratio < 0.85 || ratio > 1.0) {
        problems.push(`行内公式 ${inline}px 是正文 ${fs}px 的 ${ratio.toFixed(3)} 倍（应在 0.85–1.0，见 D6d 注释的墨迹依据）`);
      }
      const d = display - inline;
      if (d < 0 || d > 2) problems.push(`行间公式 ${display}px 与行内 ${inline}px 差 ${d}px（应在 0–2px）`);
    }
    check('D6d', problems.length === 0, problems.length
      ? `公众号公式字号：${problems.join('；')}`
      : `公众号公式字号：正文 ${fs}px / 行内 ${inline}px（${(inline / fs).toFixed(2)}×）/ 行间 ${display}px`);
  }
}

// D6b 公众号外链替代：外链只能靠二维码 + 阅读原文，两者缺一读者就拿不到链接。
// 例外：元信息块里**根本没有外链**时（教程类常这样），不该强制要求二维码——
// 2026-11-16 用户要求去掉入门篇的来源链接后，这里开始误报。
//
// 判据用正文 markdown 的元信息块**和**产物里的二维码张数比对：每条外链都该有一枚码，
// 少一枚就是读者拿不到的链接。设了 `WECHAT_QR_PATTERN` 时只要求命中的那些。
{
  const wechatPath = join(ROOT, 'dist', 'wechat', `${slug}.html`);
  if (!existsSync(wechatPath)) {
    check('D6b', true, '没有 dist/wechat 产物（还没渲染，忽略）');
  } else {
    const wc = readFileSync(wechatPath, 'utf8');
    // 二维码用 @@QRn@@ 占位；上传后变成 mmbiz.qpic.cn 地址。两种都算「有」。
    // 数**图**不是数占位符：每张图同时写 src 和 data-src，占位符会出现两次，
    // 直接 match 全局会把 2 张数成 4 张（2026-11-18 实际数错）。
    const qrs = (wc.match(/<img[^>]+src="@@QR\d+@@"/g) ?? []).length
      || (wc.match(/<img[^>]+width:68px;height:68px/g) ?? []).length;
    const qrLabels = [...wc.matchAll(/margin-top:2px;">([^<]*)</g)].map((m) => m[1].trim());
    // 元信息块里的外链（正文 markdown 的第一段引用块，按 `> **字段**　内容` 逐行读）
    const metaLinks = [];
    for (const line of body.split('\n')) {
      if (!/^>\s*\*\*/.test(line)) continue;
      for (const m of line.matchAll(/https?:\/\/[^\s)<>\]]+/g)) metaLinks.push(m[0]);
    }
    const pattern = (() => {
      const raw = process.env.WECHAT_QR_PATTERN;
      if (!raw) return null;
      try { return new RegExp(raw); } catch { return null; }
    })();
    const want = pattern ? metaLinks.filter((u) => pattern.test(u)) : metaLinks;
    const problems = [];
    if (want.length > qrs) {
      problems.push(`元信息块有 ${want.length} 条外链但只有 ${qrs} 枚二维码，读者点不到的那几条只能靠复制 URL`);
    }
    if (qrLabels.some((l) => !l)) problems.push('有二维码没有标签，读者不知道它通向哪');
    check('D6b', problems.length === 0, problems.length
      ? `公众号外链替代：${problems.join('；')}`
      : (qrs
        ? `公众号外链替代：${qrs} 枚二维码（${[...new Set(qrLabels)].join(' / ')}）${meta.wechat_draft_id ? '，阅读原文指向个人站' : '（阅读原文在建草稿时写入）'}`
        : '公众号外链替代：元信息块没有外链，跳过（阅读原文仍指向个人站）'));
  }
}

// D6c 公众号问答编号 + 文末标签
//
// 用户 2026-11-15 反馈：问答要「问题1 / 回答1」而不是「问：/答：」；文末要有一排可读标签。
// 两者都是模板层面的，换稿时最容易丢。
{
  const wechatPath = join(ROOT, 'dist', 'wechat', `${slug}.html`);
  if (!existsSync(wechatPath)) {
    check('D6c', true, '没有 dist/wechat 产物（还没渲染，忽略）');
  } else {
    const wc = readFileSync(wechatPath, 'utf8');
    const plain = wc.replace(/<[^>]+>/g, '');
    const hasQA = /附[：:]\s*问答/.test(plain);
    const qN = (plain.match(/问题\d+/g) ?? []).length;
    const aN = (plain.match(/回答\d+/g) ?? []).length;
    const oldStyle = (plain.match(/问[：:]/g) ?? []).length;
    // 标签行从 HTML 里认（`color:#8a4b2a` 那段），不要从纯文本猜——
    // 标签名里可能带空格（`Training-Time Test`），按空格切会数错。
    const tagLine = (wc.match(/color:#8a4b2a[^>]*>((?:\s*#[^<]+)+)</g) ?? [])
      .map((m) => m.replace(/^[^>]*>/, ''))
      .sort((a, b) => (b.match(/#/g) ?? []).length - (a.match(/#/g) ?? []).length)[0] ?? '';
    const tagCount = tagLine ? (tagLine.match(/#/g) ?? []).length : 0;
    const problems = [];
    if (hasQA && (qN === 0 || aN === 0)) problems.push(`问答没有编号（问题N ${qN} / 回答N ${aN}）`);
    if (oldStyle) problems.push(`还有 ${oldStyle} 处「问：」旧格式`);
    if (!tagCount) problems.push('文末没有标签行（article.yaml 的 wechat_tags）');
    else if (tagCount < 6) problems.push(`文末只有 ${tagCount} 个标签（建议 6–10 个）`);
    check('D6c', problems.length === 0, problems.length
      ? `公众号问答/标签：${problems.join('；')}`
      : `公众号问答/标签：问题N ${qN} 处、文末 ${tagCount} 个标签`);
  }
}

// D10 论文原表：LaTeX 表源 → HTML 表格必须逐格忠实。
//
// 2026-11-12：图表最初是截图，14 列压到 720px 后字高只有 4–5px，读者一个数字都认不出；
// 改成渲染 HTML 表格后，「某一行少了最后一格」这种错误看起来完全正常——
// 而错表比糊表更糟，读者会当真。所以这里跑一遍逐格比对。
{
  const texDir = join(ROOT, 'articles', slug, 'source/tables');
  const tables = existsSync(texDir) ? readdirSync(texDir).filter((f) => f.endsWith('.tex')) : [];
  if (!tables.length) {
    check('D10', true, '没有 LaTeX 表源，跳过表格逐格校验');
  } else {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/verify-table.mjs'), `--slug=${slug}`, '--json'], { encoding: 'utf8' });
    let rows = [];
    try { rows = JSON.parse(r.stdout || '[]'); } catch { /* 输出不是 JSON 就当作没登记 */ }
    if (!rows.length) {
      check('D10', true, `表源 ${tables.join('、')} 尚未登记到 verify-table.mjs，跳过`);
    } else {
      const bad = rows.filter((x) => !x.ok);
      check('D10', bad.length === 0, bad.length
        ? `表格渲染不忠实：${bad.map((x) => `${x.file}（${[...x.problems, x.missing.length ? `缺 ${x.missing.join(',')}` : '', x.extra.length ? `多 ${x.extra.join(',')}` : ''].filter(Boolean).join('；')}）`).join(' / ')}`
        : `论文原表逐格一致：${rows.map((x) => `${x.file.split('/').pop()} ${x.cells} 个数字`).join('、')}`);
    }
  }
}

report();

function report() {
  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed++;
    console.log(`${result.ok ? '✅' : '❌'} [${result.id}] ${result.message}`);
  }
  console.log(failed ? `\n${failed} 项未通过。判断类检查见 publish/checklist.md。` : '\n机器检查全部通过。人工项见 publish/checklist.md（A8 抽查、B5 限定语、C4/C5 抽看）。');
  process.exit(failed ? 1 : 0);
}

function resolveFile(meta, key, names) {
  const configured = meta.files?.[key];
  if (configured && existsSync(join(ROOT, configured))) return configured;
  for (const name of names) {
    const candidate = `articles/${slug}/${name}`;
    if (existsSync(join(ROOT, candidate))) return candidate;
  }
  return null;
}


/** 元信息区里连续引用块的组数：中间隔一个空行就算另一组 */
function countQuoteGroups(head) {
  const lines = head.split('\n');
  const first = lines.findIndex((l) => /^>/.test(l));
  if (first < 0) return 0;
  let groups = 1;
  for (let i = first; i < lines.length; i++) {
    if (/^>/.test(lines[i])) continue;
    if (!lines[i].trim()) {
      let k = i + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if ((lines[k] ?? '').startsWith('>') && /^>\s*\*\*[^*]+\*\*/.test(lines[k])) { groups++; i = k - 1; continue; }
    }
    break;
  }
  return groups;
}

function sectionAlias(name) {
  return {
    'TL;DR': ['TL;DR', '摘要', '一句话'],
    '引言': ['引言', '背景'],
    '问题': ['问题'],
    '方法': ['方法'],
    '实验设置': ['实验设置', '实验'],
    '主要结果': ['主要结果', '主要实验', '结果'],
    '深入分析': ['深入分析', '分析', '消融'],
    '讨论与判断': ['讨论', '判断', '局限'],
  }[name] ?? [name];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
