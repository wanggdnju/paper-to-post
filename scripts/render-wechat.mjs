#!/usr/bin/env node
/**
 * 把 articles/<slug>/article.md 转成公众号可直接提交的 HTML。
 *
 *   node scripts/render-wechat.mjs --slug=dspine [--out=dist/wechat/dspine.html]
 *   加 --upload 会把正文图片上传到微信素材库并替换成微信域名（需要 access_token）
 *
 * 公众号编辑器的限制（按踩坑顺序）：
 *   - 剥离 <style>、class、id、外部 CSS：所有样式必须内联在 style 属性里
 *   - 不渲染 KaTeX/MathML：公式一律转成 PNG 图片（KaTeX → 页面截图）
 *   - 只信任白名单标签：<section> <p> <span> <img> <table> 可用，<figure>/<figcaption> 会被削
 *   - 外链 <a> 会被去掉 href：把「链接」文本保留，URL 以纯文本写在后面
 *   - 图片必须是微信域名（上传素材后返回的 url），相对路径和 data: 都会被丢弃
 *
 * 论文原表（`表 N` 图片）：有 LaTeX 表源时**渲染成窄表**，不贴截图。
 * 手机正文宽 ~343px，18 列的原表截图缩进去每个数字只剩 4–5px——
 * 和之前的站点是同一个问题，只是这里连横向滚动都没有。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import process from 'node:process';
import katex from 'katex';
import { marked } from 'marked';
import { launchOptions } from './lib/chromium.mjs';
import { compactForTable } from './lib/paper-tables.mjs';
import { loadExtras, renderExtrasNarrow } from './lib/paper-extras.mjs';

const extraEsc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 只有「单个字母 / 短词 / 不带下标的短式」才降级成文本；其余一律出图 */
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };
function isPlainTex(tex) {
  // 只有「每个字符都能映射到 Unicode 下标/数字」时才降级，否则宁可出图也不出现 G_q 这种半吊子写法。
  if (/^[a-zA-Z0-9]$/.test(tex)) return true;
  if (/^[a-zA-Z][-+][0-9]$/.test(tex)) return true;
  if (/^K\s*=\s*[0-9]+$/.test(tex)) return true;
  const sub = tex.match(/^([a-zA-Z])_(?:\{([a-zA-Z0-9])\}|([a-zA-Z0-9]))$/);
  if (sub) return !!SUB[(sub[2] ?? sub[3])];
  // 其余带下标/上标/命令的一律出图——降级成纯文本会丢掉结构。
  if (/[_^\\]/.test(tex)) return false;
  return tex.replace(/[{}]/g, '').trim().length <= 6;
}
function hasLetterSub(tex) {
  for (let i = 1; i < tex.length; i++) {
    if (tex[i] !== '_') continue;
    const next = tex[i + 1];
    if (next && /[a-zA-Z]/.test(next)) return true;
  }
  return false;
}
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
/** 逐字符映射成 Unicode 上下标；任一字符没有对应形式就整体退回 x_{...} */
function toSub(text) {
  const comma = text.includes(',');
  // 逗号没有下标形式：整体无法完整映射，就退成「首字符下标 + ,+ 其余同高」的写法
  const parts = text.split(',');
  const mapped = parts.map((part) => [...part].map((c) => SUB[c] ?? null));
  if (mapped.every((p) => p.every(Boolean))) return mapped.map((p) => p.join('')).join(',');
  if (comma) return `_${text}`;
  return `_${text}`;
}
function toSup(text) {
  const out = [...text].map((c) => SUP[c] ?? null);
  return out.every(Boolean) ? out.join('') : `^${text}`;
}
/** TeX → 可读纯文本：x_{0} → x₀，t-1 → t−1，\top → ᵀ */
function texToPlain(tex) {
  return tex
    .replace(/\\(mathrm|text|operatorname)\{([^}]*)\}/g, '$2')
    .replace(/_\{([^}]*)\}/g, (m, g) => toSub(g))
    .replace(/\^\{([^}]*)\}/g, (m, g) => toSup(g))
    .replace(/_([0-9a-zA-Z])(?![a-zA-Z])/g, (m, g) => toSub(g))
    .replace(/\^([0-9])(?![0-9])/g, (m, g) => toSup(g))
    .replace(/\\top/g, 'ᵀ')
    .replace(/-/g, '−')
    .replace(/\s+/g, ' ')
    .trim();
}

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/render-wechat.mjs --slug=<slug> [--in=article.md] [--out=dist/wechat/<slug>.html] [--upload]');
  process.exit(1);
}
const slug = String(args.slug);
const inPath = String(args.in ?? `articles/${slug}/article.md`);
const outPath = String(args.out ?? `dist/wechat/${slug}.html`);
const mdDir = dirname(join(ROOT, inPath));
const yamlText = readFileSync(join(ROOT, 'articles', slug, 'article.yaml'), 'utf8');
const meta = parseYaml(yamlText);
// 文末标签：优先 wechat_tags，其次 xhs_tags。公众号不认纯文本话题为可点实体，
// 这一行只承担「一眼看出归类」和站内搜索的作用。
const metaTags = parseYamlList(yamlText, 'wechat_tags') ?? parseYamlList(yamlText, 'xhs_tags') ?? [];

