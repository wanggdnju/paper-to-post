#!/usr/bin/env node
/**
 * 发布流程驱动：按阶段推进一篇论文解读。
 *
 *   npm run publish -- --slug=dflash --status
 *   npm run publish -- --slug=dflash --stage=new --arxiv=2602.06036 [--title=...]
 *   npm run publish -- --slug=dflash --stage=drafted --digest="..."
 *   npm run publish -- --slug=dflash --stage=reviewed [--note="改了什么"]
 *   npm run publish -- --slug=dflash --stage=rendered
 *   npm run publish -- --slug=dflash --stage=published --url=kuaishou=...
 *
 * 阶段顺序：new → drafted → reviewed → rendered → published
 * 每个阶段结束都停住，等用户确认后才推进（这是流程的核心）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArxivId, tryParseArxivId } from './lib/arxiv.mjs';
import { parseArticle, stringifyArticle } from './lib/frontmatter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const globalPlatforms = parseArticle(readFileSync(join(ROOT, 'publish/config.yaml'), 'utf8')).data.platforms;
// 阶段顺序。outlined 和 checked 是自动化链路插入的两级检查点：
//   outlined —— 大纲出齐，等人审一眼（一页纸，30 秒）；
//   checked  —— 正文写完且 critic 跑过，自检通过之前的人工确认点。
// 为什么要有它们：生成一条 5000 字的稿子要几分钟到十几分钟，中途崩溃后
// 只靠 "drafted" 这一个状态无法表达「写到一半」，也留不住「大纲已确认」这件事。
const STAGES = ['new', 'outlined', 'drafted', 'checked', 'reviewed', 'rendered', 'published'];

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));

if (args.status) {
  printBoard();
  process.exit(0);
}
if (!args.slug) {
  console.error('用法：npm run publish -- --slug=<slug> --stage=<new|drafted|reviewed|rendered|published> [...字段]');
  console.error('      npm run publish -- --status');
  process.exit(1);
}

const slug = String(args.slug);
const articleDir = join(ROOT, 'articles', slug);
const yamlPath = join(articleDir, 'article.yaml');

if (args.stage === 'new') {
  if (!args.arxiv) fail('新开一篇必须提供 --arxiv=<arXivID 或 URL>，论文信息从 arXiv 拉，不手猜。');
  // 用户按文档会直接粘 https://arxiv.org/abs/xxxx，这里统一收口成裸 ID。
  // 不这么做的话，整个 URL 会被当成 ID 存进 article.yaml，后续 fetch-figures /
  // research-paper 静默取不到数据——标题变空串、调研整段跳过，且不报错。
  const { id: arxivId, version } = parseArxivId(args.arxiv);
  if (version) console.log(`ℹ️  带版本号 ${version}，元数据按最新版取（ID 存裸号）`);
  mkdirSync(articleDir, { recursive: true });
  if (existsSync(yamlPath)) {
    // 已有本篇（例如从旧目录迁入）：只补元数据，不重置已有状态
    const existing = loadDoc();
    existing.data.arxiv_id ||= arxivId;
    if (args.title) existing.data.title ||= String(args.title);
    writeFileSync(yamlPath, stringifyArticle(existing.data, readFileSync(yamlPath, 'utf8')));
    console.log(`已存在 ${yamlPath}，仅补 arXiv 元数据。当前状态：${existing.data.status}`);
    process.exit(0);
  }
  const meta = await fetchArxivMeta(arxivId);
  if (!meta.title) {
    console.error(`⚠️  arXiv API 没返回标题（${arxivId}）。先确认 ID 对不对；`);
    console.error('    确实取不到就加 --title="..." 手动指定，否则后续自检 A1 会拦住。');
  }
  writeFileSync(yamlPath, `# 本篇发文元数据。由 scripts/publish.mjs 推进，状态字段不要手改。
arxiv_id: "${arxivId}"
title: ${JSON.stringify(args.title ? String(args.title) : meta.title)}
authors: ${JSON.stringify(meta.authors)}
venue: ${JSON.stringify(args.venue ? String(args.venue) : '')}
slug: "${slug}"

status: new                 # new → drafted → reviewed → rendered → published
publish_completed: false
digest: ""                  # 80–128 字，公众号摘要也用这份
cover:
  big: ""                   # 封面上最大的那几个字（如 6×）
  num: ""                   # 封面主数字（如 6.08×）
  unit: ""                  # 数字的单位（如 GSM8K 加速比）
  vs: ""                    # 对比条（如 EAGLE-3 只有 2.23×）
  hook: ""                  # 一句话钩子
  cards: ""                 # 4 条佐证：标签~值，用 || 分隔，必须有一条诚实代价

files:
  article: ""               # 完整解读 markdown（默认 articles/<slug>/article.md）
  xhs: ""                   # 小红书短版（默认 articles/<slug>/xhs.md）
  zhihu: ""                 # 知乎发布稿，公式用 【公式N】 占位（默认 articles/<slug>/zhihu.md）

platforms:
${Object.entries(mergePlatformConfig(slug, globalPlatforms)).map(([name, cfg]) => `  ${name}: ${'{ ' + Object.entries(cfg).map(([k, v]) => `${k}: ${v}`).join(', ') + ' }'}`).join('\n')}

urls: {}
review: ""                  # 审稿报告路径（默认 articles/<slug>/review.md）
rendered_at: ""
published_at: ""
`);
  console.log(`已建 ${yamlPath}`);
  console.log('下一步：按 publish/writing-spec.md 写 articles/' + slug + '/article.md + xhs.md，然后');
  console.log(`  npm run publish -- --slug=${slug} --stage=drafted --digest="..."`);
  process.exit(0);
}

const doc = loadDoc();
doc.source = readFileSync(yamlPath, 'utf8');
const want = args.stage;

// report 是旁路命令：随时可跑，不推进状态机、不写 article.yaml
if (want === 'report') {
  const result = run('scripts/deliverable-report.mjs', [`--slug=${slug}`]);
  if (result.status !== 0) { process.stderr.write(result.stderr); fail('生成交付清单失败。'); }
  console.log(result.stdout);
  process.exit(0);
}

// 平台状态回写是旁路命令：`--platform=zhihu=draft` 单独给时只改那个字段，
// 不推进状态机。原来的实现在 `want` 之后才应用 --platform，而 `want` 必须先等于
// 下一阶段，于是「草稿建好了，把 zhihu 标成 draft」这件事做不了——
// 要么跳阶段（被拒），要么手改 yaml（状态字段约定不手改）。2026-11-13 撞到。
if (!args.stage && args.platform) {
  const entries = [].concat(args.platform);
  for (const e of entries) {
    const [name, status] = String(e).split('=');
    if (!name || !status) fail(`--platform 需要 name=status 形式，收到「${e}」`);
    if (!['todo', 'draft', 'published'].includes(status)) {
      fail(`平台状态只能是 todo / draft / published，收到「${status}」`);
    }
    const prev = doc.data.platforms?.[name]?.status;
    doc.data.platforms = { ...(doc.data.platforms ?? {}), [name]: { ...(doc.data.platforms?.[name] ?? {}), status } };
    console.log(`平台 ${name}：${prev ?? '（无）'} → ${status}`);
  }
  writeFileSync(yamlPath, stringifyArticle(doc.data, doc.source));
  process.exit(0);
}

if (!STAGES.includes(want)) fail(`未知阶段 ${want}，可选：${STAGES.join(' / ')} / report`);
const next = STAGES[STAGES.indexOf(doc.data.status) + 1];
if (want !== next) fail(`当前状态 ${doc.data.status}，下一阶段只能是 ${next}；不要跳阶段。`);
if (want === 'published' && !args.confirm) fail('发到公网不可撤回：加 --confirm 表示用户已确认逐平台发布完成。');

// outlined：大纲出齐就算过。检查它真的存在且不是 --dry 的空壳。
if (want === 'outlined') {
  const outlinePath = join(articleDir, 'outline.json');
  // --from-article：手写稿的回推入口。
  //
  // 先写正文再补大纲时，人只能要么手编一份（和正文对不上），要么跳过状态机。
  // 这里的做法是从 article.md 的 h2 和各节首段**回推**一份大纲：
  // 它记录的是「这篇实际怎么写成的」，字段口径与 outline.mjs 一致，后续 generate 不会用错。
  if (args['from-article'] && !existsSync(outlinePath)) {
    const articlePath = join(ROOT, doc.data.files?.article || `articles/${slug}/article.md`);
    if (!existsSync(articlePath)) fail(`--from-article 需要 article.md，但 ${articlePath} 不存在`);
    const { outlineFromArticle } = await import('./lib/outline-from-article.mjs');
    const md = readFileSync(articlePath, 'utf8');
    const outline = outlineFromArticle(md, doc.data.title ?? slug);
    writeFileSync(outlinePath, JSON.stringify(outline, null, 1));
    writeFileSync(join(articleDir, 'outline.md'),
      [`# 大纲：${slug}`, '', `> 论点：${outline.thesis}`, '',
        ...outline.sections.map((s, i) => `${i + 1}. **${s.heading}** — ${s.claim}`)].join('\n') + '\n');
    console.log(`↩︎ 从正文回推大纲：${outline.sections.length} 节（--from-article）`);
  }
  if (!existsSync(outlinePath)) fail(`没有 articles/${slug}/outline.json。手写稿可以加 --from-article 从正文回推，或先跑 npm run outline -- --slug=${slug}`);
  const outline = JSON.parse(readFileSync(outlinePath, 'utf8'));
  if (outline.dry) fail('outline.json 是 --dry 生成的空壳，先跑一次真正的 outline。');
  const emptyClaim = (outline.sections ?? []).filter((s) => !s.claim?.trim());
  if (emptyClaim.length) fail(`${emptyClaim.length} 个小节没有 claim（${emptyClaim.map((s) => s.heading).join('、')}），大纲不合格。`);
  console.log(`大纲：${outline.sections.length} 节，论点「${(outline.thesis ?? '').slice(0, 40)}…」`);
  console.log(`人审入口：articles/${slug}/outline.md`);
}

// checked：正文写完 + critic 跑过 + high 级问题已清。
if (want === 'checked') {
  const articlePath = join(ROOT, doc.data.files?.article || `articles/${slug}/article.md`);
  if (!existsSync(articlePath)) fail('正文还没写。');
  const criticPath = join(articleDir, 'critic.json');
  if (!existsSync(criticPath)) fail(`没有 critic.json，先跑 npm run critic -- --slug=${slug}`);
  const critic = JSON.parse(readFileSync(criticPath, 'utf8'));
  const high = (critic.findings ?? []).filter((f) => f.severity === 'high');
  // critic 的 high 是**编辑判断**，不是机器错误（数字/表格/结构才是）。
  // 默认只告警不阻断：这条链现在没有人工审稿环节，卡在这里等于把流程停在半路。
  // 需要严格把关时加 --strict。
  if (high.length) {
    const lines = high.slice(0, 5).map((f) => `    · ${f.problem}`);
    if (args.strict) {
      console.error(`✗ critic 还有 ${high.length} 条 high 级问题（--strict）：`);
      for (const l of lines) console.error(l);
      console.error('  逐条处理后再推进；判断为误报就加 --allow-high，或去掉 --strict 只告警。');
      process.exit(1);
    }
    console.warn(`⚠️ critic 有 ${high.length} 条 high 级问题（不阻断，发布前会在摘要里再列一次）：`);
    for (const l of lines) console.warn(l);
  }
  console.log(`critic：${critic.paragraphs_reviewed} 段，high ${high.length} / medium ${(critic.findings ?? []).filter((f) => f.severity === 'medium').length}`);
}

if (want === 'drafted') {
  if (!args.digest) fail('--stage=drafted 必须带 --digest（80–128 字）。');
  const m = String(args.digest).match(/[一-龥]/g)?.length ?? 0;
  if (m < 80 || m > 128) fail(`digest 中文 ${m} 字，需要在 80–128 之间。`);
  doc.data.digest = String(args.digest);
  doc.data.files.article ||= pickExisting([`articles/${slug}/article.md`, `articles/${slug}/${slug}.md`]);
  doc.data.files.xhs ||= pickExisting([`articles/${slug}/xhs.md`, `articles/${slug}/${slug}.xhs.md`]);
  doc.data.files.zhihu ||= pickExisting([`articles/${slug}/zhihu.md`, `articles/${slug}/${slug}.zhihu.md`], '');
  for (const key of ['article', 'xhs']) {
    if (!existsSync(join(ROOT, doc.data.files[key]))) fail(`${doc.data.files[key]} 不存在，先写稿。`);
  }
  checkResearch(slug);
}

if (want === 'reviewed') {
  const result = run('scripts/publish-check.mjs', [`--slug=${slug}`]);
  if (result.status !== 0) fail('机器自检未通过，按上面的 ❌ 逐条修，再重跑。');
  doc.data.review = `articles/${slug}/review.md`;
  writeFileSync(join(ROOT, doc.data.review), buildReviewReport(slug, result.stdout));
}

if (want === 'rendered') {
  // 传 doc.data，不是 doc。传整个 {data, source} 时 buildRenderArgs 里的
  // data.cover 永远是 undefined——封面参数一个都没传进去，渲染退回到脚本默认值
  // （曾经是 DFlash 的 6.08×/GSM8K）。2026-11-12 代码审查发现，属静默失败。
  const result = run('scripts/render-article.mjs', buildRenderArgs(doc.data));
  if (result.status !== 0) { process.stderr.write(result.stderr); fail('渲染失败。'); }
  doc.data.rendered_at = new Date().toISOString();
  console.log(result.stdout);
  // 素材出齐后顺手生成交付清单（渲染失败不写，避免清单里出现不存在的图）
  const report = run('scripts/deliverable-report.mjs', [`--slug=${slug}`]);
  if (report.status === 0) console.log(`📋 交付清单：articles/${slug}/交付清单.md`);
  // 切图刚生成，这时候的 C1/C1b/C3 才是有效检查（reviewed 阶段还没有切图，会跳过）。
  const recheck = run('scripts/publish-check.mjs', [`--slug=${slug}`]);
  if (recheck.status !== 0) {
    process.stderr.write(recheck.stdout);
    fail('渲染后的复检没通过（上面有 ❌）。切图/表格有问题先修，不要往下发布。');
  }
}

if (want === 'published') {
  const urls = Object.fromEntries(Object.entries(args).filter(([k]) => !['slug', 'stage', 'confirm', 'platform'].includes(k)).map(([k, v]) => [k, String(v)]));
  doc.data.urls = { ...doc.data.urls, ...urls };
  doc.data.publish_completed = true;
  doc.data.published_at = new Date().toISOString();
  doc.data.platforms = Object.fromEntries(Object.entries(doc.data.platforms ?? {}).map(([k, v]) => [k, { ...v, status: 'published' }]));
}

if (args.platform) {
  const [name, status] = String(args.platform).split('=');
  doc.data.platforms[name] = { ...(doc.data.platforms[name] ?? {}), status };
}
doc.data.status = want;
const dropComments = want === 'published' ? ['publish_completed'] : [];
if (want === 'drafted') dropComments.push('status');
writeFileSync(yamlPath, stringifyArticle(doc.data, doc.source, { rewriteComments: dropComments }));
console.log(`✅ ${slug}: ${want}`);
if (want === 'drafted') console.log(`下一步：npm run publish -- --slug=${slug} --stage=reviewed`);
if (want === 'reviewed') console.log(`审稿报告：${doc.data.review}\n下一步：npm run publish -- --slug=${slug} --stage=rendered`);
if (want === 'rendered') console.log(`图片在 dist/xhs/。逐平台发布后：npm run publish -- --slug=${slug} --stage=published --confirm --zhihu=<url> ...`);

// ---------------------------------------------------------------- helpers

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function run(script, argv) {
  return spawnSync(process.execPath, [join(ROOT, script), ...argv], { cwd: ROOT, encoding: 'utf8' });
}

/**
 * 写稿前的调研完整性检查。
 *
 * 为什么必须查：research-deep.md 是子智能体的产出，**没有对应脚本**，纯靠人记得让子智能体
 * 落盘。它缺失时 briefing.mjs 会把 ①-a「直接影响结论的几件事」整段跳过，
 * 简报照常生成、照常注入提示词——从流程上看不出少了任何东西。
 * DSpine 那一篇最值钱的四条（只领先 3.7%、block size 不对等、第三方未达标、量化部署全排除）
 * 全部在这段里，丢了也没人发现。
 *
 * 所以在这里硬拦：缺深度调研就 --allow-missing-research 显式跳过，让跳过成为一次决定。
 */
