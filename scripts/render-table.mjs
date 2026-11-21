#!/usr/bin/env node
/**
 * 把论文里的表格变成 PNG（用于「结果表直接贴原表」）。
 *
 * 两种来源，优先用第一种：
 *
 *   ① 直接从 PDF 裁（**首选**）
 *      npm run render:table -- --slug=eagle --pdf=/tmp/2401.15077.pdf --page=6 --caption="Table 1" --out=main
 *      按 caption 定位表格区域，用 PDFKit 渲染成 300dpi PNG。
 *      输出是论文排版的最终结果，逐行逐列与原文一致；caption 也一并带上。
 *
 *   ② 从 LaTeX 转（PDF 裁不准时的退路，比如表格跨页或没有 PDF）
 *      npm run render:table -- --slug=dflash --tex=/tmp/eprint-2602.06036/tables/results/main.tex --out=main
 *      原理：用一个极简的 LaTeX→HTML 转换器把 tabular 转成 <table>（支持 tabular/tabular*、
 *      \multicolumn、\multirow、\toprule/\midrule/\bottomrule、\textbf、$...$ 数学），
 *      再 Chromium 截图。
 *
 * 为什么现在默认改成裁 PDF：
 *   自己写 LaTeX 子集解释器，每多一种写法就多一个 bug，而且**错得很安静**——
 *   eagle 的主表曾因为一个贪婪正则把两列合并，页面上印出「2 HumanEval」「2cGSM8K」，
 *   数字检查全过（数字本身没变），只有人眼看图才发现。裁 PDF 不存在「解释错」这件事。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug || (!args.tex && !args.pdf)) {
  console.error('用法①（首选，从 PDF 裁）：node scripts/render-table.mjs --slug=<slug> --pdf=<paper.pdf> --page=<页> --caption="Table 1" [--out=main] [--dpi=300]');
  console.error('用法②（退路，LaTeX 转）：node scripts/render-table.mjs --slug=<slug> --tex=<table.tex> [--out=main] [--dpi=2]');
  process.exit(1);
}
const ROOT = process.cwd();
const outName = String(args.out ?? 'table');
const assetDirEarly = join(ROOT, 'articles', String(args.slug), 'assets');
fs.mkdirSync(assetDirEarly, { recursive: true });

// ---------------------------------------------------------------- 路线①：从 PDF 裁
// 没有字体/宏解释器，表格长什么样就是论文里长什么样。
if (args.pdf) {
  const { execFileSync: run } = await import('node:child_process');
  const outPng = join(assetDirEarly, `tab-${outName}.png`);
  let result;
  try {
    const stdout = run('swift', [
      join(ROOT, 'scripts/lib/pdf-table.swift'),
      String(args.pdf), String(args.page ?? 1), String(args.caption ?? 'Table 1'),
      outPng, String(args.dpi ?? 300),
      // 有些模板把 \caption 放在表格**下方**（DFlare Table 2 就是这样）。
      // 不给这个标记时按「caption 在上」处理，会顺着下方正文一路裁。
      args['caption-below'] ? 'below' : 'above',
    ], { encoding: 'utf8' });
    result = JSON.parse(stdout);
  } catch (error) {
    // 退出码 2 = 本页没这个 caption，提示换页；3 = 区域识别失败，提示改用 --tex
    const detail = error.stdout || error.stderr || error.message;
    console.error(`✗ 从 PDF 裁表格失败：${String(detail).trim()}`);
    console.error('  · 退出码 2：这一页没有该 caption，用 --page 换一页（页码从 1 开始）');
    console.error('  · 退出码 3：区域识别异常（跨页表 / 双栏串栏），退回 --tex=<table.tex> 渲染');
    process.exit(1);
  }
  // caption 写回，供 article.md 引用与人工核对
  fs.writeFileSync(join(assetDirEarly, `tab-${outName}.caption.txt`), `${result.caption}\n`);
  console.log(JSON.stringify({
    png: `articles/${args.slug}/assets/tab-${outName}.png`,
    source: 'pdf-crop',
    page: result.page,
    caption: result.caption,
    rows: result.rows,
    pixels: result.pixels,
    hint: '这是论文原表裁图（含论文 caption）。正文图注请写「表 N · …」，不要重复论文 caption 字数。',
  }, null, 1));
  process.exit(0);
}

// ---------------------------------------------------------------- 路线②：LaTeX → HTML → 截图
const katex = (await import('katex')).default;
const katexFonts = (() => {
  const dir = join(ROOT, 'node_modules/katex/dist');
  const css = fs.readFileSync(join(dir, 'katex.min.css'), 'utf8');
  return css.replace(/url\(fonts\/([\w-]+\.woff2)\)/g, (m, file) => {
    const path = join(dir, 'fonts', file);
    return fs.existsSync(path) ? `url(data:font/woff2;base64,${fs.readFileSync(path).toString('base64')})` : m;
  });
})();

/**
 * 按**平衡花括号**解析 `\\命令{...}{...}`，返回替换后的文本。
 *
 * 为什么不能用正则：`\\multicolumn{8}{l}{\\textbf{GSM8K}}` 的内层有嵌套花括号，
 * 非贪婪 `\{([\s\S]*?)\}` 会在第一个 `}` 处截断，拿到 `\textbf{GSM8K`，
 * 于是 `\textbf{` 永远匹配不到闭合括号，最后被通用剥命令规则变成字面
 * `\textbfGSM8K` 印在表格里（2026-11-19 Domino 同数据表实测，用户截图看到）。
 * 贪婪版本又会在同一行里吞并后面的命令。两个都不对，只能按层级数括号。
 *
 * @param {string} text
 * @param {string} cmd 命令名，不含反斜杠
 * @param {(args:string[], match:string)=>string} fn 收到各参数内容（已去括号）
 */