// ---- 1. Markdown → 结构化块 ----
const source = readFileSync(join(ROOT, inPath), 'utf8');
const inline = [];
const display = [];
const placeholders = source
  .replace(/^#\s+[^\n]*$/gm, '')
  .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => `@@D${display.push(tex.trim()) - 1}@@`)
  .replace(/(?<![$\\])\$([^\n$]+?)\$(?!\$)/g, (_m, tex) => `@@M${inline.push(tex.trim()) - 1}@@`);
// breaks:false —— 单行换行被转成 <br> 会打断列表结构，公众号里变成一串空项目符号
let html = marked.parse(placeholders, { async: false, breaks: false });

// 开头的元信息块（> **论文**　xxx\  **作者**　yyy）在公众号里 grid 布局会失效、挤成一团，
// 这里先摘出来，后面单独渲染成逐行段落。
let metaLines = [];
// 开头可能有**多个** blockquote：元信息块 + 紧随的导读。
//
// 以前只取第一个：如果稿件把 `作者` 和 `来源/原文` 拆成两个块（手写稿常见），
// 第二个块里的链接既进不了元信息区、也不会生成二维码，正文里还留着一长条裸 URL。
// format:article 的 repairMetaBlock 已经把这种稿子合并了，这里再兜一层——
// 判据是「这个块是不是以字段名开头」，是就并进元信息，不是（导读）就原样留在正文。
const metaParts = [];
const consumed = [];
{
  // 用游标逐块取：`^\s*<blockquote>` 带 g 不带 m 只在字符串开头匹配，
  // 直接对全文 matchAll 只能拿到第一块。
  let rest = html;
  while (true) {
    const m = rest.match(/^\s*<blockquote>([\s\S]*?)<\/blockquote>/);
    if (!m) break;
    if (!/<strong>(?:论文|作者|链接|来源|原文|本篇|代码|模型|架构图)<\/strong>/.test(m[1])) break;
    metaParts.push(m[1]);
    consumed.push(m[0]);
    rest = rest.slice(m[0].length);
  }
}
if (metaParts.length) {
  // 按 <strong> 切行，而不是按 <br>：行尾的 `\` 是 Markdown 硬换行，
  // 但当它是「**原文**　https://…\」这种「URL + 反斜杠」时，GFM 的自动链接
  // 会把反斜杠吞进 URL（变成 %5C），<br> 就消失了，两行粘成一行。
  // 按 strong 标签切对两种写法都成立。
  const inner = metaParts.join('').replace(/<\/?p[^>]*>/g, '').replace(/<br\s*\/?>/g, '');
  const seen = new Set();
  metaLines = [...inner.matchAll(/<strong>([^<]+)<\/strong>\s*([\s\S]*?)(?=<strong>|$)/g)]
    .map(([, k, v]) => [k.trim(), sanitizeUrlTrail(v.trim())])
    .filter(([k, v]) => {
      if (v.length < 0) return false;
      const key = `${k}\u0000${v}`;
      if (seen.has(key)) return false;   // 重复字段只保留一次
      seen.add(key);
      return true;
    });
  for (const block of consumed) html = html.replace(block, '');
}

// ---- 派生区块：机制图 + 横向对比 ----
// 必须在下面扫 <img> 之前插进来，否则机制图不会进上传队列（相对路径发到微信会被丢弃）。
// 公众号正文约 343px：五列矩阵表放不下，走 narrow 版（每方一行）。
const extras = loadExtras(ROOT, slug);
const extrasImgSrc = extras.diagram ? `assets/${basename(extras.diagram.png)}` : '';
if (extras.diagram || extras.compare) {
  // alt 只放短标题；完整说明在下面单独一段，因为公众号的图注会被削成一行
  const tag = extrasImgSrc
    ? `<p><img src="${extrasImgSrc}" alt="机制图 · ${extraEsc(extras.diagram.spec.title ?? '')}"></p>`
    : '';
  const extrasHtml = renderExtrasNarrow(extras, { imgTag: tag, small: 13 });
  // 「附：问答」是附录，留在最后；横向对比是正文内容，插在它前面。
  html = /<h2>附[：:]\s*问答<\/h2>/.test(html)
    ? html.replace(/(<h2>附[：:]\s*问答<\/h2>)/, `${extrasHtml}\n$1`)
    : `${html}\n${extrasHtml}\n`;
}

const images = [...html.matchAll(/<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"[^>]*>/g)].map((m) => ({
  src: m[1],
  caption: m[2],
}));

