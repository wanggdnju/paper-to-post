#!/usr/bin/env node
/**
 * 文末问答：给正文末尾补一节「附：问答」，问题由浅到深。
 *
 *   node scripts/qa.mjs --slug=<slug> [--n=9] [--dry] [--no-write]
 *   → 原地更新 articles/<slug>/article.md 的 `## 附：问答` 一节（重跑覆盖，幂等）
 *   → 报告写 articles/<slug>/qa.json
 *
 * 为什么要单独一节：
 *   长文是按「论证链」写的，读者读完往往还带着几个具体问题——「所以到底能快多少」
 *   「为什么不用加深网络解决」「我下载下来能跑出这个数吗」。这些问题在正文里
 *   分散在几处，读者得自己拼。集中成问答，一层层往下问，是把「读完了」变成
 *   「搞懂了」的最短路径。
 *
 * 三层由浅到深（--n=9 时每层 3 个）。**这三层只用于生成**，不写进正文：
 *   入门 —— 这是什么、解决什么问题、跟我有什么关系；
 *   机制 —— 为什么这么设计、和别的做法差在哪、代价是什么；
 *   落地 —— 数字口径、边界条件、复现会撞上什么、作者没写的坑。
 * 写进 article.md 的是一组平铺的「问 / 答」（见 renderSection）——分组小标题
 * 只会打断阅读，而且问题常常跨两类，归错比不归更糟（2026-11-13 用户反馈）。
 *
 * **答案不许出现正文里没有的数字**。这是机械校验的：抽出答案里所有小数，
 * 每一个都要能在正文或 facts.json 里找到；找不到就把那一段打回重写（最多一次），
 * 仍不过就保留问题、清空答案并在退出码上标红，绝不带着编造的数字发出去。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createLlm, extractJson } from './lib/llm.mjs';
import { parseArticle } from './lib/frontmatter.mjs';
import { mapPoolSettled, resolveJobs } from './lib/pool.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/qa.mjs --slug=<slug> [--n=9] [--jobs=3] [--questions=<文件>] [--dry] [--no-write]');
  console.error('  --questions=<文件>  用人给的题目，模型只负责作答（不再自己出题）');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const articlePath = join(dir, 'article.md');
if (!existsSync(articlePath)) {
  console.error(`✗ 没有 articles/${slug}/article.md`);
  process.exit(1);
}

/**
 * 题型：模型每条自报一个，脚本据此检查「必出题型有没有全」。
 *
 * 只靠提示词说「四类每类至少一条」，模型会挑好写的写（通常全落在「机制」），
 * 于是「初始条件」「反事实」这两类最值钱的题反而缺席——它们恰恰是正文没写、
 * 读者最卡的地方。所以让模型自报 type，缺哪类就单独补一条。
 */
const KINDS = [
  { name: '术语', need: true, hint: '把正文一个抽象说法翻译成代码里在做什么' },
  { name: '初始条件', need: true, hint: '第 0 步的输入从哪来；训练有真值，推理时那份真值怎么拿到' },
  { name: '反事实', need: true, hint: '最坏情况会怎样、会不会反而更慢、靠什么止损' },
  { name: '实现', need: true, hint: '一条前向怎么并行、默认配置是多少、哪个参数一改就失效' },
  { name: '动机', need: false, hint: '为什么非得这么做、不做会怎样' },
  { name: '口径', need: false, hint: '某个数字该怎么读、容易误读成什么' },
];

const QA_HEADING = '附：问答';
const TIERS = [
  // 第一层不叫「入门」也不出「这是什么」的题：那种题答案就是摘要，读者在正文第一段已经看过。
  // 用户示范的第一题是「为什么用特征级自回归」——同样浅，但问的是**动机**，答案要给出取舍。
  { name: '动机', hint: '不给没读过的人科普「这是什么」。直接问「为什么非得这么做 / 不这么做会怎样」，答案要落到具体取舍上。' },
  { name: '机制', hint: '给读过摘要的人：一个具体设计怎么运作、和别的做法差在哪、代价落在哪里。讲因果，不罗列。' },
  { name: '边界', hint: '给「觉得自己看懂了」的人：初始条件怎么起来、最坏情况会不会亏、哪个前提一破就不成立。这类题的答案正文通常只给了一半，要接着往下推。' },
  { name: '落地', hint: '给准备复现或上线的人：口径怎么读、默认配置是什么、会撞上什么坑。可用已核实的仓库/文档细节，但正文没写的要说明来源。' },
];

