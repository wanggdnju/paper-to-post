#!/usr/bin/env node
/**
 * 把 Markdown 解读渲染成一个自包含的单文件 HTML 页面。
 *
 *   npm run render:html -- --in=articles/dflash/article.md --out=dist/html/dflash.html [--title=...]
 *
 * 产物：
 *   - 一个 .html 文件，公式（KaTeX）、样式、脚本全部内联，可直接发给别人 / 传到静态服务器 / 用浏览器打开
 *   - 手机优先：默认宽度 100%，字号和行高按移动端可读性调过
 *   - 带右侧目录、阅读进度条、代码/表格横向滚动、深色模式跟随系统
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import katex from 'katex';
import { marked } from 'marked';
import { loadExtras, renderExtrasWide } from './lib/paper-extras.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
if (!args.in) {
  console.error('用法：node scripts/render-html.mjs --in=article.md --out=dist/html/article.html [--title=...] [--subtitle=...]');
  process.exit(1);
}

const ROOT = process.cwd();
const markdown = readFileSync(join(ROOT, args.in), 'utf8');
const title = args.title ?? markdown.match(/^#\s+(.+)$/m)?.[1] ?? '论文解读';
const subtitle = args.subtitle ?? '';
const outPath = args.out ?? `dist/html/${(args.in.split('/').pop() ?? 'article').replace(/\.md$/, '')}.html`;
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 落地信息：articles/<slug>/assets/links.json（由 npm run extract:links 生成）
const linksFile = join(ROOT, args.in, '..', 'assets', 'links.json');
const links = existsSync(linksFile) ? JSON.parse(readFileSync(linksFile, 'utf8')) : null;
// 页头的链接条只在**正文没有元信息块**时才用。
// 正文里有 `> **论文** … **代码** …` 块时，页头再列一遍就是同一批链接出现两次，
// 而且页头那版没有标签（「项目页」看不出是哪个项目的），信息量更低。
const bodyHasMetaBlock = /^>\s*\*\*(?:论文|作者|链接)\*\*/m.test(markdown.split(/\n##\s/)[0] ?? '');
const linkChips = !bodyHasMetaBlock && links ? [
  ...(links.github ?? []).map((l) => `<a href="${l.url}" target="_blank" rel="noopener">代码 · ${esc(l.repo ?? l.host)}</a>`),
  ...(links.huggingface ?? []).map((l) => `<a href="${l.url}" target="_blank" rel="noopener">模型 · HF ${esc(l.repo ?? '')}</a>`),
  ...(links.modelscope ?? []).map((l) => `<a href="${l.url}" target="_blank" rel="noopener">魔搭 · ${esc(l.repo ?? '')}</a>`),
  // 项目页要过滤：`/blog/` 那类路径是别人方法的介绍文章，不是本文项目页
  ...(links.project ?? []).filter((l) => !/\/(?:blog|posts?|news)\//i.test(l.url))
    .map((l) => `<a href="${l.url}" target="_blank" rel="noopener">项目页</a>`),
] : [];
const katexDist = join(ROOT, 'node_modules/katex/dist');
let katexCss = readFileSync(join(katexDist, 'katex.min.css'), 'utf8');
katexCss = katexCss.replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (m, file) => {
  const path = join(katexDist, 'fonts', file);
  if (!existsSync(path)) return m;
  return `url(data:font/woff2;base64,${readFileSync(path).toString('base64')})`;
});

// ---- 图片：保留相对路径（不内联 base64）。
// 原因：几百 KB 的 base64 放进 markdown 再经 marked 解析会卡死（实测 >2 分钟）。
// 分享时把 .html 和它所在的 assets 目录一起带上即可；要单文件版再看 --inline-images 选项。
const inlineImages = (md) => md.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, alt, src, caption) => {
  if (/^https?:/.test(src)) return match;
  const mdDir = join(ROOT, args.in, '..');
  const abs = [join(ROOT, src), join(mdDir, src)].find((c) => existsSync(c));
  if (!abs) { console.warn('⚠️ 图片不存在，跳过：', src); return match; }
  // 图片路径相对 html 输出目录
  const rel = relative(dirname(join(ROOT, outPath)), abs);
  const captionText = (caption ?? alt ?? '').replace(/\$([^$]*)\$/g, '$1');
  const payload = Buffer.from(JSON.stringify({ src: rel, caption: captionText }), 'utf8').toString('base64');
  return `\n\n@@FIG${payload}@@\n\n`;
});

