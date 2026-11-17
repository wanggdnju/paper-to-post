#!/usr/bin/env node
/**
 * critic：写完稿之后，让一个独立模型逐段质问「这句凭什么这么说」。
 *
 *   node scripts/critic.mjs --slug=dspine [--out=articles/dspine/critic.md]
 *   → articles/<slug>/critic.json + critic.md（缺陷清单，不改稿）
 *
 * 为什么需要它：机器自检只能数加粗、数表格、查宏；查不出
 *   -「这个论断论文没说过」
 *   -「这里的因果关系是作者自己补的」
 *   -「拿第三方数字当论文数据用了」
 * 这些只有拿原文对照才看得出来，而且**必须由一个没有写过这件稿子的模型来看**——
 * 同一个模型回头看自己的输出，倾向于认为都合理。
 *
 * 设计要点：
 *   1. **逐段过，不要一次性喂全文**：一次喂 8000 字，模型只会给三条泛泛的建议。
 *   2. 输入是「段落 + 它声称引用的数字 + 原文相关片段」，让它做的判断具体到句。
 *   3. 输出是缺陷清单（严重度 / 原句 / 问题 / 建议），**不直接改稿**——
 *      改不改、怎么改由人决定，避免 critic 把对的句子改坏。
 *   4. 论文原文按关键词检索出相关片段给它，而不是整篇塞进去（成本低、噪音少）。
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
  console.error('用法：node scripts/critic.mjs --slug=<slug> [--max=20] [--paper=path]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const meta = parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data;
// meta.files.article 存的是相对仓库根的路径（如 articles/dspine/article.md），
// 不能直接 join 到文章目录上，否则会拼成 articles/dspine/articles/dspine/article.md。
const rel = meta.files?.article
  || (existsSync(join(dir, 'article.md')) ? `articles/${slug}/article.md` : '');
const articlePath = join(ROOT, rel);
if (!rel || !existsSync(articlePath)) {
  console.error(`✗ 找不到正文：${rel || '(article.yaml 没有 files.article)'}`);
  process.exit(1);
}
const article = readFileSync(articlePath, 'utf8');
// 论文全文优先取仓库里归档的那份（prepare.mjs 落的 source/paper.txt）。
// /tmp 只是兼容旧流程：它是临时的，跑完当天就没了，之后 critic 会静默退化成
// 「只查内部一致性」，然后对附录里的数字大段报「无出处」——2026-11-16 实际踩到。
const archivedPaper = join(dir, 'source', 'paper.txt');
const paperPath = args.paper
  ? String(args.paper)
  : (existsSync(archivedPaper) ? archivedPaper : `/tmp/${slug}.txt`);
const paper = existsSync(paperPath) ? readFileSync(paperPath, 'utf8') : '';
if (!paper) console.error(`⚠️ 没有论文原文（${paperPath}），critic 只能查内部一致性，查不出「论文没说过」。`);

const factFile = join(dir, 'facts.json');
const facts = existsSync(factFile) ? JSON.parse(readFileSync(factFile, 'utf8')) : null;

const llm = createLlm();
if (!llm.configured) {
  console.error('✗ LLM 未配置');
  process.exit(1);
}

// ---- 抽取待审段落 ----
// 只审「有论断的段落」：含数字、含因果词、含判断句的。纯过渡句不必审。
const body = article.replace(/^---\n[\s\S]*?\n---\n/, '');
const paragraphs = body.split(/\n\s*\n/)
  .map((p) => p.trim())
  .filter((p) => p.length > 40 && !p.startsWith('|') && !p.startsWith('```') && !p.startsWith('$$') && !p.startsWith('!['))
  .filter((p) => /[\d%×]|因此|所以|说明|意味着|证明|优于|落后|原因是|因为/.test(p));

const limit = Number(args.max ?? 20);
const picked = paragraphs.slice(0, limit);

/**
 * 给一段话检索证据。
 *
 * 只检索论文正文句子是不够的——**论文的主要数字都在表格里**，正文句子往往不含具体数值。
 * 结果是 critic 会理直气壮地说「论文里没有 3.77」，把对的段落判成错的（实测发生过）。
 *
 * 所以证据有三个来源：
 *   ① 论文正文里关键词重叠的句子；
 *   ② facts.json 里值正好出现在这段话中的事实（「这个数属于哪张表哪一格」）；
 *   ③ 这段话里出现的数字，逐个在 facts 里查归属。
 */
