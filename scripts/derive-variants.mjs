#!/usr/bin/env node
/**
 * 平台变体派生：从 article.md 生成 zhihu.md / xhs.md / xhs-article.md，并校验一致性。
 *
 *   node scripts/derive-variants.mjs --slug=dspine [--only=zhihu,xhs] [--force]
 *
 * 为什么要派生而不是手写四份：
 *   现在四份稿子互相独立，靠人保持一致——这是**注定会漂移**的结构。
 *   改了一个数字忘了改其余三份，是这类流程最典型的错误，而且自检查不出来
 *   （每份单看都自洽）。
 *
 * 派生规则：
 *   zhihu.md        公式替换成【公式N】占位，文首附 TeX 清单，供 zhihu.mjs 灌入
 *   xhs.md          LLM 压缩到 1000 字以内，结论先行
 *   xhs-article.md  结构化裁剪到 14 屏以内（长图切页的来源）
 *
 * 每个变体生成后都跑一致性校验：
 *   - 变体里的每个数字必须能在 article.md 里找到（防止压缩时凭空造数）
 *   - 知乎的公式数必须等于原文公式数
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createLlm } from './lib/llm.mjs';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/derive-variants.mjs --slug=<slug> [--only=zhihu,xhs,xhs-article] [--force]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const meta = parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data;
const articleRel = meta.files?.article || `articles/${slug}/article.md`;
const article = readFileSync(join(ROOT, articleRel), 'utf8');
// 知乎是长文平台，文末问答跟着正文一起发——读者读完了正好接上。
// 小红书（短文案 + 长图）不带：短版要「结论先行」，14 屏的长图预算也排不进问答。
const bodyFull = article.replace(/^---\n[\s\S]*?\n---\n/, '').trimEnd();
const bodyNoQa = bodyFull.split(/^##\s+附[：:]\s*问答\s*$/m)[0].trimEnd();
const body = bodyFull;

const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : ['zhihu', 'xhs', 'xhs-article'];
const report = [];

// ---------------------------------------------------------------- 内容提取

/** 按 h2 切小节 */
function sections(md) {
  const out = [];
  const lines = md.split('\n');
  let cur = { heading: '', body: [] };
  for (const ln of lines) {
    const m = ln.match(/^##\s+(.+)$/);
    if (m) {
      if (cur.heading) out.push({ heading: cur.heading, body: cur.body.join('\n').trim() });
      cur = { heading: m[1].trim(), body: [] };
    } else {
      cur.body.push(ln);
    }
  }
  if (cur.heading) out.push({ heading: cur.heading, body: cur.body.join('\n').trim() });
  return out;
}
const secs = sections(body);
const tldr = secs.find((s) => /TL;DR|摘要/i.test(s.heading))?.body ?? '';
const conclusion = secs.find((s) => /讨论|判断|结论/i.test(s.heading))?.body ?? '';
const mainResults = secs.find((s) => /主要结果/i.test(s.heading))?.body ?? '';

/** 正文里出现的小数 → 用于校验变体没有编数 */
const articleNumbers = new Set([...body.matchAll(/(\d+\.\d+)/g)].map((m) => m[1]));

/** 变体里出现的小数，凡不在原文的，列出来 */
function checkNumbers(text) {
  const bad = [...new Set([...text.matchAll(/(\d+\.\d+)/g)].map((m) => m[1]))]
    .filter((n) => !articleNumbers.has(n));
  return bad;
}

// ---------------------------------------------------------------- zhihu

/** 纯规则，不调模型：把公式换成占位符并生成清单 */
function deriveZhihu() {
  const mathTable = [];
  let counter = 0;
  // 行间公式
  let out = body.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    counter += 1;
    mathTable.push({ n: counter, kind: '行间', tex: tex.trim() });
    const purpose = guessPurpose(tex);
    // 猜不出用途就只留编号：`【公式1：公式】` 是废话，不如没有
    return purpose ? `【公式${counter}：${purpose}】` : `【公式${counter}】`;
  });
  // 行内公式：保留在正文里（知乎能插行内公式），但要登记
  const inlineSeen = new Set();
  out = out.replace(/(?<![$\w])\$([^$\n]+?)\$(?!\$)/g, (m, tex) => {
    const key = tex.trim();
    if (!inlineSeen.has(key)) {
      inlineSeen.add(key);
      mathTable.push({ n: null, kind: '行内', tex: key });
    }
    return m;
  });
  // 插图占位：![alt](path) → 【图N：alt】/【表N：alt】
  //
  // 图和表要分开编号，并且**沿用主稿的号**：正文里写的是「表 1」「表 2」，
  // 如果表格图被转成【图6：…】，读者按「表 1」去找只会找到一张叫「图 6」的图。
  // 主稿的图注已经带了 `图 N ·` / `表 N ·` 前缀，直接拿它当号；没有前缀时才顺延。
  let figN = 0;
  let tabN = 0;
  out = out.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_, alt) => {
    const numbered = alt.match(/^\s*(图|表)\s*(\d+)\s*·\s*([\s\S]*)$/);
    if (numbered) {
      const [, kind, n, rest] = numbered;
      if (kind === '表') tabN = Math.max(tabN, Number(n));
      else figN = Math.max(figN, Number(n));
      return `【${kind}${n}：${rest.trim()}】`;
    }
    const isTable = /^\s*表/.test(alt);
    const n = isTable ? ++tabN : ++figN;
    return `【${isTable ? '表' : '图'}${n}：${alt.split('·').pop()?.trim() || alt}】`;
  });

  const title = meta.title ?? slug;
  // 正文区要剥掉 H1 和 digest 引用行：知乎的标题单独填在标题框里，
  // 正文再带一遍会重复；digest 是公众号摘要，不属于正文。
  const zhihuBody = out
    .replace(/^#\s+.+\n/, '')
    .replace(/^>\s*[^\n]*\n/, '')
    .trim();
  const table = mathTable
    .filter((m) => m.n !== null)
    .map((m) => `| ${m.n} | ${m.kind} | \`${m.tex}\` |`)
    .join('\n');
  const inlineRows = mathTable
    .filter((m) => m.n === null)
    .map((m) => `\`${m.tex}\``)
    .join('、');

  const md = [
    `# 知乎发布稿：${title}`,
    '',
    `> 用法：正文一次性粘贴（已把行间公式换成占位符），再按公式清单逐个插入知乎公式卡。`,
    `> 标题：**${title}**`,
    '> 发布前提醒：知乎草稿页可以保存，点「发布」不可撤回。',
    '',
    `## 公式清单（行间 ${mathTable.filter((m) => m.n !== null).length} 个）`,
    '',
    '| N | 类型 | TeX 源码 |',
    '| --- | --- | --- |',
    table,
    '',
    inlineRows ? `行内公式（直接写在正文里，无需卡片）：${inlineRows}` : '',
    '',
    '---',
    '',
    // 这个标题是**契约**，不是装饰：render-zhihu.mjs 靠 `## 正文` 切分，
    // 取它之后的内容贴进编辑器。少了它，切分失败会退回整份文件——
    // 「用法说明 + 公式清单」被当成正文灌进知乎（2026-11-11 实际发生过）。
    '## 正文（从下方开始整段复制到编辑器）',
    '',
    zhihuBody,
    '',
  ].join('\n');
  return { md, formulaCount: mathTable.filter((m) => m.n !== null).length, inlineCount: inlineSeen.size, figureCount: figN };
}

