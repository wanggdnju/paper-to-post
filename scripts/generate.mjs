#!/usr/bin/env node
/**
 * 分节生成正文：大纲 → 逐节写 → 拼装。
 *
 *   node scripts/generate.mjs --slug=dspine [--only=s3,s5] [--best-of=2] [--force] [--jobs=8]
 *   → articles/<slug>/draft/<section-id>.md   每节单独落盘
 *   → articles/<slug>/article.md              拼装后的全文
 *
 * 分节之间**并发**执行（--jobs，默认 8）：每节的上下文只由大纲决定，互不依赖。
 * 实测 8 节从 4–8 分钟降到 1 分钟左右，瓶颈是网关而不是本地 CPU。
 *
 * 为什么分节而不是一次性写 8000 字：
 *   1. 一次生成长文，模型对前面几节投入的注意力远大于后面，
 *      实际表现就是「前 3 节详、后 5 节水」，而且第 6 节之后开始复读；
 *   2. 单节失败/不满意，重跑一节只要几十秒，重跑全文要几分钟；
 *   3. 每节的上下文可以精确控制——写「实验设置」时不该看到知乎同题文章标题。
 *
 * 每节的上下文 = 全文论点 + 大纲里这一节的 claim + 邻节摘要 + 术语表 + 允许引用的 fact + 原始材料。
 * **不给全文**，也不给其它节的成稿（只给摘要），避免上下文被自己的旧输出带跑。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createLlm } from './lib/llm.mjs';
import { parseArticle } from './lib/frontmatter.mjs';
import { mapPool, resolveJobs } from './lib/pool.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/generate.mjs --slug=<slug> [--only=s3,s5] [--best-of=2] [--force] [--paper=path]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const draftDir = join(dir, 'draft');
const outlinePath = join(dir, 'outline.json');
if (!existsSync(outlinePath)) {
  console.error(`✗ 没有 articles/${slug}/outline.json，先跑 npm run outline -- --slug=${slug}`);
  process.exit(1);
}
const outline = JSON.parse(readFileSync(outlinePath, 'utf8'));
if (outline.dry) {
  console.error('✗ outline.json 是空壳（--dry 生成的），先跑一次真正的 outline');
  process.exit(1);
}

const readIf = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
const meta = parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data;
const spec = readFileSync(join(ROOT, 'publish/writing-spec.md'), 'utf8');
const briefing = readIf('briefing.md');
const factsRaw = readIf('facts.json');
const facts = factsRaw ? JSON.parse(factsRaw) : { facts: [] };
const factById = new Map(facts.facts.map((f) => [f.id, f]));
const paperPath = args.paper ? String(args.paper) : `/tmp/${slug}.txt`;
const paper = existsSync(paperPath) ? readFileSync(paperPath, 'utf8') : '';

/**
 * 术语表：分节生成时**每节都注入同一份**。
 * 这是「各节独立生成」最容易出问题的地方——模型看不到别的节写了什么，
 * 同一概念会一节一个叫法（「并行草稿」/「并行 draft 网络」/「候选生成器」）。
 * 注入统一译名是唯一低成本的解法。
 */
const glossaryRaw = readIf('glossary.json');
const glossary = glossaryRaw ? JSON.parse(glossaryRaw) : null;
const glossaryBlock = glossary?.terms?.length
  ? `# 术语表（全篇必须用这里的译名，不要自创叫法）\n${glossary.terms.map((t) => `- ${t.en} → ${t.zh}${t.note ? `（${t.note}）` : ''}`).join('\n')}\n`
  : '';

