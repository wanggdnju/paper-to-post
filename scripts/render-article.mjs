#!/usr/bin/env node
/**
 * 把论文解读渲染成小红书长图（以及可选的 H5 页面）。
 *
 *   npm run render:article -- --in=article.md --out=dist/xhs [--title=...]
 *
 * 输出：
 *   dist/xhs/<slug>-00-cover.png   信息流封面（1080×1440）
 *   dist/xhs/<slug>-01.png …       正文手机屏截图（780×1040，3:4，按内容自动分页）
 *   dist/xhs/<slug>-labels.json    每屏讲什么（交付清单用）
 *
 * 早期这里还会把入参 markdown 加个 front matter 抄一份到 dist/xhs/<slug>.md。
 * 那是 `articles/<slug>/xhs-article.md` 的纯副本，**没有任何脚本读它**
 * （2026-11-12 核对：全仓无消费者），删掉以减少 dist 噪音。
 */
import { createServer } from 'node:http';
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import katex from 'katex';
import { marked } from 'marked';
import { envGet } from './lib/env.mjs';
import { loadExtras, renderExtrasMarkdown } from './lib/paper-extras.mjs';

const ROOT = process.cwd();
// 页眉/页码里的品牌名。默认取仓库名，可用 .env 的 SITE_NAME 换成自己的栏目。
const BRAND = envGet('SITE_NAME', ROOT) || 'Paper to Post';
const BRAND_UPPER = BRAND.toUpperCase();
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
if (!args.in) {
  console.error('Usage: node scripts/render-article.mjs --in=article.md --out=dist/xhs [--title=...]');
  process.exit(1);
}

const markdown = readFileSync(args.in, 'utf8');
const title = args.title ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? '论文解读';
const slug = args.slug ?? slugify(args.in.split('/').pop()?.replace(/\.md$/, '') ?? title);
const outDir = args.out ?? 'dist/xhs';// 封面把「让人停下来」的信息做成视觉层级：一个大字 + 主张 + 数字 + 对比 + 论文卡片
// 封面数据卡。**必须用 --cards-data，不能用 --cards**：
// `--cards` 在这个脚本里已经表示「用 cards.md 走卡片模式」的文件路径，
// 两个含义共用一个参数键，传数据串进来会被当成文件名去 readFileSync，直接 ENOENT 崩掉。
const cards = (args['cards-data'] ?? '').split('||').filter(Boolean).map((card) => card.split('~'));
// 封面数字**没有默认值**。以前这里写着 `num ?? '6.08×'`、`unit ?? 'GSM8K 加速比'`
// ——那是 DFlash 一篇的硬编码，别的论文漏传参数时会安静地印上别人的数据
// （2026-11-12 代码审查发现；publish.mjs 只在 yaml 有值时才传参，字段一空就中招）。
// 现在缺字段直接报错，让漏参变成一次可见的失败。
const missingCover = ['big', 'num', 'unit', 'vs'].filter((k) => !args[k]?.trim());
if (missingCover.length) {
  console.error(`✗ 封面缺参数：${missingCover.map((k) => `--${k}`).join('、')}`);
  console.error('  封面数字必须来自本篇论文，脚本不再提供跨论文默认值。');
  process.exit(1);
}
// kicker 是封面/页眉那行「<品牌> · 论文解读」的后半句。教程类文章不该被叫「论文解读」，
// 所以允许用 --kicker 覆盖；默认保持原样，历史文章一个字都不变。
const cover = { big: args.big, title: args.cover ?? title, num: args.num, unit: args.unit, vs: args.vs, hook: args.hook ?? '', cards, id: args.id ?? '', venue: args.venue ?? '', kicker: args.kicker ?? '论文解读' };
mkdirSync(outDir, { recursive: true });

const files = [];   // 保持输出结构里的 files 字段，目前为空（不再产出 markdown 副本）

const COVER_CSS = `
.cover { position: relative; width: 1080px; height: 1440px; box-sizing: border-box; padding: 110px 88px;
  background:
    radial-gradient(900px 620px at 85% 8%, rgba(94,234,212,0.28), transparent 62%),
    radial-gradient(760px 560px at 6% 96%, rgba(167,139,250,0.30), transparent 60%),
    #070b18;
  color: #fff; font-family: 'PingFang SC', 'Hiragino Sans GB', system-ui, sans-serif; overflow: hidden; }
.cover::after { content: ''; position: absolute; inset: 34px; border: 2px solid rgba(94,234,212,0.22); border-radius: 40px; pointer-events: none; }
.cover .eyebrow { font-size: 26px; letter-spacing: 0.32em; color: #5eead4; font-weight: 600; }
.cover .big { font-size: 250px; line-height: 0.95; font-weight: 800; letter-spacing: -0.05em; margin: 40px 0 18px;
  background: linear-gradient(135deg, #ffffff 8%, #5eead4 52%, #a78bfa 96%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.cover .title { font-size: 58px; line-height: 1.28; font-weight: 700; color: #f1f5ff; letter-spacing: -0.01em; }
.cover .metric { display: flex; align-items: baseline; gap: 20px; margin-top: 34px; }
.cover .metric .num { font-size: 132px; font-weight: 800; color: #5eead4; line-height: 1; letter-spacing: -0.03em; }
.cover .metric .unit { font-size: 32px; color: #9aa8c7; }
.cover .vs { display: inline-block; margin-top: 20px; padding: 18px 30px; border-radius: 999px;
  background: rgba(251,191,36,0.14); border: 1px solid rgba(251,191,36,0.45); color: #fbbf24; font-size: 36px; font-weight: 600; }
.cover .hook { margin-top: 30px; font-size: 42px; font-weight: 600; color: #fbbf24; line-height: 1.45; }
.cover .cards { position: relative; margin-top: 38px; border-top: 1px solid rgba(148,163,184,0.25); }
.cover .card-row { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 0; border-bottom: 1px solid rgba(148,163,184,0.18); }
.cover .card-row .k { font-size: 31px; color: #9aa8c7; }
.cover .card-row .v { font-size: 34px; color: #e6ecff; font-weight: 700; }
.cover .cover-body { transform-origin: top left; }
.cover .foot { position: absolute; left: 88px; bottom: 66px; font-size: 26px; color: #6b7a9c; letter-spacing: 0.04em; }
`;

const SLIDE_CSS = `
/* 手机视口：390×520pt（2x 出图 780×1040，3:4），和小红书封面比例一致 */
html, body { margin: 0; background: #f4f1ea; }
.slide { width: 390px; min-height: 520px; box-sizing: border-box; padding: 22px 22px 16px; display: flex; flex-direction: column;
  background: #f4f1ea; color: #1d1d1d;
  font-family: 'PingFang SC','Hiragino Sans GB','Songti SC',system-ui,sans-serif; font-size: 12px; line-height: 1.7; }
.slide h1 { font-size: 21px; line-height: 1.3; margin: 0 0 18px; letter-spacing: -.01em; font-weight: 900; }
.slide h2 { font-size: 16.5px; line-height: 1.35; margin: 0 0 12px; padding-left: 10px; border-left: 4px solid #d9633b; font-weight: 900; }
.slide h3 { font-size: 14.5px; margin: 0 0 10px; color: #2a2620; font-weight: 800; }
.slide p { margin: 0 0 10px; }
.slide strong { color: #0f0f0f; font-weight: 800; background: linear-gradient(transparent 60%, #f7d98a 60%); }
.slide blockquote { margin: 0 0 14px; padding: 10px 14px; border-left: 4px solid #d9633b; background: #ebe5d7; border-radius: 0 8px 8px 0; font-size: 12px; line-height: 1.66; }
.slide ul, .slide ol { margin: 0 0 12px; padding-left: 1.15em; }
.slide li { margin-bottom: 4px; }
/* 表格：长表会被拆成每片 ≤5 行（见 SPLIT_ROWS），所以单片不高，字号可以到 12px。
   2026-11-18 之前是 8px + 整表一屏，手机上是一团灰点，读不了。 */
.slide table { width: 100%; max-width: 100%; table-layout: fixed; border-collapse: collapse; margin: 0 0 12px; font-size: 12px; line-height: 1.45; }
.slide th, .slide td { border: 1px solid #d8d1c2; padding: 7px 5px; text-align: center; word-break: break-word; }
.slide th:first-child, .slide td:first-child { text-align: left; }
.slide td strong { background: none; }
.slide th { background: #1f1d1a; color: #f4f1ea; }
.slide img { max-width: 100%; border-radius: 6px; display: block; background: #fff; border: 1px solid #e3dccd; }
.slide .fig.bleed img { width: calc(100% + var(--bleed, 0%) * 2); max-width: none; margin-left: calc(var(--bleed, 0%) * -1); }
.slide .figcap { font-size: 10.5px; line-height: 1.6; color: #6b655c; margin: 6px 0 10px; }
.slide .figcap b { color: #b8451f; }
.slide .formula { overflow-x: auto; margin: 0 0 10px; font-size: 9px; }
.slide .formula .katex-display { margin: 2px 0; }
.slide .katex-display > .katex { white-space: nowrap; }
.slide .titlepage { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.slide .titlepage h1 { font-size: 28px; }
.slide .titlepage .metabar { margin-top: 22px; font-size: 15px; line-height: 1.8; color: #45403a; }
.slide .titlepage .metabar b { color: #1d1d1d; }
.slide .eyebrow { font-size: 11px; letter-spacing: .26em; color: #8a8376; margin-bottom: 20px; font-weight: 600; }
.slide .banner { display: flex; align-items: center; justify-content: space-between; font-size: 10.5px; letter-spacing: .12em;
  color: #8a8376; margin-bottom: 10px; font-weight: 600; }
.slide .page-no { display: flex; justify-content: space-between; font-size: 10px; color: #a39b8b; margin-top: auto; padding-top: 10px; letter-spacing: .08em; }
.slide .slide-body { }
.slide .wide-table { margin-left: -20px; margin-right: -20px; }
.slide.wide-page { padding-left: 12px; padding-right: 12px; }
`;

