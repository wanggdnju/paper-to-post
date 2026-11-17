#!/usr/bin/env node
/**
 * 把 articles/<slug>/zhihu.md 转成可直接贴进知乎编辑器的 HTML。
 *
 *   npm run render:zhihu -- --slug=dflash            # → dist/zhihu/dflash.html
 *   npm run render:zhihu -- --slug=dflash --blocks   # → dist/zhihu/dflash-blocks.json（调试用）
 *
 * 规则：
 *   - 「## 正文（…）」之前的内容（公式清单、用法说明）不输出；
 *   - 【公式N：说明】就地换成**行间公式**（`data-eeimg="2"`），由编辑器粘贴时直接落成公式卡；
 *   - 表格输出成 <table>，Draft.js 粘贴后会自动转成可编辑表格；
 *   - 【表N：…】**有 LaTeX 表源时渲染成紧凑 HTML 表**（按任务拆成几张窄表），
 *     没有表源才退回截图——知乎正文宽 ~690px，18 列的原表截图和文字都读不出来。
 *
 * 为什么公式现在直接写进 HTML，而不再留占位符让脚本点工具栏插入：
 *   工具栏那条路（选中占位符 → Backspace → Enter×2 → 点「公式」→ 敲 TeX → 确认）
 *   ① 每次会留下 2 个空段落 → 公式前好几个空行；
 *   ② 出来的节点是 `data-eeimg="1"`（**行内**公式），不是行间，所以永远左对齐；
 *   ③ 三次 UI 操作都可能静默失败，脚本还得核对占位符是否删掉。
 *   知乎的阅读页 CSS 是 `.ztext-math[data-eeimg="2"]{display:block;text-align:center}`，
 *   所以只要在粘贴的 HTML 里写成 `data-eeimg="2"`，粘贴完就是居中行间公式——
 *   已实测（2026-11-11）：粘贴后节点带 `MathJax_SVG_Display`，`display:block; text-align:center`，
 *   而且不会多出空段落。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { compactForTable, cellMarkdown } from './lib/paper-tables.mjs';
import { loadExtras, renderExtrasNarrow } from './lib/paper-extras.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/render-zhihu.mjs --slug=<slug> [--blocks]');
  process.exit(1);
}

const ROOT = process.cwd();
const srcPath = join(ROOT, 'articles', String(args.slug), 'zhihu.md');
if (!existsSync(srcPath)) {
  console.error(`找不到 ${srcPath}`);
  process.exit(1);
}
const source = readFileSync(srcPath, 'utf8');
// 必须有 `## 正文` 这一节。不能用 `?? source` 兜底：
// 兜底的结果是把「用法说明 + 公式清单」当成正文贴进知乎（2026-11-11 实际发生过，
// 编辑器里第一章变成了「用法：正文一次性粘贴…」）。宁可报错，也不要产出坏稿。
const bodyMatch = source.match(/^##\s*正文.*$/m);
if (!bodyMatch) {
  console.error(`✗ ${srcPath} 里找不到「## 正文」标题，无法切出正文。`);
  console.error('  derive-variants.mjs 会写这个标题；如果是手改过的旧稿，补一行即可。');
  process.exit(1);
}
const body = source.slice(bodyMatch.index + bodyMatch[0].length);

// 公式清单（在「## 正文」之前）里的 TeX 源码：`| 1 | 行间 | \`\hat{f}=...\` |`
const formulaTex = new Map(
  [...source.matchAll(/^\|\s*(\d+)\s*\|\s*行间\s*\|\s*`([^`]+)`\s*\|$/gm)]
    .map((m) => [Number(m[1]), m[2]]),
);
// 图片按 article.md 中出现的顺序取。图表编号是**分两套**的（图 1–7、表 1–4），
// 而素材是一个按文档顺序排的数组，所以先按同样规则给每张素材编号，再建映射。
const articlePath = join(ROOT, 'articles', String(args.slug), 'article.md');
const imageList = existsSync(articlePath)
  ? [...readFileSync(articlePath, 'utf8').matchAll(/!\[([^\]]*)\]\((assets\/[^)\s]+)\)/g)]
    .map((m) => ({ alt: m[1], path: join('articles', String(args.slug), m[2]) }))
  : [];
const imageByNumber = new Map();
{
  let fig = 0;
  let tab = 0;
  for (const it of imageList) {
    const isTable = /(?:^|\/)tab-/.test(it.path) || /^\s*表/.test(it.alt);
    const key = `${isTable ? '表' : '图'}${isTable ? ++tab : ++fig}`;
    imageByNumber.set(key, it.path);
  }
}

// ---- 切成块 ----
const blocks = [];
const lines = body.split('\n');
let buf = [];
const flush = () => {
  const text = buf.join('\n').trim();
  if (text) blocks.push({ type: 'text', text });
  buf = [];
};
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trim();
  if (/^\|/.test(t)) {
    flush();
    const rows = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++].trim());
    i--;
    blocks.push({ type: 'table', rows: rows.filter((r) => !/^\|[\s\-:|]+\|$/.test(r)) });
    continue;
  }
  const h = t.match(/^(#{2,4})\s+(.*)$/);
  if (h) { flush(); blocks.push({ type: 'h', level: h[1].length, text: h[2] }); continue; }
  if (/^【公式\d+/.test(t)) { flush(); blocks.push({ type: 'formula', text: t }); continue; }
  // 开头的「论文/作者/链接」引用块：逐行输出，避免 p 里塞 <br>
  if (/^>\s/.test(t)) {
    flush();
    const quoted = [];
    while (i < lines.length && /^>\s?/.test(lines[i].trim())) quoted.push(lines[i++].trim().replace(/^>\s?/, ''));
    i--;
    blocks.push({ type: 'quote-lines', lines: quoted.filter(Boolean) });
    continue;
  }
  // 【图N：…】/【表N：…】：都指向 assets 里的图片。
  // 图和表在 article.md 里是两条独立计数（图 1–7、表 1–4），但图片素材
  // 是**按文档顺序**排的一个数组，所以要把「第几张图」「第几张表」换算成
  // 它在 images[] 里的下标——两套编号直接当数组下标用，会指错图。
  const img = t.match(/^【(图|表)(\d+)[：:](.+?)】$/);
  if (img) { flush(); blocks.push({ type: 'image', kind: img[1], n: Number(img[2]), caption: img[3] }); continue; }
  if (/^[-*]\s+/.test(t)) {
    flush();
    const items = [];
    while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) items.push(lines[i++].trim().replace(/^[-*]\s+/, ''));
    i--;
    blocks.push({ type: 'ul', items });
    continue;
  }
  if (t === '---' || t === '') { flush(); continue; }
  buf.push(line);
}
flush();

// ---- 生成 HTML ----
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 行内 `$...$` → 可读的纯文本。
 *
 * 知乎支持行内公式，但**只能一个个手动插公式卡**，正文粘贴时 `$T_{\mathrm{draft}}$`
 * 会原样显示成带美元符号的 TeX 源码。行内公式往往有几十处（eagle 有 76 个 `$`），
 * 逐个插卡不现实；所以这里降级成纯文本，与公众号的做法一致。
 *
 * ⚠️ 不能简单去掉 `$` 了事：`T_{\mathrm{draft}}` 会变成 `T_draft`，
 * 读者看到的是下划线而不是下标。这里把常见写法真正转成 Unicode：
 *   \tau → τ、T_{\mathrm{draft}} → T_draft（知乎不支持下标的更细形式）
 * 转换不了的结构（分式、希腊字母下标组合）保留原样并**去掉美元符号**，
 * 至少不会在正文里出现 `$`。
 */