/**
 * 出题规则（2026-11-13 按用户给的 EAGLE 提问重写）。
 *
 * 原来那版问的是「这篇讲了什么」的结构化改写，答案是正文的复述，读者读完等于没读。
 * 用户示范的好题目有共同点：**锚定到一个具体的术语、默认值或反事实**，
 * 而且答案在正文里只写了一半——必须接着往下推。四类必出：
 *   ① 术语→具体操作（「往前挪一个时间步」到底挪了什么）
 *   ② 初始条件（推理第一步从哪拿到真实 token / 真实特征）
 *   ③ 反事实与代价（如果第一步就被拒，会不会比不开还慢；靠什么止损）
 *   ④ 机制落到实现（一条前向怎么验完整棵树；默认树深几层、几个节点）
 * 另外每条必须能写出一句话的「解答核心」——写不出来说明这题只会得到复述。
 */
const QUESTION_RULES = `# 出题规则（比「讲清楚」更重要）
每题都必须**锚定正文里的一个具体点**，不能是章节名的改写：
- 反例（不要）：「EAGLE 的方法是什么」「它比 Medusa 好在哪」「做了哪些实验」——这些用目录就能答。
- 正例：「『token 序列往前挪一步』到底挪了什么，消掉的是哪条分叉」「推理时草稿的第一个位置怎么拿到真实 token 的特征」。

四类题**每类至少一条**：
1. **术语落到操作**：把正文里一个抽象说法翻译成「代码里到底在做什么」。读者读得懂字面、但想象不出动作，就是这类。
2. **初始条件**：算法在第 0 步从哪拿到输入？训练时有真值，推理时那份真值从哪来？正文往往一句话带过，这是最容易卡住的地方。
3. **反事实与代价**：如果最坏情况发生会怎样（第一个 token 就被拒、树全错、数据翻倍没用），系统靠什么止住亏损。要有明确的是/否，不要和稀泥。
4. **机制落到实现**：默认配置是什么（深度、分支、节点数）、一条前向怎么并行处理多个分支、哪个参数一改就失效。数字要能从正文或已核实材料取到。

另外两条：
- 至少一条问「加了什么代价 / 什么时候不该用」；至少一条问「某个数字该怎么读，容易误读成什么」。
- 每条先写 \`core\`：一句话解答核心（≤40 字）。写不出 core 的题不要出——那说明答案只能是复述。

## 好问题的句法（照着造，别自由发挥）
- 「**『某个原句』到底改的是什么？**」——把正文里的一个说法钉死到具体操作上。
- 「**既然 X 成立，那 Y 还需要做吗？**」——从一个人人认可的前提往下推一步，逼出容易漏掉的那层。
- 「**如果最坏情况发生（第一个 token 就被拒 / 树全错 / 数据翻倍），会不会反而更慢？靠什么止损？**」——要有明确的是/否。
- 「**真正推理时，第 0 步的输入从哪来？训练时有真值，推理时那份真值怎么拿到？**」
- 「**默认配置是什么？深度、分支、节点数分别是多少？**」——问具体字段，不要问「大概什么样」。
- 「**为什么 A 加数据没用，B 一加就涨？**」——用对照逼出机制差别。

## 不要这样问
- 只问「是什么 / 有什么 / 有哪些」的（黑名单机械拦截）。
- 答案能在正文某一段里整段找到的（那是摘抄，不是问答）。
- 一句话里塞三个子问题的（拆成三条）。`;

const meta = existsSync(join(dir, 'article.yaml'))
  ? parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data
  : {};
const md = readFileSync(articlePath, 'utf8');
const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');