function checkResearch(slug) {
  const dir = join(ROOT, 'articles', slug);
  const has = (n) => existsSync(join(dir, n));
  const problems = [];

  if (!has('briefing.md')) {
    problems.push('没有 briefing.md —— 先跑 `npm run briefing -- --slug=' + slug + '`');
  } else {
    const brief = readFileSync(join(dir, 'briefing.md'), 'utf8');
    if (!/^### 直接影响结论的几件事/m.test(brief)) {
      problems.push('briefing.md 里没有「直接影响结论的几件事」——多半是 research-deep.md 缺失导致整段没生成');
    }
  }
  if (!has('research-deep.md')) {
    problems.push('没有 research-deep.md —— 派一个子智能体做深度调研，让它按固定小节落盘（见 e2e-runbook 2e）');
  }

  if (!problems.length) return;
  if (args['allow-missing-research']) {
    console.log('⚠️  调研不完整，已按 --allow-missing-research 跳过：');
    for (const p of problems) console.log(`    · ${p}`);
    return;
  }
  console.error('✗ 调研链不完整，写稿大概率会漏掉「论文没写但影响结论」的东西：');
  for (const p of problems) console.error(`    · ${p}`);
  console.error('  确实不需要（比如论文太新、社区无讨论）就加 --allow-missing-research 显式跳过。');
  process.exit(1);
}

