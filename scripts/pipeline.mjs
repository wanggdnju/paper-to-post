#!/usr/bin/env node
/**
 * 文案生成编排：一条命令跑完「素材 → 大纲 → 正文 → critic → 派生 → 评分」。
 *
 *   node scripts/pipeline.mjs --slug=dspine [--from=outline] [--to=score] [--dry]
 *
 * 每个阶段都是独立脚本，这个文件只负责「按顺序跑、失败就停、记录耗时和花费」。
 * 为什么不做成一个大脚本：单步失败要能单独重跑（大纲不满意只重跑 outline，
 * critic 太慢可以跳过），把逻辑内聚在一个文件里就做不到了。
 *
 * 阶段依赖：
 *   facts      需要 LaTeX 源（--src）
 *   glossary   需要论文全文（/tmp/<slug>.txt）
 *   outline    需要 briefing.json + facts.json + 论文全文
 *   generate   需要 outline.json
 *   polish     需要 article.md（只改表达，数字/表格/公式/标题机械校验）
 *   critic     需要 article.md（+ 可选 facts.json 提高准确率）
 *   derive     需要 article.md
 *   compare    需要 facts.json + article.md（数字对比要 facts，机制维度要正文）
 *   diagram    需要 article.md（首次 --gen 起草 spec，之后只渲染）
 *   score      需要以上全部
 *
 * 默认从「第一个还缺产物的阶段」开始，所以中断后直接重跑即可续上。
 *
 * ── 并发（2026-11-12）──
 * `group` 相同的阶段并发跑，不同 group 按声明顺序串行。
 * generate 之后的 critic / derive / compare / diagram 只读 article.md + facts.json，互不依赖，
 * 全部塞进 group 'after-article'：串行时它们相加 4–6 分钟，并发后等于最慢的那一个。
 * 需要严格顺序的地方（generate 必须在 outline 之后）用不同 group 表达。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/pipeline.mjs --slug=<slug> [--from=facts] [--to=score] [--src=LaTeX 目录] [--paper=全文.txt] [--dry]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
if (!existsSync(join(dir, 'article.yaml'))) {
  console.error(`✗ 没有 articles/${slug}/article.yaml，先 npm run publish -- --slug=${slug} --stage=new --arxiv=<id>`);
  process.exit(1);
}

const src = args.src ? String(args.src) : '';
const paper = args.paper ? String(args.paper) : `/tmp/${slug}.txt`;
// 并发数一路透传：pipeline --jobs=N → generate/critic 的 --jobs=N
const jobsArg = args.jobs ? [`--jobs=${args.jobs}`] : [];

/**
 * LaTeX 源的自动定位。
 *
 * 以前 `--src` 缺省时会硬编码 `/tmp/dspine-src`——换一篇论文，facts 阶段要么读别人的表，
 * 要么直接失败。而 `fetch:figures` 其实已经把 e-print 解到 `/tmp/eprint-<id>/`，
 * 这个位置是可直接用的。所以按顺序找：
 *   1. --src 显式指定
 *   2. /tmp/eprint-<arxiv_id>（fetch:figures 的默认解包位置）
 *   3. articles/<slug>/source/latex/tree
 */
function resolveSrc() {
  if (src) return src;
  const id = readFileSync(join(dir, 'article.yaml'), 'utf8').match(/^arxiv_id:\s*"?([^"\n]+)"?$/m)?.[1] ?? '';
  const candidates = [
    id ? `/tmp/eprint-${id}` : '',
    join(dir, 'source', 'latex', 'tree'),
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? '';
}