/** 从 TeX 里猜一个中文用途说明，给占位符用 */
function guessPurpose(tex) {
  // 注意：这里的模式是**按某几篇论文的具体公式写的**，换一篇就可能全不匹配、
  // 全部退化成「公式」——而更糟的是**误匹配**：EAGLE-2 的价值函数里有一个
  // `\prod`，被这里的 `prod` 分支判成「并行草稿的独立分解」（DFlash 的说法），
  // 于是知乎稿里出现一句和本文无关的说明（2026-11-12 发现）。
  // 现在只保留足够具体的模式，其余一律回落到中性的「公式」。
  if (/TPOT|T_\{\\text\{draft\}\}|T_\{verify\}/.test(tex)) return '单步耗时分解';
  if (/q_\{\\mathrm\{draft\}\}(x\^\{-?t\})?/.test(tex)) return '并行草稿的独立分解';
  if (/normalize|R_l/.test(tex)) return '统一空间的投影';
  if (/sigma|g_\{l,t\}/.test(tex)) return '门控权重';
  if (/RMS|h_\{l,t\}/.test(tex)) return '注入后的隐状态';
  if (/cos|L_\{\\mathrm\{emb/.test(tex)) return '嵌入余弦对齐损失';
  if (/L_\{?L|lambda/.test(tex)) return '总损失';
  return '';
}

// ---------------------------------------------------------------- 派生策略：抽取而非重写

/**
 * 主稿里「带保留」的说法。派生版本引用同一个数字时，必须把保留一起带过去。
 *
 * 为什么需要这个：压缩稿最容易犯的错不是算错数字，而是**把保留删掉**。
 * 实测过两处：
 *   - 主稿「这条性质本身没有多少可改的余地」→ 小红书「这块没有优化空间」
 *   - 主稿「原文只说 accuracy，未指明模型/基准，只能当量级参考」→ 小红书直接断言
 * 前者是删掉限定词，后者是删掉整句免责说明。数字没变，但可信度完全不同。
 */
const HEDGE_PATTERNS = [
  // 注意 `\s*` 不能省：小红书文案里模型会把空格压掉（「仍有约 2.3x」→「仍有约2.3x」），
  // 也可能反过来加空格。紧贴着写的正则会漏判，把「保留还在」的句子误报成丢保留。
  /约\s*(?:为|有)?\s*\d/g, /大约\s*\d/g, /左右/g, /量级/g, /大致/g,
  /论文(?:的原话|措辞|自己)/g, /原文(?:只说|措辞|写)/g, /未(?:指明|声明|说明|展开)/g,
  /只能(?:当|作)/g, /据(?:推算|估计)/g, /不完全(?:一致|确定)/g,
  // 「略优 / slightly better」这类弱化判断，压缩时最容易被改成「更好」
  /略(?:优|好|高|低)/g, /slightly/gi, /偏(?:小|低|高)/g,
];

/** 判断一句话里是否带「保留」。
 *  ⚠️ `HEDGE_PATTERNS` 里都是带 `/g` 的正则，直接用 `.test()` 会留下 `lastIndex`，
 *  下一次调用从上次停下的位置继续找 —— 同一句话第二次判断就变成 false。
 *  这是个会**静默给出错误结论**的陷阱（表现为「约 2.3x 明明在，却报丢了保留」），
 *  所以每次都新建正则，不复用带状态的实例。 */
function hasHedge(text) {
  return HEDGE_PATTERNS.some((re) => new RegExp(re.source, re.flags).test(text));
}

/** 从主稿里找出所有「带保留 + 含数字」的句子，供派生稿对照。 */
function hedgedSentences(md) {
  const out = [];
  // 先按行拆，再按句号拆：标题（`### 7.4 … 约 0.1x`）和紧随的段落之间没有句号，
  // 不分行会让整段黏成一句，后面按数字比对时全都对错位。
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // 表格行、图片、公式块都不是「论述句」，没有保留可言
    if (t.startsWith('|') || t.startsWith('![') || t.startsWith('$$')) continue;
    for (const sent of t.split(/(?<=[。！？；])/)) {
      const s = sent.trim();
      if (!s || !/\d/.test(s) || !hasHedge(s)) continue;
      out.push({ text: s, numbers: [...new Set(s.match(/\d+\.\d+/g) ?? [])] });
    }
  }
  return out;
}

/** 数字出现的位置，要求前后不是数字或小数点——`includes('2.7')` 会命中 `2.79`。 */
function numberOccurrences(text, num) {
  const esc = num.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\d.])${esc}(?![\\d.])`, 'g');
  return [...text.matchAll(re)].map((m) => m.index);
}

/**
 * 校验派生稿：主稿里某个数字如果是在「带保留」的句子里出现的，
 * 派生稿里**改写**了这个数字时，改写后的句子也必须带保留。
 *
 * ⚠️ 只对「重写型」派生有意义。抽取型（xhs-article）的正文是主稿原文逐字拼接，
 * 保留天然在，不该也不用拿这条去查——同一个数字在主稿里出现在多处语境
 * （3.94 既在 TL;DR 的保留句里，也在消融段落里），按数字比对必然大量误报。
 *
 * @param verbatimOf 抽取型派生传入原文块数组；此时只校验「每个句子都来自原文」
 */
function checkHedges(text, hedged, { verbatimOf = null } = {}) {
  // 派生稿里的表格行不是「断言」，跳过——表格给的是原始数据，
  // 保留应该体现在**引用这张表的论述句**里，不该要求每个单元格自带限定词。
  const prose = text.split('\n').filter((l) => !l.trim().startsWith('|')).join('\n');
  // 只按句末标点和换行切，**不按分号**：「把加速从约1.9x推到2.8x；特征输入只是略优」
  // 用分号切开后，「约」留在前半句，后半句的 2.8x 就被判成丢保留——
  // 但那两半本来就是同一句话，读者看到的是完整的。
  const sentences = prose.split(/(?<=[。！？\n])/).filter((s) => s.trim());

  // 抽取型：正文是原文拼接，只需确认每句都能在原文块里找到（逐字一致）
  if (verbatimOf) {
    const source = verbatimOf.join('\n');
    const notFound = sentences
      .map((s) => s.trim())
      .filter((s) => s.length >= 8 && !source.includes(s));
    return notFound.map((s) => ({ kind: 'not-verbatim', derived: s.slice(0, 80) }));
  }

  const violations = [];
  for (const item of hedged) {
    for (const num of item.numbers) {
      const hits = sentences.filter((s) => numberOccurrences(s, num).length > 0);
      if (!hits.length) continue; // 派生稿没用到这个数字，不算问题
      const bad = hits.find((s) => !hasHedge(s));
      if (bad) {
        violations.push({
          kind: 'hedge-lost',
          number: num,
          source: item.text.slice(0, 80),
          derived: bad.trim().slice(0, 80),
        });
      }
    }
  }
  // 同一个数字可能命中多条主稿句子，按数字去重
  const seen = new Set();
  return violations.filter((v) => (seen.has(v.number) ? false : (seen.add(v.number), true)));
}

// ---------------------------------------------------------------- 小红书（需模型）

const XHS_RULES = `小红书文案规则：
1. 总长 ≤ 1000 字（含话题标签），中文为主；
2. **第一句就是结论**，不要铺垫、不要行话开场；第一行写成「emoji + 钩子」，≤20 字，单独成段；
3. 结构：结论 → 现状/痛点 → 做法 → 效果 → 代价（诚实交代局限）→ 一句判断；
4. 正文必须用 1️⃣ 2️⃣ 3️⃣ 编号小节（至少 3 个），每段一行、段与段之间空一行；
5. 单段 ≤ 140 中文字。宁可多分一段，不要一段写三层意思；
6. 不要用 markdown 标题、加粗和表格（小红书不渲染，** 会原样印出）；
7. 数字必须来自原文，不许自己算新的；
8. 结尾给 4–6 个话题标签，格式 #标签；
9. 不要「不是A而是B」「值得注意的是」「综上」。`;

async function deriveXhs(llm) {
  // 小红书只有 1000 字：正文 9000 字压进来已经要删很多，问答节整段不参与。
  // 把主稿里带保留的句子显式列给模型，并要求照抄。
  // 只说「不许改变措辞」是不够的——模型会认为「限定语可以省」，
  // 必须把**具体哪几句不能动**指出来。
  const hedged = hedgedSentences(bodyNoQa);
  const hedgeBlock = hedged.length
    ? `\n# 以下说法带保留，引用其中数字时必须连保留一起照抄（不许删限定词、不许改成断言）\n${hedged.map((h) => `- ${h.text}`).join('\n')}\n`
    : '';

  const prompt = `把下面这篇论文解读压缩成小红书文案。

# 原文（全文，用于提取）
${bodyNoQa}

# 重点小节
## TL;DR
${tldr}

## 主要结果
${mainResults}

## 讨论与判断
${conclusion}
${hedgeBlock}
# ${XHS_RULES}

只输出文案本身，不要解释。`;

  const raw = (await llm.complete({
    messages: [
      { role: 'system', content: '你是技术内容编辑，擅长把长文压成小红书文案。只输出文案。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 2000,
    temperature: 0.3,
  })).trim();

  // 小红书不渲染 markdown：模型偶尔仍会加 ** 和 ##，落盘前清掉。
  // 段落结构（编号、空行）不在这里补，缺了由 publish-check 的 D2c 拦。
  const text = raw
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const numbered = (text.match(/^[0-9]️⃣/gm) ?? []).length;
  if (numbered < 3) console.warn(`⚠️ xhs.md 只有 ${numbered} 个编号小节（D2c 至少 3 个），建议人工补`);

  const zh = (text.match(/[一-龥]/g) ?? []).length;
  const tags = (text.match(/#[^\s#]+/g) ?? []).length;
  return { md: `# 小红书文案\n\n${text}\n`, chars: zh, tags, hedgeViolations: checkHedges(text, hedged) };
}

/**
 * 小红书正文：**抽取，不重写**。
 *
 * 早先版本让模型「压到 1200–1800 字」，结果是模型把每段重述一遍——数字对得上
 * （一致性校验只查数字），但语气被改了：主稿「没有多少可改的余地」变成
 * 「没有优化空间」，主稿「未指明模型，只能当量级参考」整句消失。
 * 这类漂移比算错数字更危险：读者看不出差别，但作者原本的保留没了。
 *
 * 现在的做法：把主稿切成「块」（段落/图/表/公式），让模型**只挑编号、不改写**。
 * 挑中的块原样拼接，措辞必然与主稿逐字一致。
 */
/** 长图正文最多保留多少块（不含标题另算，实际是 20+8 标题）。 */
const MAX_BLOCKS = 20;


/**
 * 检测「悬空连接词」：段落以「但 / 而 / 所以 / 因此 / 这两个 / 它」开头，
 * 但它的上一段被裁掉了——读者看不到它承接的是什么。
 *
 * 按块裁必然遇到这个问题（连接词跨块）。处理方式不是硬删（那句话本身可能是
 * 最有价值的一段），而是**把被裁掉的上一块补回来**，只补一层，不递归。
 */
const LEADING_CONNECTIVE = /^(?:但是|但|然而|而|所以|因此|于是|这就|这两个|这两种|它|这|该|那|同样|此外|另外|分子是|分母是|其中|上式|上表|下表|换句话说|也就是说|具体来说|这个结果|这个结论|这条曲线|这一点|这些数字|第[一二三四五六七八九十]个(?:杠杆|瓶颈|问题|原因)|第[一二三四五六七八九十](?:堵|样|类|条|种|层))/;

function fixDanglingConnectives(chosen, blocks) {
  const set = new Set(chosen);
  const added = [];
  for (const i of chosen) {
    const t = blocks[i].text.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    if (!LEADING_CONNECTIVE.test(t)) continue;
    const prev = i - 1;
    // 上一块存在、没被选 → 补回来。图/表也要补：「这个结果否定了…」承接的正是一张图，
    // 只补正文段会让这段依然悬空（2026-11-13 DSpark 实测）。
    if (prev >= 0 && !set.has(prev) && ['para', 'img', 'table', 'math'].includes(blocks[prev].kind)) {
      set.add(prev);
      added.push(prev);
      // 「分子是…」承接的是前一段里那个被裁掉的公式：补完公式还要把它前面的句子也补上，
      // 否则读者看到的是一个没头没尾的符号。
      if (prev - 1 >= 0 && !set.has(prev - 1) && ['math', 'para'].includes(blocks[prev - 1].kind)) {
        set.add(prev - 1); added.push(prev - 1);
        if (prev - 2 >= 0 && !set.has(prev - 2) && blocks[prev - 2].kind === 'para') {
          set.add(prev - 2); added.push(prev - 2);
        }
      }
    }
  }
  return { chosen: [...set].sort((a, b) => a - b), added };
}

async function deriveXhsArticle(llm) {
  // 长图同样不带问答节：14 屏预算要留给论证主线和图表。
  const blocks = splitBlocks(bodyNoQa);
  const numbered = blocks
    .map((b, i) => {
      const tag = b.kind === 'para' ? '' : `[${b.kind}] `;
      return `[${i}]${tag}${b.text.replace(/\n/g, ' ').slice(0, 220)}`;
    })
    .join('\n');

  const headline = blocks.filter((b) => b.kind === 'h2').map((b, i) => `[${i}] ${b.text}`).join('\n');

  const prompt = `下面是一篇论文解读的**候选块**，每块前面是编号。
请挑选能组成一篇「手机竖屏长图」正文的块，**只输出编号**，不要改写任何文字。

# 硬性上限
**最多选 20 块**（\`##\` 标题另算，标题默认全要）。原始正文有 ${blocks.length} 块、
约 7000 中文字；小红书单篇最多 18 张图，全选会让长图变成三四十屏，没人看完。
目标：选完约 1200–1800 中文字，切成 10–14 屏。

# 挑选原则
1. 开头必须是最有冲击力的结论段（通常是 TL;DR 的第一段）；
2. 每个 \`##\` 节标题都要保留，否则读者失去结构感；但**节内最多留 2–3 段**；
3. 段落优先级：具体数字 + 归因判断 > 泛泛描述；机制解释 > 背景铺垫；
4. **带保留的段落必须保留**（含「约」「只能当参考」「未指明」「论文措辞」这类词的）；
   删掉它们，剩下的数字会变成没有限定的断言；
5. 图留 1–2 个最有说明力的，表最多留 1 个；
6. 宁缺毋滥——不要为了凑字数选平庸的段落。

# 候选块
${numbered}

只输出 JSON：{"picks": [编号数组], "reason": "一句话说明取舍"}`;

  const { extractJson } = await import('./lib/llm.mjs');
  const raw = await llm.complete({
    messages: [
      { role: 'system', content: '你是技术内容编辑。你的工作是挑段落，不是改写。只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    maxTokens: 2000,
    temperature: 0.2,
    jsonMode: true,
  });

  let picks;
  try {
    picks = extractJson(raw).picks ?? [];
  } catch {
    // 模型没给合法 JSON 时**不能退回「全选」**——那会让小红书变成整篇论文，
    // 而是退回「按规则选」：所有 h2 标题 + 前 25 个段落。
    console.warn('⚠️ 模型没给出合法编号，退回规则选取');
    picks = [];
  }
  const valid = [...new Set(picks)]
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n < blocks.length)
    .sort((a, b) => a - b);

  // 保底：一个都没选中时按顺序取（标题全要、段落取前 25 个）
  let chosen = valid;
  if (!chosen.length) {
    chosen = blocks
      .map((b, i) => ({ b, i }))
      .filter(({ b }, idx) => b.kind === 'h2' || (b.kind === 'para' && idx < 40))
      .map(({ i }) => i);
  }

  // 每个 h2 标题必须出现：模型漏掉时补回来，否则长图会变成一串没有小标题的段落
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].kind === 'h2' && !chosen.includes(i)) {
      // 插到「比它大的第一个已选编号」之前，保持原文顺序
      const next = chosen.find((c) => c > i);
      chosen = next === undefined ? [...chosen, i] : [...chosen.filter((c) => c !== next), i, next];
    }
  }
  chosen = [...new Set(chosen)].sort((a, b) => a - b);

  // 模型经常无视「最多 20 块」的指令（实测一次选了 112 块）。**代码里兜底**：
  // 超了就按优先级裁。裁的时候三个原则——
  //   ① 标题永不裁；② 带保留的段落优先保留（它们承载的是「别把话说满」的信息）；
  //   ③ **图和表单独留配额**。
  //
  // ③ 是 2026-11-11 那次事故的根因：以前按文档顺序补满名额，而被裁的永远是靠后的块
  // ——结果图和表正好是「主要结果」「消融」那几节里最靠后的，一律被裁掉，长图变成纯文字。
  // 现在先按类型锁住各 1 个（图优先架构图与结果图，表优先主要结果表），再谈其余。
  // 图和表的保底**必须在裁剪之前单独做**：模型常常正好选满 20 块且一块图/表都没选，
  // 而下面的裁剪分支只在 `> MAX_BLOCKS` 时才跑，于是「有图有表」这条判据形同虚设
  // （2026-11-13 DSpark 实测：9 张图、3 张表在候选池里，成品 imgN=0 tableN=0）。
  // 所以先按类型各锁一个，超出名额时用「最后一段非标题、非带保留」的块去换。
  for (const kind of ['img', 'table']) {
    if (chosen.some((i) => blocks[i].kind === kind)) continue;
    const candidate = blocks.findIndex((b) => b.kind === kind);
    if (candidate < 0) continue;
    chosen.push(candidate);
    // 挪出名额：从尾部找第一个既不是 h2、也不是带保留的块删掉
    while (chosen.length > MAX_BLOCKS) {
      let victim = -1;
      for (let k = chosen.length - 1; k >= 0; k--) {
        const i = chosen[k];
        if (i === candidate) continue;
        if (blocks[i].kind === 'h2' || hasHedge(blocks[i].text)) continue;
        victim = k; break;
      }
      if (victim < 0) break;
      chosen.splice(victim, 1);
    }
  }
  chosen = [...new Set(chosen)].sort((a, b) => a - b);

  if (chosen.length > MAX_BLOCKS) {
    const isHeading = (i) => blocks[i].kind === 'h2';   // 只有 `##` 必留，`###` 可裁
    const isHedged = (i) => hasHedge(blocks[i].text);
    const keep = new Set();
    for (const i of chosen) if (isHeading(i)) keep.add(i);
    // 图、表各最少留 1 个。这就是 C6 那条「小红书必须有图有表」的派生侧对应保证。
    for (const kind of ['img', 'table']) {
      const first = chosen.find((i) => blocks[i].kind === kind);
      if (first !== undefined) keep.add(first);
    }
    for (const i of chosen) if (isHedged(i) && !keep.has(i)) keep.add(i);
    // 剩余名额按原顺序填（模型给的顺序本身就是它的偏好，不再重新排序）
    for (const i of chosen) {
      if (keep.size >= MAX_BLOCKS) break;
      keep.add(i);
    }
    chosen = [...keep].sort((a, b) => a - b);
  }

  // 裁块之后修一次悬空连接词（补回上一段），再组装
  const fixed = fixDanglingConnectives(chosen, blocks);
  chosen = fixed.chosen;

  // 到这里 chosen 是「模型选的块 + 配额补齐」，还可能重复引用同一张图。
  // 后面的处理有顺序依赖，按这个顺序走：
  //   ① 同图去重（保留靠前那次）→ ② 删掉因此落空的「这张图说明…」→ ③ 空节补正文
  //   → ④ 补悬空的图/公式 → ⑤ 图和表的最终保底。
  // 顺序错了会互相打架：先补空节再删段落，删完就又是空节（2026-11-13 DSpark 实测，
  // `## 2. 问题` 最后只剩两个列表项，读者不知道在讲哪张图）。

  // ① 同一张图只出现一次。主稿里同一张图常在「问题」和「深入分析」各引一次
  //    （DSpark 的 fig-position_cond_accept 就是），按块抽取会把两次都带进来；
  //    读者滑到第二张一模一样的图会以为自己翻回去了。保留靠前的那次。
  {
    const seen = new Set();
    const dup = new Set();
    for (const i of chosen) {
      if (blocks[i].kind !== 'img') continue;
      const src = blocks[i].text.match(/\(([^)]+)\)/)?.[1] ?? blocks[i].text;
      if (seen.has(src)) dup.add(i); else seen.add(src);
    }
    if (dup.size) chosen = chosen.filter((i) => !dup.has(i));
  }

  // ② 图被去重掉、解释段却留下了：那段「这张图说明…」现在指着空气，只能整段去掉。
  //    但如果那张图只是**没被选中**（不是重复），就不要删段——④ 会把图补回来。
  //    两者的区别是「这张图的 src 是否已经在成品里出现过」。
  {
    const shownSrc = new Set(
      chosen.filter((i) => blocks[i].kind === 'img')
        .map((i) => blocks[i].text.match(/\(([^)]+)\)/)?.[1] ?? blocks[i].text),
    );
    chosen = chosen.filter((i) => {
      if (blocks[i].kind !== 'para') return true;
      if (!/^(这张图|上图)/.test(blocks[i].text.trim())) return true;
      for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
        if (blocks[k].kind !== 'img') { if (blocks[k].kind === 'h2') break; continue; }
        if (chosen.includes(k)) return true;
        const src = blocks[k].text.match(/\(([^)]+)\)/)?.[1] ?? blocks[k].text;
        return !shownSrc.has(src);   // 同图已在别处 → 删段；否则留给 ④ 补图
      }
      return true;
    });
  }

  // ③ 「空标题」补一段：节标题保留但节内一段正文都没选上时，长图会出现连着的几个
  //    光秃秃的 `## 2. 问题` `## 3. 方法`——读者刚被标题提起来就翻页，等于没讲。
  //    补的段落按「有加粗落点、有数字」排序，取第一节内最优的一段，不重新润色。
  const paraScore = (t) => (t.match(/\*\*/g) ?? []).length * 2 + (/\d/.test(t) ? 3 : 0);
  const isProse = (i) => blocks[i].kind === 'para' && !/^[-*+]\s/.test(blocks[i].text.trim());
  for (const h of chosen.filter((i) => blocks[i].kind === 'h2')) {
    const nextH2 = blocks.findIndex((b, i) => i > h && b.kind === 'h2');
    const end = nextH2 < 0 ? blocks.length : nextH2;
    // 只认正文段，且不能是列表项——「- Code 域…」这种条目不会交代它讲的是哪张图。
    if (chosen.some((i) => i > h && i < end && isProse(i))) continue;
    let best = -1;
    let bestScore = -1;
    for (let i = h + 1; i < end; i++) {
      if (!isProse(i)) continue;
      const s = paraScore(blocks[i].text);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best < 0) continue;
    chosen = [...chosen, best].sort((a, b) => a - b);
  }

  // ③补进来的段落本身可能就是「分子是…」这种承接句（它的上文是公式和引出句）。
  // 所以连接词修复要在补段之后再跑一遍——第一遍跑的时候这段还不在 chosen 里。
  chosen = fixDanglingConnectives(chosen, blocks).chosen;

  // ④ 「图注悬空」与「半句话」：按块裁会把一对绑定结构拆开。
  //    · 段落以「这张图说明」开头，但那张图没被选 → 读者不知道在说哪张图；
  //    · 段落以「写成：」结尾，但紧跟的公式没被选 → 一句话断在半空。
  //    两种情况都补上缺的那块（图/公式），而不是删段——删掉的往往是信息最密的一段。
  {
    const set = new Set(chosen);
    const shownSrc = new Set(
      chosen.filter((i) => blocks[i].kind === 'img')
        .map((i) => blocks[i].text.match(/\(([^)]+)\)/)?.[1] ?? blocks[i].text),
    );
    for (const i of [...chosen]) {
      const t = blocks[i].text.trim();
      if (/^(这张图|上图|这张表|上表|该图|该表)/.test(t)) {
        for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
          if (blocks[k].kind !== 'img') { if (blocks[k].kind === 'h2') break; continue; }
          // 这张图已经在别处出现过就不再补，避免同图两次
          const src = blocks[k].text.match(/\(([^)]+)\)/)?.[1] ?? blocks[k].text;
          if (!shownSrc.has(src)) { set.add(k); shownSrc.add(src); }
          break;
        }
      }
      if (/[：:]$/.test(t) && i + 1 < blocks.length) {
        const nk = blocks[i + 1].kind;
        if (nk === 'math' || nk === 'table') set.add(i + 1);
      }
    }
    chosen = [...set].sort((a, b) => a - b);
  }

  // ⑤ 图和表的最终保底：C6 的判据是「成品里有没有」，
  //    而上面每一步都可能顺手丢掉图块，所以保证只能放在成品前一刻。
  //    图的目标是 2 张（一张主结果、一张机制/分析），纯文字长图读者滑两屏就跑了。
  {
    const srcOf = (i) => blocks[i].text.match(/\(([^)]+)\)/)?.[1] ?? blocks[i].text;
    // 优先级：主结果图 > 位置条件接受率（机制证据）> 深度/块长（分析）> 其余
    const rank = (i) => {
      const s = srcOf(i);
      if (/tab-|table/i.test(s)) return 0;
      if (/position_cond/i.test(s)) return 1;
      if (/layer|block_size/i.test(s)) return 2;
      return 3;
    };
    for (const [kind, want] of [['img', 2], ['table', 1]]) {
      for (;;) {
        const have = new Set(chosen.filter((i) => blocks[i].kind === kind).map(srcOf));
        if (have.size >= want) break;
        const cands = blocks.map((b, i) => i)
          .filter((i) => blocks[i].kind === kind && !have.has(srcOf(i)))
          .sort((a, b) => rank(a) - rank(b) || (Math.abs(a - chosen[0]) - Math.abs(b - chosen[0])));
        if (!cands.length) break;
        // 优先挑紧邻已选段落的那个（读者刚读到相关论述，接着看到图最自然）
        const pick = cands.find((i) => chosen.includes(i - 1) || chosen.includes(i + 1)) ?? cands[0];
        chosen = [...chosen, pick].sort((a, b) => a - b);
        console.warn(`⚠️ 成品缺${kind === 'img' ? '图' : '表'}，已从原文补入一块（第 ${pick} 块）`);
      }
    }
  }

  // ⑥ 「第二样输入」「第二堵墙」这类序数回指：如果正文里没有对应的「第一X」，
  //    读者会以为漏看了一段。抽取型派生不能改写文字，只能删掉指代落空的那段。
  {
    const text = chosen.map((i) => blocks[i].text).join('\n');
    const orphans = new Set();
    for (const m of text.matchAll(/第(二|三|四)(样|堵|类|条|种|层)/g)) {
      if (!text.includes(`第一${m[2]}`)) {
        // 找出提到「第二X」且没有「第一X」的那一段
        for (const i of chosen) {
          if (blocks[i].kind !== 'para') continue;
          if (!blocks[i].text.includes(`第${m[1]}${m[2]}`)) continue;
          if (blocks[i].text.includes(`第一${m[2]}`)) continue;
          orphans.add(i);
        }
      }
    }
    if (orphans.size) chosen = chosen.filter((i) => !orphans.has(i));
  }

  // ⑦ 字数预算：小红书正文 2000 字是硬上限，超了会被截断。
  //    上面各步都在「补」，最后必须有一次「收」：按段落价值从低到高删，
  //    只删正文段——标题、图、表、公式、带保留的句子、每节第一段都不动。
  {
    const zhCount = () => (chosen.map((i) => blocks[i].text).join('\n').match(/[一-龥]/g) ?? []).length;
    const protectedSet = new Set();
    for (const i of chosen) {
      if (blocks[i].kind !== 'para') protectedSet.add(i);
      if (hasHedge(blocks[i].text)) protectedSet.add(i);
      // 图的解释段不能删：删了图就成了没有说明的截图，读者看不懂在讲什么。
      if (/^(这张图|上图)/.test(blocks[i].text.trim())
        && chosen.some((k) => k > Math.max(0, i - 3) && k < i && blocks[k].kind === 'img')) {
        protectedSet.add(i);
      }
    }
    for (const h of chosen.filter((i) => blocks[i].kind === 'h2')) {
      const firstProse = chosen.find((i) => i > h && isProse(i));
      if (firstProse !== undefined) protectedSet.add(firstProse);
    }
    while (zhCount() > 1900) {
      let victim = -1;
      let low = Infinity;
      for (const i of chosen) {
        if (protectedSet.has(i)) continue;
        const s = paraScore(blocks[i].text);
        if (s < low) { low = s; victim = i; }
      }
      if (victim < 0) break;
      chosen = chosen.filter((i) => i !== victim);
    }
  }

  const assembled = chosen.map((i) => blocks[i].text).join('\n\n') + '\n';

  // 图号重排：抽块会留下「图 3 · 图 6」这种跳号（第 1、4、5 张没被选），
  // 读者在长图里看到「图 6」却只见过两张图，会以为漏了几屏。按出现顺序重编。
  let figNo = 0;
  const md = assembled.replace(/!\[图\s*\d+\s*·/g, () => `![图 ${++figNo} ·`);
  const zh = (md.match(/[一-龥]/g) ?? []).length;
  const h2 = (md.match(/^##\s/gm) ?? []).length;
  void headline;
  // 图/表必须真的进了成品。以前 ok 只看字数、节数、保留句，
  // 于是「一张图一个表都没有」的派生稿照样判通过（2026-11-11 用户看到的就是这个）。
  // 这里数的是**成品 md 里**的图和表，不是候选池。
  const imgN = (md.match(/^!\[/gm) ?? []).length;
  const tableN = (md.match(/^\|[\s:|-]+\|$/gm) ?? []).length;
  return {
    md, chars: zh, sections: h2, imgN, tableN,
    picked: chosen.length, total: blocks.length,
    // 抽取型派生用「每句都能在原文里找到」来保证，不用数字-保留比对。
    // 比对的是**重编号之前**的 assembled：上面把「图 6」改成了「图 1」，
    // 拿改过的文本去逐字比对原文，图注那一行必然对不上（2026-11-13 踩过一次）。
    hedgeViolations: checkHedges(assembled, [], { verbatimOf: blocks.map((b) => b.text) }),
  };
}

/** 把正文切成块：段落 / 标题 / 图 / 表 / 公式。代码块内部不切。 */
function splitBlocks(md) {
  const out = [];
  let buf = [];
  let inCode = false;
  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    // `##` 与 `###` 必须分开：长图只需要 `##` 这一级做骨架，
    // `###` 是正文内部的小标题，是可以整个删掉的（EAGLE 有 22 个 `###`，
    // 全当必留标题的话名额立刻被占满，正文一段都进不去）。
    const kind = text.startsWith('## ') ? 'h2'
      : text.startsWith('### ') ? 'h3'
      : text.startsWith('![') ? 'img'
      : text.startsWith('|') ? 'table'
      : text.startsWith('$$') ? 'math'
      : 'para';
    out.push({ kind, text });
  };
  for (const line of md.split('\n')) {
    if (line.trim().startsWith('```')) inCode = !inCode;
    if (!inCode && !line.trim()) { flush(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- 执行

const llm = createLlm();
const needsLlm = only.some((v) => v !== 'zhihu');
if (needsLlm && !llm.configured) {
  console.error('✗ xhs / xhs-article 需要模型：.env 需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  console.error('  （zhihu 是纯规则派生，可以用 --only=zhihu 单独跑）');
  process.exit(1);
}

const results = [];

// 已有文件默认不覆盖：这些稿子可能是人工改过的（尤其是 zhihu.md 的公式清单，
// 手工调整过顺序或措辞）。覆盖前必须 --force，或者先把旧文件挪走。
function guard(name) {
  const p = join(dir, name);
  if (existsSync(p) && !args.force) {
    const size = readFileSync(p, 'utf8').length;
    console.error(`⏭  ${name} 已存在（${size} 字符），跳过。要重新派生就加 --force。`);
    return false;
  }
  return true;
}

if (only.includes('zhihu') && guard('zhihu.md')) {
  const out = join(dir, 'zhihu.md');
  const { md, formulaCount, figureCount } = deriveZhihu();
  const srcFormulas = (body.match(/\$\$[\s\S]*?\$\$/g) ?? []).length;
  const ok = formulaCount === srcFormulas && (md.match(/【公式\d+/g) ?? []).length === formulaCount;
  writeFileSync(out, md, 'utf8');
  results.push({
    variant: 'zhihu.md',
    formulaCount,
    srcFormulas,
    figureCount,
    numbersNotInArticle: checkNumbers(md),
    ok,
  });
}

// xhs 与 xhs-article 是两次**互不依赖**的模型调用（都只读主稿），并发跑。
// 串行时两次各 30–60 秒；并发后墙钟约等于较慢的那一次。zhihu 是纯规则派生，更快，保持在前面。
const tasks = [];
if (only.includes('xhs') && guard('xhs.md')) {
  tasks.push((async () => {
    const { md, chars, tags, hedgeViolations } = await deriveXhs(llm);
    writeFileSync(join(dir, 'xhs.md'), md, 'utf8');
    results.push({
      variant: 'xhs.md', chars, tags,
      numbersNotInArticle: checkNumbers(md),
      hedgeViolations,
      ok: chars <= 1000 && tags >= 3 && hedgeViolations.length === 0,
    });
  })());
}

if (only.includes('xhs-article') && guard('xhs-article.md')) {
  tasks.push((async () => {
    const { md, chars, sections: n, picked, total, hedgeViolations, imgN, tableN } = await deriveXhsArticle(llm);
    writeFileSync(join(dir, 'xhs-article.md'), md, 'utf8');
    results.push({
      variant: 'xhs-article.md', chars, sections: n, picked, total, imgN, tableN,
      numbersNotInArticle: checkNumbers(md),
      hedgeViolations,
      ok: chars <= 2000 && n >= 6 && hedgeViolations.length === 0 && imgN >= 1 && tableN >= 1,
    });
  })());
}
await Promise.all(tasks);

console.log(JSON.stringify({ slug, results }, null, 1));
let failed = false;
for (const r of results) {
  if (!r.ok) failed = true;
  if (r.numbersNotInArticle?.length) {
    failed = true;
    console.error(`⚠️ ${r.variant} 里有原文没有的数字（可能是压缩时算出来的）：${r.numbersNotInArticle.join('、')}`);
  }
  if (r.hedgeViolations?.length) {
    failed = true;
    console.error(`⚠️ ${r.variant} 有 ${r.hedgeViolations.length} 处「主稿带保留、派生稿变成断言」：`);
    for (const v of r.hedgeViolations) {
      console.error(`   · 数字 ${v.number}：主稿「${v.source}…」→ 派生稿「${v.derived}…」`);
    }
  }
}
process.exit(failed ? 1 : 0);