function texToPlain(tex) {
  const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };
  const GREEK = {
    tau: 'τ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', eta: 'η',
    theta: 'θ', lambda: 'λ', mu: 'μ', nu: 'ν', pi: 'π', rho: 'ρ', sigma: 'σ',
    phi: 'φ', psi: 'ψ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω',
  };
  let out = tex;
  // 先处理「整式只有一个符号」的最常见情况
  const sym = out.match(/^\s*\\([a-zA-Z]+)\s*$/);
  if (sym && GREEK[sym[1]]) return GREEK[sym[1]];
  // 取参数内容的命令
  out = out.replace(/\\(?:mathrm|text|textrm|operatorname|mathbf|mathrm)\s*\{([^{}]*)\}/g, '$1');
  // 带固定写法的符号必须**先**替换，否则会被下面「去反斜杠」那步变成 times/cdot
  out = out.replace(/\\times/g, '×').replace(/\\cdot/g, '·')
    .replace(/\\hat\s*\{([^{}]*)\}/g, '$1̂')   // \hat{p} → p̂
    .replace(/\\bar\s*\{([^{}]*)\}/g, '$1̄');
  // 其余命令只去掉反斜杠，保留名字（\min → min、\mathrm{x} → x 已在上一步处理）
  out = out.replace(/\\([a-zA-Z]+)/g, (m, name) => GREEK[name] ?? name);
  // 纯数字下标 → Unicode 下标（x_1 → x₁）；字母下标保留 _ 形式（知乎能看懂）
  out = out.replace(/_\{?([0-9])\}?/g, (m, d) => SUB[d] ?? `_${d}`);
  out = out.replace(/\^\{?([0-9])\}?/g, (m, d) => ({ 0: '⁰', 1: '¹', 2: '²', 3: '³' }[d] ?? `^${d}`));
  // 剩下的花括号只是分组符号，去掉
  out = out.replace(/[{}]/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

const inline = (s) => {
  // 链接要落成真正的 <a>：之前把 [文字](url) 降级成纯文字，理由是「粘贴后编辑器会自己
  // 识别链接」——实际不会，读者看到的是点不动的文字（2026-11-14 用户反馈）。
  // 裸 URL 同理，个人站架构图那一行就是裸链接，必须自己包成 <a>。
  const anchors = [];
  const hold = (html) => `\u0000${anchors.push(html) - 1}\u0000`;
  let out = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\$([^$\n]+)\$/g, (_m, tex) => esc(texToPlain(tex)))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, text, url) => hold(`<a href="${url}">${text}</a>`))
    .replace(/https?:\/\/[^\s<）)，。；]+/g, (url) => hold(`<a href="${url}">${url}</a>`));
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => anchors[Number(i)]);
};

