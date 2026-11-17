#!/usr/bin/env node
/**
 * 写作简报：把三路调研合并成一份「写稿前必须知道的事」，喂给写稿环节。
 *
 *   node scripts/briefing.mjs --slug=dspine [--paper=/tmp/paper.md]
 *   → articles/<slug>/briefing.md
 *
 * 为什么不直接把 research.md 和 research-platform.md 拼给模型：
 *   两份加起来 1.6 万字，全是原始材料（issue 原文、别人文章开头），信噪比太低。
 *   写稿真正需要的是**三条对照**：
 *     ① 论文说的 vs 外部查到的（冲突点——这是深度解读的价值所在）
 *     ② 别人讲过的 vs 还没人讲的（差异点——决定我们写什么）
 *     ③ 哪些数字必须小心（口径陷阱——最容易写错的地方）
 *
 * 本脚本不调模型，只做结构化提取 + 人工可读的清单。
 *
 * ── 关于「怎么从 research-deep.md 里挑东西」──
 * 早期版本用正则匹配具体句子（`/对真正最强的基线只领先 3\.7%/`），只能命中 DSpine 那一篇。
 * 换一篇论文，全部匹配不上，安静地输出空列表——比报错更糟。
 *
 * 现在改成**约定驱动**：深度调研里凡是「影响写稿判断」的结论，一律写成
 *
 *     > **写稿影响**：仓库那组数据里，对最强基线只领先 3.7%
 *
 * 简报把所有这类行抽出来，组成 ①-a。这样：
 *   - 换论文不用改代码；
 *   - 「哪句话是给写稿看的」由调研者显式标注，不靠猜；
 *   - 标记一条都没有时能直接告警，而不是安静降级。
 * 骨架写法和这个约定的出处见 references/e2e-runbook.md 第 2e 节。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/briefing.mjs --slug=<slug> [--paper=/tmp/paper.md]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);

const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
const article = read('article.md');
const research = read('research.md');
const platform = read('research-platform.md');
const deep = read('research-deep.md');
const yaml = read('article.yaml');
const title = yaml.match(/^title:\s*"?([^"\n]+)"?$/m)?.[1] ?? slug;

/**
 * 从 markdown 里取出某个二级/三级小节的全部正文（到下一个同级或更高级标题为止）。
 * 标题按**关键词**匹配而不是全文精确匹配，这样小节标题可以带编号、可以微调措辞
 * （「## 三、第三方实测：没达到作者自己的验收线」也能命中 `/第三方实测/`）。
 */
function section(md, pattern, level = 3) {
  if (!md) return '';
  const lines = md.split('\n');
  const isHeading = (ln, lv) => new RegExp(`^#{1,${lv}}\\s`).test(ln);
  const start = lines.findIndex((ln) => new RegExp(`^#{1,${level}}\\s`).test(ln) && pattern.test(ln));
  if (start === -1) return '';
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading(lines[i], level)) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/** 把一段 markdown 的主体压成「一句话一条」：去掉空行、表格边框、引用符号。 */
function bullets(md, { max = 6, keepTables = false } = {}) {
  return md.split('\n')
    .map((ln) => ln.trim())
    .filter((ln) => ln && !/^[:\-–—>|\s]+$/.test(ln))
    .filter((ln) => keepTables || !ln.startsWith('|'))
    .slice(0, max);
}

