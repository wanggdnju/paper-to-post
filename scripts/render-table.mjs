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

/** LaTeX 表格 → HTML。只处理表格相关的子集。 */
const MATH = [];
function renderMath(tex) { try { return katex.renderToString(tex, { throwOnError: false }); } catch { return tex; } }
function latexTableToHtml(tex) {
  let body = tex;
  const caption = body.match(/\\caption\{([\s\S]*?)\}\s*(?:\\label|\\resizebox|$)/)?.[1] ?? '';
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
    html = html.replace(/\\textbf\{([^{}]*)\}/g, '<b>$1</b>').replace(/\\textit\{([^{}]*)\}/g, '<i>$1</i>');
    // 行内数学先转占位，等整表拼好再统一渲染（否则 \\times 会被行切分拆坏）
    html = html.replace(/\$([^$]+)\$/g, (_m, m) => {
      MATH.push(m.trim() === '\\times' ? '×' : renderMath(m));
      return `@@M${MATH.length - 1}@@`;
    });
    // 常见宏
    const hadCmid = /\\cmidrule/.test(html);
    // 分组行（Math / Code / Chat 那行）只保留文字，列名在下一行；给分组单元格加 class

    // 间距与对齐命令（\, \; \quad \hspace 等）先去掉，否则会混进单元格文字
    html = html.replace(/\\[,;:!]|\\quad|\\qquad|\\hspace\*?\{[^}]*\}|\\vspace\*?\{[^}]*\}/g, ' ');
    html = html.replace(/\\rowcolor\{([^}]*)\}/g, '<span data-rowcolor="$1"></span>');
    // \textsc / \text / \mathrm 等「取参数内容」的命令必须在通用的 \[a-zA-Z]+{...} 之前处理
    html = html.replace(/\\(?:textsc|text|textbf|textit|textrm|mathrm|mathbf|emph|mbox)\s*\{([^{}]*)\}/g, '$1');
    // \rowcolor{name} 这类着色命令：保留一个标记，后面转成淡色底
    html = html.replace(/\\toprule|\\midrule|\\bottomrule|\\cmidrule(\([^)]*\))?\{[^}]*\}/g, '')
      .replace(/\\(?:small|footnotesize|scriptstyle|tabsmall)/g, '')
      .replace(/\\(?:sc|rm|bf)\{([^{}]*)\}/g, '$1')
      .replace(/\\[hv]fill/g, ' ')
      .replace(/\\(?:setlength|resizebox|centering)\b[^\\]*/g, '')
      .replace(/\\textsuperscript\{([^}]*)\}/g, '<sup>$1</sup>')
      .replace(/\\textsubscript\{([^}]*)\}/g, '<sub>$1</sub>')
      .replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1')
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ').trim();
    const isEmpty = !html.trim();
    return `<td${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}${hadCmid && !isEmpty ? ' class="grp"' : isEmpty ? ' class="empty"' : ''}>${html}</td>`;
  };

  const rows = [];
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
    text = text.replace(/\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*?)\}/g, (m, n, inner) => `\u0004${n}\u0005${inner}\u0006`);
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
    const rowHtml = tds.join('');
    // \rowcolor 在行首，会被切进第一个（空的）单元格；这里按标记判定并在清理时移除
    const isHl = rowHtml.includes('data-rowcolor=');
    const cleanTds = rowHtml.replace(/<span data-rowcolor="[^"]*"><\/span>/g, '');
    const attrs = [text.includes('\u0007') ? 'group' : '', isHl ? 'hl' : ''].filter(Boolean).join(' ');
    if (tds.length) rows.push(`<tr${attrs ? ` class="${attrs}"` : ''}>${cleanTds.replace(/\u0007/g, '')}</tr>`);
  }
  const table = `<table>${rows.join('')}</table>`.replace(/@@M(\d+)@@/g, (_m, i) => MATH[Number(i)] ?? '');
  return { caption: caption.replace(/\\method/g, 'DFlash').replace(/\$/g, ''), html: table };
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
</style>
<style>${katexFonts}</style>
</head><body>${html}</body></html>`;

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, ...(findChromium() ? { executablePath: findChromium() } : {}) });
const p = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: Number(args.dpi ?? 3) });
await p.setContent(page, { waitUntil: 'load' });
await p.waitForTimeout(500);
const el = await p.$('table');
await el.screenshot({ path: outPng });
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