// 问答节本身不能作为出题素材（重跑时会把自己的旧答案喂回去，越抄越远）
const articleBody = body.split(new RegExp(`^##\\s+${QA_HEADING}\\s*$`, 'm'))[0].trim();
// 公式要**原样**留给模型看，不能被下面的去 Markdown 洗掉。
// 2026-11-18 事故：`$q_j$` 里的下划线被当成强调标记换成空格，模型看到的是
// `$q j$`，于是它在答案里把公式写成裸文本 `q_j`、`α̃_i`、`∏α_j`——站点上
// 这些就是普通字符，不排公式；而且 `_` 在 Markdown 里还有歧义。
// 这里先把 `$…$` / `$$…$$` 换成占位符，洗完再放回去。
const stripMarkdown = (t) => {
  const math = [];
  const kept = t.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+?\$/g, (m) => {
    math.push(m);
    return `\u0000${math.length - 1}\u0000`;
  });
  return kept
    .replace(/^!\[[^\]]*\]\([^)]*\)$/gm, ' ')
    .replace(/^\|.*$/gm, ' ')
    .replace(/[*_`>]/g, ' ')
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => math[Number(i)]);
};

const factsPath = join(dir, 'facts.json');
const facts = existsSync(factsPath) ? JSON.parse(readFileSync(factsPath, 'utf8')).facts ?? [] : [];

/**
 * 允许出现的数字：正文里已经写过的，加上 facts 表里的原始格子值，
 * 再加上 research-deep.md 里已核实的外部材料（仓库 issue、论文附录、第三方实测）。
 *
 * 为什么不干脆只认正文：有些数字（比如 gpt-fast 结合后的 tokens/s）论文里有、
 * 正文为了可读性没收进来，「落地」层的问题正需要它。research-deep 是我们自己
 * 逐条标了来源的调研，把它纳入允许集合是可追溯的；代价是答案必须标来源
 * （prompt 里要求「引用时说明是仓库/issue 说的」）。
 */
const grounded = new Set();
for (const m of articleBody.matchAll(/(\d+\.\d+)/g)) grounded.add(m[1]);
for (const f of facts) for (const p of f.parts ?? []) if (/^\d+\.\d+$/.test(String(p))) grounded.add(String(p));
const researchPath = join(dir, 'research-deep.md');
const fromResearch = new Set();
if (existsSync(researchPath)) {
  const research = readFileSync(researchPath, 'utf8');
  for (const m of research.matchAll(/(\d+\.\d+)/g)) { grounded.add(m[1]); fromResearch.add(m[1]); }
}

const n = Math.max(3, Number(args.n ?? 12));
const perTier = Math.max(1, Math.round(n / TIERS.length));

// 已核实、但正文可能没写的细节（仓库 issue、默认配置、复现口径）。
// 出「落地」层的题需要它们；答案里引用了就要标来源，所以这里只喂材料、不喂结论。
//
// --extra=<文件> 是给「跨篇问题」用的：读者常问「为什么 EAGLE-3 一加数据就涨」，
// 答案在同系列的 EAGLE-3 稿里，不在这篇正文里。把那份稿当外部材料喂进来，
// 答案就能给出有出处的对比，而不是一句「正文没写」。
const extraFiles = [].concat(args.extra ?? []).map(String).filter((f) => existsSync(f));
const supplementary = [
  ...['research-deep.md', 'briefing.md'].map((name) => {
    const p = join(dir, name);
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : '';
  }),
  ...extraFiles.map((f) => `【外部材料：${f}】\n${readFileSync(f, 'utf8').trim()}`),
].filter(Boolean).join('\n\n');
const supplementaryBlock = supplementary
  ? `\n# 已核实的外部材料（正文没写、但可以用；引用时说明来源：仓库/issue/同系列另一篇）\n${supplementary.slice(0, 12000)}\n`
  : '';

const llm = createLlm();
if (!llm.configured) {
  console.error('✗ 问答需要模型：.env 需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  process.exit(1);
}

/**
 * 人给题目模式（--questions=<文件>）：脚本只负责作答，不再自己出题。
 *
 * 为什么要这个模式：好问题来自读过论文的人，模型出题再怎么调提示词也追不上。
 * 人给题之后，脚本的价值就变成「保证答案不编数字、长度合适、每条有题眼」——
 * 这才是机械能保证的部分。
 *
 * 支持两种写法，可混用：
 *   ## 机制                       ← 二级标题当分层名（不认识的名字归到默认层）
 *   1. 问题？                     ← 编号或 - / * 都可以
 *   - 问题？（解答核心：……）       ← 括号里那句会被当作 core 参考喂给模型
 */
function parseQuestions(file) {
  const raw = readFileSync(file, 'utf8');
  const out = [];
  let tier = TIERS[0].name;
  for (const line of raw.split('\n')) {
    const h = line.match(/^#{1,3}\s+(.+)$/);
    if (h) {
      const name = h[1].trim();
      tier = TIERS.some((t) => t.name === name) ? name : tier;
      continue;
    }
    const m = line.match(/^\s*(?:\d+[.、)]|[-*+])\s+(.+)$/);
    if (!m) continue;
    let q = m[1].trim().replace(/^\*\*(.+)\*\*$/, '$1').trim();
    const hint = q.match(/[（(]\s*解答核心[：:]\s*(.+?)[)）]\s*$/);
    let coreHint = '';
    if (hint) {
      coreHint = hint[1].trim();
      q = q.slice(0, hint.index).trim();
    }
    // 提示括注去掉后，原本被括注包在里面的 `**…**` 可能残留（写成
    // `- **问题**（解答核心：…）` 时就是这样），不剥会让成品出现 `****问题****`。
    q = q.replace(/^\*\*(.+)\*\*$/, '$1').trim();
    if (q.length < 6) continue;
    out.push({ tier, q, coreHint });
  }
  return out;
}

const prompt = `下面是一篇论文解读的全文。请为它写一节「文末问答」，挂在文章最后。

# 篇幅与分层
一共 ${perTier * TIERS.length} 个问题，分 ${TIERS.length} 组，每组 ${perTier} 个：

${TIERS.map((t, i) => `${i + 1}. 「${t.name}」——${t.hint}`).join('\n')}

顺序必须由浅到深：后面的问题可以假定读者已经读完前面的答案，但**不要自己回答自己**。

# 每条答案怎么写
- **第一句直接给结论**，而且这一句要等于你写的 \`core\`。后面 2–4 句解释为什么。总长 100–250 中文字。
- 答案要能从正文推出来。**不许引入正文里没有的数字、模型名、结论**（外部材料里的例外，但要标来源）。
- 不要复述正文原段。换个说法，补上「所以呢」——读者读完这条要有新收获。
- 中文引号用「」，不要用 ASCII 引号。不要出现「值得注意的是」「不是A而是B」「综上」。
- **公式一律用 $…$ 包起来**，和正文完全一样：$q_j$、$\alpha_i$、$\prod \alpha_j$、$\rho_t$、$\Sigma_k \nabla_\theta W_k$。
  不要写成裸文本 \`q_j\`、\`α_j\`、\`∏α_j\`——那样在网页上不会被排版成公式，只会显示成一串带下划线的字符。
  单字母下标也要包：写 $p_i$ 不写 p_i。公式里的数学符号用 LaTeX：$\alpha$ $\gamma$ $\rho$ $\prod$ $\nabla$ $\leq$ $\approx$ $\sigma$。

${QUESTION_RULES}
${supplementaryBlock}
# 全文
${stripMarkdown(articleBody)}

只输出 JSON：
{"tiers":[{"name":"${TIERS[0].name}","items":[{"q":"问题","kind":"${KINDS.map((k) => k.name).join('|')} 之一","core":"一句话解答核心，≤40 字","a":"答案"}]}]}`;

let parsed = null;
if (args.questions) {
  const file = String(args.questions);
  if (!existsSync(file)) {
    console.error(`✗ 找不到题目文件：${file}`);
    process.exit(1);
  }
  const asked = parseQuestions(file);
  if (!asked.length) {
    console.error(`✗ ${file} 里没解析出问题（每行用「1. 问题」或「- 问题」）`);
    process.exit(1);
  }
  console.log(`按给定题目作答：${asked.length} 条`);
  const sys = '你是这篇论文的解读作者。题目由作者本人给出，你只负责作答。只输出 JSON。';
  const body = await llm.complete({
    messages: [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `下面是作者自己拟好的 ${asked.length} 个问题，请逐条作答。

# 每条答案怎么写
- **第一句直接给结论**，而且这一句要等于你写的 \`core\`（≤40 字）。后面 2–4 句解释为什么。总长 100–250 中文字。
- 答案要能从正文推出来。**不许引入正文里没有的数字**（外部材料里的例外，但要标来源）。
- 不要复述正文原段，补上「所以呢」。
- 中文引号用「」，不要用 ASCII 引号。
- 如果某题在正文里确实没有依据，答案第一句就直说「正文没有给这个数 / 这点论文没展开」，再补能从正文推出的部分。**不要为了答满而编。**
${supplementaryBlock}
# 问题
${asked.map((x, i) => `${i + 1}. ${x.q}${x.coreHint ? `\n   （作者给的解答核心参考：${x.coreHint}）` : ''}`).join('\n')}

# 正文
${stripMarkdown(articleBody)}

只输出 JSON：{"items":[{"n":1,"core":"≤40 字","a":"答案"}]}`,
      },
    ],
    maxTokens: 4000,
    temperature: 0.3,
    jsonMode: true,
  });
  const got = extractJson(body).items ?? [];
  const byN = new Map(got.map((it) => [Number(it.n), it]));
  parsed = {
    tiers: TIERS.map((t) => ({
      name: t.name,
      items: asked.map((x, i) => ({ ...x, n: i + 1 })).filter((x) => x.tier === t.name)
        .map((x) => ({
          q: x.q,
          kind: '',
          core: String(byN.get(x.n)?.core ?? '').trim(),
          a: String(byN.get(x.n)?.a ?? '').trim(),
        })),
    })),
  };
}

if (!parsed) {
  parsed = extractJson(await llm.complete({
    messages: [
      { role: 'system', content: '你是这篇论文的解读作者，正在给读者补一节文末问答。只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 4000,
    temperature: 0.4,
    jsonMode: true,
  }));
}

/** 把模型输出规整成 [{tier, q, kind, core, a}]，丢掉空项与重复问题 */
const items = [];
const seenQ = new Set();
const addItems = (tiers) => {
  for (const tier of tiers ?? []) {
    const name = TIERS.some((t) => t.name === tier.name) ? tier.name : TIERS[items.length ? 1 : 0].name;
    for (const it of tier.items ?? []) {
      const q = String(it.q ?? '').trim();
      const a = String(it.a ?? '').trim();
      const core = String(it.core ?? '').trim();
      const kind = String(it.kind ?? '').trim();
      if (q.length < (args.questions ? 4 : 8) || seenQ.has(q)) continue;
      seenQ.add(q);
      items.push({ tier: name, q, kind, core, a });
    }
  }
};
addItems(parsed.tiers);
if (!items.length) {
  console.error('✗ 一个问题都没解析出来，检查模型输出');
  process.exit(1);
}

/** 模型自报的题型归一：写「反事实/最坏情况」都算反事实，写不出就按空处理 */
function normalizeKind(raw) {
  const k = String(raw ?? '').trim();
  if (!k) return '';
  const hit = KINDS.find((x) => k === x.name || k.includes(x.name));
  return hit?.name ?? k;
}
for (const it of items) it.kind = normalizeKind(it.kind);

// 必出题型缺席时，单独补一条（不整篇重跑）。
// 为什么需要这一步：只靠提示词，模型会挑好写的写，四类里「初始条件」「反事实」
// 最容易被略过——而它们恰恰是正文没写、读者最卡的地方（2026-11-13 eagle 首跑实测：
// 12 条里 9 条落在「机制/动机」，反事实只有 1 条、初始条件 0 条）。
// **人给题目模式不补题**：题目是作者定的，脚本往里塞自己出的题就成了「改你的题」
// （2026-11-13 用户当场指出过这个问题）。
{
  const covered = new Set(items.map((i) => i.kind));
  const missing = args.questions ? [] : KINDS.filter((k) => k.need && !covered.has(k.name));
  if (missing.length) {
    console.log(`补题：缺 ${missing.map((m) => m.name).join('、')}`);
    const topUp = await llm.complete({
      messages: [
        { role: 'system', content: '你在给一篇论文解读补几条问答。只输出 JSON。' },
        {
          role: 'user',
          content: `下面这篇论文解读已经有这些问答，现在只缺这几类题型，请各补一条：

${missing.map((k) => `- 「${k.name}」：${k.hint}`).join('\n')}

# 已有问题（不要重复）
${items.map((i) => `- [${i.kind || '?'}] ${i.q}`).join('\n')}

# 每条答案的要求
- 第一句直接给结论（等于 core），后面 2–4 句解释，总长 100–250 中文字。
- 只能引用正文里出现过的数字（正文全文见下）。
- 中文引号用「」。

# 正文
${stripMarkdown(articleBody).slice(0, 12000)}

只输出 JSON：{"items":[{"q":"问题","kind":"${missing.map((m) => m.name).join('|')}","core":"≤40 字","a":"答案"}]}`,
        },
      ],
      maxTokens: 2000,
      temperature: 0.3,
      jsonMode: true,
    });
    try {
      const extra = extractJson(topUp).items ?? [];
      addItems([{ name: missing[0].name === '术语' ? '机制' : '边界', items: extra }]);
    } catch (error) {
      console.warn(`⚠️ 补题失败（不阻断）：${error.message.split('\n')[0]}`);
    }
  }
}

// ---------------------------------------------------------------- 机械校验

const zh = (t) => (t.match(/[一-龥]/g) ?? []).length;
const DECIMAL = /(\d+\.\d+)/g;

/**
 * 泛题黑名单：这些问法用目录就能回答，答案必然是复述。
 * 判据是「问题里出现这些模式，且没有任何具体名词/数字」——纯泛题才拦，
 * 「EAGLE 的方法为什么把 token 前移一步」这种带具体操作的问法照过。
 */
const GENERIC_Q = [
  /(?:方法|思路|做法|原理|工作)是什么$/,
  /(?:是|指|做)什么的?$/,
  /有哪些(?:创新|贡献|亮点)/,
  /做了哪些实验/,
  /得到(?:了)?什么结论/,
  /有什么(?:好处|优点|意义|关系)/,
  /(?:值得|需要)(?:关心|在意)/,
  /跟(?:我|我们|读者)/,
  /^(?:请)?(?:简要)?(?:介绍|概述|总结)/,
];
const isGeneric = (q) => GENERIC_Q.some((re) => re.test(q.replace(/[？?。！!\s]/g, '')));

/**
 * 校验分两级：
 *   阻断（必须重写）：编造数字、太短/太长、ASCII 引号、泛题。
 *   提示（只记录）：core 缺失或过长、答案首句与 core 重合度低。
 * 提示项不阻断是有意的——「首句是否等于 core」是编辑判断，二元组重合率
 * 在中文上会误判（2026-11-13 eagle 首跑 12 条里 2 条假失败），
 * 而它拦住的价值远不如让流程顺跑。真正防「只会复述」的是泛题黑名单。
 */
/**
 * 抽出「没被 `$…$` 包住、但长得像公式」的片段。
 *
 * 判据要窄：中文正文里本来就有一堆 `snake_case` 式的英文词（`no_grad`、
 * `log-prob`）和量名（`block size`），全拦会把正常答案判成违规。所以只认
 * **带下标/上标的字母串**（`q_j`、`W_{k-1}`、`D_{1:K}`）、**希腊字母加下标**
 * （`α̃_i`、`ρ_t`）、以及**数学运算符**（`∏ Σ ∇ ∂ ≈ ≤ ≥ ∝`）。
 * 反引号里的（行内代码）不算——那是读者要看见字面量的地方。
 */
function bareMath(text) {
  const s = String(text ?? '')
    .replace(/`[^`\n]*`/g, ' ')          // 行内代码留给字面量
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+?\$/g, ' ');
  const out = [];
  for (const m of s.matchAll(/[A-Za-zα-ωΑ-Ω̃][α-ωΑ-Ω̃]*(?:_\{[^}]{1,12}\}|_[0-9A-Za-z]|\^\{[^}]{1,12}\}|\^[0-9A-Za-z])+/g)) out.push(m[0]);
  for (const m of s.matchAll(/[∏Σ∇∂≈≤≥∝]/g)) out.push(m[0]);
  return out;
}

function violationsOf(item) {
  const blocking = [];
  const warnings = [];
  const nums = [...item.a.matchAll(DECIMAL)].map((m) => m[1]).filter((v) => !grounded.has(v));
  if (nums.length) blocking.push(`数字不在正文/facts 里：${[...new Set(nums)].join('、')}`);
  const chars = zh(item.a);
  if (chars < 60) blocking.push(`答案只有 ${chars} 字（太短，等于没答）`);
  if (chars > 400) blocking.push(`答案 ${chars} 字（太长，读者在文末不会再读这么长）`);
  if (/[""]/.test(item.a)) blocking.push('答案里有 ASCII 双引号，改成「」');
  // 裸公式（q_j、α̃_i、∏α_j、ρ_t…）：网页上不会排成公式，只会显示成带下划线的文本。
  // 2026-11-18 用户指出「文稿里还有挺多公式的格式不对」，十篇的问答节全中——
  // 根因是 stripMarkdown 把 `$q_j$` 洗成了 `$q j$`，模型没得抄就自由发挥了。
  // 提示词已经补了规则，这里再机械拦一道，防止模型换个写法复发。
  const bare = bareMath(item.a) ?? bareMath(item.q);
  if (bare.length) blocking.push(`公式没用 $…$ 包起来：${[...new Set(bare)].slice(0, 6).join('、')}`);
  // 人给的题即便泛，也不阻断——那是作者的判断，脚本没有资格替他改题。
  if (isGeneric(item.q) && !args.questions) blocking.push(`问题「${item.q}」是泛题，用目录就能答，要锚定到具体机制或默认值`);

  if (!item.core) warnings.push('缺 core（一句话解答核心）');
  else if (zh(item.core) > 40) warnings.push(`core 有 ${zh(item.core)} 字（建议 ≤40）`);
  if (item.core && item.a) {
    const head = item.a.split(/[。！？]/)[0] ?? '';
    const grams = (s) => {
      const clean = s.replace(/[^一-龥A-Za-z0-9]/g, '');
      return new Set(Array.from({ length: Math.max(0, clean.length - 1) }, (_, i) => clean.slice(i, i + 2)));
    };
    const core = grams(item.core);
    const said = grams(head);
    if (core.size >= 4) {
      const hit = [...core].filter((g) => said.has(g)).length / core.size;
      if (hit < 0.3) warnings.push(`答案首句与 core 重合 ${Math.round(hit * 100)}%（结论不够先行）`);
    }
  }
  return { blocking, warnings };
}

// 打回重写：只针对出问题的那一条。整篇重跑既慢，又会把没问题的答案重写一遍。
async function repair(item, problems) {
  const fixed = await llm.complete({
    messages: [
      { role: 'system', content: '你在修一段问答答案。只输出 JSON。' },
      {
        role: 'user',
        content: `下面这条答案有问题：${problems.join('；')}

# 允许使用的数字（只有这些）
${[...grounded].join('、')}

# 正文里已有的信息
${stripMarkdown(articleBody).slice(0, 12000)}

# 待修的答案
问题：${item.q}
解答核心：${item.core || '（缺）'}
答案：${item.a}

重写这条答案：保持同样的结论和长度（100–250 中文字），只把有问题的地方改掉。
${args.questions ? '**题目是作者定的，一个标点都不要改**，只改答案和 core。' : '如果问题是「泛题」，连问题一起改：把它锚定到正文里的一个具体机制、默认值或反事实。'}
只输出 JSON：{"q":"问题","core":"一句话解答核心，≤40 字","a":"答案"}`,
      },
    ],
    maxTokens: 1200,
    temperature: 0.2,
    jsonMode: true,
  });
  const out = extractJson(fixed);
  return {
    // 人给题目模式下，模型即使「顺手改好了问题」也不采纳——用户要看的是他那 10 条。
    q: args.questions ? item.q : String(out.q ?? item.q).trim(),
    core: String(out.core ?? item.core ?? '').trim(),
    a: String(out.a ?? item.a).trim(),
  };
}

const jobs = resolveJobs(args.jobs, 3);
const checked = await mapPoolSettled(items, jobs, async (item) => {
  let current = item;
  let { blocking, warnings } = violationsOf(current);
  if (blocking.length) {
    try {
      current = { ...current, ...(await repair(current, blocking)) };
      ({ blocking, warnings } = violationsOf(current));
    } catch (error) {
      blocking = [...blocking, `重写调用失败：${error.message.split('\n')[0]}`];
    }
  }
  return { ...current, tier: item.tier, problems: blocking, warnings };
});

const results = checked.map((r, i) => (r.ok
  ? r.value
  : { ...items[i], problems: [`生成失败：${r.error?.message ?? r.error}`], warnings: [] }));
const bad = results.filter((r) => r.problems.length);
const warned = results.filter((r) => !r.problems.length && (r.warnings ?? []).length);

// ---------------------------------------------------------------- 渲染与落盘

function renderSection(list) {
  const out = [`## ${QA_HEADING}`, '',
    `> ${list.length} 个问题，从「为什么这么做」问到「复现会撞上什么」，难度递增。`, ''];
  // **不再按「动机 / 机制 / 边界 / 落地」分组。**
  // 分组是给生成模型用的（保证由浅到深、题型齐全），写进正文反而让人分心：
  // 读者是按顺序读的，一行「### 机制」除了打断阅读什么也没提供；
  // 而且一个问题的归类本身就模糊（「为什么不能加深骨干」既是机制也是边界），
  // 归错比不归更糟（2026-11-13 用户反馈）。
  // 现在只按 tier 的**顺序**排（浅 → 深），呈现成一组「问 / 答」。
  const ordered = TIERS.flatMap((t) => list.filter((r) => r.tier === t.name));
  const rest = list.filter((r) => !TIERS.some((t) => t.name === r.tier));
  // 编号：用户要求能指着问「问题 3 的答案再说说」。平铺但不带号时，
  // 读者没法在长文里定位，转述也没法引用（2026-11-14 反馈）。
  let n = 0;
  for (const r of [...ordered, ...rest]) {
    n += 1;
    out.push(`**问题 ${n}：${r.q}**`, '', r.a ? `回答 ${n}：${r.a}` : `回答 ${n}：（待补）`, '');
  }
  return out.join('\n');
}

const section = renderSection(results);

if (args.dry) {
  console.log(section);
} else if (!args.no_write) {
  // 幂等：已有问答节就整节替换。放在文末，替换范围是「该标题到文件结束」。
  const re = new RegExp(`\\n##\\s+${QA_HEADING}\\s*$`, 'm');
  const idx = md.search(re);
  const next = idx >= 0 ? `${md.slice(0, idx).replace(/\s+$/, '')}\n\n${section}\n` : `${md.replace(/\s+$/, '')}\n\n${section}\n`;
  writeFileSync(articlePath, next);
}

const report = {
  slug,
  generated_at: new Date().toISOString(),
  model: llm.model,
  questions: results.length,
  by_tier: Object.fromEntries(TIERS.map((t) => [t.name, results.filter((r) => r.tier === t.name).length])),
  avg_chars: Math.round(results.reduce((s, r) => s + zh(r.a), 0) / results.length),
  repaired: results.filter((r) => r.problems.length === 0
    && items.some((i) => i.q === r.q && violationsOf(i).blocking.length)).length,
  failing: bad.map((r) => ({ q: r.q, problems: r.problems })),
  // 提示项：不阻断，但列出来给写稿的人看一眼（多数是「结论不够先行」）
  warnings: warned.map((r) => ({ q: r.q, warnings: r.warnings })),
  // 出题清单留档：core 是这题的题眼，kind 用来核对「必出题型有没有全」。
  outline: results.map((r) => ({ tier: r.tier, kind: r.kind, q: r.q, core: r.core })),
  usage: llm.usage,
};
writeFileSync(join(dir, 'qa.json'), `${JSON.stringify(report, null, 1)}\n`);

if (args.dry) process.exit(bad.length ? 1 : 0);
console.log(JSON.stringify(report, null, 1));
if (warned.length) {
  console.log(`\n提示（不阻断）：${warned.length} 条`);
  for (const r of warned) console.log(`  · ${r.q}\n    ${r.warnings.join('；')}`);
}
if (bad.length) {
  console.error(`\n✗ ${bad.length} 条问答没过校验：`);
  for (const r of bad) console.error(`  · ${r.q}\n    ${r.problems.join('；')}`);
  process.exit(1);
}
console.log(`\n✓ ${results.length} 条问答已写入 articles/${slug}/article.md 末尾（重跑会整节替换）`);