function relevantPaper(text) {
  const parts = [];

  // ② + ③ 表格事实：先找这段话里的小数，再看 facts 里谁对得上
  //
  // 匹配时必须把**两侧的单位后缀都剥掉**：正文写「只有 1.5x」，正文提取出的是 `1.5`，
  // 而 facts 里这一格存的是 `1.5x`。只做 `nums.has(part)` 两边永远对不上，
  // 于是 critic 会对着一条明明有出处的论断报「证据清单为空」——
  // 这类假阳性比漏报更糟：人会被迫逐条去证伪，最后索性全部忽略 critic。
  const bare = (s) => String(s).replace(/^[+−-]/, '').replace(/(%|×|x)$/i, '').trim();
  // 数值等价：`1.5` 和 `1.50` 是同一个数，稿子写几位小数是排版选择。
  // 只做字符串比对会让 `1.5x`（稿子）对不上 `1.50x`（表里），
  // critic 于是报「没有检索到任何证据」——而那个格子明明就在表里。
  const numKey = (s) => {
    const v = Number(bare(s));
    return Number.isFinite(v) && String(s).match(/\d/) ? v.toFixed(4) : bare(s);
  };
  if (facts) {
    const nums = new Set((text.match(/\d+\.\d+/g) ?? []).map(numKey));
    // **每个数字至少给一条命中**。早先版本按事实顺序取前 N 条，
    // 于是 `0.69` 这一格（在 tab:alpha 里出现 4 次）把名额占满，
    // `3.12` 排到第 17 条被截断，critic 就报了「3.12 完全没有归属」。
    // 现在按数字轮转取：每个数字一条，再有余量才补第二条。
    const byNum = new Map();
    for (const f of facts.facts ?? []) {
      for (const p of f.parts ?? []) {
        const key = numKey(p);
        if (!nums.has(key)) continue;
        if (!byNum.has(key)) byNum.set(key, []);
        const list = byNum.get(key);
        const line = `- ${f.table}${f.group ? `【${f.group}】` : ''}：${f.method || ''}${f.method ? ' / ' : ''}${f.column} = ${f.value}`;
        if (!list.includes(line)) list.push(line);
      }
    }
    const ordered = [];
    const maxLen = Math.max(0, ...[...byNum.values()].map((l) => l.length));
    for (let round = 0; round < maxLen; round++) {
      for (const key of byNum.keys()) {
        const line = byNum.get(key)[round];
        if (line && !ordered.includes(line)) ordered.push(line);
      }
    }
    const uniq = ordered.slice(0, 24);
    if (uniq.length) parts.push('【论文表格中与这段话数字对应的事实】', ...uniq);
    // 注意：**不用 text_numbers 当证据**。它从 LaTeX 源码抓小数，
    // 大量命中的是排版参数（`\\vspace{-0.6cm`、logo 宽度 0.06），
    // 喂给 critic 只会让它把真实数字误认成有出处。
  }

  // ① 正文句子
  if (paper) {
    const keywords = [...new Set(
      (text.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []).map((w) => w.toLowerCase()),
    )].slice(0, 8);
    const sentences = paper.split(/(?<=[.!?。])\s+/).filter((s) => s.length > 40);
    const picked = [];
    if (keywords.length) {
      const scored = sentences.map((s) => {
        const low = s.toLowerCase();
        return { s, hit: keywords.filter((k) => low.includes(k)).length };
      }).filter((x) => x.hit >= 2).sort((a, b) => b.hit - a.hit).slice(0, 3);
      picked.push(...scored.map((x) => x.s));
    }
    // 数字锚定：这段话里出现的每个小数，去原文找含它的句子。
    //
    // 为什么必须加这一路：论文的**具体设定**几乎都在附录里，而附录句子不含
    // 这段话的关键词。DFlare 那轮 critic 就因此判「γ 从 4.5 起」无出处，
    // 而原文 A.1 写着 `we set the initial decay parameter to γ0 = 4.5`。
    // 只按词召回，附录永远是盲区。
    const nums = [...new Set((text.match(/\d+(?:\.\d+)?/g) ?? []))].slice(0, 6);
    for (const n of nums) {
      const hit = sentences.find((s) => s.includes(n) && !picked.includes(s));
      if (hit) picked.push(hit);
      if (picked.length >= 6) break;
    }
    if (picked.length) parts.push('【论文正文相关片段】', ...[...new Set(picked)].map((s) => `> ${s.trim()}`));
  }

  return parts.join('\n');
}

/**
 * 审一段：返回该类下的 findings（不含 section/paragraph，由调用方补）。
 * 逐段之间完全独立——证据检索是纯函数，提示词也不含「上一段说了什么」，
 * 所以可以并发（2026-11-12：原来是 20 段串行，一段 6–15 秒，光 critic 就要 3–4 分钟）。
 */