/** 阶段定义：name / 命令 / 产物（用于判断是否已完成）/ 前置条件 */
const STAGES = [
  {
    name: 'facts',
    run: () => ['scripts/facts.mjs', `--slug=${slug}`, `--src=${resolveSrc()}`, '--write'],
    produces: 'facts.json',
    requires: () => resolveSrc()
      ? null
      : '需要 --src=<LaTeX 源目录>（先解包 arXiv e-print；没有就跳过这一阶段，数字校验会退化）',
    optional: true,
  },
  {
    name: 'glossary',
    run: () => ['scripts/glossary.mjs', `--slug=${slug}`, `--paper=${paper}`],
    produces: 'glossary.json',
    requires: () => (existsSync(paper) ? null : `需要论文全文 ${paper}（用 --paper= 指定）`),
    optional: true,
  },
  {
    name: 'outline',
    run: () => ['scripts/outline.mjs', `--slug=${slug}`, `--paper=${paper}`],
    produces: 'outline.json',
    requires: () => {
      const missing = [];
      if (!existsSync(join(dir, 'briefing.json'))) missing.push('briefing.json（先跑 npm run briefing）');
      if (!existsSync(join(dir, 'facts.json'))) missing.push('facts.json');
      if (!existsSync(paper)) missing.push(paper);
      return missing.length ? `缺少：${missing.join('、')}` : null;
    },
  },
  {
    name: 'generate',
    run: () => ['scripts/generate.mjs', `--slug=${slug}`, `--paper=${paper}`, ...jobsArg],
    produces: 'article.md',
    requires: () => (existsSync(join(dir, 'outline.json')) ? null : '缺少 outline.json'),
  },
  {
    // 分节生成保证「每节自己讲清楚」，不保证「节与节之间接得上」「句子不绕」。
    // 润色只改表达，机械校验数字/表格/图片/公式/标题不变；任一节校验不过就保留原文。
    name: 'polish',
    run: () => ['scripts/polish.mjs', `--slug=${slug}`, ...jobsArg],
    produces: 'polish.json',
    requires: () => (existsSync(join(dir, 'article.md')) ? null : '缺少 article.md'),
  },
  {
    // 文末问答：由浅到深出题并作答，答案里的数字必须能在正文或 facts 里找到。
    // 排在 polish 之后——问答是独立生成的，不该再被润色改一遍。
    name: 'qa',
    run: () => ['scripts/qa.mjs', `--slug=${slug}`, ...jobsArg],
    produces: 'qa.json',
    requires: () => (existsSync(join(dir, 'article.md')) ? null : '缺少 article.md'),
    optional: true,
  },
  {
    name: 'critic',
    run: () => ['scripts/critic.mjs', `--slug=${slug}`, `--paper=${paper}`, ...jobsArg],
    produces: 'critic.json',
    requires: () => (existsSync(join(dir, 'article.md')) ? null : '缺少 article.md'),
    optional: true,
  },
  {
    name: 'derive',
    run: () => ['scripts/derive-variants.mjs', `--slug=${slug}`],
    produces: 'xhs-article.md',
    requires: () => (existsSync(join(dir, 'article.md')) ? null : '缺少 article.md'),
  },
  // 下面两步是「站上附加内容」，不影响发布：正文写完了也照样能发。
  // 所以都是 optional，失败不阻断后面的 score。
  // 顺序有讲究：compare 要先有 facts.json 才能出数字对比；
  // diagram 依赖 article.md 的方法章节，不依赖 compare。
  {
    name: 'compare',
    run: () => ['scripts/compare.mjs', `--slug=${slug}`],
    produces: 'compare.json',
    requires: () => {
      if (!existsSync(join(dir, 'facts.json'))) return '缺少 facts.json（数字对比无从生成）';
      if (!existsSync(join(dir, 'article.md'))) return '缺少 article.md';
      return null;
    },
    optional: true,
  },
  {
    name: 'diagram',
    // --gen 让模型起草 spec；已有 spec 时这一步是纯渲染，秒级、可反复跑
    run: () => ['scripts/diagram.mjs', `--slug=${slug}`,
      ...(existsSync(join(dir, 'diagram.json')) ? [] : ['--gen']), '--png'],
    produces: 'diagram.json',
    requires: () => (existsSync(join(dir, 'article.md')) ? null : '缺少 article.md'),
    optional: true,
  },
  {
    name: 'score',
    run: () => ['scripts/score.mjs', `--slug=${slug}`, '--record'],
    produces: 'score.json',
    requires: () => null,
  },
];

// 从哪个阶段开始：--from 指定，否则第一个产物缺失的阶段
const fromIdx = args.from ? STAGES.findIndex((s) => s.name === args.from) : -1;
const toIdx = args.to ? STAGES.findIndex((s) => s.name === args.to) : STAGES.length - 1;
if (args.from && fromIdx < 0) {
  console.error(`✗ 未知阶段 ${args.from}，可选：${STAGES.map((s) => s.name).join(' / ')}`);
  process.exit(1);
}
let start = fromIdx >= 0 ? fromIdx : STAGES.findIndex((s) => !existsSync(join(dir, s.produces)) || s.name === 'score');
if (start < 0) start = STAGES.length - 1;

/**
 * 阶段分组：同组并发，跨组串行。
 *
 * 依据是**产物依赖**而不是「脚本看起来有关」：
 *   - facts（LaTeX 表）与 glossary（论文全文 → 术语表）都只读输入，彼此无关 → 同组
 *   - outline 要 facts.json；glossary 只读论文全文，和 outline 互不依赖 → 同组
 *   - generate 同时要 outline.json 和 glossary.json → 在它们之后
 *   - critic / derive / compare / diagram 都只读 article.md（compare 另读 facts.json，
 *     而 facts 早在 sources 组就完成了）→ 同组
 *   - score 汇总上面所有产物 → 最后单独一组
 *
 * 该字段缺省时用阶段名，等价于「单独一组」，行为与旧版串行完全一致。
 */