// ---- Markdown → HTML（公式走 KaTeX，其余走 marked）----
const inline = [];
const display = [];
// 先抽图片（alt/图注里的 $...$ 只当纯文本，不能被 KaTeX 的 HTML 塞进属性）
const withPlaceholders = inlineImages(markdown)
  .replace(/^#\s+[^\n]*/m, '')
  .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `@@D${display.push(tex.trim()) - 1}@@`)
  .replace(/(?<![$\w])\$([^\n$]+?)\$(?!\$)/g, (_m, tex) => `@@M${inline.push(tex.trim()) - 1}@@`);
// breaks:true：单个换行即换行（元信息块里「论文 / 作者 / 链接」各占一行，不挤成一段）
let body = marked.parse(withPlaceholders, { async: false, gfm: true, breaks: true });
body = body
  .replace(/@@M(\d+)@@/g, (_m, i) => katex.renderToString(inline[Number(i)] ?? '', { displayMode: false, throwOnError: false }))
  .replace(/@@D(\d+)@@/g, (_m, i) => `<div class="formula">${katex.renderToString(display[Number(i)] ?? '', { displayMode: true, throwOnError: false })}</div>`)
  .replace(/<p>@@FIG([A-Za-z0-9+/=]+)@@<\/p>/g, (_m, payload) => renderFigure(payload))
  .replace(/@@FIG([A-Za-z0-9+/=]+)@@/g, (_m, payload) => renderFigure(payload));

function renderFigure(payload) {
  try {
    const { src, caption } = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const cap = caption ? `<figcaption>${esc(caption)}</figcaption>` : '';
    return `<figure class="paper-fig"><img src="${esc(src)}" alt="${esc(caption ?? '')}">${cap}</figure>`;
  } catch {
    return '';
  }
}

// 派生区块：机制图 + 横向对比（articles/<slug>/diagram.json + compare.json）。
// 放在正文之后、目录之前——它们是「补充材料」，不该打断论证链；
// 但必须在下面的 h2 锚点扫描**之前**拼进来，否则「横向对比」不会进目录。
const slugFromIn = (args.in.split('/').slice(-2)[0] ?? '').trim();
const extras = slugFromIn ? loadExtras(ROOT, slugFromIn) : { diagram: null, compare: null };
if (extras.diagram || extras.compare) {
  const pngRel = extras.diagram
    ? relative(dirname(join(ROOT, outPath)), extras.diagram.png)
    : '';
  const extrasHtml = renderExtrasWide(extras, { diagramHref: pngRel });
  // 「附：问答」是附录，必须留在最后；派生区块属于正文，插在它前面。
  // 直接 append 会让读者先读完十问十答、再突然冒出「横向对比」，像是忘了收尾。
  body = /<h2>附[：:]\s*问答<\/h2>/.test(body)
    ? body.replace(/(<h2>附[：:]\s*问答<\/h2>)/, `${extrasHtml}\n$1`)
    : `${body}\n${extrasHtml}`;
}

// 给 h2 加锚点，供目录跳转
const headings = [];body = body.replace(/<h2>(.*?)<\/h2>/g, (_m, text) => {
  const id = `s${headings.length + 1}`;
  headings.push({ id, text: text.replace(/<[^>]+>/g, '') });
  return `<h2 id="${id}">${text}</h2>`;
});

const toc = headings.map((h, i) => `<a href="#${h.id}"><span class="n">${String(i + 1).padStart(2, '0')}</span>${esc(h.text)}</a>`).join('');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(subtitle || title)}">
<style>
/* KaTeX 需要的字体以 data-uri 之外的方式引入；离线时退化为系统数学字体 */
${katexCss}
:root {
  --bg: #faf8f4; --fg: #1d1d1d; --muted: #6b655c; --line: #e3ddd1; --card: #ffffff;
  --accent: #b8451f; --accent-soft: #f7e3c4; --code: #f2eee6; --radius: 10px;
  --measure: 42em;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14120f; --fg: #ece7de; --muted: #a29a8d; --line: #2c2822; --card: #1d1a16;
    --accent: #f0a37a; --accent-soft: #33261d; --code: #221f1a; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 17px/1.85 -apple-system, 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans SC', system-ui, sans-serif;
  letter-spacing: .01em; }