const PAGE_CSS = `
@page { size: 1080px 1440px; margin: 0; }
html, body { margin: 0; background: #0b1020; }
.card { position: relative; width: 1080px; min-height: 1440px; box-sizing: border-box; padding: 88px 80px 110px;
  background: #0b1020; color: #e6ecff; font-family: 'PingFang SC', 'Hiragino Sans GB', system-ui, sans-serif;
  font-size: 36px; line-height: 1.8; }
.card h1 { font-size: 60px; line-height: 1.3; margin: 0 0 30px; color: #fff; }
.card h2 { font-size: 44px; margin: 52px 0 18px; color: #5eead4; line-height: 1.4; border: none; }
.card h3 { font-size: 38px; margin: 36px 0 14px; color: #c7d2fe; }
.card p { margin: 0.65em 0; }
.card strong { color: #fff; }
.card hr { display: none; }
.card blockquote { margin: 22px 0; padding: 16px 26px; border-left: 6px solid #5eead4; background: rgba(94,234,212,0.08); border-radius: 0 12px 12px 0; color: #cbd5f5; }
.card code { font-family: 'JetBrains Mono', Menlo, monospace; font-size: 0.84em; background: rgba(148,163,184,0.16); padding: 3px 8px; border-radius: 6px; }
.card pre { background: #0f172a; border: 1px solid #24304f; border-radius: 16px; padding: 24px 26px; overflow: hidden; font-size: 28px; line-height: 1.6; }
.card pre code { background: none; padding: 0; }
.card table { width: 100%; border-collapse: collapse; margin: 26px 0; font-size: 27px; }
.card th, .card td { border: 1px solid #24304f; padding: 12px 14px; text-align: left; }
.card th { background: #151d38; color: #fff; }
.card ul, .card ol { padding-left: 1.3em; }
.card .katex-display { margin: 24px 0; overflow-x: auto; }
.card .formula { overflow-x: auto; }
.card math { color: inherit; font-size: 1.02em; }
.card .imath { display: inline-block; vertical-align: -0.25em; line-height: 1.2; }
.card .imath math { font-size: 1em; }
.card .katex { font-size: 0.98em; color: inherit; }
.card img { max-width: 100%; border-radius: 16px; }
.card .page-no { position: absolute; right: 80px; bottom: 40px; color: #6b7a9c; font-size: 24px; }
`;

const CARD_CSS = `
/* ---- 小红书卡片 v3：浅色纸质底 + 大留白 + 数据卡片网格 ---- */
.xcard { position: relative; width: 1080px; height: 1440px; box-sizing: border-box; padding: 84px 76px 96px;
  background-color: #f4f1ea; color: #1d1d1d; overflow: hidden; display: flex; flex-direction: column;
  font-family: 'PingFang SC','Hiragino Sans GB','Songti SC',system-ui,sans-serif; }
/* 纸张噪点 */
.xcard::after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background-image: radial-gradient(rgba(0,0,0,.045) 1px, transparent 1px); background-size: 5px 5px; }
.xcard::before { content: ''; position: absolute; inset: 0; background-image: var(--bg-img, none); background-size: cover; background-position: center; }
.xcard > * { position: relative; z-index: 1; }

.vhead { display: flex; align-items: center; justify-content: space-between; font-size: 26px; letter-spacing: .12em; color: #8a8376; }
.vhead .brand-mark { display: flex; align-items: center; gap: 12px; font-weight: 600; color: #3d3a34; }
.vhead .dot { width: 14px; height: 14px; border-radius: 50%; background: #f2c14e; }

.xcard .tag { align-self: flex-start; font-size: 25px; letter-spacing: .16em; color: #5c5750; font-weight: 600;
  background: #e6e0d3; border-radius: 6px; padding: 10px 22px; margin-bottom: 34px; }
.xcard .content { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: flex-start; }
.xcard .content > .callout { margin-top: auto; }
.xcard .flow, .xcard .steps, .xcard .versus, .xcard .grid, .xcard .cmp, .xcard .quote { margin-bottom: 34px; }
.xcard h1.mega { font-size: 168px; line-height: .96; font-weight: 900; letter-spacing: -.05em; margin: 0; color: #141414; }
.xcard .content > :first-child { margin-top: 18px; }
.xcard h2.xk { font-size: 84px; line-height: 1.2; font-weight: 800; letter-spacing: -.02em; margin: 0 0 40px; color: #141414; }
.xcard h2.xk em, .xcard h1.mega em { font-style: normal; color: #d9633b; }
.xcard .deck { font-size: 34px; line-height: 1.6; color: #5c5750; margin: 18px 0 34px; font-weight: 500; }
.xcard .lead { font-size: 44px; line-height: 1.62; color: #2a2a2a; margin: 0 0 34px; font-weight: 600; }
.xcard .body { font-size: 34px; line-height: 1.72; color: #45403a; margin: 0 0 26px; }
.xcard .quote { margin: 6px 0 34px; padding: 30px 36px; background: #f7e3c4; border-radius: 4px;
  font-size: 40px; line-height: 1.55; font-weight: 700; color: #2b2417; }
.xcard .callout { margin-top: auto; padding: 30px 34px; border-radius: 4px; background: #e6e0d3;
  font-size: 33px; line-height: 1.6; color: #2b2823; font-weight: 600; }
.xcard .callout b, .xcard .callout strong { color: #b8451f; }
.xcard .page-no { position: absolute; right: 76px; bottom: 40px; font-size: 24px; color: #a39b8b; letter-spacing: .08em; z-index: 2; }
.xcard .foot { position: absolute; left: 76px; bottom: 40px; font-size: 24px; color: #a39b8b; letter-spacing: .1em; z-index: 2; }

/* 大数字块：整屏冲击 */
.xhero { display: flex; flex-direction: column; justify-content: center; flex: 1; }
.xhero .kicker { font-size: 34px; color: #5c5750; letter-spacing: .06em; margin-bottom: 10px; font-weight: 600; }
.xhero .huge { font-size: 210px; line-height: .92; font-weight: 900; letter-spacing: -.06em; color: #141414; }
.xhero .huge em { font-style: normal; color: #d9633b; }
.xhero .sub { font-size: 52px; line-height: 1.45; color: #2a2a2a; font-weight: 600; margin-top: 26px; }
.xhero .sub small { display: block; font-size: 32px; color: #6b655c; font-weight: 500; margin-top: 14px; }

/* 插图 + 并列 */
.illus { width: 100%; border-radius: 6px; overflow: hidden; background: #efeadf; margin: 0 0 30px; }
.illus img { width: 100%; max-height: 640px; object-fit: cover; display: block; }
.split { display: grid; grid-template-columns: 1.05fr 1fr; gap: 20px; margin: 0 0 30px; align-items: stretch; }
.split .pic { display: flex; align-items: center; justify-content: center; padding: 0; }
.split .pic { border-radius: 6px; overflow: hidden; background: #efeadf; }
.split .pic img { width: 100%; height: auto; max-height: 520px; object-fit: contain; display: block; }
.split .side { background: #fff; border-radius: 6px; padding: 28px 26px; display: flex; flex-direction: column; justify-content: space-between; min-height: 520px; }
.split .side > div { margin-bottom: 10px; }
.split .side .k { font-size: 24px; color: #8a8376; }
.split .side .v { font-size: 52px; font-weight: 900; line-height: 1; letter-spacing: -.03em; }
.split .side .note { font-size: 25px; line-height: 1.5; color: #6b655c; }

/* 数据卡片网格：2 列，一屏 4 格 */
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 8px 0 26px; }
.tile { background: #ffffff; border-radius: 6px; padding: 30px 30px 28px; display: flex; flex-direction: column; gap: 10px;
  box-shadow: 0 1px 0 rgba(0,0,0,.04); }
.tile.warm { background: #f7e3c4; }
.tile.dark { background: #1f1d1a; color: #f4f1ea; }
.tile .k { font-size: 25px; color: #8a8376; letter-spacing: .04em; }
.tile.dark .k { color: #a9a294; }
.tile .v { font-size: clamp(38px, 6.2vw, 70px); white-space: nowrap; font-weight: 900; line-height: 1; letter-spacing: -.03em; color: #141414; }
.tile.dark .v { color: #fff; }
.tile .v small { font-size: 30px; font-weight: 700; margin-left: 4px; letter-spacing: 0; }
.tile .note { font-size: 24px; line-height: 1.45; color: #6b655c; }
.tile.dark .note { color: #b5ae9f; }
.tile.wide { grid-column: span 2; }

/* 横向对比条 */
.cmp { margin: 6px 0 26px; }
.cmp .row { display: flex; align-items: center; gap: 22px; margin-bottom: 26px; }
.cmp .name { width: 260px; text-align: right; font-size: 30px; color: #45403a; font-weight: 600; flex: none; }
.cmp .track { flex: 1; height: 66px; background: #e6e0d3; border-radius: 4px; overflow: hidden; }
.cmp .fill { height: 100%; display: flex; align-items: center; justify-content: flex-end; padding-right: 20px;
  font-size: 36px; font-weight: 900; color: #141414; background: #f2c14e; border-radius: 4px; }
.cmp .fill.hot { background: #d9633b; color: #fff; }

/* 步骤条 */
.steps { margin: 6px 0 22px; }
.steps .step { display: flex; gap: 24px; align-items: flex-start; margin-bottom: 24px; }
.steps .n { flex: none; width: 54px; height: 54px; border-radius: 50%; background: #1f1d1a; color: #f4f1ea;
  font-size: 26px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
.steps .t { font-size: 34px; line-height: 1.5; color: #2a2a2a; font-weight: 600; padding-top: 4px; }
.steps .t span { display: block; font-size: 27px; color: #6b655c; font-weight: 400; margin-top: 4px; }

/* 两栏对照 */
.versus { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 6px 0 26px; }
.versus .col { background: #fff; border-radius: 6px; padding: 28px 26px; }
.versus .col.good { background: #1f1d1a; color: #f4f1ea; }
.versus .col h4 { font-size: 30px; margin: 0 0 16px; color: #8a8376; font-weight: 700; }
.versus .col.good h4 { color: #f2c14e; }
.versus .col li { font-size: 29px; line-height: 1.55; color: #45403a; margin-bottom: 8px; }
.versus .col.good li { color: #e8e2d8; }
.versus .col ul { margin: 0; padding-left: 1.05em; }

/* 封面式大标题页 */
.xcover { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.xcover .series { font-size: 30px; letter-spacing: .3em; color: #8a8376; margin-bottom: 28px; }
.xcover .t1 { font-size: 120px; line-height: 1.02; font-weight: 900; letter-spacing: -.04em; color: #141414; }
.xcover .t1 em { font-style: normal; color: #d9633b; }
.xcover .rule { width: 120px; height: 8px; background: #f2c14e; margin: 34px 0; }
.xcover .t2 { font-size: 38px; line-height: 1.55; color: #45403a; font-weight: 500; }

`;

