/**
 * 数字校验：正文里出现的每个小数，必须能在 facts.json 里找到出处。
 *
 *   node scripts/verify-numbers.mjs --slug=dspine [--article=articles/dspine/article.md] [--json]
 *
 * 退出码：0 全部有据可查；1 有对不上的（可用 --allow-unverified 降级为提示）。
 *
 * 为什么这件事必须机器做：
 *   用户反馈过两类真实事故——把 GSM8K 位置 8 的单点值 `31.8` 当成三位置均值写进 7 处；
 *   把采样时对 DSpark 的领先 `12.8%` 误当成「DSpark 比 DFlash2 高」。
 *   两者都语法正确、语义错误，任何「数加粗、数表格」的检查都发现不了。
 *   唯一可行的办法是建立「数字 → 表/行/列」的对照表（facts.json），逐个比对。
 *
 * 判定口径：
 *   - facts 里有的值 → 通过（并报出它属于哪张表的哪一格）
 *   - 正文里带 % / × 的派生值 → 通过，但要求「分子分母至少一方在 facts 里」
 *     （加速比、提升幅度本来就是算出来的，不可能是表里的原始数）
 *   - 其余 → 报「无出处」，逐条列出
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/verify-numbers.mjs --slug=<slug> [--article=path] [--json] [--allow-unverified]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const factsPath = join(dir, 'facts.json');

if (!existsSync(factsPath)) {
  console.error(`✗ 没有 articles/${slug}/facts.json`);
  console.error('  先跑 `npm run facts -- --slug=' + slug + ' --src=<LaTeX 源目录> --write`');
  process.exit(1);
}

const facts = JSON.parse(readFileSync(factsPath, 'utf8'));

// 正文来源：优先 --article，否则 article.yaml 的 files.article
const metaPath = join(dir, 'article.yaml');
const meta = existsSync(metaPath) ? parseArticle(readFileSync(metaPath, 'utf8')).data : {};
const articlePath = args.article
  ? String(args.article)
  : meta.files?.article || `articles/${slug}/article.md`;
// 绝对路径直接用，相对路径按仓库根解析（--article 常传 /tmp/xxx.md）
const full = isAbsolute(articlePath) ? articlePath : join(ROOT, articlePath);
if (!existsSync(full)) {
  console.error(`✗ 找不到正文：${articlePath}`);
  process.exit(1);
}
const body = readFileSync(full, 'utf8');

// ---- 建立索引 ----
/** 值 → 出处列表（表格事实 + 正文数字） */
const byValue = new Map();
/** 表 id → 该表的事实列表（算差值时只在同表内找） */
const byTable = new Map();
const index = (key, entry) => {
  const k = String(key).replace(/^[+−-]/, '');
  if (!byValue.has(k)) byValue.set(k, []);
  byValue.get(k).push(entry);
};
for (const f of facts.facts) {
  for (const part of f.parts) index(part, { kind: 'table', ...f });
  if (!byTable.has(f.table)) byTable.set(f.table, []);
  byTable.get(f.table).push(f);
}
// 论文正文里的数字也算有出处——写稿引用「补回 14.8 个点」是对的，
// 只是它的来源不在表里。不索引它们会产生大量误报。
for (const n of facts.text_numbers ?? []) {
  index(n.value, { kind: 'text', ...n });
}
/** 所有数字（含双值拆分），用于判断「分子分母是否在表里」 */
const allNumbers = new Set([...byValue.keys()]);
const numericValue = (s) => Number(String(s).replace(/[^\d.]/g, '')) || 0;

/**
 * 找一对「相减正好等于 target」的表格数字。
 *
 * @param context 目标数字附近的正文片段。**两个操作数必须都出现在这段文字里**——
 *   这是防假阴性的关键。早先版本只在同表里两两找组合，于是任何一篇文章
 *   只要有张大表，几乎任意小数都能被凑成某两格的差，校验等于失效
 *   （EAGLE 上实测：`2.63`/`1.74`/`0.93` 这些第三方数字全部被误放行）。
 */
function findDifference(target, decimals, context = '') {
  if (!(target > 0)) return null;
  const eps = 0.5 * 10 ** -decimals + 1e-9;
  const inContext = (p) => context.includes(String(p));
  for (const [tableId, entries] of byTable) {
    const nums = [];
    for (const e of entries) {
      for (const p of e.parts ?? []) {
        const v = numericValue(p);
        if (v && inContext(p)) nums.push({ v, p });
      }
    }
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        if (Math.abs(Math.abs(nums[i].v - nums[j].v) - target) <= eps) {
          return { a: nums[i].p, b: nums[j].p, table: tableId };
        }
      }
    }
  }
  return null;
}