const GROUPS = {
  facts: 'sources',
  glossary: 'outline',
  outline: 'outline',
  generate: 'generate',
  polish: 'polish',
  qa: 'qa',
  critic: 'after-article',
  derive: 'after-article',
  compare: 'after-article',
  diagram: 'after-article',
  score: 'score',
};

const plan = STAGES.slice(start, start <= toIdx ? toIdx + 1 : STAGES.length);

console.log(`流水线：${slug}　阶段 ${plan.map((s) => s.name).join(' → ')}\n`);
if (args.dry) {
  for (const s of plan) {
    const ok = existsSync(join(dir, s.produces));
    const req = s.requires();
    const g = GROUPS[s.name] ?? s.name;
    console.log(`${ok ? '✓' : ' '} ${s.name.padEnd(9)} [${g}] → ${s.produces}${req ? `　（${req}${s.optional ? '，可跳过' : ''}）` : ''}`);
  }
  process.exit(0);
}

const log = { slug, started_at: new Date().toISOString(), stages: [] };

/** 启动一个阶段，返回 { status, seconds }。stdio 继承，输出仍按进程写。 */
function launch(stage) {
  return new Promise((resolve) => {
    const [script, ...argv] = stage.run();
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, script), ...argv], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', (error) => resolve({ status: 'failed', seconds: 0, error }));
    child.on('close', (code) => resolve({ status: code === 0 ? 'ok' : 'failed', seconds: Math.round((Date.now() - started) / 1000) }));
  });
}

// 按 group 切块，保持声明顺序
const blocks = [];
for (const stage of plan) {
  const name = GROUPS[stage.name] ?? stage.name;
  const last = blocks[blocks.length - 1];
  if (last && last.name === name) last.stages.push(stage);
  else blocks.push({ name, stages: [stage] });
}

let blockedOrFailed = null;
for (const block of blocks) {
  // 先做前置检查：阻断性的直接停，可选的记 skipped
  const runnable = [];
  for (const stage of block.stages) {
    const req = stage.requires();
    if (!req) { runnable.push(stage); continue; }
    if (stage.optional) {
      console.log(`⏭  ${stage.name} 跳过：${req}`);
      log.stages.push({ name: stage.name, status: 'skipped', reason: req });
      continue;
    }
    console.error(`✗ ${stage.name}：${req}`);
    log.stages.push({ name: stage.name, status: 'blocked', reason: req });
    blockedOrFailed = stage.name;
  }
  if (blockedOrFailed) break;
  if (!runnable.length) continue;

  const concurrent = runnable.length > 1;
  if (concurrent) console.log(`\n=== ${block.name}（并发：${runnable.map((s) => s.name).join(' + ')}）===`);
  const outcomes = await Promise.all(runnable.map(async (stage) => {
    if (!concurrent) console.log(`\n=== ${stage.name} ===`);
    const out = await launch(stage);
    log.stages.push({ name: stage.name, status: out.status, seconds: out.seconds });
    console.log(`${out.status === 'ok' ? '✓' : '✗'} ${stage.name} ${out.seconds}s`);
    return { stage, out };
  }));
  const failed = outcomes.find((o) => o.out.status !== 'ok');
  if (failed) { blockedOrFailed = failed.stage.name; break; }
}

if (blockedOrFailed) {
  const stage = plan.find((s) => s.name === blockedOrFailed);
  if (stage && !stage.optional) {
    console.error(`\n✗ ${blockedOrFailed} 失败，后续阶段不再执行。`);
    console.error(`  修好后从这里续跑：node scripts/pipeline.mjs --slug=${slug} --from=${blockedOrFailed}`);
  }
  log.finished_at = new Date().toISOString();
  writeFileSync(join(dir, 'pipeline-log.json'), JSON.stringify(log, null, 1), 'utf8');
  process.exit(1);
}

log.finished_at = new Date().toISOString();
writeFileSync(join(dir, 'pipeline-log.json'), JSON.stringify(log, null, 1), 'utf8');
// 并发之后「各阶段耗时相加」不再等于墙钟（同组是取最大值），两个数都报出来，
// 否则会看到一个永远对不上的总数。
const sum = log.stages.filter((s) => s.seconds).reduce((a, s) => a + s.seconds, 0);
const wall = Math.round((Date.parse(log.finished_at) - Date.parse(log.started_at)) / 1000);
console.log(`\n全部完成：墙钟 ${wall}s（各阶段相加 ${sum}s）。日志：articles/${slug}/pipeline-log.json`);
console.log(`下一步：npm run publish -- --slug=${slug} --stage=drafted --digest="..."`);