async function reviewOne(para) {
  const context = relevantPaper(para);
  const raw = await llm.complete({
    messages: [
      {
        role: 'system',
        content: `你是严格的论文审稿人。你的任务是找出**解读稿**里「站不住的说法」，不是改写文章。

判断标准（只有这四类算问题）：
1. **overclaim**：论文没这么说，稿子把话说满了（如把「在特定设置下」写成「普遍」）；
2. **misattribution**：数字归属错了（哪个模型、哪个基准、哪个温度、哪个分母）；
3. **unsupported**：给出了因果解释，但论文只观察到相关性，没有解释原因；
4. **overreach**：把第三方复现/社区说法当成论文结论。

不算问题：文风、长度、修辞、结构、错别字、排版。**没毛病就返回空数组。**`,
      },
      {
        role: 'user',
        content: `# 待审段落
${para}

# 证据
${context || '（没有检索到证据。这种情况下**只报「无法核实」，不要断言论文没说过**）'}

# 任务
逐句检查这段话。只输出真实存在的问题，没有就返回 {"findings": []}。

**关于数字归属，按这三条判断，不要凭「清单里有别的格子也对得上」就报错：**

1. 清单里**有多条**都属于同一个数值，这是正常的——论文里 0.69 这种值会出现在多张表的多格里。
   只要**其中一条**和上下文（模型、基准、指标名）对得上，就**不是** misattribution。
2. 只有当**清单里没有任何一条**能对上上下文时，才报 misattribution，
   并在 problem 里写明「清单中所有归属分别是……，都对不上」。
3. 稿子自己算出的差值、比值（「A 从 x 提到 y，高 z」里的 z），
   只要 x 和 y 在清单里、且算出来确实是 z，就**不是**问题。

另外注意：
- **不要把「稿子补了一句因果解释」一律判成 unsupported**。论文给出机制性描述
  （比如「MoE 验证时可能触达多于两个专家」）时，基于该机制做的解释是合理的，
  只要与论文方向一致、没有夸大适用范围。
- 引用了 GitHub issue / 第三方评测的地方，只要稿子**明确标了来源**（写出 issue 编号或评测名），
  就属于「有出处的引用」，不算 overreach。真正算 overreach 的是**没标来源、当成论文结论**的写法。

如果某个数字在那份清单里能找到归属，就**不是** misattribution，不要报。

输出 JSON：
{"findings": [{"severity": "high|medium|low", "quote": "原文里有问题的那一句（原样复制，不要改）", "type": "overclaim|misattribution|unsupported|overreach", "problem": "为什么有问题，一句话", "fix": "怎么改，给出具体改法"}]}`,
      },
    ],
    maxTokens: 1500,
    temperature: 0.1,
    jsonMode: true,
  });
  return extractJson(raw).findings ?? [];
}

/** 找出这段属于哪个 h2 小节，便于定位 */
function headingOf(text, para) {
  const idx = text.indexOf(para.slice(0, 40));
  if (idx < 0) return '';
  const before = text.slice(0, idx);
  const heads = [...before.matchAll(/^##\s+(.+)$/gm)];
  return heads.length ? heads[heads.length - 1][1].trim() : '';
}

// ---- 并发审稿 ----
// 并发数默认 8；是纯读+LLM，没有写冲突。结果按段序回收，findings 的顺序才稳定。
const jobs = resolveJobs(args.jobs, 8);
if (picked.length > 1) console.log(`并发 ${Math.min(jobs, picked.length)} 段（--jobs 可调）`);
const reviewedAll = await mapPoolSettled(picked, jobs, async (para) => reviewOne(para));

const findings = [];
let reviewed = 0;
for (const [i, r] of reviewedAll.entries()) {
  const para = picked[i];
  if (!r.ok) {
    console.error(`⚠️ 第 ${i + 1} 段审稿失败：${r.error?.message ?? r.error}`);
    continue;
  }
  reviewed += 1;
  for (const f of r.value) {
    if (!f.quote) continue;
    findings.push({ ...f, section: headingOf(body, para), paragraph: para.slice(0, 80) });
  }
}
console.log(`已审 ${reviewed}/${picked.length} 段，累计 ${findings.length} 条问题`);

// ---- 落盘 ----
const severityRank = { high: 0, medium: 1, low: 2 };
findings.sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3));

const doc = {
  slug,
  generated_at: new Date().toISOString(),
  model: llm.model,
  paragraphs_reviewed: reviewed,
  findings,
};
writeFileSync(join(dir, 'critic.json'), JSON.stringify(doc, null, 1), 'utf8');

const md = [
  `# critic 报告：${meta.title ?? slug}`,
  '',
  `> ${doc.generated_at}　模型 ${llm.model}　审了 ${reviewed} 段，发现 ${findings.length} 条问题`,
  '> **这是缺陷清单，不改稿。** 改不改、怎么改由人决定。',
  '',
  ...(findings.length
    ? findings.map((f, i) => [
        `## ${i + 1}. [${f.severity}] ${f.type}${f.section ? `　（${f.section}）` : ''}`,
        '',
        `> ${f.quote}`,
        '',
        `**问题**：${f.problem}`,
        '',
        `**建议**：${f.fix}`,
        '',
      ].join('\n'))
    : ['没有发现问题。']),
].join('\n');
writeFileSync(join(dir, 'critic.md'), md, 'utf8');

const high = findings.filter((f) => f.severity === 'high').length;
console.log(`→ articles/${slug}/critic.md（${reviewed} 段，${findings.length} 条：high ${high}）`);
if (high) {
  console.log('\n⚠️  有 high 级别问题，发布前必须逐条处理：');
  for (const f of findings.filter((x) => x.severity === 'high').slice(0, 5)) {
    console.log(`  · ${f.problem}\n    「${f.quote.slice(0, 60)}…」`);
  }
}