const out = [];
const warn = [];
out.push(`# 写作简报：${title}`, '');
out.push(`> 生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
out.push('> 由 `node scripts/briefing.mjs --slug=' + slug + '` 从 article.md / research*.md 提取。');
out.push('> **这是写稿前读的东西，不是稿子本身。**', '');
out.push('---', '');

// ---------- ① 论文 vs 外部：冲突点 ----------
out.push('## ① 论文说的 vs 外部查到的', '');
out.push('这些是**论文正文不会告诉你、但影响结论可信度**的事。写进「局限」或「实验设置」。', '');

// ①-a 深度调研里「最要紧的结论」
// 只认一个显式约定：`> **写稿影响**：...`。不猜小节标题、不猜句子内容。
// 标记后面可以跟续行（同样以 `>` 开头），拼成一句——长结论一行写不下。
const deepKeyPoints = (() => {
  const lines = deep.split('\n');
  const points = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^\s*>\s*\*\*写稿影响\*\*[：:]\s*(.*)$/);
    if (!head) continue;
    const parts = [head[1].trim()];
    for (let j = i + 1; j < lines.length; j++) {
      const cont = lines[j].match(/^\s*>\s?(.*)$/);
      if (!cont) break;
      const text = cont[1].trim();
      // 遇到空引用行或下一条标记就停
      if (!text || /^\*\*写稿影响\*\*/.test(text)) break;
      parts.push(text);
      i = j;
    }
    points.push(parts.join('').replace(/——$/, '—— '));
  }
  return points;
})();
// 兼容早期写法：小节标题叫「直接影响结论的几件事」时，取它下面的列表项
const deepLegacy = section(deep, /直接影响结论/, 3) || section(deep, /直接影响结论/, 2);
const legacyBullets = deepLegacy ? bullets(deepLegacy, { max: 6 }) : [];

if (!deep) {
  warn.push('没有 research-deep.md：①-a「直接影响结论的几件事」整段缺失。跑了子智能体却没落盘，等于没跑。');
} else if (!deepKeyPoints.length && !legacyBullets.length) {
  warn.push('research-deep.md 里没有 `> **写稿影响**：` 标记，①-a 为空。建议让它按 e2e-runbook 2e 的约定重写。');
}

if (deepKeyPoints.length || legacyBullets.length) {
  out.push('### 直接影响结论的几件事', '');
  for (const k of deepKeyPoints) out.push(`- ${k}`);
  for (const ln of legacyBullets) out.push(ln);
  out.push('');
}

// ①-b 训练配置的口径差异
// research.md 里作者/维护者的回复格式是 `> **名字（身份）**：内容`，按体关键词筛。
const budgetHits = [...research.matchAll(/^\s*> \*\*(.+?)\*\*：(.+)$/gm)]
  .filter(([, who, body]) => /epoch|step|batch|budget|OPB|ShareGPT|learning rate|训练/i.test(`${who} ${body}`));

if (budgetHits.length) {
  out.push('### 训练配置的口径差异', '');
  out.push('论文附录与仓库/issue 的说法可能不一致，**写「实验设置」时要交代**。', '');
  for (const [, who, body] of budgetHits) out.push(`- **${who}**：${body.slice(0, 300)}`);
  out.push('');
}

// ①-c 部署门槛 / 复现问题
// 只取 research.md 里结构化的 issue 列表——深度调研里的部署内容已经由
// `> **写稿影响**` 标记汇总到 ①-a，这里再抓一遍容易把整段代码块拖进来。
const deployIssues = [...research.matchAll(/^- \[#(\d+) (\w+)\] (.+)$/gm)];

if (deployIssues.length) {
  out.push('### 官方仓库的 open issues', '');
  for (const [, n, state, t] of deployIssues) out.push(`- #${n} [${state}] ${t.slice(0, 90)}`);
  out.push('');
}

if (deep) {
  out.push('> 谱系表、论文自身的局限清单、明确查不到的东西，都在 `research-deep.md`。', '');
}

// ---------- ② 别人讲过的 vs 还没人讲的 ----------
out.push('## ② 差异点：别人写过什么', '');
if (platform) {
  const articles = [...platform.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1].trim());
  if (articles.length) {
    out.push(`知乎已有 ${articles.length} 篇同题文章：`, '');
    for (const a of articles) out.push(`- ${a}`);
    out.push('');
    out.push('**核对方式**：把上面标题和你准备用的标题、以及每个 `###` 小节标题比一遍。');
    out.push('雷同的要么换角度，要么写得比它更深（补数字、补推导）。', '');
  } else {
    out.push('- 平台侧没抓到同题文章（可能太新），这意味着标题和角度可以放开写。', '');
  }
  // 小红书是死路，脚本抓不到属于预期。这里显式说明，免得写稿的人
  // 以为「调研覆盖了小红书、没人写过」——那是把抓不到当成了没有。
  const xhsEmpty = /## 小红书[\s\S]{0,400}(抓不到|没抓到|空)/.test(platform);
  if (xhsEmpty) {
    out.push('> **小红书没有参考数据**：脚本抓不到（PC 搜索需要 `xsec_token`，服务端直接返回空壳，');
    out.push('> 换 Scrapling / 换登录态 / 换真浏览器都一样）。**这不代表小红书上没人写过**，');
    out.push('> 只是我们看不到——标题和封面别假定「独家」，要人工刷一遍再定。', '');
  }
} else {
  out.push('- 没跑 `research:platform`，建议补跑一次再定标题。', '');
}

// ---------- ③ 数字口径陷阱 ----------
out.push('## ③ 数字口径陷阱（最容易写错）', '');
out.push('以下是要写进稿子的高频数字，每个都要确认：分子分母是什么、在哪个实验里。', '');

/**
 * 数字来源的优先级：已有稿子 > 论文全文 > 外部调研。
 * 早期版本只读 article.md，而简报是在**写稿前**生成的——首稿时这个表必然是空的，
 * 「31.8 当成均值」那类错就防不住。所以 --paper 传入论文全文时用它兜底。
 */
const paperPath = args.paper ? String(args.paper) : '';
const paper = paperPath && existsSync(paperPath) ? readFileSync(paperPath, 'utf8') : '';
const numberSource = article || paper || research;
const numberSourceName = article ? 'article.md' : paper ? '论文全文（--paper）' : 'research.md';