function pickExisting(candidates, fallback = candidates[0]) {
  return candidates.find((p) => existsSync(join(ROOT, p))) ?? fallback;
}

function mergePlatformConfig(slug, globalPlatforms) {
  const defaults = Object.fromEntries(Object.entries(globalPlatforms ?? {}).map(([name, cfg]) => [name, { ...cfg, status: 'todo' }]));
  try {
    const local = parseArticle(readFileSync(join(ROOT, 'articles', slug, 'article.yaml'), 'utf8')).data.platforms ?? {};
    for (const [name, cfg] of Object.entries(local)) defaults[name] = { ...(defaults[name] ?? {}), ...cfg };
  } catch {
    // 新开一篇时还没有 article.yaml，用全局默认
  }
  return defaults;
}

async function fetchArxivMeta(id) {
  const bare = tryParseArxivId(id);   // 双保险：调用方已归一化，这里再兜一次
  if (!bare) return { title: '', authors: '' };
  try {
    const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(bare)}`, {
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': process.env.HTTP_USER_AGENT ?? 'paper-to-post' },
    });
    const xml = await response.text();
    const entry = xml.split('<entry>')[1] ?? '';
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ').trim();
    const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
    if (title) return { title, authors: authors.slice(0, 3).join('、') + (authors.length > 3 ? ' 等' : '') };
  } catch {
    // 离线时退化为空标题，写稿前人工补
  }
  return { title: '', authors: '' };
}

function loadDoc() {
  if (!existsSync(yamlPath)) fail(`没有 articles/${slug}/article.yaml，先 --stage=new --arxiv=<id>`);
  return parseArticle(readFileSync(yamlPath, 'utf8'));
}

function buildRenderArgs(data) {
  const files = data.files ?? {};
  const article = files.article || `articles/${slug}/article.md`;
  const out = `dist/xhs`;
  const cover = data.cover ?? {};
  // 封面数字是**发布物的一部分**，缺了就停在渲染前，别让它退回到脚本默认值。
  // 2026-11-12 代码审查发现：render-article 曾把 DFlash 的 `6.08×` 当默认值，
  // 任何一篇 yaml 少填 cover.num 都会安静地印上别的论文的数字。
  const missing = ['big', 'num', 'unit', 'vs'].filter((k) => !String(cover[k] ?? '').trim());
  if (missing.length) {
    fail(`article.yaml 的 cover 缺字段：${missing.map((k) => `cover.${k}`).join('、')}。`
      + '\n  封面必须写本篇的数字，不能沿用默认值。补完再 --stage=rendered。');
  }
  // 小红书用精简版正文切图（xhs-article.md 存在就优先）。**不再退回全文**：
  // 整篇塞进 18 屏必然被静默截断（render-article 只截不留提示），而 C6「有图有表」
  // 又因为文件不存在整条跳过——两个问题叠在一起，产物坏了没人报（2026-11-12 审查发现）。
  // 旧卡片模式（cards.md）保留给历史文章复现，但要求显式声明。
  const slideSource = files.xhs_article || `articles/${slug}/xhs-article.md`;
  const hasSlideSource = existsSync(join(ROOT, slideSource));
  const legacyCards = files.cards && existsSync(join(ROOT, files.cards));
  if (!hasSlideSource && !legacyCards) {
    fail(`既没有 ${slideSource}（小红书精简正文），也没有 cards.md。`
      + '\n  整篇 article.md 塞不进 18 屏，会被静默截断，且「有图有表」检查会整条跳过。'
      + `\n  先写 ${slideSource}（≥1 张架构图 + ≥1 张结果图 + ≥1 个表格，14 屏以内）。`);
  }
  const useCards = !hasSlideSource && Boolean(legacyCards);
  const inFile = hasSlideSource ? slideSource : article;
  if (!hasSlideSource) console.warn('⚠️  走旧卡片模式（cards.md），不是 H5 切图。');
  return [`--in=${inFile}`, `--out=${out}`, `--slug=${slug}`,
    ...(useCards ? [`--cards=${files.cards}`] : []),
    ...(cover.title ? [`--cover=${cover.title}`] : []),   // 封面短标题，长 H1 会顶到页脚
    ...(cover.big ? [`--big=${cover.big}`] : []),
    ...(cover.num ? [`--num=${cover.num}`] : []),
    ...(cover.unit ? [`--unit=${cover.unit}`] : []),
    ...(cover.hook ? [`--hook=${cover.hook}`] : []),
    ...(cover.cards ? [`--cards-data=${cover.cards}`] : []),
    ...(cover.vs ? [`--vs=${cover.vs}`] : []),
    // 教程/综述类不是「论文解读」，封面页眉那半句要能改。默认不传，历史文章不变。
    ...(data.kicker ? [`--kicker=${data.kicker}`] : []),
    `--id=${tryParseArxivId(data.arxiv_id) || data.arxiv_id || ''}`, `--venue=${data.venue ?? ''}`,
    ...(data.title ? [`--title=${data.title}`] : [])];
}

function buildReviewReport(currentSlug, stdout) {
  return `# 审稿报告：${currentSlug}\n\n生成时间：${new Date().toISOString()}\n\n\`\`\`\n${stdout.trim()}\n\`\`\`\n\n人工项见 publish/checklist.md。\n`;
}

function printBoard() {
  const dir = join(ROOT, 'articles');
  if (!existsSync(dir)) return;
  const rows = [];
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'article.yaml');
    if (!existsSync(file)) continue;
    const { data } = parseArticle(readFileSync(file, 'utf8'));
    const platforms = Object.entries(data.platforms ?? {}).map(([k, v]) => `${k}:${v.status}`).join(' ');
    rows.push([name, data.status ?? '?', platforms, data.arxiv_id ?? '']);
  }
  if (!rows.length) { console.log('还没有文章。npm run publish -- --slug=<slug> --stage=new --arxiv=<id>'); return; }
  const head = ['slug', 'status', 'platforms', 'arxiv'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(head));
  console.log(widths.map((w) => '─'.repeat(w)).join('  '));
  for (const row of rows) console.log(line(row));
}