.progress { position: fixed; top: 0; left: 0; height: 3px; width: 0; background: var(--accent); z-index: 50; transition: width .1s linear; }
.wrap { display: grid; grid-template-columns: minmax(0, var(--measure)) 220px; gap: 56px; justify-content: center;
  max-width: 1180px; margin: 0 auto; padding: 72px 28px 120px; }
header.hero { grid-column: 1 / -1; margin-bottom: 8px; }
.eyebrow { font-size: 13px; letter-spacing: .22em; color: var(--muted); text-transform: uppercase; }
h1 { font-size: clamp(30px, 5vw, 46px); line-height: 1.25; font-weight: 800; letter-spacing: -.02em; margin: 14px 0 18px; }
.sub { color: var(--muted); font-size: 15px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 18px; font-size: 14px; color: var(--muted); }
.meta a { color: var(--accent); text-decoration: none; }
main { min-width: 0; }
main h2 { font-size: 26px; line-height: 1.35; margin: 2.4em 0 .7em; padding-top: .2em; scroll-margin-top: 24px; }
main h3 { font-size: 20px; margin: 1.8em 0 .5em; color: var(--fg); }
main p { margin: 0 0 1.05em; }
main strong { font-weight: 700; }
main a { color: var(--accent); }
main ul, main ol { padding-left: 1.3em; margin: 0 0 1.1em; }
main li { margin-bottom: .45em; }
main blockquote { margin: 1.4em 0; padding: .9em 1.1em; background: var(--accent-soft); border-radius: var(--radius);
  color: var(--fg); font-weight: 500; }
main blockquote p { margin: 0; }
main hr { border: 0; border-top: 1px solid var(--line); margin: 2.6em 0; }
main code { background: var(--code); padding: .12em .38em; border-radius: 5px; font-size: .9em;
  font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; }