/**
 * 图片注释纯文本：`$f_I$` 要变成 `f_I`，不能把美元符号带进 figcaption。
 * 知乎的图片注释框上限 140 字，超了会截断在半个句子里，所以这里按句号收尾。
 */
const ZHIHU_CAPTION_MAX = 140;
function captionText(s) {
  let out = s.replace(/\$([^$\n]+)\$/g, (_m, tex) => texToPlain(tex)).replace(/\*\*/g, '').trim();
  if (out.length <= ZHIHU_CAPTION_MAX) return out;
  const cut = out.slice(0, ZHIHU_CAPTION_MAX);
  const sentEnd = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'));
  return sentEnd > 40 ? cut.slice(0, sentEnd + 1) : `${cut.slice(0, ZHIHU_CAPTION_MAX - 1)}…`;
}

// 用 Chromium 把图片降到合适宽度并转 JPEG，避免 HTML 里塞进十几 MB base64。
// 知乎正文容器约 690px 宽，1500px 是 2x 屏的两倍余量，没有必要：
// 6 张图压到 1500px 后 base64 合计近 1 MB，粘进 Draft.js 会把编辑器卡到超时。
// 800px（约 1.16x）在视网膜屏上仍然清晰，体积降到三分之一左右。
const ZHIHU_IMG_WIDTH = Number(process.env.ZHIHU_IMG_WIDTH ?? 800);
const ZHIHU_IMG_QUALITY = Number(process.env.ZHIHU_IMG_QUALITY ?? 0.82);
const shrinkCache = new Map();
async function shrinkAll(relPaths) {
  if (!relPaths.length) return shrinkCache;
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./lib/chromium.mjs');
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: ZHIHU_IMG_WIDTH, height: 900 } });
    for (const rel of relPaths) {
      if (shrinkCache.has(rel)) continue;
      const b64 = readFileSync(join(ROOT, rel)).toString('base64');
      const jpg = await page.evaluate(async ({ b64, maxW, q }) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const scale = Math.min(1, maxW / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        return canvas.toDataURL('image/jpeg', q).split(',')[1];
      }, { b64, maxW: ZHIHU_IMG_WIDTH, q: ZHIHU_IMG_QUALITY });
      shrinkCache.set(rel, jpg);
    }
  } finally {
    await browser.close();
  }
  return shrinkCache;
}
const imagesData = await shrinkAll([...new Set(imageByNumber.values())]);
const imageBlockCache = (rel) => imagesData.get(rel);