function replaceBalancedCommand(text, cmd, fn) {
  const tag = `\\${cmd}`;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf(tag, i);
    if (at < 0) { out += text.slice(i); break; }
    // 命令名必须在此处结束（后面不是字母）
    const after = text[at + tag.length];
    if (after && /[a-zA-Z]/.test(after)) { out += text.slice(i, at + tag.length); i = at + tag.length; continue; }
    out += text.slice(i, at);
    let j = at + tag.length;
    const args = [];
    let ok = true;
    // 收集紧随其后的花括号组（容忍中间的可选参数 [...] 和空白）
    for (let k = 0; k < 3; k++) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '[') { // 可选参数：跳过配对的 ]
        let depth = 0;
        while (j < text.length) { if (text[j] === '[') depth++; else if (text[j] === ']') { depth--; if (!depth) { j++; break; } } j++; }
        continue;
      }
      if (text[j] !== '{') break;
      let depth = 0;
      const start = j + 1;
      let end = -1;
      for (; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue; }   // 跳过转义的下一个字符
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (!depth) { end = j; break; } }
      }
      if (end < 0) { ok = false; break; }
      args.push(text.slice(start, end));
      j = end + 1;
    }
    if (!ok || !args.length) { out += tag; i = at + tag.length; continue; }
    out += fn(args, text.slice(at, j));
    i = j;
  }
  return out;
}

/** LaTeX 表格 → HTML。只处理表格相关的子集。 */
const MATH = [];
/**
 * 论文自己的方法宏（`\\method`）该显示成什么。
 *
 * 各篇论文都用 `\\method` 指代自己的工作，**值不一样**：DFlash 那篇是 DFlash、
 * Domino 这篇是 Domino。之前写死成 'DFlash'，于是 Domino 的 caption 印出
 * 「draft block size for DFlash and DFlash」——同一句话里两个 DFlash，
 * 读者会以为论文拿自己跟自己比。
 *
 * 默认按 slug 猜一个可读名（domino → Domino），也可用 `--method=名字` 覆盖。
 */