main pre { background: var(--code); padding: 16px 18px; border-radius: var(--radius); overflow-x: auto; }
main pre code { background: none; padding: 0; }
.tablewrap { overflow-x: auto; margin: 1.3em 0; border-radius: var(--radius); border: 1px solid var(--line); }
main table { border-collapse: collapse; width: 100%; font-size: 15px; background: var(--card); }
main th, main td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
main th { background: var(--code); font-weight: 700; white-space: nowrap; }
main tr:last-child td { border-bottom: 0; }
.paper-fig { margin: 2em 0; padding: 0; }
.paper-fig img { width: 100%; height: auto; display: block; border-radius: 6px; background: #fff; }
.paper-fig figcaption { margin-top: 12px; font-size: 14px; line-height: 1.6; color: var(--muted); text-align: center; }
/* 本站画的图，图注是三四行的说明文字，居中排版每行长度不一、读起来跳；
   论文原图的图注通常一两句，居中才好看。 */
.paper-fig.owned figcaption { text-align: left; }
.fig-note { display: inline-block; margin-top: 6px; font-size: 13px; color: var(--muted); opacity: .85; }
/* 横向对比区块（scripts/lib/paper-extras.mjs 产出） */
.cmp { margin-top: 3em; padding-top: 1.6em; border-top: 1px solid var(--line); }
.cmp-intro { font-size: 15px; color: var(--muted); }
.cmp-scroll { overflow-x: auto; margin: 1.2em 0; border: 1px solid var(--line); border-radius: var(--radius); }
/* 五列表在 700px 正文宽里每格只剩 120px，中文一行只能放五六个字，整张表被拉成柱状。
   和站点同一套处理：单元格给最小宽度、允许换行，整表横向滚动。 */
.cmp-matrix { min-width: 1000px; }
.cmp-matrix td { white-space: normal; min-width: 150px; font-size: 13.5px; line-height: 1.6; }
.cmp-matrix, .cmp-table { border-collapse: collapse; width: 100%; font-size: 14px; background: var(--card); }
.cmp-matrix th, .cmp-matrix td, .cmp-table th, .cmp-table td { padding: 9px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
.cmp-matrix thead th, .cmp-table thead th { background: var(--code); font-weight: 700; white-space: nowrap; }
.cmp-matrix tbody th { white-space: nowrap; font-weight: 600; }
/* 窄屏出现的是段落版（.cmp-narrow），表格版整个收起来 */
.cmp-narrow { display: none; }
.cmp-dimname { font-weight: 700; margin: 18px 0 4px; }
.cmp-dimval { margin: 0 0 6px; font-size: 15.5px; line-height: 1.75; color: var(--fg); }
@media (max-width: 900px) {
  .cmp-narrow { display: block; }
  .cmp-matrix, .cmp-hint-wide { display: none; }
  /* 数字表在手机上要横滑（8 列放不下 348px），首列钉住，
     滑动时还能看出这行是哪个模型。 */
  .cmp-table thead th:first-child, .cmp-table tbody th {
    position: sticky; left: 0; z-index: 1; background: var(--card);
    box-shadow: 1px 0 0 var(--line);
  }
  .cmp-table thead th:first-child { background: var(--code); }
}
.cmp-matrix .ours, .cmp-table tr.ours td { background: var(--accent-soft); }
.cmp-group-name { font-weight: 700; margin: 16px 0 6px; }
/* 这两张表在任何宽度下都会横向溢出（正文栏只有 42em，五列矩阵要 1000px），
   提示一直显示；窄屏上矩阵换成段落版，对应的那条提示跟着一起隐藏。 */
.cmp-hint { font-size: 13px; color: var(--muted); margin: -2px 0 8px; }
.cmp-caption { font-size: 13px; color: var(--muted); margin: 14px 0 4px; }
.cmp-block { margin-bottom: 18px; }
.cmp-group { margin-bottom: 14px; }
.cmp-note { font-size: 13px; color: var(--muted); }
.table-caption { margin: 1.4em 0 -0.9em; font-size: 14px; line-height: 1.6; color: var(--muted); }
@media (prefers-color-scheme: dark) { .paper-fig img { background: #f7f5f0; padding: 10px; } }
.formula { overflow-x: auto; margin: 1.2em 0; padding: 4px 0; }
.katex { font-size: 1.02em; }
.meta-block .after { margin: 10px 0 0; font-weight: 500; }
.meta-block .kv { display: grid; grid-template-columns: 5.2em 1fr; gap: 10px; padding: 3px 0; font-weight: 400; }
.meta-block .kv .k { color: var(--muted); font-weight: 600; }
.meta-block .kv .v { min-width: 0; overflow-wrap: anywhere; }
.toc { position: sticky; top: 40px; align-self: start; font-size: 14px; }
.toc .t { font-size: 12px; letter-spacing: .18em; color: var(--muted); margin-bottom: 12px; }
.toc a { display: flex; gap: 10px; padding: 6px 0; color: var(--muted); text-decoration: none; border-left: 2px solid transparent; padding-left: 10px; }
.toc a .n { color: var(--line); font-variant-numeric: tabular-nums; }
.toc a:hover, .toc a.on { color: var(--fg); border-left-color: var(--accent); }
footer { grid-column: 1 / -1; margin-top: 64px; padding-top: 24px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 14px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
@media (max-width: 680px) {
  .tablewrap { border: 0; background: none; }
  /* 只把**正文表格**转成卡片式。横向对比的表不能转：
     它们在自己的 .cmp-scroll 里横向滚动，.cmp-matrix 还有 min-width:1000px，
     一旦 display:block 就会把单元格撑出屏幕、文字被切掉（2026-11-13 实测）。 */
  main .tablewrap table { display: block; font-size: 15px; }
  main .tablewrap thead { display: none; }
  main .tablewrap tbody, main .tablewrap tr, main .tablewrap td { display: block; width: 100%; }
  main .tablewrap tr { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); margin-bottom: 12px; padding: 8px 4px; }
  main .tablewrap td { border: 0; display: flex; justify-content: space-between; gap: 14px; padding: 7px 14px; text-align: right; }
  main .tablewrap td::before { content: attr(data-label); color: var(--muted); font-size: 13.5px; text-align: left; flex: none; max-width: 42%; }
  main .tablewrap td:first-child { font-weight: 700; color: var(--fg); text-align: left; }
  main .tablewrap td:first-child::before { display: none; }
}
@media (max-width: 900px) {
  .wrap { grid-template-columns: minmax(0, 1fr); gap: 0; padding: 40px 20px 80px; }
  .toc { display: none; }
  body { font-size: 16.5px; }
}
@media print {
  .toc, .progress, footer { display: none; }
  .wrap { display: block; padding: 0; max-width: none; }
  main a { color: inherit; }
}
</style>
</head>
<body>
<div class="progress" id="progress"></div>
<div class="wrap">
  <header class="hero">
    <div class="eyebrow">Paper to Post · 论文解读</div>
    <h1>${esc(title)}</h1>
    ${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}
    <div class="meta">
      ${args.arxiv ? `<span>arXiv:${esc(args.arxiv)}</span>` : ''}
      ${args.venue ? `<span>${esc(args.venue)}</span>` : ''}
      ${args.arxiv ? `<a href="https://arxiv.org/abs/${esc(args.arxiv)}" target="_blank" rel="noopener">阅读原文 →</a>` : ''}
      ${linkChips.join('\n      ')}
    </div>
  </header>
  <main>${wrapTables(formatMetaBlock(body))}</main>
  <aside class="toc"><div class="t">目录</div>${toc}</aside>
  <footer><span>Paper to Post · 大模型全景解读</span><span>${new Date().toISOString().slice(0, 10)}</span></footer>
</div>
<script>
// 阅读进度 + 目录高亮
(function () {
  var bar = document.getElementById('progress');
  var links = [].slice.call(document.querySelectorAll('.toc a'));
  function onScroll() {
    var h = document.documentElement;
    var total = h.scrollHeight - h.clientHeight;
    bar.style.width = (total > 0 ? (h.scrollTop / total) * 100 : 0) + '%';
    var cur = null;
    links.forEach(function (a) {
      var el = document.getElementById(a.getAttribute('href').slice(1));
      if (el && el.getBoundingClientRect().top < 120) cur = a;
    });
    links.forEach(function (a) { a.classList.toggle('on', a === cur); });
  }
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();
</script>
</body>
</html>`;

mkdirSync(dirname(join(ROOT, outPath)), { recursive: true });
writeFileSync(join(ROOT, outPath), html);
console.log(JSON.stringify({ out: outPath, bytes: Buffer.byteLength(html), sections: headings.length }, null, 1));

/** 元信息块：把「标签　内容」多行块拆成左标签右内容的网格，保证多行对齐 */
function formatMetaBlock(html) {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (whole, inner) => {
    const clean = inner.replace(/<p>/g, '').replace(/<\/p>\s*$/, '');
    const lines = clean.split(/<br\s*\/?>/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return whole;
    const rows = [];
    const rest = [];
    for (const line of lines) {
      const m = line.match(/^<strong>([^<]{1,6})<\/strong>[\s\u3000]*(.*)$/);
      if (m && !rest.length) rows.push(`<div class="kv"><span class="k">${m[1]}</span><span class="v">${m[2]}</span></div>`);
      else rest.push(line);
    }
    if (!rows.length) return whole;
    return `<blockquote class="meta-block">${rows.join('')}${rest.length ? `<p class="after">${rest.join('<br>')}</p>` : ''}</blockquote>`;
  });
}

function wrapTables(html) {
  const wrapped = html.replace(/<table>[\s\S]*?<\/table>/g, (table) => {
    const heads = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    const labelled = table.replace(/<tr>([\s\S]*?)<\/tr>/g, (row) => {
      if (!row.includes('<td')) return row;
      let i = 0;
      return '<tr>' + row.slice(4, -5).replace(/<td>/g, () => `<td data-label="${heads[i++] ?? ''}">`) + '</tr>';
    });
    return `<div class="tablewrap">${labelled}</div>`;
  });
  // 顺序不能反：图注行要匹配「后面紧跟 tablewrap」，所以必须**先**把表格包进容器。
  // 反着写只能匹配到 0–1 个，样式静默不生效。
  return wrapped.replace(/<p>(表\s*\d+\s*·\s*[\s\S]*?)<\/p>\s*(?=<div class="tablewrap">)/g,
    (_m, text) => `<p class="table-caption">${text}</p>`);
}