// ---- 扫描正文 ----
// 只要小数（x.x / x.xx）；整数（5 个 baseline、3 个表）属于常识计数，不查。
// 排除四类噪声——它们看起来像数字，但不是「结论数字」：
//   ① 标题（`### 1.1 投机解码的演进`：1.1 是小节编号）
//   ② 正文里的章节引用（`见 5.2`、`（6.2）`）
//   ③ arXiv ID、版本号、URL 路径
//   ④ 代码块 / 公式 / 表格
// 不排除的话，一篇 7000 字稿子能扫出上百个「无出处数字」，全是章号，人根本看不过来。
// 章节编号：从 markdown 标题里收（`### 3.1 xxx`），正文里这些数字是交叉引用不是结论。
const sectionNumbers = new Set([...body.matchAll(/^#{2,6}\s+(\d+(?:\.\d+)+)\s/gm)].map((m) => m[1]));

const stripped = body
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/\$\$[\s\S]*?\$\$/g, ' ')
  .replace(/\$[^$\n]+\$/g, ' ')
  .replace(/^\|.*\|$/gm, ' ')             // 表格行
  .replace(/^#{1,6}.*$/gm, ' ')           // 标题行
  .replace(/arxiv:\s*\d{4}\.\d{4,5}(v\d+)?/gi, ' ')
  .replace(/https?:\/\/\S+/g, ' ')
  .replace(/见\s*\d+(\.\d+)*/g, ' ')       // 「见 5.2」
  .replace(/[（(]\s*\d+\.\d+\s*[)）]/g, ' ') // 「（6.2）」
  .replace(/第\s*\d+\.\d+\s*[节小节]/g, ' ') // 「第 5.2 节」
  // 「因为 3.1 的设计」「这正是 2.2 的时机」——数字后直接跟「的」的，基本是章节引用。
  // 带单位的数（10.0% 的提升）不会命中，因为 % 夹在中间。
  .replace(/(?<![\d.])\d+\.\d+\s*的/g, ' ');

const occurrences = [];
// 前面不能紧挨字母/数字/点：排除 `Qwen3.5`、`SM90.0` 这类模型名里的版本号。
for (const m of stripped.matchAll(/(?<![A-Za-z\d.])(\d+\.\d+)\s*(%|×|x\b|ms|个点|个百分点)?/g)) {
  // 无单位的、且恰好是某节编号 → 交叉引用（「3.1 把预测特征…」这种没有「的」也拦得到）
  if (!m[2] && sectionNumbers.has(m[1])) continue;
  occurrences.push({ value: m[1], unit: m[2] ?? '', index: m.index, raw: m[0] });
}

const verified = [];
const rounded = [];
const derived = [];
const unverified = [];

/** 按出现的精度做舍入比对：「14.0」能对上表里的「14.02」。 */
function roundMatches(value) {
  const decimals = (value.split('.')[1] ?? '').length;
  const target = Number(value);
  const out = [];
  for (const [key, entries] of byValue) {
    const v = Number(key);
    if (!Number.isFinite(v)) continue;
    if (Number(v.toFixed(decimals)) === target) out.push(...entries.map((e) => ({ ...e, rawValue: key })));
  }
  return out;
}

for (const occ of occurrences) {
  const hits = byValue.get(occ.value);
  if (hits?.length) {
    verified.push({ ...occ, from: hits[0] });
    continue;
  }
  // 舍入：稿件里写 1 位小数、表里是 2 位，是有意为之的排版选择。
  // 但**不能静默通过**——历史上出过「把 GSM8K 位置 8 的单点值 31.87 舍成 31.8，
  // 当成三位置均值写进 7 处」。所以这里报出来源格子，让人自己确认取的是对的那一格。
  const near = roundMatches(occ.value);
  if (near.length) {
    rounded.push({ ...occ, from: near[0], candidates: near.slice(0, 4) });
    continue;
  }  // 百分点/加速比这类派生值：需要能在 facts 里找到「同一个数量级、数值接近」的原始数，
  // 才认为它是从表里的东西算出来的。
  // 这里要求更严：候选数必须与目标值相差不到 50%，且方向合理（比值类要在 1~5 之间）。
  // 之前用「差值 < 目标值的 60%」太松，几乎任何数都能匹配上，等于没查。
  if (occ.unit === '%' || occ.unit === '×' || occ.unit === 'x') {
    const target = Number(occ.value);
    const near = [...allNumbers].filter((n) => {
      const v = numericValue(n);
      if (!v) return false;
      const ratio = v / target;
      if (occ.unit === '×') return ratio >= 1 && ratio <= 5;          // 加速比的分母
      return Math.abs(v - target) <= Math.max(2, target * 0.5);        // 百分点的基数
    });
    if (near.length) {
      derived.push({ ...occ, basis: near.slice(0, 3) });
      continue;
    }
  }
  // 无单位的差值：「τ 从 4.29 掉到 3.43，跌幅 0.86」里的 0.86 是两个格子的差。
  // 这类数合法且常见，但**必须两个操作数都出现在这个数字附近的正文里**，
  // 否则「表里有任意两个数相减碰巧等于它」就能放行——
  // EAGLE 那篇实测过：只按同表两两组合找，`2.63`/`1.74`/`0.93` 这些
  // 来自 issue 和第三方的数字全被判成「派生值」，等于校验器自己造了假阴性。
  if (!occ.unit) {
    const target = Number(occ.value);
    const decimals = (occ.value.split('.')[1] ?? '').length;
    const found = findDifference(target, decimals, stripped.slice(Math.max(0, occ.index - 160), occ.index + 160));
    if (found) {
      derived.push({ ...occ, basis: [`${found.a} − ${found.b}`] });
      continue;
    }
  }
  unverified.push(occ);
}

const summary = {
  article: articlePath,
  facts: facts.fact_count,
  textNumbers: (facts.text_numbers ?? []).length,
  scanned: occurrences.length,
  verified: verified.length,
  rounded: rounded.length,
  derived: derived.length,
  unverified: unverified.length,
};

if (args.json) {
  console.log(JSON.stringify({ ...summary, roundedDetails: rounded, unverifiedDetails: unverified }, null, 1));
} else {
  console.log(`正文：${articlePath}　对照表：${facts.fact_count} 条表内事实 + ${(facts.text_numbers ?? []).length} 条正文数字`);
  console.log(`扫描到小数 ${occurrences.length} 个：精确命中 ${verified.length}，舍入命中 ${rounded.length}，派生值 ${derived.length}，无出处 ${unverified.length}`);
  if (rounded.length) {
    console.log('\n舍入命中（稿件写得更短，来源如下，确认取的是对的格子）：');
    const seen = new Set();
    for (const r of rounded) {
      if (seen.has(r.value)) continue;
      seen.add(r.value);
      const from = r.candidates.map((c) => c.kind === 'table'
        ? `${c.table} / ${c.group ? c.group + ' / ' : ''}${c.method || '?'} / ${c.column}`
        : `${c.table}（正文）`).join(' ');
      console.log(`  ${r.raw}  ← ${r.from.rawValue}　${from}`);
      if (r.candidates.length > 1) console.log(`      同类候选 ${r.candidates.length} 个，注意别取错格：${r.candidates.map((c) => c.rawValue).join(' / ')}`);
    }
  }
  if (derived.length) {
    console.log('\n派生值（加速比 / 百分比，需人工确认计算过程）：');
    for (const d of derived.slice(0, 15)) console.log(`  ${d.raw}  ← 参考 ${d.basis.join(' / ')}`);
  }
  if (unverified.length) {
    console.log('\n无出处的数字（论文表格和正文里都找不到）：');
    const seen = new Set();
    for (const u of unverified) {
      if (seen.has(u.value)) continue;
      seen.add(u.value);
      const start = Math.max(0, u.index - 40);
      const ctx = stripped.slice(start, u.index + 30).replace(/\s+/g, ' ');
      console.log(`  ${u.raw}  …${ctx}…`);
    }
  }
}

const failed = unverified.length > 0 && !args['allow-unverified'];
if (failed) {
  console.error(`\n✗ ${unverified.length} 个数字在 facts.json 里找不到出处。`);
  console.error('  要么改成本文能证明的数，要么补一张表进 facts.json；');
  console.error('  确实是论文正文里的数（不在表里）就加 --allow-unverified 并人工确认。');
}
process.exit(failed ? 1 : 0);