// 派生区块（机制图 + 横向对比）。图片走和其它图同一条压缩管道：
// 知乎正文 690px，原图 690×444 不缩也能看，但统一压成 JPEG 能省一半 base64。
const extras = loadExtras(ROOT, String(args.slug));
const extrasDiagramRel = extras.diagram ? relative(ROOT, extras.diagram.png) : '';
if (extrasDiagramRel) await shrinkAll([extrasDiagramRel]);

// 先把「哪几张表能渲染成紧凑表」算出来。能渲染的：
//   ① 图片块直接用紧凑表替换（不贴截图）；
//   ② 紧跟其后的「…切片…」说明段落 + 手抄切片表一并删掉——同一份数字出现两遍，
//      手抄表还容易和原表对不上。
const articleDir = join(ROOT, 'articles', String(args.slug));
for (const b of blocks) {
  if (b.type !== 'image' || b.kind !== '表') continue;
  const compact = compactForTable(articleDir, b.n, b.caption);
  if (!compact) continue;
  if (compact.problems.length) {
    console.warn(`⚠️ 表 ${b.n} 的 LaTeX 表源解析不干净（${compact.problems.join('；')}），退回截图`);
    continue;
  }
  if (compact.tables.length) b.compact = compact;
}
for (let i = 0; i < blocks.length; i++) {
  if (!blocks[i].compact) continue;
  // 跳过可能存在的「…切片…」说明段，再删掉紧随的表
  let j = i + 1;
  if (blocks[j]?.type === 'text' && /切片/.test(blocks[j].text)) j++;
  if (blocks[j]?.type === 'table') blocks.splice(j, 1);
}