// ---- 2. KaTeX 公式转图片 ----
const { chromium } = await import('playwright');
const browser = await chromium.launch(launchOptions());
// 4 倍图：公众号正文会把图片按 CSS 宽度缩放显示，2x 拉伸后公式会发虚
const page = await browser.newPage({ deviceScaleFactor: 4, viewport: { width: 1200, height: 500 } });
const katexCss = readFileSync(join(ROOT, 'node_modules/katex/dist/katex.min.css'), 'utf8');
const fontDir = join(ROOT, 'node_modules/katex/dist/fonts');
await page.setContent(
  `<!doctype html><html><head><meta charset="utf-8"><style>${katexCss.replace(/url\(fonts\//g, `url(file://${fontDir}/`)}</style></head><body><div id="m"></div></body></html>`,
  { waitUntil: 'load' },
);
await page.evaluate(() => document.fonts.ready);

/** 渲染一个公式成 PNG（透明底黑字），返回 { buffer, width } */
async function renderFormula(tex, displayMode) {
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>${katexCss.replace(/url\(fonts\//g, `url(file://${fontDir}/`)}</style>
     <style>body{margin:0;padding:8px;background:#fff;display:inline-block}#m{font-size:${displayMode ? 22 : 20}px;}</style>
     </head><body><div id="m">${katex.renderToString(tex, { displayMode, throwOnError: false })}</div></body></html>`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => document.fonts.ready);
  const el = await page.$('#m');
  const buffer = await el.screenshot({ type: 'png', omitBackground: false });
  const box = await el.boundingBox();
  return { buffer, width: Math.ceil(box.width), height: Math.ceil(box.height) };
}

// 行内公式里大量只是单个字母或下标（v、C、t-1），转成图片既慢又糊，直接降级成纯文本；
// 只有带上下标/分式/根号的才画图。
const plainInline = new Map();
const formulaImages = [];
// 同一个符号在文中出现多次：复用已渲染的图片（省渲染时间），但每个出现位置仍保留自己的 key，
// 否则替换时会出现「复用了别人的占位符、自己的占位符没人处理」的情况。
const rendered = new Map(); // tex → { buffer, width, height }
for (const [i, tex] of display.entries()) {
  if (!rendered.has(tex)) rendered.set(tex, await renderFormula(tex, true));
  formulaImages.push({ key: `D${i}`, ...rendered.get(tex) });
}
for (const [i, tex] of inline.entries()) {
  if (isPlainTex(tex)) { plainInline.set(`M${i}`, texToPlain(tex)); continue; }
  const k = `inline:${tex}`;
  if (!rendered.has(k)) rendered.set(k, await renderFormula(tex, false));
  formulaImages.push({ key: `M${i}`, ...rendered.get(k) });
}

await browser.close();

// ---- 3. 内联样式化 ----
const FS = 16; // 正文字号
const wrap = (inner, style = '') => `<section style="${style}">${inner}</section>`;
const S = {
  p: `font-size:${FS}px;line-height:1.85;color:#37352f;margin:0 0 18px;letter-spacing:.2px;`,
  h2: `font-size:22px;line-height:1.5;font-weight:700;color:#141414;margin:40px 0 18px;padding-left:12px;border-left:4px solid #d9633b;`,
  // 三级标题：浅底 + 橙色编号，层级明显低于 h2
  h3: `font-size:${FS + 1}px;line-height:1.6;font-weight:700;color:#8a4b2a;margin:28px 0 12px;padding:6px 12px;background:#faf3ee;border-radius:4px;`,
  strong: 'font-weight:700;color:#0f0f0f;',
  quote: `font-size:${FS - 1}px;line-height:1.8;color:#5c5750;margin:0 0 20px;padding:12px 16px;background:#f6f3ec;border-radius:6px;`,
  li: `font-size:${FS}px;line-height:1.85;color:#37352f;margin:0 0 10px;`,
  ul: 'margin:0 0 18px;padding-left:22px;',
  th: `border:1px solid #e3ddd1;background:#faf8f3;padding:7px 6px;font-size:${FS - 2}px;font-weight:700;color:#1d1d1d;text-align:center;`,
  td: `border:1px solid #e3ddd1;padding:7px 6px;font-size:${FS - 2}px;color:#37352f;text-align:center;`,
  table: 'width:100%;border-collapse:collapse;margin:0 0 20px;table-layout:fixed;',
  // 窄表的标题：靠左、比图注略深一点，让读者知道这是一段新表
  tblcap: `font-size:${FS - 2}px;line-height:1.7;color:#8a4b2a;font-weight:600;margin:22px 0 8px;`,
  figcap: `font-size:${FS - 3}px;line-height:1.7;color:#8a8376;text-align:center;margin:8px 0 22px;`,
  img: 'width:100%;display:block;margin:0 auto;',
};
/**
 * 把 <ul>/<ol> 改写成「section + 手写符号」。
 * 自内向外处理：先替换内部不含列表的最内层列表，直到没有列表标签。
 */
function flattenLists(input) {
  let out = input;
  for (let guard = 0; guard < 50 && /<(ul|ol)[\s>]/.test(out); guard++) {
    const m = out.match(/<(ul|ol)([^>]*)>((?:(?!<(?:ul|ol)[\s>]|<\/(?:ul|ol)>)[\s\S])*?)<\/\1>/);
    if (!m) break;
    const [, kind, , inner] = m;
    const ordered = kind === 'ol';
    const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((x) => x[1]);
    const blocks = items.map((content, i) => {
      const mark = ordered ? `${i + 1}. ` : '• ';
      const indent = ordered ? 18 : 16;
      return `<section style="margin:0 0 10px;padding-left:22px;text-indent:-${indent}px;font-size:${FS}px;line-height:1.85;color:#37352f;">${mark}${content.replace(/^\s+|\s+$/g, '')}</section>`;
    });
    out = out.slice(0, m.index) + blocks.join('') + out.slice(m.index + m[0].length);
  }
  return out;
}

// ---- 3b. 论文原表 → 窄表（有 LaTeX 表源时） ----
// 公众号手机正文 ~343px：18 列的原表截图缩进去每个数字只剩 4–5px，和站点当初一样。
// 这里把 `![表 N · …](assets/tab-*.png)` 换成几张窄表，每张 5 列左右、可直接读。
// 没有表源的表保持原样（截图），交给后面的图片管线。
// 放在样式表之后，是为了用 S.tblcap / S.th / S.td 生成内联样式。
{
  const articleDir = join(ROOT, 'articles', slug);
  const replaced = [];
  for (const img of images) {
    const m = (img.caption ?? '').match(/^表\s*(\d+)/);
    if (!m || !/(?:^|\/)tab-/.test(img.src)) continue;
    const compact = compactForTable(articleDir, Number(m[1]), img.caption);
    if (!compact) continue;
    if (compact.problems.length) {
      console.warn(`⚠️ 表 ${m[1]} 的 LaTeX 表源解析不干净（${compact.problems.join('；')}），退回截图`);
      continue;
    }
    if (!compact.tables.length) continue;
    const block = compact.tables.map((t) => `<section style="${S.tblcap}">${t.title}</section>`
      + `<table><thead><tr>${t.header.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>`
      + t.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
      + '</tbody></table>').join('');
    const re = new RegExp(`<p[^>]*>\\s*<img[^>]+src="${escapeRe(img.src)}"[^>]*>\\s*</p>`);
    if (!re.test(html)) { console.warn(`⚠️ 表 ${m[1]}：产物里找不到对应 <img>，跳过窄表替换`); continue; }
    html = html.replace(re, block);
    replaced.push(img.src);
    // 紧随其后的「…切片…」说明段 + 手抄表：同一份数字出现两遍，删掉
    html = html.replace(/<p[^>]*>[^<]*切片[^<]*<\/p>\s*<table[\s\S]*?<\/table>/, '');
  }
  if (replaced.length) {
    const keep = images.filter((i) => !replaced.includes(i.src));
    images.length = 0;
    images.push(...keep);
  }
}

// 代码块：公众号不保留 <pre>，转成内联样式的 section，保留换行与空格。
// 必须先于行内 <code> 的替换处理，否则 `<code class="language-python">` 匹配不上
// 那条只认裸 `<code>` 的规则，class 会原样留在产物里（D6 会报）。
html = html.replace(/<pre><code(?: class="[^"]*")?>([\s\S]*?)<\/code><\/pre>/g,
  (_m, inner) => `<section style="font-family:Menlo,monospace;font-size:${FS - 5}px;line-height:1.62;background:#f6f3ec;border:1px solid #e6dfd1;border-radius:6px;padding:14px 16px;margin:0 0 16px;white-space:pre-wrap;word-break:break-word;">${inner}</section>`);

// 行内标签：把 <strong>/<em>/<code> 换成带 style 的 span（公众号保留 span 的 style）
html = html
  .replace(/<strong>/g, `<span style="${S.strong}">`).replace(/<\/strong>/g, '</span>')
  .replace(/<em>/g, '<span style="font-style:italic;">').replace(/<\/em>/g, '</span>')
  .replace(/<code>/g, '<span style="font-family:Menlo,monospace;font-size:0.9em;background:#f6f3ec;padding:1px 5px;border-radius:3px;">').replace(/<\/code>/g, '</span>')
  .replace(/<h2[^>]*>/g, `<h2 style="${S.h2}">`)
  .replace(/<h3[^>]*>/g, `<h3 style="${S.h3}">`)
  .replace(/<h4[^>]*>/g, `<h4 style="${S.h3}">`)
  .replace(/<p>/g, `<p style="${S.p}">`)
  .replace(/<blockquote>/g, `<blockquote style="${S.quote}">`)
  // <li> 里包裹的 <p> 要去掉，否则公众号渲染会多出一行空项目符号
  .replace(/<li([^>]*)>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/li>/g, (_m, attrs, inner) => `<li${attrs}>${inner}</li>`)
  .replace(/<li([^>]*)>\s+/g, '<li$1>')
  .replace(/\s+<\/li>/g, '</li>')
  .replace(/<table>/g, `<table style="${S.table}">`)
  .replace(/<th>/g, `<th style="${S.th}">`)
  .replace(/<td>/g, `<td style="${S.td}">`)
  .replace(/<hr\s*\/?>/g, '<hr style="border:0;border-top:1px solid #eee8dc;margin:30px 0;">');

// 问答：源稿是 `**问题 N：…**` + `回答 N：…`。公众号里两行字号一样、只靠加粗区分，
// 读者扫读时找不到「下一题」的起点。这里把编号单独着色，并把「回答 N：」的编号也加粗。
// 只动编号，不动一个字（2026-11-15 用户要求「问和答加上数字，变成问题1、回答1」）。
html = html
  .replace(/(<p[^>]*>)?<span style="font-weight:700;color:#0f0f0f;">(问题\s*)(\d+)([：:])/g,
    (_m, pOpen, label, n, colon) => `${pOpen ?? ''}<span style="display:inline-block;font-weight:700;color:#c0501f;margin-right:2px;">${label.trim()}${n}${colon}</span>`)
  .replace(/(^|>)(回答\s*)(\d+)([：:])/g, (_m, lead, label, n, colon) => `${lead}<span style="font-weight:700;color:#c0501f;">${label.trim()}${n}${colon}</span>`);

// 列表：**不用 <ul>/<li>**。
// 微信编辑器打开草稿时会重新归一化列表，把每个 `<li>` 拆成「空 <li> + 内容 <li>」，
// 读者看到的是一列空圆点。同一份 HTML 没被打开过时是干净的——所以脚本自检看不到，
// 只有用户点开草稿才发现（2026-11-12 连续两次反馈）。
// 我们试过剥 <li> 内的 <p>、剥 <li> 内侧换行，都挡不住，因为归一化发生在微信那边。
// 改成「section + 自己写的符号 + 悬挂缩进」，微信对这种结构不做任何改写。
html = flattenLists(html);

// 外链：公众号不保留 href，改成「文字 + 纯文本 URL」，读者可复制
html = html.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_m, url, text) =>
  `<span style="color:#c0501f;">${text}</span><span style="font-size:${FS - 4}px;color:#8a8376;word-break:break-all;">（${url}）</span>`);

// 图片：拆成独立 section + 图注。data-src 是公众号图片的「原始大图」地址，
// 编辑器和客户端靠它实现点击放大；只写 src 的图片在公众号里点不开。
let imageBudget = '';
for (const img of images) {
  const tag = `<img src="@@IMG:${img.src}@@" data-src="@@IMG:${img.src}@@" style="${S.img}">`;
  const re = new RegExp(`<p[^>]*>\\s*<img[^>]+src="${escapeRe(img.src)}"[^>]*>\\s*</p>`);
  const block = `<section style="margin:18px 0 0;">${tag}</section>`
    + (img.caption ? `<section style="${S.figcap}">${img.caption}</section>` : '');
  if (re.test(html)) html = html.replace(re, block);
  else html = html.replace(new RegExp(`<img[^>]+src="${escapeRe(img.src)}"[^>]*>`), tag);
  imageBudget += img.src;
}

// 注意：这里**不再**删除「原表图片后面的切片表」。
// 旧规则的理由是「原表已经作为图片插入了，切片表重复」——但图片本身在手机上就是
// 一张看不清的位图，删掉切片表等于把唯一可读的版本删了（2026-11-12 之前一直这样）。
// 现在原表有表源时会换成窄表，切片表则由上面那段按需删除。

// 开头元信息：逐行段落，避免 grid 在公众号里挤成一坨
//
// ⚠️ 公众号正文**没有任何可点外链**。2026-11-15 实测：提交
// `<a href="https://arxiv.org/abs/2401.15077">…</a>`，draft/get 读回来连 <a> 标签都不剩，
// 只剩文字（anchors=0）。所以「把 arXiv / 代码 / 架构图做成超链接」在公众号做不到，
// 用户反馈的「这些都没有超链接」是平台限制而非排版问题。
//
// 能给的替代只有两种，都已接上：
//   ① 元信息块每一条后面挂一枚**二维码**（读者长按识别 / 扫码打开），
//      这是微信里唯一「可点」的形态；二维码本身在正文里是图片，不会被削。
//   ② 文章级「阅读原文」——每条草稿只有一个名额，这里给个人站本篇页面
//      （content_source_url，在 wechat-publish.mjs 里设）。
// 纯文本 URL 仍然保留，方便读者复制；二维码贴在它下面一行。
// 每条链接配一枚二维码：公众号正文不支持可点外链，扫码是唯一能「点开」的形态。
const qrImages = []; // { key, url }
if (metaLines.length) {
  const qrKeys = new Map(); // url → 占位符 key（同一地址只生成一张图）
  const qrOf = (url) => {
    if (!qrKeys.has(url)) {
      const key = `QR${qrKeys.size}`;
      qrKeys.set(url, key);
      qrImages.push({ key, url });
    }
    return `@@${qrKeys.get(url)}@@`;
  };
  // 二维码统一收在元信息块最下面一行：每条链接各挂一枚，标签写「二维码下面那行小字」。
  // 早期版本是「每行文字后面紧跟一排二维码」，5 条链接会把元信息块撑到一屏多；
  // 收成一行后整块高度稳定在 400px 上下（2026-11-15 实拍）。
  const allLinks = []; // 顺序即显示顺序
  const lineHtml = ([k, v]) => {
    const links = [...v.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => ({ url: sanitizeUrlTrail(m[1]).replace(/&amp;/g, '&'), text: m[2].replace(/<[^>]+>/g, '').trim() }));
    for (const l of links) if (!allLinks.some((x) => x.url === l.url)) allLinks.push(l);
    // 锚文本本身就是 URL 时不再重复补一次（裸链接会被 marked 自动包成 <a>）
    const textPart = v.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_m, url, text) => {
      const bare = text.replace(/<[^>]+>/g, '').trim();
      if (/^https?:\/\//.test(bare)) return text;
      return `${text}<span style="font-size:${FS - 5}px;color:#b3ab9c;word-break:break-all;">　${sanitizeUrlTrail(url)}</span>`;
    });
    return `<p style="font-size:${FS - 2}px;line-height:1.7;color:#37352f;margin:0 0 6px;"><span style="font-weight:700;color:#8a8376;">${k}</span>　${textPart}</p>`;
  };
  const lines = metaLines.map(lineHtml).join('');
  // 一行最多 5 枚，超过就换行；64px 含 10px 间距，343px 正文宽刚好放 4 枚
  const perRow = 4;
  const rows = [];
  for (let i = 0; i < allLinks.length; i += perRow) rows.push(allLinks.slice(i, i + perRow));
  const qrBlocks = rows.map((row) => '<p style="margin:0 0 8px;font-size:0;line-height:0;">'
    + row.map((l) => '<span style="display:inline-block;text-align:center;margin:0 10px 0 0;vertical-align:top;width:68px;">'
      + `<img src="${qrOf(l.url)}" data-src="${qrOf(l.url)}" style="width:68px;height:68px;display:block;">`
      + `<span style="display:block;font-size:${FS - 6}px;line-height:1.3;color:#8a8376;margin-top:2px;">${shortLabel(l.text, l.url)}</span>`
      + '</span>').join('')
    + '</p>').join('');
  const metaHtml = `<section style="margin:0 0 26px;padding:14px 16px;background:#faf8f3;border-radius:6px;">`
    + lines
    + (allLinks.length
      ? `<p style="font-size:${FS - 4}px;line-height:1.6;color:#a39b8b;margin:10px 0 8px;">扫码打开（公众号正文不支持可点外链，长按二维码识别）：</p>${qrBlocks}`
      : '')
    + '</section>';
  html = metaHtml + html;
}

// 简单符号：占位符直接换成纯文本（包一层 span 保持字号一致）
for (const [key, text] of plainInline) {
  // 不用 Georgia 斜体：中文正文里那套字体的小写 l 在这套字号下形似 ⍺，读者会误认成符号。
  html = html.split(`@@${key}@@`).join(`<span style="font-family:'Times New Roman',serif;font-style:italic;color:#1d1d1d;">${text}</span>`);
}

// 公式占位 → 图片。占位符被包在 <p>/<div class="formula"> 里，
// 统一先整体抽出段落，再按「整段只有一个占位符」还是「段内混排」分别处理。
for (const f of formulaImages) {
  const inlineImg = `<img src="@@FORMULA:${f.key}@@" data-src="@@FORMULA:${f.key}@@" style="width:${f.width}px;max-width:100%;vertical-align:middle;display:inline-block;" />`;
  const blockImg = `<section style="margin:8px 0;text-align:center;"><img src="@@FORMULA:${f.key}@@" data-src="@@FORMULA:${f.key}@@" style="width:${f.width}px;max-width:100%;display:inline-block;" /></section>`;
  const ph = `@@${f.key}@@`;
  // 整段 = 单个占位符
  html = html.replace(new RegExp(`<p[^>]*>\\s*${ph}\\s*</p>`, 'g'), blockImg);
  html = html.replace(new RegExp(`<div[^>]*class="formula"[^>]*>\\s*${ph}\\s*</div>`, 'g'), blockImg);
  html = html.split(ph).join(f.key.startsWith('M') ? inlineImg : blockImg);
}

// ---- 4. 落地信息 + 尾注 ----
const links = existsSync(join(mdDir, 'assets/links.json')) ? JSON.parse(readFileSync(join(mdDir, 'assets/links.json'), 'utf8')) : {};
const landing = [...(links.github ?? []), ...(links.huggingface ?? []), ...(links.modelscope ?? []), ...(links.project ?? [])];
if (landing.length) {
  // 标签必须非空。`project` 类链接没有 `repo` 字段，直接 `l.repo ?? ''` 会渲染成
  // 「：https://dflash.z-lab.ai」——冒号前什么都不剩（2026-11-12 用户截图反馈）。
  // 优先级：repo → label → 按类型给一个中文默认名 → 主机名。
  const labelOf = (l) => l.repo || l.label
    || (l.host === 'github.com' ? 'GitHub 仓库' : null)
    || (String(l.url).startsWith('https://huggingface.co') ? 'HuggingFace 模型' : null)
    || '项目页';
  html += wrap(
    '<p style="' + S.p + 'font-weight:700;margin-bottom:8px;">相关链接</p>'
    + landing.map((l) => `<p style="${S.p}font-size:${FS - 2}px;margin-bottom:6px;">${labelOf(l)}：<span style="color:#c0501f;word-break:break-all;">${l.url}</span></p>`).join(''),
    'margin-top:34px;padding-top:20px;border-top:1px solid #eee8dc;',
  );
}
// 文末标签：公众号支持 #话题 但 API 提交的纯文本不会被识别成可点话题，
// 它只是让读者一眼看到这篇归在哪个词下、也方便站内搜索。标签从 article.yaml 的
// `wechat_tags` 取（没有就退回 `xhs_tags`），单条不超过 12 字、6–9 个。
const tagList = Array.isArray(metaTags) ? metaTags : [];
if (tagList.length) {
  html += wrap(
    `<p style="font-size:${FS - 2}px;line-height:2;color:#8a4b2a;margin:0;">${tagList.map((t) => `#${t}`).join('　')}</p>`,
    'margin-top:26px;',
  );
}

html += wrap(
  `<p style="${S.p}font-size:${FS - 3}px;color:#a39b8b;margin:0;text-align:center;">{{SITE_NAME}} · 论文解读</p>`,
  'margin-top:30px;',
);

const htmlPath = join(ROOT, outPath);
mkdirSync(dirname(htmlPath), { recursive: true });

// 兜底：公众号会削掉 class，留着只会让 D6 报错，也说明还有没处理到的模板分支。
html = html.replace(/\s+class="[^"]*"/g, '');

// ⚠️ 不带 --upload 的渲染会把已经上传好的图片 URL **冲回占位符**。
//
// 2026-11-11 实际发生：为了验证 D6 顺手跑了一次 `node scripts/render-wechat.mjs --slug=eagle`，
// 结果 dist/wechat/eagle.html 里的微信图床 URL 全变回 `@@IMG:…@@`，
// 之后所有检查都在对着一份"假坏"的产物报错，而真正草稿箱里那份是好的。
//
// 这条路径几乎总是误操作：想预览就用 --dry-render 输出到临时文件，
// 真要覆盖已上传的产物，显式加 --force。
if (!args.upload && !args.force && existsSync(htmlPath)) {
  const prev = readFileSync(htmlPath, 'utf8');
  // 微信返回的是 http://（不是 https://）。守卫之前只匹配 https，等于形同虚设——
  // 2026-11-12 又一次把 dflash 的 4 张图冲回了 @@IMG 占位符。
  const hadUploaded = /https?:\/\/mmbiz\.(?:qpic|qlogo)\.cn\//.test(prev);
  if (hadUploaded) {
    console.error(`✗ ${outPath} 里已有上传好的微信图床 URL，本次是**不带 --upload** 的渲染，`);
    console.error('  继续会把它冲回 @@IMG 占位符（草稿箱里那份不会变，但本地产物会变成假坏）。');
    console.error('  要覆盖请加 --force；只想看 HTML 用 --out=<临时路径>。');
    process.exit(2);
  }
}

writeFileSync(htmlPath, html);

// ---- 5. 上传（可选） ----
let uploadReport = null;
if (args.upload) {
  const { getToken, uploadImage } = await import('./wechat-api.mjs');
  const { mapPool } = await import('./lib/pool.mjs');
  const token = await getToken();
  const urlMap = new Map();
  // 图片与公式图**并发上传**：串行时 8 张图 + N 张公式图每张 1–2 秒，
  // 光上传就要十几秒。微信素材接口对并发没有硬限制，4 并发实测稳定。
  const imgJobs = images.map((img) => async () => {
    const abs = resolve(mdDir, img.src);
    urlMap.set(`@@IMG:${img.src}@@`, await uploadImage(token, readFileSync(abs), `${slug}-${img.src.split('/').pop()}`, 'png'));
  });
  // 相同 TeX 的公式共用一张图：按 buffer 内容去重上传
  const byHash = new Map(); // base64 → { buffer, keys[] }
  for (const f of formulaImages) {
    const hash = f.buffer.toString('base64');
    if (!byHash.has(hash)) byHash.set(hash, { buffer: f.buffer, keys: [] });
    byHash.get(hash).keys.push(f.key);
  }
  const formulaJobs = [...byHash.values()].map(({ buffer, keys }) => async () => {
    const url = await uploadImage(token, buffer, `${slug}-eq-${keys[0]}.png`, 'png');
    for (const key of keys) urlMap.set(`@@FORMULA:${key}@@`, url);
  });
  // 二维码：本地生成 PNG 再上传，和正文图片走同一条素材通路
  const QR = (await import('qrcode')).default;
  const qrJobs = qrImages.map((q) => async () => {
    const buf = await QR.toBuffer(q.url, { width: 300, margin: 1, errorCorrectionLevel: 'M' });
    urlMap.set(`@@${q.key}@@`, await uploadImage(token, buf, `${slug}-${q.key}.png`, 'png'));
  });
  await mapPool([...imgJobs, ...formulaJobs, ...qrJobs], 4, (job) => job());
  for (const [k, v] of urlMap) html = html.split(k).join(v);
  writeFileSync(htmlPath, html);
  uploadReport = { images: images.length, formulas: formulaImages.length, qrcodes: qrImages.length };
}

// @@FORMULA:xxx@@ / @@IMG:xxx@@ 是「待上传」占位，属于正常；这里只找没被替换的原始公式占位
const leftovers = [...html.matchAll(/@@[MD]\d+@@/g)].map((m) => m[0]);
const qrLeft = [...html.matchAll(/@@QR\d+@@/g)].map((m) => m[0]);
if (qrLeft.length && !args.upload) {
  console.error(`⚠️ 有 ${qrLeft.length} 个二维码占位没有被替换：不加 --upload 渲染时无法生成二维码图片`);
}
console.log(JSON.stringify({
  out: outPath,
  bytes: Buffer.byteLength(html),
  images: images.length,
  formulas: formulaImages.length,
  qrcodes: qrImages.length,
  uploaded: uploadReport,
  unresolved: [...leftovers, ...qrLeft],
}, null, 1));
process.exit(leftovers.length || (qrLeft.length && args.upload) ? 1 : 0);

/**
 * 二维码下面那行小字。
 * 优先按 URL 归类给出固定短名（读者扫之前就知道这枚通向哪），
 * 认不出类型再退回锚文本 / 主机名。前缀一致才能一眼分清 5 枚码。
 */
function shortLabel(text, url = '') {
  const u = (() => { try { return new URL(url); } catch { return null; } })();
  if (u) {
    const p = u.pathname;
    if (/arxiv\.org$/.test(u.host)) return /\/pdf\//.test(p) ? '论文 PDF' : 'arXiv 原文';
    if (/github\.com$/.test(u.host)) return '代码仓库';
    if (/huggingface\.co$/.test(u.host) || u.host === 'hf.co') return '模型权重';
    if (/modelscope\.cn$/.test(u.host)) return '魔搭模型';
    if (/note\.ossradar\.top$/.test(u.host)) return /-static\.html?$/.test(p) ? '静态架构图' : '动态架构图';
  }
  const raw = String(text ?? '').replace(/（[^）]*）/g, '').trim();
  if (raw && !/^https?:\/\//.test(raw)) return raw.length > 10 ? `${raw.slice(0, 10)}…` : raw;
  if (u) return u.host.replace(/^www\./, '').replace(/\.(com|org|io|ai|cn)$/, '');
  return raw.slice(0, 10);
}

/** GFM 把「URL 行尾的反斜杠」吞进了链接（%5C / 结尾 \），这里还原成干净 URL */
function sanitizeUrlTrail(text) {
  return text
    .replace(/(https?:\/\/[^\s<>"）]+?)%5C(?=\)|$|\s)/gi, '$1')
    .replace(/(https?:\/\/[^\s<>"）]+?)\\(?=\)|$|\s)/g, '$1');
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** 解析 yaml 里的字符串数组字段（`key:` 下面缩进的 `- item`） */
function parseYamlList(text, key) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s+-\s*(.+)$/);
    if (m) out.push(m[1].trim().replace(/^["']|["']$/g, ''));
    else if (lines[i].trim() === '') continue;
    else break;
  }
  return out.length ? out : null;
}

function parseYaml(text) {
  const data = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m && !line.startsWith(' ')) data[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return data;
}