// ---- 长图渲染 ----
const { chromium } = await import('playwright');
// KaTeX 字体：page.setContent 的页面是 about:blank，外链字体会静默失败。
// 做法是启动本地静态服务托管 node_modules/katex/dist，页面用 http://127.0.0.1 加载，
// 字体就能正常解析（已验证 about:blank 下即使内联 base64 也不加载）。
const katexRoot = join(dirname(new URL(import.meta.url).pathname), '../node_modules/katex/dist');
const katexCss = readFileSync(join(katexRoot, 'katex.min.css'), 'utf8');
const server = createServer((request, response) => {
  const url = decodeURIComponent((request.url ?? '/').split('?')[0]);
  if (url.startsWith('/file/')) {
    const file = url.slice(6);
    if (!existsSync(file)) { response.writeHead(404).end(); return; }
    const type = file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'image/jpeg' : 'application/octet-stream';
    // CORS：页面要读图片像素做留白检测，无此头 canvas 会被污染
    response.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' }).end(readFileSync(file));
    return;
  }
  if (url.startsWith('/asset/')) {
    const asset = join(process.cwd(), url.slice(7));
    if (!asset.startsWith(process.cwd()) || !existsSync(asset)) { response.writeHead(404).end(); return; }
    const type = asset.endsWith('.png') ? 'image/png' : 'image/jpeg';
    response.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' }).end(readFileSync(asset));
    return;
  }
  const file = join(katexRoot, url.replace(/^\/+/, ''));
  if (!file.startsWith(katexRoot) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : file.endsWith('.ttf') ? 'font/ttf' : 'application/octet-stream';
  response.writeHead(200, { 'content-type': type }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const assetBase = `http://127.0.0.1:${server.address().port}`;
const css = `<link rel="stylesheet" href="${assetBase}/katex.min.css">\n<base href="${assetBase}/">\n<style>\n${COVER_CSS}\n${PAGE_CSS}\n${CARD_CSS}\n</style>`;
const browser = await chromium.launch({ headless: true, ...(findChromium() ? { executablePath: findChromium() } : {}) });
const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 2 });
// 清掉上次渲染遗留的分页图片，避免混进这次的结果
for (const name of fs.readdirSync(outDir)) {
  if (name.startsWith(`${slug}-`) && name.endsWith('.png') && /^\d+\.png$/.test(name.slice(slug.length + 1))) {
    fs.rmSync(join(outDir, name));
  }
}
// ---- 封面长图（第一张，用于信息流吸引力）----
async function renderCover() {
  // 内容只用 .textContent 写入，避免标题里的 < > & 破坏 HTML
  const coverHtml = `<div class="cover">
    <div class="cover-body">
      <div class="eyebrow">${BRAND_UPPER} · <span data-v="kicker"></span></div>
      <div class="big" data-v="big"></div>
      <div class="title" data-v="title"></div>
      ${cover.hook ? '<div class="hook" data-v="hook"></div>' : ''}
      <div class="metric"><span class="num" data-v="num"></span><span class="unit" data-v="unit"></span></div>
      <div class="vs" data-v="vs"></div>
      ${cover.cards.length ? '<div class="cards">' + cover.cards.map((card) => `<div class="card-row"><span class="k"></span><span class="v"></span></div>`).join('') + '</div>' : ''}
    </div>
    <div class="foot" data-v="foot"></div>
  </div>`;
  const page = await browser.newPage({ viewport: { width: 1080, height: 1440 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">${css}</head><body>${coverHtml}</body></html>`, { waitUntil: 'load' });
  await page.evaluate((values) => {
    document.querySelectorAll('[data-v]').forEach((node) => {
      node.textContent = values[node.getAttribute('data-v')] ?? '';
    });
    document.querySelectorAll('.cards .card-row').forEach((row, index) => {
      row.children[0].textContent = values.cards[index]?.[0] ?? '';
      row.children[1].textContent = values.cards[index]?.[1] ?? '';
    });
  }, { ...cover, foot: (() => {
    // 页脚去重：venue 里已经带了这个 arXiv 号（dspine 的 venue 就写成「arXiv 2609.36173」），
    // 再拼一遍会变成「arXiv:2609.36173 · arXiv 2609.36173」。
    const id = String(cover.id ?? '');
    const venue = String(cover.venue ?? '');
    const parts = [id ? `arXiv:${id}` : '', venue].filter(Boolean);
    return parts.filter((p, i) => i === 0 || !(id && p.includes(id))).join(' · ');
  })() });

  // 封面固定在 1080×1440 且 overflow:hidden——内容超长会被**直接裁掉**，
  // 截图看着正常，只是少了最后几行（2026-11-12 实际发生：dspine 第 4 张卡片压在图脚下，
  // overlap 56px；dflash / eagle 也各差 18px，末行卡片贴住了 arXiv 页脚）。
  //
  // 处理顺序：先试**整体缩小封面正文**（transform: scale，正文是字号驱动，缩得动），
  // 缩到 0.85 还放不下才报错——那时候说明字数真的超了，得改文案。
  // 不能只报错：这几篇的内容本身没问题，只是差十几像素。
  const measure = () => page.evaluate(() => {
    const coverEl = document.querySelector('.cover');
    const foot = document.querySelector('.foot');
    const cards = document.querySelector('.cards');
    const bodyEl = document.querySelector('.cover-body');
    const footTop = foot.getBoundingClientRect().top;
    let contentBottom = 0;
    for (const el of bodyEl.querySelectorAll('.big, .title, .hook, .metric, .vs, .cards')) {
      contentBottom = Math.max(contentBottom, el.getBoundingClientRect().bottom);
    }
    return {
      overlap: Math.round(contentBottom - footTop),
      bodyHeight: Math.round(bodyEl.getBoundingClientRect().height),
      bodyTop: Math.round(bodyEl.getBoundingClientRect().top),
      footTop: Math.round(footTop),
      cardRows: cards ? cards.querySelectorAll('.card-row').length : 0,
    };
  });
  let overflow = await measure();
  if (overflow.overlap > -24) {
    // 可用高度 = 页脚顶边 − 正文顶边 − 24px 安全间距
    const room = overflow.footTop - overflow.bodyTop - 24;
    const k = Math.min(1, room / overflow.bodyHeight);
    if (k >= 0.85) {
      await page.evaluate((k) => {
        const bodyEl = document.querySelector('.cover-body');
        bodyEl.style.transform = `scale(${k.toFixed(4)})`;
        bodyEl.style.transformOrigin = 'top left';
        bodyEl.style.width = `${(100 / k).toFixed(3)}%`;
      }, k);
      overflow = await measure();
      console.warn(`ℹ️ 封面正文缩放到 ${k.toFixed(2)} 以避让页脚（重叠 ${overflow.overlap}px）`);
    }
  }
  if (overflow.overlap > -24) {
    console.error(`✗ 封面内容压到页脚了（重叠 ${overflow.overlap}px，${overflow.cardRows} 张卡片）。`);
    console.error('  缩到 0.85 仍放不下，说明文案确实太长：减少 --cards-data 的条目，或缩短 --hook。');
    process.exitCode = 1;
    await page.close();
    return;
  }
  await page.screenshot({ path: join(outDir, `${slug}-00-cover.png`) });
  await page.close();
}
await renderCover();

const images = [`${slug}-00-cover.png`].map((name) => join(outDir, name));
// 小红书默认走「H5 页面切图」：正文当成一个手机网页，按 390×693pt（2x）的屏幕一段段截下来。
// 卡片脚本（cards.md）只在显式传 --cards 时使用。
const slideLimit = args['slide-limit'] ? Number(args['slide-limit']) : 17; // 小红书单篇最多 18 图，扣掉封面
let slideLabels = [];
if (args.cards) {
  images.push(...(await renderCards(readFileSync(args.cards, 'utf8'))));
} else {
  // 派生区块（机制图 + 横向对比）在渲染期拼进来，和 H5 / 知乎 / 公众号同一份数据源。
  // 小红书的形态是逐屏截图，所以走 markdown 版（窄屏排版、不含逐格数字表）。
  const cx = loadExtras(ROOT, slug);
  let slideSource = markdown;
  if (cx.diagram || cx.compare) {
    const extraMd = renderExtrasMarkdown(cx, { imgSrc: `assets/fig-${slug}-diagram.png` });
    if (extraMd.trim()) slideSource = `${markdown.trimEnd()}\n\n${extraMd}`;
  }
  const slides = await renderSlides(slideSource, slideLimit);
  images.push(...slides.files);
  slideLabels = slides.labels;
}
await browser.close();
server.close();
// 每屏讲什么：供 deliverable-report.mjs 生成交付清单时读取
if (slideLabels.length) writeFileSync(join(outDir, `${slug}-labels.json`), JSON.stringify(slideLabels, null, 1));
console.log(JSON.stringify({ files, images, slides: images.length - 1, slideLabels }, null, 1));


// ---- H5 切图：整篇正文排成一个手机网页，按 390×520pt 视口逐屏截（2x 出图 780×1040，3:4）----
// 和 cards.md 的区别：这里不重写内容，直接用 article.md 的正文、标题、表格、公式和插图，
// 读者从小红书点进来看到的就是长文本身。只在自然分页处断（标题不落单、图不切开）。
async function renderSlides(markdown, limit) {
  // 图片路径是相对稿子所在目录的（assets/xxx.png），setContent 的页面没有基准目录，
  // 必须先解析成绝对路径再交给本地静态服务（/file/ 前缀）。
  const baseDir = args.in ? dirname(args.in) : join(ROOT, 'articles', slug);
  // alt 里可以出现方括号（`![图 2 · …[A, T1, MASK×6] 上并行…](assets/x.png)`），
  // 用 `[^\]]*` 匹配 alt 会在第一个 `]` 就断开，整个替换静默失效、图保持相对路径，
  // 最后在 about:blank 页面里 404（2026-11-21 dmtp architecture.png 实测）。
  // 改成非贪婪 `.*?` 再要求紧跟 `](`，才能跨过 alt 内部的方括号。
  const resolved = markdown.replace(/(!\[.*?\]\()([^)\s]+)(\))/g, (_m, a, src, c) => {
    if (/^(https?:|data:)/.test(src)) return `${a}${src}${c}`;
    return `${a}${assetBase}/file/${join(baseDir, src)}${c}`;
  });
  const view = await browser.newPage({ viewport: { width: 390, height: 520 }, deviceScaleFactor: 2 });
  await view.setContent(`<!doctype html><html><head><meta charset="utf-8">${css}<style>${SLIDE_CSS}</style></head>
    <body><article class="slide" id="root">${markdownToHtml(resolved)}</article></body></html>`, { waitUntil: 'load' });
  // 必须等字体和图片都就绪再量高度：KaTeX 字体没到时公式会被低估，渲染时撑高就会溢出画布
  await view.evaluate(() => Promise.all(Array.from(document.images).map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))));
  await view.evaluate(() => document.fonts.ready);
  await view.waitForTimeout(300);

  // 把「图 + 图注」拆开：图注单独一段，方便分页时跟着图走
  await view.evaluate(() => {
    const root = document.getElementById('root');
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const holder = img.closest('p, .figure, div') ?? img.parentElement;
      // 图注可能来自两处：
      //   ① 同一段落里的文字（`<p><img>图注</p>`）；
      //   ② **`alt` 属性**——`marked` 把 `![图 1 · …](x.png)` 渲染成
      //      `<p><img alt="图 1 · …" src="x.png"></p>`，此时 textContent **是空的**。
      //   只读 textContent 会让所有 markdown 图片的图注全部丢失（2026-11-11 实际发生）。
      const text = (holder.textContent ?? '').trim();
      const alt = (img.getAttribute('alt') ?? '').trim();
      const cap = text || alt;
      const fig = document.createElement('div');
      fig.className = 'fig';
      fig.appendChild(img);
      let tail = null;
      if (cap) {
        tail = document.createElement('div');
        tail.className = 'figcap';
        tail.textContent = cap;
      }
      holder.replaceWith(fig);
      if (tail) fig.after(tail);
    }
  });

  // 长段落按句号拆开：分页只能落在段与段之间，不能从一句话中间切开
  await view.evaluate(() => {
    const root = document.getElementById('root');
    const room = 520 - parseFloat(getComputedStyle(root).paddingTop) - parseFloat(getComputedStyle(root).paddingBottom) - 40;
    for (const p of Array.from(root.querySelectorAll(':scope > p'))) {
      if (p.getBoundingClientRect().height < room * 0.45) continue;
      // 逐句量高度后贪心拼成若干段
      const text = p.innerHTML;
      const sentences = text.split(/(?<=[。！？；])/).map((t) => t.trim()).filter(Boolean);
      if (sentences.length < 2) continue;
      const probe = document.createElement('div');
      probe.className = p.className;
      probe.style.width = `${p.getBoundingClientRect().width}px`;
      p.after(probe);
      const heights = sentences.map((t) => {
        probe.textContent = t;
        return probe.getBoundingClientRect().height;
      });
      probe.remove();
      const groups = [];
      let cur = [], curH = 0;
      const limit = room * 0.82;
      sentences.forEach((t, i) => {
        if (cur.length && curH + heights[i] > limit) { groups.push(cur.join('')); cur = []; curH = 0; }
        cur.push(t); curH += heights[i];
      });
      if (cur.length) groups.push(cur.join(''));
      const first = p.cloneNode(false);
      first.innerHTML = groups[0];
      let prev = first;
      p.replaceWith(first);
      for (const g of groups.slice(1)) {
        const np = p.cloneNode(false);
        np.innerHTML = g;
        prev.after(np);
        prev = np;
      }
    }
  });

  // 大表格拆成几张分表：一屏塞 12 行只能压到 8px 字号，手机上根本读不了。
  // 2026-11-18 实测 dspark 的主结果表就是这样——整张 10 行表挤在一屏、
  // 字号 8px，用户在小红书里看到的是一团灰点。
  // 做法：行数超过 SPLIT_ROWS 的表拆成每片 ≤SPLIT_ROWS 行，每片都带原表头
  // （读者在任何一片上都能独立看懂），并给每片加「（1/3）」这种序号。
  // 每片 3 行：5 行 + 表头 + 节标题就超过 520px 可用高度，第二片会被裁掉一行。
  // 2026-11-18 实测 5 行时 Alpaca / Arena-Hard 整行消失。
  const SPLIT_ROWS = 3;
  await view.evaluate((limit) => {
    const root = document.getElementById('root');
    for (const table of Array.from(root.querySelectorAll('table'))) {
      const headRow = table.querySelector('thead tr') ?? table.querySelector('tr');
      const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
      if (!headRow || bodyRows.length <= limit) continue;
      const headHtml = headRow.outerHTML;
      const chunks = [];
      for (let i = 0; i < bodyRows.length; i += limit) chunks.push(bodyRows.slice(i, i + limit));
      const frag = document.createDocumentFragment();
      chunks.forEach((rows, ci) => {
        const t = document.createElement('table');
        // 用 innerHTML 塞 <thead>/<tbody>：浏览器会规范化，但不会丢节点。
        t.innerHTML = `<thead>${headHtml}</thead><tbody>${rows.map((r) => r.outerHTML).join('')}</tbody>`;
        if (!t.querySelector('thead th')) console.warn('⚠️ 拆表时表头丢了');
        frag.appendChild(t);
        if (ci < chunks.length - 1) {
          const brk = document.createElement('div');
          brk.className = 'table-break';
          frag.appendChild(brk);
        }
      });
      table.replaceWith(frag);
    }
    // 拆出来的表格之间插一个必须分页的标记块
    for (const t of Array.from(root.querySelectorAll('table'))) {
      t.classList.add('table-chunk');
    }
  }, SPLIT_ROWS);

  // 所有块的 HTML 一次性取出来，分页在真实页面里逐块实测完成（见下方 renderPage）
  const kidsHtml = await view.evaluate(() => Array.from(document.getElementById('root').children)
    .filter((n) => n.offsetHeight > 0).map((n) => n.outerHTML));
  const title = await view.evaluate(() => document.querySelector('#root h1')?.outerHTML ?? '');

  // 实测分页：把块逐个放进真实画布量底边，超过可用高度就退出一块开新页。
  // 不再预估高度——图片加载、字体度量、浏览器节流都会让预估失真，实测是唯一可靠的。
  // 把一页的块装进真实画布并测量占用高度
  const buildPage = async (rows, no, total) => {
    // 品牌名必须作为参数传进去：这个回调在浏览器里执行，拿不到 Node 侧的常量。
    await view.evaluate(({ html, no, total, venue, kicker, brand, brandUpper }) => {
      document.body.innerHTML = `<article class="slide">
        <div class="banner"><span>${brandUpper} · ${kicker}</span><span>${venue}</span></div>
        <div class="slide-body">${html}</div>
        <div class="page-no"><span>${no} / ${String(total).padStart(2, '0')}</span><span>关注 ${brand}</span></div>
      </article>`;
      const slide = document.querySelector('article.slide');
      slide.style.minHeight = '520px';
      slide.style.height = '520px';
      slide.style.overflow = 'hidden';
    }, { html: rows.join('\n'), no, total, venue: cover.venue ?? '', kicker: cover.kicker, brand: BRAND, brandUpper: BRAND_UPPER });
    await view.evaluate(() => Promise.all(Array.from(document.images).map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))));
    return view.evaluate(() => {
      const slide = document.querySelector('article.slide');
      const body = slide.querySelector('.slide-body');
      const sr = slide.getBoundingClientRect();
      const top = body.getBoundingClientRect().top;
      let bottom = top;
      for (const n of body.children) bottom = Math.max(bottom, n.getBoundingClientRect().bottom);
      return { used: Math.round(bottom - top), avail: Math.round(sr.bottom - 34 - top) };
    });
  };

  // 实测分页：一次把所有块渲染进画布，量出每块高度（含 margin），再在 Node 侧分页。
  // 逐块反复渲染太慢，且容易在「退回图注」时算错边界。
  // 先把所有图片解码进缓存，测量时才不会有 0 高度的图。
  // **返回加载失败的 src 列表**：以前 onerror 也 resolve，于是 404 的图全链路静默——
  // 变成 0 高度被 `offsetHeight > 0` 过滤掉，最后产物里那一屏就凭空少一张图
  // （2026-11-12 代码审查发现）。
  const failedImages = await view.evaluate(async (htmlList) => {
    const srcs = [...new Set((htmlList.join('').match(/<img[^>]+src="([^"]+)"/g) ?? [])
      .map((t) => t.match(/src="([^"]+)"/)[1]))];
    const failed = [];
    await Promise.all(srcs.map((src) => new Promise((r) => {
      const i = new Image();
      i.onload = () => { if (!i.naturalWidth) failed.push(src); r(); };
      i.onerror = () => { failed.push(src); r(); };
      i.src = src;
    })));
    return failed;
  }, kidsHtml);
  if (failedImages.length) {
    console.error(`✗ ${failedImages.length} 张图加载失败，产物会缺图：`);
    for (const src of failedImages.slice(0, 8)) console.error(`    · ${src}`);
    process.exitCode = 1;
    await view.close?.();
    // 必须返回同构的空结果：调用方无条件读 `slides.files`，
    // 返回 undefined 会让「一张图失败」升级成整个渲染进程 TypeError（2026-11-21 实测）。
    return { files: [], labels: [] };
  }
  const metrics = await view.evaluate(({ htmlList, brandUpper }) => {
    // 测量期间把当前文档换成和最终页面完全同构的 slide 结构
    document.body.innerHTML = `<article class="slide">
      <div class="banner"><span>${brandUpper} · 论文解读</span><span></span></div>
      <div class="slide-body"></div>
      <div class="page-no"><span></span><span></span></div>
    </article>`;
    const slide = document.querySelector('article.slide');
    slide.style.minHeight = '520px';
    slide.style.height = 'auto';
    slide.style.overflow = 'visible';
    const body = slide.querySelector('.slide-body');
    body.innerHTML = htmlList.join('\n');
    const top = body.getBoundingClientRect().top;
    // 真实可用高度必须**实测**：banner 的高度随字体/内容变化，写死 `520-22-16-34`
    // 会多算 banner 那一截（约 12px），于是分页以为装得下、渲染时越界。
    // 2026-11-12 实际发生：EAGLE-3 末屏按 448px 装箱，真实只有 436px，最后一行被裁掉。
    const avail = Math.round(slide.getBoundingClientRect().top + 520 - 34 - top);
    return {
      avail,
      heights: Array.from(body.children).map((n) => Math.round(n.getBoundingClientRect().height + (parseFloat(getComputedStyle(n).marginBottom) || 0))),
    };
  }, { htmlList: kidsHtml, brandUpper: BRAND_UPPER });
  const AVAIL = metrics.avail;
  const heights = metrics.heights;
  const isHeading = (html) => /^\s*<h[123]/i.test(html);
  const isCaption = (html) => /class="figcap"/.test(html);
  const isFigure = (html) => /class="fig"/.test(html);
  // 表标题是普通 `<p>表 N · …`，和 `<table>` 是两个独立块。
  // 不合并的话，页尾会只剩表标题、表格翻到下一页（2026-11-12 代码审查发现）。
  const isTableTitle = (html) => /^\s*<p[^>]*>\s*(<[^>]+>\s*)*表\s*\d+\s*·/.test(html);
  const isTable = (html) => /^\s*<table/i.test(html);
  const isList = (html) => /^\s*<(ul|ol)[\s>]/i.test(html);
  // 「引出句」：整段文字以冒号收尾（去掉内联标签后判断），后面通常就是它要引的东西。
  const isColonIntro = (html) => /^\s*<p[\s>]/i.test(html)
    && /[：:]\s*<\/p>\s*$/i.test(html);

  // ---- 先合并「不可拆单元」：图 + 紧跟的图注算**一个**单元 ----
  //
  // 之前的做法是在分页循环里事后回退（页尾是图注就往前挪），漏掉了最要紧的一种：
  // 图本身就快占满一屏，图注被挤到下一页 → 回退条件 `end - start > 1` 挡住，
  // 结果架构图独占一页、图注孤零零落在下一页（2026-11-11 实际发生）。
  // 改成先合并成单元再装箱，就不会有「图注落到别页」这条路径。
  const units = [];
  for (let i = 0; i < kidsHtml.length; i++) {
    if (isFigure(kidsHtml[i]) && i + 1 < kidsHtml.length && isCaption(kidsHtml[i + 1])) {
      units.push({ from: i, to: i + 2, height: (heights[i] ?? 0) + (heights[i + 1] ?? 0) });
      i++;
    } else if (isTableTitle(kidsHtml[i]) && i + 1 < kidsHtml.length && isTable(kidsHtml[i + 1])) {
      units.push({ from: i, to: i + 2, height: (heights[i] ?? 0) + (heights[i + 1] ?? 0) });
      i++;
    } else if (isHeading(kidsHtml[i]) && i + 1 < kidsHtml.length && isTable(kidsHtml[i + 1])) {
      // 节标题 + 紧跟的表格算一个单元。
      // 2026-11-18 之前它们分开装：表格拆成多片后，标题被装进上一页的剩余空间，
      // 下一屏直接从表格中段开始，读者看到一张没有标题、也没有表头的表（dspark 实测）。
      // 只绑**第一片**，后续片自己成页——绑全部会让整节超过缩放能救的范围。
      units.push({ from: i, to: i + 2, height: (heights[i] ?? 0) + (heights[i + 1] ?? 0) });
      i++;
    } else if (isColonIntro(kidsHtml[i]) && i + 1 < kidsHtml.length && isList(kidsHtml[i + 1])) {
      // 冒号引子 + 紧跟的列表算一个单元：「作者自己交代的几处，值得记：」被切到页尾、
      // 列表翻到下一页，读者看到的是半句话（2026-11-21 dmtp 第 11 节实测）。
      units.push({ from: i, to: i + 2, height: (heights[i] ?? 0) + (heights[i + 1] ?? 0) });
      i++;
    } else {
      units.push({ from: i, to: i + 1, height: heights[i] ?? 0 });
    }
  }

  // 分页：严格顺序装填。不做跨页回填——把后面的段落提前填进来会打乱论证顺序，
  // 留白比「先讲结论后讲前提」好得多。
  const pages = [];
  const pageSpans = [];
  {
    let u = 0;
    while (u < units.length) {
      let end = u;
      let used = 0;
      while (end < units.length) {
        const h = units[end].height;
        // 单元超高（独占一屏的大图）时允许它单独成页，交给后面的整体缩放
        if (used + h > AVAIL && end > u) break;
        used += h;
        end++;
      }
      if (end === u) end = u + 1;

      // 标题不能落在页尾——但只在「这个单元只有一个块」时算。
      // 合并单元（标题 + 紧跟的表/图）里标题后面本来就有内容，回退会把标题连同
      // 它自己的表一起推到下一页，上一页留下半屏空白：2026-11-21 dmtp 实测，
      // 第 2 屏只有 TL;DR 列表（242/436），第 3 屏只有标题 + 一张单行表（221/436）。
      const endsWithHeading = (k) => units[k].to - units[k].from === 1 && isHeading(kidsHtml[units[k].from]);
      while (end - u > 1 && endsWithHeading(end - 1)) end--;
      // 整页只有一个标题时，把下一块硬拉进来。
      // 否则「标题独占一屏、下一屏才见图」——2026-11-12 实际发生（第 5 屏只有一行
      // 「3. 方法：展开 + 重排」，图在第 6 屏）。合并后会超高，交给下面的整体缩放兜底。
      if (end - u === 1 && endsWithHeading(u) && end < units.length) end++;
      const sliceFrom = units[u].from;
      const sliceTo = units[end - 1].to;
      pages.push(kidsHtml.slice(sliceFrom, sliceTo));
      pageSpans.push([u, end]);
      u = end;
    }
  }
  // 末页太空，两种处理：
  //   ① 并回前一页（前提是合并后还在缩放能救的范围内）；
  //   ② 并回去就超太多时，**从前一页末尾借几块过来**。
  // 只做 ① 的话，前一页刚好装满时末屏就只能剩两行——2026-11-12 实际出现（DFlash 末屏）。
  if (pages.length > 1) {
    const lastSpan = pageSpans.at(-1);
    const prevSpan = pageSpans.at(-2);
    const lastH = units.slice(lastSpan[0], lastSpan[1]).reduce((sum, x) => sum + x.height, 0);
    if (lastH < AVAIL * 0.35) {
      const mergedH = units.slice(prevSpan[0], lastSpan[1]).reduce((sum, x) => sum + x.height, 0);
      // 1.35 太宽松：合并后要缩到 0.84 才装得下，正文整体变小、和前后屏不一致
      // （2026-11-12 EAGLE 末屏实测）。1.18 之内才值得合并，超了宁可多一屏。
      if (mergedH < AVAIL * 1.18) {
        pageSpans.pop();
        pageSpans[pageSpans.length - 1] = [prevSpan[0], lastSpan[1]];
        pages.pop();
        pages[pages.length - 1] = kidsHtml.slice(units[prevSpan[0]].from, units[lastSpan[1] - 1].to);
      } else {
        // ② 从上一页末尾往前借，直到末页接近半屏；上一页至少留 45%
        let split = lastSpan[0];
        let tailH = lastH;
        let headH = units.slice(prevSpan[0], prevSpan[1]).reduce((sum, x) => sum + x.height, 0);
        while (split > prevSpan[0] + 1 && tailH < AVAIL * 0.55) {
          const u = units[split - 1];
          if (headH - u.height < AVAIL * 0.45) break;
          split--;
          tailH += u.height;
          headH -= u.height;
        }
        if (split < lastSpan[0]) {
          pageSpans[pageSpans.length - 2] = [prevSpan[0], split];
          pageSpans[pageSpans.length - 1] = [split, lastSpan[1]];
          pages[pages.length - 2] = kidsHtml.slice(units[prevSpan[0]].from, units[split - 1].to);
          pages[pages.length - 1] = kidsHtml.slice(units[split].from, units[lastSpan[1] - 1].to);
        }
      }
    }
  }
  // 超过发布上限（小红书单篇 ≤ 18 图，扣掉封面）就只截前 limit 屏，末屏提示去长文
  if (process.env.DEBUG_PAGES) {
    pages.forEach((pg, i) => console.error(`PAGE ${i + 1}: ` + pg.map((h) => (h.match(/^<h[12][^>]*>(.*?)<\/h[12]>/)?.[1] ?? h.slice(0, 26).replace(/\n/g, ' '))).join(' | ')));
  }
  const truncatedPages = pages.length > limit;
  const visiblePages = truncatedPages ? pages.slice(0, limit - 1) : pages;
  const totalPages = pages.length;
  // 逐页重建（带正确页码）+ 越界兜底 + 截图
  const out = [];
  const labels = [];
  for (const [index, rows] of visiblePages.entries()) {
    const no = String(index + 1).padStart(2, '0');
    const file = join(outDir, `${slug}-${no}.png`);
    const m = await buildPage(rows, no, totalPages);
    if (m.used > m.avail) {
      // ① 先直接压图。**整体 scale 对图片是无效的**：scale(k) 的同时把 body
      //    width 设成 100/k，图片按 max-width:100% 重新布局成更宽，视觉尺寸不变
      //    （2026-11-12 实际发生：第 6 屏缩放到 0.85 后图片仍越界 35px）。
      //    文字是字号驱动，所以能被 scale 缩小；图片是宽度驱动，只能改 max-height。
      const shrunk = await view.evaluate((avail) => {
        const body = document.querySelector('.slide-body');
        const imgs = Array.from(body.querySelectorAll('img'));
        if (!imgs.length) return false;
        const top = body.getBoundingClientRect().top;
        let bottom = top;
        for (const n of body.children) bottom = Math.max(bottom, n.getBoundingClientRect().bottom);
        const over = Math.round(bottom - top - avail);
        if (over <= 0) return false;
        const tallest = imgs.map((n) => ({ n, h: n.getBoundingClientRect().height }))
          .sort((a, b) => b.h - a.h)[0];
        tallest.n.style.maxHeight = `${Math.max(40, Math.round(tallest.h - over - 6))}px`;
        tallest.n.style.width = 'auto';
        tallest.n.style.margin = '0 auto';
        return true;
      }, m.avail);
      // 注意：**不能在这里重新 buildPage**——那会把 rows 的原始 HTML 重新写进 DOM，
      // 上一步刚设的 maxHeight 立刻被丢弃，图又回到原尺寸（2026-11-12 踩过一次）。
      // 所以只原地再量一遍。
      const m2 = shrunk ? await view.evaluate(() => {
        const slide = document.querySelector('article.slide');
        const body = slide.querySelector('.slide-body');
        const sr = slide.getBoundingClientRect();
        const top = body.getBoundingClientRect().top;
        let bottom = top;
        for (const n of body.children) bottom = Math.max(bottom, n.getBoundingClientRect().bottom);
        // 越界判定也要重新读：压图后 slide-body 的 scrollHeight 才是真实占高
        return {
          used: Math.round(Math.max(bottom, body.getBoundingClientRect().top + body.scrollHeight) - top),
          avail: Math.round(sr.bottom - 34 - top),
        };
      }) : m;
      if (m2.used > m2.avail) {
        const k = m2.avail / m2.used;
        await view.evaluate(({ k, used }) => {
          const body = document.querySelector('.slide-body');
          body.style.transform = `scale(${k.toFixed(4)})`;
          body.style.transformOrigin = 'top left';
          body.style.width = `${(100 / k).toFixed(3)}%`;
          // transform 不改变布局占位，所以还得把盒子的高度按缩放比例压回去。
          // 不压的话 `.page-no`（margin-top:auto）会被推到画布外，
          // 那一屏就没了页码和文末那行署名（2026-11-12 实际发生）。
          //
          // **但这里绝不能加 overflow:hidden**：裁剪发生在 transform 之前的布局坐标系里，
          // body 高 = used×k，内容布局高 = used，于是 0→used×(1−k) 那截被直接切掉。
          // 0.95 的缩放就会吃掉最后一行（2026-11-12 用户截图：EAGLE-3 末屏「调度代码不用动」被裁）。
          // 内容按 k 缩小后视觉高度正好是 used×k，不需要靠裁剪兜底。
          body.style.height = `${Math.round(used * k)}px`;
        }, { k, used: m2.used });
        console.warn(`ℹ️ 第 ${index + 1} 屏整体缩放到 ${k.toFixed(2)}（${m2.used}px → ${m2.avail}px）`);
      } else if (shrunk) {
        console.warn(`ℹ️ 第 ${index + 1} 屏压缩图片以适配（${m.used}px → ${m2.used}px）`);
      }
    }
    await view.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const bad = await view.evaluate(() => {
      const slide = document.querySelector('article.slide');
      const sr = slide.getBoundingClientRect();
      // 同上：页码会被推到画布外，不能用它当边界
      const limit = sr.bottom - 34;
      const errs = [];
      // **正文（纯文字）也必须查越界**。以前只查 img/table，文字被 overflow:hidden
      // 裁掉时脚本全绿、用户在图上看到的是半行字（2026-11-12 实际发生，EAGLE-3 末屏）。
      const body = slide.querySelector('.slide-body');
      if (body) {
        let bottom = body.getBoundingClientRect().top;
        for (const n of body.children) bottom = Math.max(bottom, n.getBoundingClientRect().bottom);
        if (bottom > limit + 1) errs.push(`正文底部越界 ${Math.round(bottom - limit)}px`);
        // 整体被 scale 压过时，上面的 bottom 是**缩放后**的坐标，可能刚好卡在边界内，
        // 但字已经小到读不了。这类屏必须报出来——2026-11-18 dspark 第 3 屏
        // 「3. 方法」整节就这样消失（内容在 DOM 里、在画布外）。
        const k = body.getBoundingClientRect().height / (body.scrollHeight || 1);
        if (k < 0.9) errs.push(`正文整体缩到 ${k.toFixed(2)}，字会小到读不清`);
      }
      slide.querySelectorAll('img, table').forEach((n) => {
        const r = n.getBoundingClientRect();
        if (r.bottom > limit + 1) errs.push(`${n.tagName} 底部越界 ${Math.round(r.bottom - limit)}px`);
      });
      // 图片必须完整可见：裁剪/变形都算失败
      slide.querySelectorAll('img').forEach((n) => {
        const r = n.getBoundingClientRect();
        if (n.classList.contains('bleed') || n.closest('.fig.bleed')) {
          const fig = n.closest('.fig');
          const fr = fig.getBoundingClientRect();
          if (r.left > fr.left - 1 && n.naturalWidth / n.naturalHeight > 0) { /* 正常 */ }
        }
        // 用 clientWidth/clientHeight，不用 getBoundingClientRect：
        // 后者**含 1px 边框**（`.slide img` 有 border），宽高各多加 2px。
        // 对一张 4.84:1 的超宽表图，2px 就能把比例从 4.84 拉到 4.74，
        // 于是「没变形」的图被报成变形（2026-11-18 Draft-OPD 主结果表就是这样被拦下的）。
        const cw = n.clientWidth;
        const ch = n.clientHeight;
        if (!cw || !ch) return;
        const ratio = cw / ch;
        const nat = n.naturalWidth / n.naturalHeight;
        if (Math.abs(ratio - nat) / nat > 0.02) errs.push(`IMG 变形 ${ratio.toFixed(3)} vs ${nat.toFixed(3)}`);
      });
      return errs;
    });
    if (bad.length) {
      console.error(`✗ 第 ${index + 1} 屏排版越界：${bad.join('；')}`);
      process.exitCode = 1;
    }
    // 截图前把滚动位置归零并强制一次布局。
    // 上一页可能因为内容更长把文档撑高、浏览器保留了 scrollY，于是这一页
    // 截出来是「从中间开始」的一段——2026-11-18 dspark 第 3 屏整个「3. 方法」
    // 就这样凭空消失（DOM 里在、图上看不到）。
    await view.evaluate(() => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      void document.body.offsetHeight;   // 强制同步布局
    });
    // 等两帧 + 一小段真实时间：KaTeX 用的是 webfont，字体到位后行高会变，
    // 重排没结束时截图会拿到「上半页已绘制、下半页还空白」的中间态
    // （2026-11-18 dspark 第 3 屏「3. 方法」整节就是这样丢的）。
    // 强制整页重绘：先滚到底再回顶。headless Chromium 在「上一页内容更短、
    // 本页 DOM 被整体替换」时只重绘已进入过合成层的区域，页面下半截保持空白——
    // 2026-11-18 dspark 第 3 屏就是这样：DOM 里 4 个块都在、高度也对，图里只有前 2 个。
    await view.evaluate(async () => {
      const h = Math.max(document.documentElement.scrollHeight, 520);
      window.scrollTo(0, h);
      await new Promise((r) => requestAnimationFrame(r));
      window.scrollTo(0, 0);
      await new Promise((r) => requestAnimationFrame(r));
    });
    await view.waitForTimeout(150);
    // 用 clip 明确圈定画布：headless 下 `screenshot({path})` 按 viewport 截，
    // 但页面若因前几页的重排残留在某个滚动/合成状态，会截出「上半页有、下半页空」
    // （2026-11-18 dspark 第 3 屏实测：DOM 4 个块、样式全正常，图里只有前 2 个）。
    // clip 走的是「按坐标绘制」，不依赖 viewport 的滚动状态。
    // 截**元素**而不是页面：`page.screenshot()` 在 headless 下按视口绘制，
    // 长页面被替换后下半截可能是旧的合成层；`locator.screenshot()` 走元素边界，
    // 会强制重新栅格化该元素（2026-11-18 第 3 屏「3. 方法」消失的最后解法）。
    // 每页换一个干净的 page 来截图。
    // 在同一个 page 上反复 `document.body.innerHTML = ...` 时，headless Chromium
    // 会把上一页遗留的合成层一并保留，新内容只要没触发重排就画不出来——
    // 2026-11-18 dspark 第 3 屏「3. 方法」反复消失（DOM 4 块、高度正确、图上 2 块）。
    // 新 page 从空白开始，没有可继承的合成状态。
    const shot = await browser.newPage({ viewport: { width: 390, height: 520 }, deviceScaleFactor: 2 });
    await shot.setContent(`<!doctype html><html><head><meta charset="utf-8">${css}<style>${SLIDE_CSS}</style></head>
      <body>${await view.evaluate(() => document.querySelector('article.slide').outerHTML)}</body></html>`, { waitUntil: 'load' });
    await shot.evaluate(() => Promise.all(Array.from(document.images).map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })))));
    await shot.evaluate(() => document.fonts.ready);
    await shot.waitForTimeout(120);
    if (process.env.FONT_DEBUG) {
      const fd = await shot.evaluate(() => ({
        status: document.fonts.status,
        size: document.fonts.size,
        pingfang: document.fonts.check('12px "PingFang SC"'),
        links: [...document.querySelectorAll('link')].map(l => ({ href: l.href, sheet: !!l.sheet })),
        zh: (document.querySelector('.slide-body')?.innerText ?? '').slice(0, 20),
        zhW: (() => { const n = document.querySelector('.slide-body p'); if (!n) return null; const r = document.createRange(); r.selectNodeContents(n); return Math.round(r.getBoundingClientRect().width); })(),
      }));
      console.error(`FONT ${no}: ` + JSON.stringify(fd));
    }
    // 强制整页重绘后再截。
    // headless Chromium 在「新开 page + setContent」时偶发只绘制部分图层：
    // DOM 完整、字体已加载（`document.fonts.status === 'loaded'`、中文测宽正常）、
    // 但图上只剩英文和数字，整段中文不出现（2026-11-21 dflare 第 6 屏实测，
    // 那一屏恰好是拆表产生的两张相邻 table）。
    // 之前 bsk 侧的解法是「滚动到底再回顶」，这里同样适用。
    await shot.evaluate(async () => {
      const h = Math.max(document.documentElement.scrollHeight, 520);
      window.scrollTo(0, h);
      await new Promise((r) => requestAnimationFrame(r));
      window.scrollTo(0, 0);
      await new Promise((r) => requestAnimationFrame(r));
      // 逐个元素读一次布局属性，强制栅格化整页
      for (const n of document.querySelectorAll('.slide-body *')) void n.offsetHeight;
    });
    await shot.waitForTimeout(80);
    await shot.screenshot({ path: file });
    await shot.close();
    if (process.env.DUMP_SLIDE) {
      const fs2 = await import('node:fs');
      fs2.writeFileSync(`/tmp/slide-${no}.html`, `<!doctype html><html><head><meta charset="utf-8">${css}<style>${SLIDE_CSS}</style></head><body>${await view.evaluate(() => document.querySelector('article.slide').outerHTML)}</body></html>`);
    }
    out.push(file);
    // 交付清单要列出每屏讲什么：优先取这屏第一个标题，没有标题就取第一个内容块的首句
    const label = await view.evaluate(() => {
      const body = document.querySelector('.slide-body');
      if (!body) return '';
      const h = body.querySelector('h1, h2, h3');
      if (h) return h.innerText.replace(/\s+/g, ' ').trim();
      // 纯图页：正文第一个元素可能是 .fig（没有可见文字），此时取图注。
      // 早先直接读 firstElementChild.innerText，图页会得到空串，清单里显示成「—」。
      const cap = body.querySelector('.figcap')?.innerText?.replace(/\s+/g, ' ').trim();
      const first = body.firstElementChild;
      const text = (first?.innerText ?? body.innerText).replace(/\s+/g, ' ').trim();
      const source = text || cap || '';
      if (!source) return '';
      // 按句末标点取首句；仍旧过长就截断并加省略号，避免半句结尾
      const sentence = source.split(/(?<=[。！？；])/)[0] ?? source;
      return sentence.length > 40 ? `${sentence.slice(0, 38)}…` : sentence;
    });
    labels.push(label);
  }
  await view.close();
  console.log(`ℹ️ H5 切图 ${out.length} 张`);
  return { files: out, labels };
}