const html = blocks.map((b) => {
  if (b.type === 'h') return `<h${b.level}>${inline(b.text)}</h${b.level}>`;
  if (b.type === 'text') {
    return b.text.split(/\n\s*\n/).filter(Boolean).map((p) => {
      const one = p.replace(/\n/g, ' ');
      // 表格的图注行（`表 3 · 链式与树式草稿的接受长度对比`）用斜体，
      // 否则它和正文段落长得一模一样，读者不知道这是表的标题还是论述。
      if (/^表\s*\d+\s*·/.test(one.trim())) return `<p><em>${inline(one.trim())}</em></p>`;
      return `<p>${inline(one)}</p>`;
    }).join('');
  }
  // 元信息引用块：<blockquote> + 每行一个 <p>，知乎粘贴后是独立段落，不会挤成一行
  if (b.type === 'quote-lines') {
    // 行尾的 `\` 是 markdown 的续行符（写在 article.md 里让 marked 生成 <br>）。
    // 知乎这里是逐行 <p>，续行本就成立，反斜杠会原样显示成正文里的一个「\」。
    const inner = b.lines.map((l) => `<p>${inline(l.replace(/\\\s*$/, ''))}</p>`).join('');
    return `<blockquote>${inner}</blockquote>`;
  }
  // 行间公式：直接写成知乎自己的 ztext-math 节点，`data-eeimg="2"` = 行间（居中）。
  // 找不到对应 TeX 时退回占位符文本，让人一眼看出是哪条没配上，而不是静默丢公式。
  if (b.type === 'formula') {
    const n = Number(b.text.match(/^【公式(\d+)/)?.[1]);
    const tex = formulaTex.get(n);
    if (!tex) return `<p data-formula="${esc(b.text)}">${esc(b.text)}</p>`;
    return `<p><span class="ztext-math" data-eeimg="2" data-tex="${esc(tex)}">${esc(tex)}</span></p>`;
  }
  if (b.type === 'image') {
    // 表：有 LaTeX 表源时前面已经算好紧凑表（b.compact），这里直接输出。
    // 知乎正文 ~690px，18 列的原表截图（2600–4800px 宽）缩进去每个数字只剩 5–6px，
    // 读者既看不清也没法选中；紧凑表按任务拆成几张窄表，每张自带 Model/Method。
    if (b.compact) {
      // 每张窄表自带标题（含序号 n/N），不再单独来一行总图注——那样同一句话会出现两遍
      return b.compact.tables.map((t) => {
        const head = `<tr>${t.header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>`;
        // 单元格带 <strong>/<em>：`inline()` 会先 esc()，所以要先把标签换成 Markdown 强调，
        // 否则页面上会出现字面 `<strong>5.15×</strong>`（2026-11-12 实际出现过）
        const rows = t.rows.map((r) => `<tr>${r.map((c) => `<td>${inline(cellMarkdown(c))}</td>`).join('')}</tr>`).join('');
        return `<p><em>${inline(t.title)}</em></p><table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
      }).join('');
    }
    // 图片顺序 = article.md 里出现的顺序
    const asset = imageByNumber.get(`${b.kind}${b.n}`);
    if (!asset) return `<p data-image="${esc(b.caption)}">【${b.kind}${b.n}：${esc(b.caption)}（article.md 里找不到对应的${b.kind}）】</p>`;
    // 原图动辄 5MB，压到 800px 宽再嵌入
    const data = imageBlockCache(asset);
    // 图注**只放在 alt 里**，不再拼进正文：
    //   - 拼进正文时它只是一段普通段落，读者分不清哪句是图注；
    //   - 知乎图片有自己的注释位（figcaption），zhihu-fill 会把 alt 填进去，
    //     这样图注显示在图下方、字号更小，和知乎原生图片一致。
    //   另外 `<img>` 两侧的 `<p>`/`</p>` 碎片如果被单独粘贴，会凭空多出空段落，
    //   所以这里保证每张图是**一个完整的 <p>**。
    return `<p><img src="data:image/jpeg;base64,${data}" alt="${esc(captionText(`${b.kind} ${b.n} · ${b.caption}`))}"></p>`;
  }
  if (b.type === 'ul') return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
  if (b.type === 'table') {
    const rows = b.rows.map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const [head, ...rest] = rows;
    return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest
      .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  return '';
}).join('\n');

// 派生区块拼在正文之后。知乎的图必须是 `<p><img>` 整块（碎片会被粘成空段落），
// 图注仍然只放 alt——zhihu-fill 会把它填进 figcaption。
const extrasDiagramTag = extras.diagram && extrasDiagramRel
  ? `<p><img src="data:image/jpeg;base64,${imageBlockCache(extrasDiagramRel)}" alt="${esc(
    `机制图 · ${extras.diagram.spec.title ?? ''}`.trim(),
  )}"></p>`
  : '';
const extrasHtml = extrasDiagramTag || extras.compare
  ? renderExtrasNarrow(extras, { imgTag: extrasDiagramTag, small: 13 })
  : '';
// 「附：问答」是附录，留在最后；横向对比是正文内容，插在它前面。
const htmlWithExtras = extrasHtml
  ? (/<h2>附[：:]\s*问答<\/h2>/.test(html)
    ? html.replace(/(<h2>附[：:]\s*问答<\/h2>)/, `${extrasHtml}\n$1`)
    : `${html}\n${extrasHtml}`)
  : html;

const outDir = join(ROOT, 'dist', 'zhihu');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${args.slug}.html`);
writeFileSync(outPath, htmlWithExtras);
if (args.blocks) writeFileSync(join(outDir, `${args.slug}-blocks.json`), JSON.stringify(blocks, null, 1));

const formulas = blocks.filter((b) => b.type === 'formula');
const missingTex = formulas.filter((f) => {
  const n = Number(f.text.match(/^【公式(\d+)/)?.[1]);
  return !formulaTex.has(n);
});
console.log(JSON.stringify({
  out: outPath,
  bytes: Buffer.byteLength(htmlWithExtras),
  blocks: blocks.length,
  tables: blocks.filter((b) => b.type === 'table').length,
  formulas: formulas.length,
  // 有占位符但清单里找不到 TeX：这类会原样留下【公式N】，必须在灌入前修掉
  missingTex: missingTex.map((f) => f.text),
  formulaList: formulas.map((f) => f.text),
}, null, 1));
if (missingTex.length) {
  console.error(`✗ 有 ${missingTex.length} 个公式在清单里找不到 TeX，会原样显示成【公式N】`);
  process.exit(1);
}
