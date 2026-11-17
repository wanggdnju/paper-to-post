#!/usr/bin/env node
/**
 * 从渲染好的单文件 HTML 反推 markdown（应急恢复用）。
 *
 *   node scripts/html-to-md.mjs --in=dist/html/dspine.html --out=/tmp/recovered.md
 *
 * 为什么会需要这个：generate.mjs 曾经在「只有部分小节写好」时也执行拼装，
 * 把完整成稿替换成半成品，而仓库没有 git 历史可回滚。
 * 唯一还留着全文的地方是 dist/html/<slug>.html —— 它由 article.md 直接渲染，
 * 结构（标题层级、图片、表格、代码块）都在，只是样式内联。
 *
 * 这只是**恢复手段**，不是日常流程。还原后的文件必须人工过一遍：
 *   - KaTeX 渲染过的公式会变成 <span class="katex">，本脚本用 data-tex 属性还原；
 *   - 加粗、链接、行内代码能从标签恢复；
 *   - 但**原文里的空行分布**会损失，长图切页可能和原来不一样。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.in) {
  console.error('用法：node scripts/html-to-md.mjs --in=dist/html/<slug>.html [--out=path.md]');
  process.exit(1);
}
const source = readFileSync(String(args.in), 'utf8');

// 只取正文区。render-html.mjs 的结构是 <header class="hero">…</header><main>正文</main>，
// 标题和 arXiv 链接在 header 里（那是模板加的，不属于 article.md），所以从 <main> 开始取。
const bodyMatch = source.match(/<main[^>]*>([\s\S]*?)<\/main>/)
  ?? source.match(/<article[^>]*>([\s\S]*?)<\/article>/);
if (!bodyMatch) {
  console.error('✗ 找不到正文区（没有 <main>）');
  process.exit(1);
}
let html = bodyMatch[1];
// 渲染时插进去的「论文/作者/链接」信息块不属于 markdown 原文，去掉
html = html.replace(/<blockquote class="meta-block">[\s\S]*?<\/blockquote>/g, '');

// ---- KaTeX 还原 ----
// KaTeX 输出是三层冗余：视觉层（span.mord 等）+ MathML 层 + annotation（TeX 原文）。
// 直接剥标签会得到「E_v⊤ h E_v^\top h E_v^⊤ h」这种三遍重复的垃圾。
// 正确做法：整段 <span class="katex">…</span> 连同内部所有东西一起吃掉，
// 只从 <annotation encoding="application/x-tex"> 里取出 TeX。
// 这里用「先整体替换成占位符」的两步法，避免嵌套 span 的配对问题。
const mathSlots = [];
function stashMath(match) {
  const tex = match.match(/<annotation[^>]*>([\s\S]*?)<\/annotation>/)?.[1];
  const display = /class="katex-display"/.test(match.slice(0, 200));
  if (!tex) return '';
  const decoded = tex
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
  mathSlots.push(display ? `\n\n$$${decoded}$$\n\n` : `$${decoded}$`);
  return `\u0000MATH${mathSlots.length - 1}\u0000`;
}
// katex-display 包着 katex；先匹配外层，避免 display 判断失效
html = html.replace(/<span class="katex-display"[^>]*>[\s\S]*?<\/span>\s*<\/span>\s*<\/span>/g, stashMath);
html = html.replace(/<span class="katex"[^>]*>[\s\S]*?<annotation[^>]*>[\s\S]*?<\/annotation>[\s\S]*?<\/span>\s*<\/span>/g, stashMath);
// 剩下的（结构不标准时）逐个 katex 处理
html = html.replace(/<span class="katex"[^>]*>[\s\S]*?<\/span>(?=<)/g, stashMath);

// 块级元素 → markdown
const lines = [];
const push = (s) => { const t = s.trim(); if (t) lines.push(t); };
const inline = (s) => s
  .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/g, '**$1**')
  .replace(/<em[^>]*>([\s\S]*?)<\/em>/g, '*$1*')
  .replace(/<code[^>]*>([\s\S]*?)<\/code>/g, '`$1`')
  .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
  .replace(/<br\s*\/?>/g, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\u0000MATH(\d+)\u0000/g, (_, i) => mathSlots[Number(i)] ?? '')
  .replace(/[ \t]+/g, ' ');

// 逐块扫描，保持顺序
const BLOCK = /<(h1|h2|h3|h4|p|ul|ol|table|blockquote|pre|img)[^>]*>([\s\S]*?)<\/\1>/g;
// 图片是自闭合标签，单独处理
const TOKEN = /(<img[^>]*>|<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>|<p[^>]*>[\s\S]*?<\/p>|<ul[^>]*>[\s\S]*?<\/ul>|<ol[^>]*>[\s\S]*?<\/ol>|<table[^>]*>[\s\S]*?<\/table>|<blockquote[^>]*>[\s\S]*?<\/blockquote>|<pre[^>]*>[\s\S]*?<\/pre>)/g;
void BLOCK;

for (const m of html.matchAll(TOKEN)) {
  const tag = m[1];
  if (tag.startsWith('<img')) {
    const src = tag.match(/src="([^"]*)"/)?.[1] ?? '';
    const alt = tag.match(/alt="([^"]*)"/)?.[1] ?? '';
    // 恢复成相对于 articles/<slug>/ 的路径
    const rel = src.replace(/^(\.\.\/)+articles\/[^/]+\//, '');
    push(`![${alt.replace(/"/g, "'")}](${rel})`);
    lines.push('');
    continue;
  }
  const h = tag.match(/^<h([1-4])[^>]*>([\s\S]*?)<\/h[1-4]>$/);
  if (h) {
    push(`${'#'.repeat(Number(h[1]))} ${inline(h[2]).replace(/\n/g, ' ')}`);
    lines.push('');
    continue;
  }
  if (tag.startsWith('<ul') || tag.startsWith('<ol')) {
    const ordered = tag.startsWith('<ol');
    for (const li of tag.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      push(`${ordered ? '1.' : '-'} ${inline(li[1]).replace(/\n/g, ' ')}`);
    }
    lines.push('');
    continue;
  }
  if (tag.startsWith('<table')) {
    // 表格逐行还原成 markdown
    const rows = [...tag.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
      [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => inline(c[1]).replace(/\n/g, ' ').replace(/\|/g, '\\|').trim()));
    if (rows.length) {
      push(`| ${rows[0].join(' | ')} |`);
      push(`| ${rows[0].map(() => '---').join(' | ')} |`);
      for (const r of rows.slice(1)) push(`| ${r.join(' | ')} |`);
      lines.push('');
    }
    continue;
  }
  if (tag.startsWith('<pre')) {
    const code = tag.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    lines.push('```', code.trim(), '```', '');
    continue;
  }
  if (tag.startsWith('<blockquote')) {
    for (const ln of inline(tag.replace(/<\/?blockquote[^>]*>/g, '')).split('\n')) push(`> ${ln}`);
    lines.push('');
    continue;
  }
  // <p>
  const text = inline(tag);
  if (text.trim()) { push(text); lines.push(''); }
}

const md = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
const out = args.out ? String(args.out) : '/tmp/recovered.md';
writeFileSync(out, md, 'utf8');
const zh = (md.match(/[一-龥]/g) ?? []).length;
console.log(`→ ${out}（${zh} 中文字，${lines.length} 行）`);
if (!args.silent) console.log(md.slice(0, 600));