// ---- 卡片模式：articles/<slug>/cards.md，用 --- 分页，一页一个观点 ----
async function renderCards(source) {
  const slides = source.split(/\n---\n/).map((s) => s.trim()).filter(Boolean);
  const files = [];
  for (const [index, slide] of slides.entries()) {
    const no = String(index + 1).padStart(2, '0');
    const file = join(outDir, `${slug}-${no}.png`);
    // [[bg 相对项目根的图片]]：AI 出画面，数字和文字仍由排版层负责，保证数据准确
    const bg = slide.match(/\[\[bg\s+([^\]]+)\]\]/)?.[1]?.trim();
    const bgCss = bg ? `--bg-img: linear-gradient(rgba(7,11,24,0.55), rgba(7,11,24,0.88)), url('${assetBase}/asset/${bg}');` : '';
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8">${css}</head>
      <body><div class="xcard" style="${bgCss}">
        <div class="vhead"><span class="brand-mark"><span class="dot"></span>${BRAND_UPPER}</span><span>${escHtml(cover.venue || '论文解读')}</span></div>
        <div class="content">${cardBody(slide)}</div>
        <div class="foot">${escHtml(cover.id ? 'arXiv:' + cover.id : '')}</div>
        <div class="page-no">${String(index + 1).padStart(2, '0')} / ${String(slides.length).padStart(2, '0')}</div>
      </div></body></html>`, { waitUntil: 'load' });
    // 排版：量 .content 的自然高度，超高则整体缩放（transform 不影响布局，所以先量后缩）
    await page.waitForTimeout?.(0);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const fit = await page.evaluate(() => {
      const card = document.querySelector('.xcard');
      const content = card.querySelector('.content');
      const cs = getComputedStyle(card);
      const room = card.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const used = Array.from(content.children).reduce((sum, n) => {
        const g = getComputedStyle(n);
        return sum + n.getBoundingClientRect().height + (parseFloat(g.marginTop) || 0) + (parseFloat(g.marginBottom) || 0);
      }, 0) + 60;
      const scale = used > room ? room / used : 1;
      if (scale < 1) {
        content.style.transform = `scale(${scale.toFixed(3)})`;
        content.style.transformOrigin = 'center top';
      }
      return { used: Math.round(used), room: Math.round(room), scale: Number(scale.toFixed(2)) };
    });
    if (process.env.CARD_DEBUG) console.log(JSON.stringify(await page.evaluate(() => { const t = document.querySelector('.tag'); const c = document.querySelector('.content'); return { sheets: [...document.styleSheets].map(x => { try { return x.cssRules.length; } catch { return 'blocked'; } }), tagFs: getComputedStyle(t).fontSize, tagPad: getComputedStyle(t).paddingTop, tagW: Math.round(t.getBoundingClientRect().width), tagH2: Math.round(t.getBoundingClientRect().height), cardH: document.querySelector('.xcard').clientHeight }; })));
    if (process.env.CARD_DEBUG) console.log(JSON.stringify(await page.evaluate(() => { const c = document.querySelector('.content'); return { cards: document.querySelectorAll('.xcard').length, cKids: c ? c.children.length : 'no-content', contentH: c ? Math.round(c.getBoundingClientRect().height) : 0, tagH: document.querySelector('.tag') ? Math.round(document.querySelector('.tag').getBoundingClientRect().height) : 0 }; })));
    if (fit.scale < 1) console.warn(`ℹ️ 第 ${index + 1} 页缩放到 ${fit.scale}（内容 ${fit.used}px / 空间 ${fit.room}px）`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  return files;
}

function escHtml(v) { return String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

function cardBody(source) {
  // 卡片语法（每块之间空一行）
  //   ## 标签         ### 标题         小注：副标题          > 金句
  //   [[cover 系列名 | 大标题 | 副标题]]   —— 封面页
  //   [[hero 小标题 | 巨大数字 | 说明 | 补充]]
  //   [[grid 标签>数值>说明;样式 | ...]]   —— 数据卡片网格，样式: warm/dark/wide
  //   [[bars 名称>数值 | ...]]            —— 横向对比条，最后一条高亮
  //   [[flow 步骤>说明 | ...]]            —— 步骤条
  //   [[vs 左标题>要点;要点 | 右标题>要点;要点]]
  //   [[callout 结论]]        [[bg 图片路径]]
  const blocks = source.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < blocks.length) {
    const t = blocks[i];
    // 连续的数据卡片合并成一个网格
    if (t.startsWith('[[grid')) {
      const tiles = [];
      while (i < blocks.length && blocks[i].startsWith('[[grid')) { tiles.push(blocks[i]); i++; }
      out.push(renderGrid(tiles));
      continue;
    }
    out.push(renderBlock(t));
    i++;
  }
  return out.join('\n');
}

function renderBlock(t) {
  if (t.startsWith('### ')) return `<h2 class="xk">${mdInline(t.slice(4))}</h2>`;
  if (t.startsWith('## ')) return `<div class="tag">${mdInline(t.slice(3))}</div>`;
  if (t === '[[anchor]]') return '';
  if (t.startsWith('[[bg ')) return '';
  if (t.startsWith('小注：')) return `<div class="deck">${mdInline(t.slice(3))}</div>`;
  if (t.startsWith('> ')) return `<div class="quote">${mdInline(t.slice(2).replace(/\n/g, '<br>'))}</div>`;
  if (t.startsWith('[[cover')) return renderCoverPage(t);
  if (t.startsWith('[[illus')) return renderIllus(t);
  if (t.startsWith('[[split')) return renderSplit(t);
  if (t.startsWith('[[hero')) return renderHero(t);
  if (t.startsWith('[[grid')) return renderGrid([t]);
  if (t.startsWith('[[bars')) return renderBars(t);
  if (t.startsWith('[[flow')) return renderFlow(t);
  if (t.startsWith('[[vs')) return renderVs(t);
  if (t.startsWith('[[callout')) return `<div class="callout">${mdInline(t.replace(/^\[\[callout\s*/, '').replace(/\]\]$/, ''))}</div>`;
  if (/^(- |\d+\. )/m.test(t) && t.split('\n').every((l) => /^(- |\d+\. )/.test(l.trim()) || !l.trim())) {
    return `<ul class="xu">${t.split('\n').filter((l) => l.trim()).map((l) => `<li>${mdInline(l.replace(/^(- |\d+\. )/, ''))}</li>`).join('')}</ul>`;
  }
  return `<p class="${t.length < 70 ? 'lead' : 'body'}">${mdInline(t.replace(/\n/g, ' '))}</p>`;
}

// [[illus 图片路径 | 图注]]
function renderIllus(block) {
  const [src, cap, ratio] = block.replace(/^\[\[illus\s*/, '').replace(/\]\]$/, '').split('|').map((x) => x.trim());
  const style = ratio ? ` style="aspect-ratio:${ratio};object-fit:cover"` : '';
  return `<div class="illus"><img src="${assetBase}/asset/${src}" alt=""${style}>${cap ? `<div class="deck" style="margin:16px 20px 18px">${mdInline(cap)}</div>` : ''}</div>`;
}

// [[split 图片路径 | 标签>数值>说明 | 标签>数值>说明]]
function renderSplit(block) {
  const parts = block.replace(/^\[\[split\s*/, '').replace(/\]\]$/, '').split('|').map((x) => x.trim());
  const [src, ...stats] = parts;
  return `<div class="split"><div class="pic"><img src="${assetBase}/asset/${src}" alt=""></div><div class="side">${stats.map((st) => {
    const [k, v, note] = st.split('>').map((x) => x.trim());
    return `<div><div class="k">${mdInline(k ?? '')}</div>${v ? `<div class="v">${mdInline(v)}</div>` : ''}${note ? `<div class="note">${mdInline(note)}</div>` : ''}</div>`;
  }).join('')}</div></div>`;
  }

// [[cover 系列 | 大标题（可用 ** 强调）| 副标题]]
function renderCoverPage(block) {
  const [series, t1, t2] = block.replace(/^\[\[cover\s*/, '').replace(/\]\]$/, '').split('|').map((x) => x.trim());
  return `<div class="xcover"><div class="series">${mdInline(series ?? '')}</div><div class="t1">${mdInline(t1 ?? '')}</div>${t2 ? `<div class="rule"></div><div class="t2">${mdInline(t2)}</div>` : ''}</div>`;
}

// [[hero 小标题 | 巨大数字 | 主说明 | 补充说明]]
function renderHero(block) {
  const [kicker, huge, sub, extra] = block.replace(/^\[\[hero\s*/, '').replace(/\]\]$/, '').split('|').map((x) => x.trim());
  return `<div class="xhero">${kicker ? `<div class="kicker">${mdInline(kicker)}</div>` : ''}<div class="huge">${mdInline(huge ?? '')}</div>${sub ? `<div class="sub">${mdInline(sub)}${extra ? `<small>${mdInline(extra)}</small>` : ''}</div>` : ''}</div>`;
}

// [[grid 标签>数值>说明;样式 | ...]]，样式可省略：warm / dark / wide
function renderGrid(blocks) {
  const tiles = blocks.flatMap((b) => b.replace(/^\[\[grid\s*/, '').replace(/\]\]$/, '').split('|')).map((tile) => {
    const [head, style = ''] = tile.split(';');
    const [k, v, note] = head.split('>').map((x) => x.trim());
    return { k, v, note, style: style.trim() };
  }).filter((t) => t.k || t.v);
  return `<div class="grid">${tiles.map((t) =>
    `<div class="tile ${t.style}"><div class="k">${mdInline(t.k ?? '')}</div>${t.v ? `<div class="v">${mdInline(t.v)}</div>` : ''}${t.note ? `<div class="note">${mdInline(t.note)}</div>` : ''}</div>`,
  ).join('')}</div>`;
}

// [[bars 标题>值>比例 | 名称>值>比例]] —— 最后一条自动高亮
function renderBars(block) {
  const inner = block.replace(/^\[\[bars\s*/, '').replace(/\]\]$/, '');
  const rows = inner.split('|').map((r) => r.split('>').map((x) => x.trim())).filter((r) => r.length >= 2);
  // 条形长度直接按数值算（值就是相对 1× 的倍数），这样 2.2× 和 4.86× 的差异一眼可见
  const max = Math.max(...rows.map((r) => Number(r[2] ?? r[1]) || 0));
  return `<div class="cmp">${rows.map((r, i) => {
    const pct = Math.max(14, Math.round((Number(r[2] ?? r[1].replace(/[^0-9.]/g, '')) / max) * 100));
    const hot = i === rows.length - 1;
    return `<div class="row"><div class="name">${mdInline(r[0])}</div><div class="track"><div class="fill ${hot ? 'hot' : ''}" style="width:${pct}%">${mdInline(r[1])}</div></div></div>`;
  }).join('')}</div>`;
}

// [[big 6.08× | 一句话说明]]
function renderBig(block) {
  const [value, caption] = block.replace(/^\[\[big\s*/, '').replace(/\]\]$/, '').split('|').map((x) => x.trim());
  return `<div class="bignum">${value}</div>${caption ? `<div class="bigcap">${mdInline(caption)}</div>` : ''}`;
}

// [[flow 步骤1>说明 | 步骤2>说明 ...]]
function renderFlow(block) {
  const steps = block.replace(/^\[\[flow\s*/, '').replace(/\]\]$/, '').split('|').map((x) => x.trim()).filter(Boolean);
  return `<div class="steps">${steps.map((s, i) => {
    const [head, sub] = s.split('>').map((x) => x.trim());
    return `<div class="step"><div class="n">${i + 1}</div><div class="t">${mdInline(head)}${sub ? `<span>${mdInline(sub)}</span>` : ''}</div></div>`;
  }).join('')}</div>`;
}

// [[vs 左标题>左要点;左要点 | 右标题>右要点;右要点]] —— 右栏高亮
function renderVs(block) {
  const [left, right] = block.replace(/^\[\[vs\s*/, '').replace(/\]\]$/, '').split('|');
  const col = (raw, good) => {
    const [title, items] = raw.split('>');
    return `<div class="col ${good ? 'good' : ''}"><h4>${mdInline(title.trim())}</h4><ul>${(items ?? '').split(';').filter(Boolean).map((i) => `<li>${mdInline(i.trim())}</li>`).join('')}</ul></div>`;
  };
  return `<div class="versus">${col(left, false)}${col(right, true)}</div>`;
}

function renderVerdict(block) {
  const inner = block.replace(/^\[\[verdict\s*/, '').replace(/\]\]$/, '');
  const [bad, good] = inner.split('|').map((x) => x.trim());
  return `<div class="verdict"><span class="x">✗</span>${mdInline(bad ?? '')}</div><div class="verdict"><span class="v">✓</span>${mdInline(good ?? '')}</div>`;
}

function mdInline(text) {
  return text.replace(/&lt;br\s*\/?&gt;|<br\s*\/?>/g, '<br>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/<em>/g, '<em>').replace(/\\n/g, '<br>');
}

function markdownToHtml(source) {
  // 行内公式用 MathML（Chromium 原生渲染，不依赖 KaTeX 字体）；
  // 行间公式保留 KaTeX HTML 分支，因为需要真正的上下标排版。
  const inline = [];
  const display = [];
  const withPlaceholders = source
    .replace(/^#\s+[^\n]*/m, (line) => `%%TITLE%%${line.replace(/^#\s+/, '')}`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `@@D${display.push(tex.trim()) - 1}@@`)
    .replace(/(?<![$\w])\$([^\n$]+?)\$(?!\$)/g, (_m, tex) => `@@M${inline.push(tex.trim()) - 1}@@`);
  const html = marked.parse(withPlaceholders, { async: false });
  return html
    .replace(/<p>%%TITLE%%(.*?)<\/p>/g, '<h1>$1</h1>')
    // 行内公式包一层 span，否则直接插 <math> 会让行高错乱
    .replace(/@@M(\d+)@@/g, (_m, index) => katex.renderToString(inline[Number(index)] ?? '', { displayMode: false, throwOnError: false }))
    .replace(/@@D(\d+)@@/g, (_m, index) => `<div class="formula">${katex.renderToString(display[Number(index)] ?? '', { displayMode: true, throwOnError: false })}</div>`);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'article';
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { existsSync, readdirSync } = fs;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
    const base = join(cache, dir, 'chrome-mac-arm64');
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const mac = join(base, entry, 'Contents', 'MacOS');
      if (existsSync(mac)) return join(mac, readdirSync(mac)[0]);
    }
  }
  return undefined;
}