const METHOD_NAME = String(args.method ?? (() => {
  // 优先读 article.yaml 的 title：冒号前就是论文自己的规范写法
  // （`DFlash：…` / `Domino：…`）。按 slug 首字母大写会把 DFlash 写成 Dflash。
  try {
    const yml = fs.readFileSync(join(ROOT, 'articles', String(args.slug), 'article.yaml'), 'utf8');
    const t = yml.match(/^title:\s*"?([^"：:\n]+)/m)?.[1]?.trim();
    if (t) return t;
  } catch { /* 没有 yaml 就退回 slug */ }
  const s = String(args.slug);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Ours';
})());
function renderMath(tex) { try { return katex.renderToString(tex, { throwOnError: false }); } catch { return tex; } }
function latexTableToHtml(tex) {
  let body = tex;
  // caption 用平衡花括号解析：`\caption{... \shortstack{a\\b} ...}` 里有嵌套 {},
  // 非贪婪正则会在内层 `}` 处截断，caption 只剩前半句并把后面的 tabular 源
  // 一起吞进来（2026-11-19 dspine 消融表实测）。
  let caption = '';
  replaceBalancedCommand(body, 'caption', (args, match) => {
    if (!caption) caption = args[0] ?? '';
    return match;
  });
  const tabular = body.match(/\\begin\{tabular\*?\}(?:\[[^\]]*\])?\{[^}]*\}([\s\S]*?)\\end\{tabular\*?\}/);
  if (!tabular) throw new Error('没找到 tabular 环境');
  const raw = tabular[1];

  // 按行切分（\\ 结束一行；\toprule 等规则命令作为分隔）
  const lines = raw.split(/\\\\/).map((l) => l.trim()).filter(Boolean);
  const cell = (text, attrs = {}) => {
    let html = text.trim();
    let colspan = attrs.colspan ?? 1;
    let rowspan = attrs.rowspan ?? 1;
    // \textbf / \textit
    //
    // 前面可能紧挨着 multicolumn/multirow 的占位符控制字符（\u0005 / \u0002），
    // 那不是「命令名的一部分」。不加中括号限制时，`\u0005\textbf{Qwen3-4B}\u0006`
    // 会被后面的通用剥命令规则变成 `\textbfQwen3-4B` —— 分组行的粗体整个丢失，
    // 还把命令名原样印在表格里（2026-11-19 Domino 并发表实测）。
    html = html.replace(/\\textbf\s*\{([^{}]*)\}/g, '<b>$1</b>').replace(/\\textit\s*\{([^{}]*)\}/g, '<i>$1</i>');
    // 行内数学先转占位，等整表拼好再统一渲染（否则 \\times 会被行切分拆坏）
    html = html.replace(/\$([^$]+)\$/g, (_m, m) => {
      MATH.push(m.trim() === '\\times' ? '×' : renderMath(m));
      return `@@M${MATH.length - 1}@@`;
    });
    // 常见宏
    const hadCmid = /\\cmidrule/.test(html);
    // 分组行（Math / Code / Chat 那行）只保留文字，列名在下一行；给分组单元格加 class

    // 间距与对齐命令（\, \; \quad \hspace 等）先去掉，否则会混进单元格文字
    // 论文自定义的方法宏必须在通用「剥掉所有 \command{...}」之前替换掉，
    // 否则 `\method~\tabsmall\secondarycolor{(16)}` 只剩 `(16)`，
    // 表格里 Domino 那一行的名字整格空白（2026-11-19 Domino 实测）。
    html = html.replace(/\\method\b/g, METHOD_NAME);
    html = html.replace(/\\secondarycolor\s*\{([^{}]*)\}/g, '$1');
    // \shortstack[a]{第一行\\第二行}：表头里用来把一个长列名拆成两行。
    // 不处理的话三处表头（w/o last-write / refinement、Token CE、Embedding cosine）
    // 全是空白单元格（2026-11-19 dspine 消融表实测）。
    html = replaceBalancedCommand(html, 'shortstack', (args) => {
      const inner = args[args.length - 1] ?? '';
      return inner.split(/\\\\/).map((x) => x.trim()).filter(Boolean).join('<br>');
    });
    // \textcolor{color}{...}：保留内容并染成对应的灰绿色。
    // 论文常用它把「相对基线的加速比」做成小字下标（`\textcolor{green!45!black}
    // {\scriptsize\ensuremath{_{1.5\times}}}`）。原来这条没处理，会被通用
    // 「剥命令」规则整段吃掉——并发表里加速比全消失，只剩绝对吞吐
    // （2026-11-19 Domino 实测）。
    // 只认 xcolor 的 `green!N!black` 写法，其它颜色退化成不染色、保留内容。
    html = html.replace(/\\textcolor\s*\{([^{}]*)\}\s*\{([\s\S]*?)\}/g, (_m, col, inner) => {
      const keep = /green/i.test(col);
      return keep ? `<span class="ratio">${inner}</span>` : inner;
    });
    html = html.replace(/\\[,;:!]|\\quad|\\qquad|\\hspace\*?\{[^}]*\}|\\vspace\*?\{[^}]*\}/g, ' ');
    html = html.replace(/\\rowcolor\{([^}]*)\}/g, '<span data-rowcolor="$1"></span>');
    // \textsc / \text / \mathrm 等「取参数内容」的命令必须在通用的 \[a-zA-Z]+{...} 之前处理
    html = html.replace(/\\(?:textsc|text|textbf|textit|textrm|mathrm|mathbf|emph|mbox|ensuremath)\s*\{([^{}]*)\}/g, '$1');
    // \rowcolor{name} 这类着色命令：保留一个标记，后面转成淡色底
    html = html.replace(/\\toprule|\\midrule|\\bottomrule|\\cmidrule(\([^)]*\))?\{[^}]*\}/g, '')
      .replace(/\\(?:small|footnotesize|scriptstyle|tabsmall)/g, '')
      .replace(/\\(?:sc|rm|bf)\{([^{}]*)\}/g, '$1')
      .replace(/\\[hv]fill/g, ' ')
      .replace(/\\(?:setlength|resizebox|centering)\b[^\\]*/g, '')
      .replace(/\\textsuperscript\{([^}]*)\}/g, '<sup>$1</sup>')
      .replace(/\\textsubscript\{([^}]*)\}/g, '<sub>$1</sub>')
      .replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1')
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ').trim();
    const isEmpty = !html.trim();
    return `<td${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${hadCmid && !isEmpty ? ' class="grp"' : isEmpty ? ' class="empty"' : ''}>${html}</td>`;
  };

  const rows = [];
  // 记录「还占着列」的 rowspan 单元格：{col, remaining}。
  // HTML 里 rowspan 覆盖的格子，后续行**不能再写 td**；但 LaTeX 源常常照写
  // 空 cell（`& & 2 & & 4 …` 就是给 rowspan 的两列留了空位），多出来的 td 会把
  // 整行推到列数溢出，浏览器直接不渲染那一行——表现是表头凭空消失、不报错
  // （2026-11-19 Domino 并发表：12 列的表，第 2 行写了 12 个 td，实际只有 10 个位置）。
  let carry = []; // 每个元素是该列被 rowspan 占用的剩余行数
  for (const line of lines) {
    // \multirow{2}[2]{*}{文本} → 记录 rowspan
    let text = line.replace(/\\multirow\{(\d+)\}(?:\[\d+\])?\{[^}]*\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
      (m, n, inner) => `\u0001${n}\u0002${inner}\u0003`);
    // \multicolumn{n}{c}{文本} → colspan
    //
    // ⚠️ 内层必须是**非贪婪**的 `[\s\S]*?`。用 `[\s\S]*` 时正则会在同一行里
    // 一路吞到最后一个 `}`，把后面所有 `\multicolumn` 一起吃掉：
    //   `\multicolumn{2}{c}{HumanEval} & \multicolumn{2}{c}{GSM8K}`
    // 会变成一个单元格、内容是 `HumanEval} & \multicolumn{2}{c}{GSM8K`，
    // 表格里就印出 `2 HumanEval`、`2cGSM8K` 这种残渣，而且列全错位。
    // 内层先展开一次「取参数」类命令，再塞进占位符。
    // 否则 `\u0005\textbf{Qwen3-4B}\u0006` 里的 `\textbf{` 前面多了一个控制字符，
    // cell() 里的粗体规则匹配不上，最后被通用剥命令规则变成 `\textbfQwen3-4B`
    // —— 命令名原样印进表格、粗体丢失（2026-11-19 Domino 并发表实测）。
    text = replaceBalancedCommand(text, 'multicolumn', (args, span) => {
      const n = args[0];
      // args[2] 是单元格内容：**先展开取参数类命令，再塞进占位符**。
      // 否则 `\u0005\textbf{Qwen3-4B}\u0006` 里 `\textbf{` 前多了控制字符，
      // cell() 的粗体规则匹配不上，最后被通用剥命令规则变成 `\textbfQwen3-4B`
      // —— 命令名原样印进表格、粗体丢失。
      const flat = args[2].replace(
        /\\(?:textbf|textit|textsc|textrm|mathrm|mathbf|emph|mbox|text)\s*\{([^{}]*)\}/g, '$1');
      return `\u0004${n}\u0005${flat}\u0006`;
    });
    const parts = text.split('&');
    const tds = parts.map((part) => {
      let colspan = 1, rowspan = 1;
      let inner = part;
      const mc = inner.match(/\u0004(\d+)\u0005([\s\S]*)\u0006/);
      if (mc) { colspan = Number(mc[1]); inner = mc[2]; }
      const mr = inner.match(/\u0001(\d+)\u0002([\s\S]*)\u0003/);
      if (mr) { rowspan = Number(mr[1]); inner = mr[2]; }
      return cell(inner, { colspan, rowspan });
    });
    // 跳过被上一行 rowspan 占住的列（对应该是空 cell）
    let occupied = carry.reduce((n, r) => n + (r > 0 ? 1 : 0), 0);
    let kept = tds;
    if (occupied > 0) {
      // 按顺序剔除前面 occupied 个「空」单元格
      const out = [];
      let need = occupied;
      for (const td of tds) {
        const isEmptyCell = /class="empty"/.test(td);
        if (need > 0 && isEmptyCell) { need--; continue; }
        out.push(td);
      }
      kept = out;
    }
    const rowHtml = kept.join('');
    // \rowcolor 在行首，会被切进第一个（空的）单元格；这里按标记判定并在清理时移除
    const isHl = rowHtml.includes('data-rowcolor=');
    const cleanTds = rowHtml.replace(/<span data-rowcolor="[^"]*"><\/span>/g, '');
    const attrs = [text.includes('\u0007') ? 'group' : '', isHl ? 'hl' : ''].filter(Boolean).join(' ');
    if (kept.length) rows.push(`<tr${attrs ? ` class="${attrs}"` : ''}>${cleanTds.replace(/\u0007/g, '')}</tr>`);
    // 更新 carry：本行新增的 rowspan 往后排，已有的减一
    const nextCarry = [];
    let ci = 0;
    for (const td of kept) {
      const m = td.match(/rowspan="(\d+)"/);
      const span = m ? Number(m[1]) - 1 : 0;
      nextCarry.push(span);
      ci++;
    }
    // 加上被占住的列（它们在本行没有 td，但索引要占位）
    carry = nextCarry;
  }
  const table = `<table>${rows.join('')}</table>`.replace(/@@M(\d+)@@/g, (_m, i) => MATH[Number(i)] ?? '');
  return { caption: caption.replace(/\\method/g, METHOD_NAME).replace(/\\textsc\{([^}]*)\}/g, '$1').replace(/\$/g, ''), html: table };
}