if (numberSource) {
  const nums = [...numberSource.matchAll(/(\d+\.\d+%|\d+\.\d+×|\b\d+\.\d{1,2}\b)/g)].map((m) => m[1]);
  const freq = new Map();
  for (const n of nums) freq.set(n, (freq.get(n) ?? 0) + 1);
  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    out.push(`> 来源：\`${numberSourceName}\`${!article && paper ? '（首稿阶段，稿子里还没有数字）' : ''}`, '');
    out.push('| 数字 | 出现次数 | 必须核对的点 |', '| --- | --- | --- |');
    for (const [n, c] of top) {
      let check = '确认来源段落';
      if (n.endsWith('%')) check = '**分母是谁**？（对最强基线还是最弱基线；贪婪还是采样）';
      else if (n.endsWith('×')) check = '相对谁的加速比？单点还是平均？';
      else if (/^\d+\.\d{1,2}$/.test(n)) check = '哪个模型/哪个基准？不要跨表混用';
      out.push(`| ${n} | ${c} | ${check} |`);
    }
    out.push('');
  } else {
    out.push('- 抽取的数字源里没有小数数字（稿子还没写，也没传 --paper）。');
    out.push('');
  }
} else {
  out.push('- 没有可用的数字源：`article.md` 还不存在，也没传 `--paper`。', '');
}

// 这条无条件输出：它防的是「机器查不出的语义错误」，首稿阶段最需要。
out.push('> **历史教训（无条件保留）**：');
out.push('> 1. 曾把 `31.8`（GSM8K 位置 8 的单点值）当成三位置均值写进 7 处；');
out.push('> 2. 曾把采样时对 DSpark 的领先 `12.8%` 误当成「DSpark 比 DFlash2 高」；');
out.push('> 3. 曾把「对 DFlash 的 27.8%」和「对最强基线 DFlash2 的 10.0%」混着写。');
out.push('> **这类错自检脚本查不出，只能逐条回原文核。**', '');

// ---------- ④ 写稿顺序建议 ----------
out.push('## ④ 建议的写稿顺序', '');
out.push('1. 先读本简报的 ①②③ 三段，形成「这篇有什么值得写、哪里要小心」的判断；');
out.push('2. 再读 `article.md` 现有结构（或 `publish/writing-spec.md` 的 8 节骨架）；');
out.push('3. 需要原始细节时回查 `research.md`（官方仓/issue）和 `research-platform.md`（别人怎么写）；');
out.push('4. 写完跑 `npm run publish:check -- --slug=' + slug + '`，**机器检查过了再人工核数字**。', '');

// ---------- ⑤ 生成时的告警（给跑脚本的人看，不写进简报正文） ----------
if (warn.length) {
  out.push('## ⑤ 生成告警', '');
  for (const w of warn) out.push(`- ⚠️ ${w}`);
  out.push('');
}

const text = out.join('\n');
const outPath = join(dir, 'briefing.md');
writeFileSync(outPath, text, 'utf8');

// ---------- 结构化版本：给生成器用，md 给人看 ----------
// 为什么要两份：md 是给人审的，读起来顺；但生成器需要「有选择地注入」——
// 写「实验设置」这一节时只该看到训练配置，不该看到知乎同题文章标题。
// 把同一份内容同时输出成 JSON，生成器就能按小节取字段，人也能对照着看它到底拿了什么。
const numberTable = numberSource
  ? (() => {
      const nums = [...numberSource.matchAll(/(\d+\.\d+%|\d+\.\d+×|\b\d+\.\d{1,2}\b)/g)].map((m) => m[1]);
      const freq = new Map();
      for (const n of nums) freq.set(n, (freq.get(n) ?? 0) + 1);
      return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([value, count]) => ({ value, count, unit: value.endsWith('%') ? '%' : value.endsWith('×') ? '×' : 'raw' }));
    })()
  : [];

const structured = {
  slug,
  title,
  generated_at: new Date().toISOString(),
  // ① 冲突点：写「实验设置」「局限」时必须交代的事
  conflicts: deepKeyPoints.map((text) => ({ text, source: 'research-deep' })),
  trainingConfig: budgetHits.map(([, who, body]) => ({ who, text: body.slice(0, 300) })),
  openIssues: deployIssues.map(([, n, state, title]) => ({ number: Number(n), state, title })),
  // ② 差异点：别人写过什么
  competitors: platform
    ? [...platform.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1].trim())
    : [],
  xhsUnavailable: Boolean(platform && /## 小红书[\s\S]{0,400}(抓不到|没抓到|空)/.test(platform)),
  // ③ 数字陷阱
  numberSource: numberSourceName,
  numberTraps: numberTable,
  // 材料完整性：生成器据此判断哪些论断不能写
  missing: [
    ...(deep ? [] : ['research-deep.md']),
    ...(research ? [] : ['research.md']),
    ...(platform ? [] : ['research-platform.md']),
  ],
  warnings: warn,
};
writeFileSync(join(dir, 'briefing.json'), JSON.stringify(structured, null, 1), 'utf8');

console.log(JSON.stringify({
  out: `articles/${slug}/briefing.md`,
  json: `articles/${slug}/briefing.json`,
  bytes: Buffer.byteLength(text),
  deep: Boolean(deep),
  deepTop: Boolean(deepKeyPoints.length || legacyBullets.length),
  conflicts: structured.conflicts.length,
  competitors: structured.competitors.length,
  numberSource: numberSourceName,
  warnings: warn,
}, null, 1));

// 告警也打到 stderr：跑脚本的人要当场看到，不能翻文件才发现
for (const w of warn) console.error(`⚠️  ${w}`);