const bestOf = Math.max(1, Number(args.best_of ?? 1));
const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;
const llm = createLlm();
if (!llm.configured) {
  console.error('✗ LLM 未配置：.env 需要 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  process.exit(1);
}

mkdirSync(draftDir, { recursive: true });

const sectionFile = (id) => join(draftDir, `${id}.md`);
const done = outline.sections.filter((s) => existsSync(sectionFile(s.id))).map((s) => s.id);

/** 已写小节的一句话摘要：给后文做衔接用，但不给它全文（否则会跟着抄）。
 *
 * 只用大纲里的 claim，**不看文件是否已写好**。这样每个小节的上下文完全由大纲决定，
 * 与生成顺序无关——分节并发才成立（2026-11-12 改成并发前，这里靠 existsSync 过滤，
 * 并发时前面几节还没落盘，衔接信息会随机缺失，输出不可复现）。
 */
function previousSummary(index) {
  return outline.sections.slice(0, index).map((s) => `- ${s.heading}：${s.claim}`).join('\n');
}

function factBlock(section) {
  const ids = section.factIds ?? [];
  const lines = ids.map((id) => {
    const f = factById.get(id);
    if (!f) return `- ${id}（⚠️ facts.json 里没有这条，不要引用）`;
    return `- ${f.group ? f.group + ' / ' : ''}${f.method || ''}${f.method ? ' | ' : ''}${f.column} = ${f.value}`;
  });
  // 这一节允许引用的数字：只给 ID 对应的值，避免模型自己去别处捞数
  return lines.length ? lines.join('\n') : '（本节不允许引用表格数字，只写机制与判断）';
}

/**
 * 稳定前缀：所有小节**逐字节相同**的那部分（论点 + 简报 + 术语表 + 论文原文）。
 *
 * 为什么要单独切出来：网关支持 prompt cache，前缀命中后 input 只按 10% 计费、
 * 首 token 也更快。8 个小节各带 4.5 万字的论文原文，串行时是 8 次全价；
 * 并发时这 8 次几乎同时发出，命中率取决于它们是否**同时**遇到「已存在的缓存」——
 * 所以并发前先用一次极短调用把前缀写进缓存（见 warmPrefix）。
 *
 * 顺序很关键：前缀里不能夹任何随小节变化的内容（「你在写第 3 节」这种），
 * 夹一个字节就整段失效。易变部分一律放在 prefix 之后的 user 尾部。
 */
function stablePrefix() {
  return [
    `# 全文论点\n${outline.thesis}`,
    briefing ? `# 写这一节要小心的事（来自外部调研）\n${briefing}` : '',
    glossaryBlock,
    `# 论文原文（技术细节以此为准，不要凭印象）\n${paper.slice(0, 45000)}`,
  ].filter(Boolean).join('\n\n');
}

const PREFIX = stablePrefix();

async function writeSection(section, index, attempt) {
  const isFirst = index === 0;
  const isLast = index === outline.sections.length - 1;
  const system = `你是「Paper to Post」的技术作者，写论文解读。
读者：${meta.target_reader ?? '算法工程师'}。
调性：克制、判断明确、不吹。
你只负责写文章的**其中一节**，不要写其它节，不要写总标题，不要写结语。

${spec}`;

  const user = `# 你在写哪一节
第 ${index + 1}/${outline.sections.length} 节：**${section.heading}**
这一节要让读者记住：${section.claim}
目标字数：${section.words ?? 800}

${section.notes ? `# 本节注意事项\n${section.notes}\n` : ''}
# 前面已经写过的小节（只用于衔接，不要重复它们的内容）
${previousSummary(index) || '（这是第一节）'}

# 本节可引用的数据（数字只能来自这里，其它数字一律不写）
${factBlock(section)}

# 本节可用的图
${(section.figures ?? []).map((f) => `- ${f}`).join('\n') || '（本节不插图）'}

# 输出要求
1. 直接输出这一节的 markdown，**从 \`## ${section.heading}\` 这一行开始**；
2. ${isFirst ? '这是第一节，开头第一段要直接给结论，不要用行话开场。' : `不要写「上一节我们讲了」这类过渡语，直接进入内容。`}
3. 行间公式写成一行：\`$$ ... $$\`；行内公式 \`$x$\`；
4. 表内数据只用上面「可引用的数据」，写的时候标明它属于哪个模型、哪个基准；
5. 加粗必须是「数字 + 意思」能独立读懂的短语；**加粗不要以标点开头**（\`**「xx」**\` 在 CommonMark 下不成立）；
6. 中文引号用「」，不要 ASCII 双引号；
7. 不用「不是A而是B」「值得注意的是」「首先其次」「综上」；
8. ${isLast ? '这是最后一节，要给出明确判断和适用边界。' : '不要写总结段，把总结留给最后一节。'}
9. 篇幅 ${Math.round((section.words ?? 800) * 0.75)}–${Math.round((section.words ?? 800) * 1.3)} 字。`;

  return llm.complete({
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    cachePrefix: PREFIX,
    maxTokens: Math.min(8192, Math.max(2000, Math.round((section.words ?? 800) * 3))),
    temperature: attempt === 1 ? 0.4 : 0.6,   // 第 2 版提温度，产出更不一样
  });
}

/**
 * 预热前缀缓存：发一次最小请求，让网关把 prefix 写进缓存。
 *
 * 为什么必须预热而不是靠第一次正式调用：小节是并发发的，
 * 8 个请求同时到达时都看不到「已存在的缓存」，会各自建一份（实测三次并发只有第三个命中）。
 * 预热一次（16 token 输出），后面所有小节就能命中。代价约 1 秒。
 */
async function warmPrefix() {
  if (!PREFIX) return;
  try {
    await llm.complete({
      messages: [{ role: 'user', content: '（预热）' }],
      cachePrefix: PREFIX,
      maxTokens: 8,
      temperature: 0,
    });
  } catch {
    // 预热失败不影响主流程：只是少省一点钱，不应该让生成失败
  }
}

/**
 * 修复一节：把「上一版 + 具体问题」给模型，只改这些问题。
 * 关键约束：**不许改结构、不许换论点**——修复环是为了满足硬规则，
 * 不是为了让它重写一遍（那等于把 best-of 的成果丢掉）。
 */
async function repairSection({ section, index, text, problems }) {
  return (await llm.complete({
    messages: [
      { role: 'system', content: '你是技术编辑，只做定点修改。保持原文的结构、论点和信息量，只修列出的问题。' },
      {
        role: 'user',
        content: `# 要修的这一节
${section.heading}
${section.claim ? `这一节要让读者记住：${section.claim}` : ''}

# 当前版本
${text}

# 必须修掉的问题
${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}

# 允许引用的数据（改完数字仍只能来自这里）
${factBlock(section)}

${glossaryBlock}
# 规则
1. **只修上面的问题**，不要重写整节，不要改变论证顺序；
2. 段落数量、每段讲什么保持原样；
3. 直接输出修改后的完整小节（从 \`## ${section.heading}\` 开始），不要解释你改了什么。`,
      },
    ],
    maxTokens: Math.min(8192, Math.max(2000, Math.round((section.words ?? 800) * 3))),
    temperature: 0.2,   // 修复要稳，不要发挥
  })).trim();
}

/** 粗略质量分：用于 best-of-N 选优。不追求准，只要能排开差的那个。 */function scoreSection(text, section) {
  let score = 0;
  const zh = (text.match(/[一-龥]/g) ?? []).length;
  const target = section.words ?? 800;
  // 离目标字数越近越好，超太多或不足都扣
  score -= Math.abs(zh - target) / target * 10;
  // 有加粗加分（写作规范要求）
  score += Math.min(5, (text.match(/\*\*[^*\n]+\*\*/g) ?? []).length);
  // 残留章节前缀（模型偶尔会把「第 3 节」写进去）扣分
  if (/^#+\s*第\s*\d+\s*节/m.test(text)) score -= 20;
  return score;
}

/**
 * 单节自检：只查「作品本身能不能过稿」的硬规则，和全文自检（publish-check）重叠但更严。
 * 修复环靠它给出具体问题，而不是笼统说「重写一遍」。
 */
function lintSection(text, section) {
  const problems = [];
  const zh = (text.match(/[一-龥]/g) ?? []).length;
  const target = section.words ?? 800;
  if (zh < target * 0.6) problems.push(`字数不足：${zh} 字，目标 ${target}（至少要有 ${Math.round(target * 0.6)}）`);
  if (zh > target * 1.6) problems.push(`字数超出：${zh} 字，目标 ${target}（最多 ${Math.round(target * 1.6)}）`);
  // 加粗后紧跟标点 → CommonMark 不成立，会印出星号
  const badBold = [...text.matchAll(/\*\*[「『（(《“"'][^*]*\*\*/g)].map((m) => m[0].slice(0, 20));
  if (badBold.length) problems.push(`加粗以标点开头（会印出星号）：${badBold.slice(0, 3).join('、')}`);
  // ASCII 引号
  const asciiQuotes = (text.match(/"/g) ?? []).length;
  if (asciiQuotes > 0) problems.push(`用了 ${asciiQuotes} 个 ASCII 双引号，应改成「」`);
  // 跨行 $$ 公式
  const multi = [...text.matchAll(/\$\$([^$]+)\$\$/g)].filter((m) => m[1].includes('\n')).length;
  if (multi) problems.push(`${multi} 个跨行 $$ 公式，必须写成一行`);
  // AI 味句式
  if (/不是[^，。]{2,12}而是/.test(text)) problems.push('出现「不是A而是B」句式');
  if (/值得注意的是|综上所述|首先.*其次.*最后/.test(text)) problems.push('出现 AI 味过渡句');
  // 数字必须在允许清单里
  const allowed = new Set((section.factIds ?? []).flatMap((id) => {
    const f = factById.get(id);
    return f ? f.parts : [];
  }).map((p) => String(p).replace(/^[+−-]/, '')));
  if (allowed.size) {
    const used = [...new Set((text.match(/\d+\.\d+/g) ?? []))];
    const stray = used.filter((n) => !allowed.has(n));
    // 允许章节号、年份这类；只报「看起来像数据」且不在清单里的
    const suspicious = stray.filter((n) => !/^(19|20)\d\d$/.test(n) && !/^\d{1,2}$/.test(n));
    if (suspicious.length) problems.push(`出现未授权数字：${suspicious.slice(0, 5).join('、')}（只允许引用给定的事实）`);
  }
  return problems;
}

/**
 * 生成一节：best-of-N → 修复环 → 落盘。
 *
 * 每节完全独立：上下文只由 outline + prefix 决定（不看别的节有没有落盘），
 * 所以可以并发。落盘在函数内部完成，`--only` 重跑和全量跑走同一条路径。
 *
 * @returns {Promise<object|null>} 成功返回结果摘要，全部尝试失败返回 null
 */
async function generateOne(section, index) {
  const startedAt = Date.now();
  let best = null;
  for (let attempt = 1; attempt <= bestOf; attempt++) {
    const started = Date.now();
    try {
      const text = (await writeSection(section, index, attempt)).trim();
      const score = scoreSection(text, section);
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`✓ ${section.id} ${section.heading}　${text.match(/[一-龥]/g)?.length ?? 0} 字　${elapsed}s　第${attempt}版　score ${score.toFixed(1)}`);
      if (!best || score > best.score) best = { text, score, attempt };
    } catch (error) {
      console.error(`✗ ${section.id} 第${attempt}版失败：${error.message}`);
    }
  }
  if (!best) {
    console.error(`✗ ${section.id} 全部尝试失败，跳过。修好后用 --only=${section.id} 重跑。`);
    return null;
  }

  // ---- 修复环：拿自检结果回喂重写，最多 maxRepair 轮 ----
  // 只对「硬规则不通过」的节重写；规则全过就直接收。
  // 每轮把**具体问题 + 上一版全文**一起给它，比笼统说「再改改」有效得多。
  const maxRepair = Number(args['repair-rounds'] ?? 2);
  let repairs = 0;
  for (let round = 1; round <= maxRepair; round++) {
    const problems = lintSection(best.text, section);
    if (!problems.length) break;
    console.log(`  ↻ ${section.id} 第 ${round} 轮修复：${problems.length} 个问题`);
    for (const p of problems.slice(0, 4)) console.log(`     · ${p}`);
    try {
      const fixed = await repairSection({ section, index, text: best.text, problems });
      const fixedScore = scoreSection(fixed, section);
      const remaining = lintSection(fixed, section);
      // 只有「问题变少」才采纳——防止修一轮反而改坏
      if (remaining.length < problems.length) {
        best = { text: fixed, score: fixedScore, attempt: `repair${round}` };
        repairs = round;
      } else {
        console.log(`     （修复后问题未减少，保留原版）`);
        break;
      }
    } catch (error) {
      console.error(`  ✗ 修复失败：${error.message}`);
      break;
    }
  }
  if (repairs) {
    const left = lintSection(best.text, section).length;
    console.log(`  ✓ ${section.id} 修复 ${repairs} 轮完成${left ? `，仍有 ${left} 个问题` : '，问题已清零'}`);
  }
  writeFileSync(sectionFile(section.id), best.text + '\n', 'utf8');
  console.log(`  ⏱ ${section.id} 总耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return { id: section.id, heading: section.heading, chars: (best.text.match(/[一-龥]/g) ?? []).length, score: best.score };
}

// ---- 并发生成 ----
// 2026-11-12：这里原本是 `for (const ...) await`，8 节串行，一节 20–60 秒，
// 光正文就要 4–8 分钟。而网关实测 16 并发长请求全部成功、24 并发也不报错，
// `.env` 却把并发压在 2——串行等待完全是自找的。
//
// 并发是安全的，因为每节的上下文**只由大纲决定**（见 previousSummary 的注释）。
// 唯一曾依赖执行顺序的地方是「前面已写过的小节」列表，已改成只读大纲。
const jobs = resolveJobs(args.jobs, 8);
const todo = outline.sections
  .map((section, index) => ({ section, index }))
  .filter(({ section }) => (!only || only.includes(section.id)));

const skipped = todo.filter(({ section }) => existsSync(sectionFile(section.id)) && !args.force);
for (const { section } of skipped) console.log(`⏭  ${section.id} ${section.heading}（已存在，--force 重写）`);
const work = todo.filter(({ section }) => !(existsSync(sectionFile(section.id)) && !args.force));

const results = [];
if (work.length) {
  await warmPrefix();
  if (work.length > 1) console.log(`并发 ${Math.min(jobs, work.length)} 节（--jobs 可调）\n`);
  const startedAll = Date.now();
  const produced = await mapPool(work, jobs, ({ section, index }) => generateOne(section, index));
  const wall = Math.round((Date.now() - startedAll) / 1000);
  for (const r of produced) if (r) results.push(r);
  console.log(`\n${work.length} 节完成，墙钟 ${wall}s`);
}

// ---- 拼装 ----
// 两道保护，缺一不可：
//   ① 只有「所有小节都在」才拼装——用 --only 重写一节时不能拼装；
//   ② 拼装结果如果比现有 article.md 明显短，拒绝写入并备份。
// 第 ② 条是事故后加的：先前只做了 ①，结果 ① 的条件成立（8 节文件都在 draft/ 里，
// 其中 7 个是上一轮遗留的），拼出来的却是 553 字，直接覆盖了 7355 字的成稿，
// 而且仓库没有 git 历史，最后只能从 dist/html 反推恢复。
// 字数只是代理指标，但它足够抓住「拼装后明显更短」这种致命情况。
let totalZh = 0;
const missing = outline.sections.filter((s) => !existsSync(sectionFile(s.id)));
const canAssemble = missing.length === 0;
const articlePath = join(dir, 'article.md');
const beforeZh = existsSync(articlePath)
  ? (readFileSync(articlePath, 'utf8').match(/[一-龥]/g) ?? []).length
  : 0;

if (canAssemble && !args['no-assemble']) {
  const parts = [`# ${meta.title ?? slug}`, ''];
  if (meta.digest) parts.push(`> ${meta.digest}`, '');
  for (const section of outline.sections) {
    parts.push(readFileSync(sectionFile(section.id), 'utf8').trim(), '');
  }
  // 拼装后立刻做结构排版：补元信息块、图表编号、标题编号、修粘连表格。
  // 放在这里而不是「发布前再补」，是因为 article.md 是所有下游的源头——
  // 知乎/小红书/公众号/H5 都从它派生，源头没编号，四份产物就都没有。
  const { formatArticle } = await import('./lib/article-format.mjs');
  const researchPath = join(dir, 'research.md');
  const linksPath = join(dir, 'assets', 'links.json');
  const full = formatArticle(parts.join('\n'), {
    meta,
    research: existsSync(researchPath) ? readFileSync(researchPath, 'utf8') : '',
    links: existsSync(linksPath) ? JSON.parse(readFileSync(linksPath, 'utf8')) : null,
  });
  totalZh = (full.match(/[一-龥]/g) ?? []).length;

  // 明显变短 = 拼装用的分节文件不完整/是旧版本，拒绝覆盖
  const GUARD_RATIO = 0.7;
  if (beforeZh > 500 && totalZh < beforeZh * GUARD_RATIO) {
    const backup = join(dir, `article.before-assemble-${Date.now()}.md`);
    writeFileSync(backup, readFileSync(articlePath, 'utf8'), 'utf8');
    console.error(`\n✗ 拒绝覆盖：拼装结果 ${totalZh} 字，现有 article.md 是 ${beforeZh} 字（不足 70%）。`);
    console.error('  多半是 draft/ 里混了旧版本或缺节。现有稿件已备份到：');
    console.error(`  ${backup}`);
    console.error('  确认要覆盖就删掉 / 加 --force-assemble。');
    if (!args['force-assemble']) process.exit(1);
    console.error('  （已按 --force-assemble 覆盖）');
  }
  writeFileSync(articlePath, full, 'utf8');
  console.log(`\n拼装 → articles/${slug}/article.md　共 ${totalZh} 中文字${beforeZh ? `（原 ${beforeZh}）` : ''}`);
} else if (missing.length) {
  console.log(`\n⚠️ 只有 ${outline.sections.length - missing.length}/${outline.sections.length} 节完成，**没有覆盖 article.md**。`);
  console.log(`   缺：${missing.map((s) => `${s.id} ${s.heading}`).join('、')}`);
  console.log('   全部写完后重跑 `npm run generate -- --slug=' + slug + '`（已有的节会自动跳过）即可拼装。');
}

console.log(`模型 ${llm.model}　本次 ${llm.usage.calls} 次调用　${(llm.usage.promptTokens + llm.usage.completionTokens).toLocaleString()} tokens${llm.usage.cacheReadTokens ? `（缓存命中 ${llm.usage.cacheReadTokens.toLocaleString()}）` : ''}`);
if (done.length) console.log(`（此前已完成 ${done.length} 节：${done.join(', ')}）`);

writeFileSync(join(dir, 'generate-log.json'), JSON.stringify({
  slug,
  generated_at: new Date().toISOString(),
  model: llm.model,
  usage: llm.usage,
  sections: results,
  total_zh_chars: totalZh || beforeZh,
}, null, 1), 'utf8');