const { caption, html } = latexTableToHtml(fs.readFileSync(String(args.tex), 'utf8'));
const assetDir = join(ROOT, 'articles', String(args.slug), 'assets');
fs.mkdirSync(assetDir, { recursive: true });
const outPng = join(assetDir, `tab-${outName}.png`);

const page = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body { margin: 0; background: #fff; font-family: 'Times New Roman', 'Songti SC', serif; }
  table { border-collapse: collapse; font-size: 15px; color: #111; }
  td { padding: 3px 7px; text-align: center; vertical-align: middle; white-space: nowrap; }
  tr:first-child td { font-weight: 600; }
  b { font-weight: 700; }
  td.grp { border-bottom: 1px solid #444; padding-bottom: 6px; font-weight: 600; }
  td.empty { padding: 0; }
  tr:first-child td { border-bottom: 1px solid #444; }
  td[rowspan] { font-weight: 600; }
  tr.hl td { background: #fdf1e8; }
  .ratio { color: #3f7d4e; font-size: 11px; }
</style>
<style>${katexFonts}</style>
</head><body>${html}</body></html>`;

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, ...(findChromium() ? { executablePath: findChromium() } : {}) });
const p = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: Number(args.dpi ?? 3) });
await p.setContent(page, { waitUntil: 'load' });
await p.waitForTimeout(500);
// 先按表格实际尺寸把视口撑开再截。
// 宽表（Domino 并发表 12 列、约 5900 CSS px）远超默认 1600 视口，
// `el.screenshot()` 只覆盖可见区域，**表头行会被整行切掉**且不报错
// （2026-11-19 实测：渲染出来第一行直接是 Qwen3-4B 分组）。
const box = await (await p.$('table')).boundingBox();
await p.setViewportSize({ width: Math.ceil(box.width) + 40, height: Math.ceil(box.height) + 40 });
await p.waitForTimeout(200);
// 撑开视口后 `el.screenshot()` 仍可能只截到原布局高度里的一部分——
// Playwright 在元素高度超过视口时会把图截断，而表头正好在最顶上时表现为
// 「第一行凭空消失」。改成截 body 再裁到表格区域，配合 fullPage 兜住高度。
const table = await p.$('table');
const tb = await table.boundingBox();
await p.screenshot({
  path: outPng,
  clip: { x: tb.x, y: tb.y, width: tb.width, height: tb.height },
  captureBeyondViewport: true,
});
await browser.close();
fs.writeFileSync(join(assetDir, `tab-${outName}.caption.txt`), `${caption}\n`);
console.log(JSON.stringify({ png: `articles/${args.slug}/assets/tab-${outName}.png`, caption }, null, 1));

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  for (const dir of fs.readdirSync(cache).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
    const base = join(cache, dir, 'chrome-mac-arm64');
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const mac = join(base, entry, 'Contents', 'MacOS');
      if (fs.existsSync(mac)) return join(mac, fs.readdirSync(mac)[0]);
    }
  }
  return undefined;
}
void execFileSync;
