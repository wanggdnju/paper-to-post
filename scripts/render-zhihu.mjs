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
 *   - 《表N》图片**一律贴原表截图**，不转紧凑 HTML 表（2026-11-19 起）；
 *     行内 `$…$` 全部做成行内公式卡（`data-eeimg="1"`），表格单元格里用可读纯文本。
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
  ? [...readFileSync(articlePath, 'utf8').matchAll(/!\[(.*?)\]\((assets\/[^)\s]+)\)/g)]
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
 * ⚠️ 不能简单去掉 `$` 和反斜杠了事。2026-11-17 用户拿 dspark 的线上页面指出
 * 「很多不好理解的公式」，根因就是旧实现把命令名原样留下了：
 *   `\tau=\sum_r\left(1+\sum_{j\le\ell_r}a_{r,j}\right)`
 *   → `τ=sum_rleft(1+sum_jleell_ra_r,jright)`
 * 读者看到的是一串英文命令拼接，比公式本身还难读。现在按结构转 Unicode：
 *   Σ ∏ ∫ ∈ ≤ ≥ ≠ ≈ × · √ ℓ ℝ，`\left`/`\right` 直接丢，`\frac{a}{b}` → a/b，
 *   下标能映射到 Unicode 就映射（x_1 → x₁），映射不了保留 `_{...}`。
 * 仍然转不了的结构（矩阵、多层嵌套）会留下花括号，但不再出现命令名。
 */
function texToPlain(tex) {
  const SUB = {
    0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
    a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ',
    o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
  };
  const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
  const GREEK = {
    tau: 'τ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', eta: 'η',
    theta: 'θ', lambda: 'λ', mu: 'μ', nu: 'ν', pi: 'π', rho: 'ρ', sigma: 'σ',
    phi: 'φ', psi: 'ψ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Gamma: 'Γ',
    Lambda: 'Λ', Theta: 'Θ', Pi: 'Π', Phi: 'Φ', Psi: 'Ψ', xi: 'ξ', zeta: 'ζ', kappa: 'κ',
    ell: 'ℓ',
  };
  // 运算符 / 关系符：必须在「去掉反斜杠」之前替换，否则会变成 sum、le 这类英文单词
  const OPS = {
    sum: 'Σ', prod: '∏', int: '∫', le: '≤', leq: '≤', ge: '≥', geq: '≥',
    neq: '≠', approx: '≈', equiv: '≡', propto: '∝', in: '∈', notin: '∉',
    subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', to: '→', rightarrow: '→',
    leftarrow: '←', cdot: '·', times: '×', pm: '±', mp: '∓', infty: '∞',
    ldots: '…', dots: '…', cdots: '…', mid: '|', prime: '′', partial: '∂',
    nabla: '∇', forall: '∀', exists: '∃', perp: '⊥', parallel: '∥',
  };
  const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', E: '𝔼', Q: 'ℚ', C: 'ℂ' };

  let out = tex;
  // 整式只有一个希腊字母：最常见、也最容易漏（\tau 单独出现）
  const sym = out.match(/^\s*\\([a-zA-Z]+)\s*$/);
  if (sym && GREEK[sym[1]]) return GREEK[sym[1]];

  // 1) 只影响排版、没有语义的命令
  out = out.replace(/\\(?:left|right|big|Big|bigg|Bigg)\s*/g, '')
    .replace(/\\[,;:!]/g, ' ')
    .replace(/\\quad|\\qquad/g, ' ')
    .replace(/\\(?:displaystyle|textstyle|limits|nolimits)/g, '');

  // 2) 取内容、丢命令字面的包装
  out = out.replace(/\\(?:mathrm|text|textrm|operatorname|mathbf|mathit|mathsf|texttt)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\mathbb\s*\{([A-Z])\}/g, (m, c) => BLACKBOARD[c] ?? c)
    .replace(/\\mathcal\s*\{([A-Z])\}/g, '$1')          // \mathcal{V} → V（花体字在手机上不一定有字形）
    .replace(/\\hat\s*\{([^{}]*)\}/g, '$1̂')             // \hat{p} → p̂
    .replace(/\\bar\s*\{([^{}]*)\}/g, '$1̄')
    .replace(/\\tilde\s*\{([^{}]*)\}/g, '$1̃');

  // 3) 分式：只处理一层，嵌套的留给 4) 去命令名（至少不会印出 frac）
  out = out.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (m, a, b) =>
    (/^[\w.]+$/.test(a) && /^[\w.]+$/.test(b) ? `${a}/${b}` : `(${a})/(${b})`));
  // 4) 根号
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√$1').replace(/\\sqrt\s*(\w)/g, '√$1');

  // 5) 带固定写法的符号（先于「去反斜杠」）。
  //    非字母命令先处理：`\|` 是范数双竖线，不处理会印成反斜杠加竖线。
  out = out.replace(/\\\|/g, '‖').replace(/\\\\/g, ' ');
  //    必须按「已知命令名最长优先」匹配，且要处理粘连：
  //    `\tau\cdot\mathrm{SPS}` 在第 2 步去掉 `\mathrm{}` 后会变成 `\tau\cdotSPS`，
  //    通用正则的 `\\([a-zA-Z]+)` 会把整段读成 `cdotSPS`，印出来是 `τcdotSPS(B)`
  //    （2026-11-17 实测踩到）。所以这里先做最长前缀拆分。
  const KNOWN = [...new Set([...Object.keys(GREEK), ...Object.keys(OPS)])].sort((a, b) => b.length - a.length);
  const knownRe = new RegExp(`\\\\(${KNOWN.join('|')})(?![A-Za-z])`, 'g');
  out = out.replace(knownRe, (m, name) => GREEK[name] ?? OPS[name]);
  // 收掉数学符号两侧的空白：`τ= Σ_r(1+ Σ_{j ≤ ℓ_r}` 这种排法在中文里很松散，
  // 统一压成 `τ=Σ_r(1+Σ_{j≤ℓ_r}`。空格只在「两个字母/数字之间」保留。
  out = out.replace(/[ \t]*([=+\-·×≤≥∈∏Σ∝/|]|\\\|)[ \t]*/g, '$1')
    .replace(/[ \t]*([()[\]{};,])[ \t]*/g, '$1');
  // 其余命令：去掉反斜杠保留名字（\min → min 这类函数名读者能认）；
  // 名字里若「已知符号 + 粘连字母」，按最长前缀拆开。
  out = out.replace(/\\([a-zA-Z]+)/g, (m, name) => {
    for (const k of KNOWN) {
      if (name.length > k.length && name.startsWith(k)) return `${GREEK[k] ?? OPS[k]}${name.slice(k.length)}`;
    }
    return name;
  });

  // 6) 上下标：能映射成 Unicode 的就映射（x_1 → x₁、ℓ_r → ℓᵣ），
  //    映射不了**保留花括号**（a_{r,j}）——去掉括号变成 `a_r,j` 反而看不懂。
  //    先换成哨兵再统一去分组括号：直接写 `\}(?!...)` 那种判据会吃掉
  //    `s_{k-1};W_1[...]` 里的闭括号（2026-11-17 实测）。
  const holds = [];
  const holdSub = (s) => `\u0001${holds.push(s) - 1}\u0001`;
  out = out.replace(/_\{([^{}]*)\}/g, (m, s) => (s.length === 1 && SUB[s] ? SUB[s] : holdSub(`_{${s}}`)))
    // 只把**数字**下标转成 Unicode：`x_1 → x₁`。
    // 字母下标若也转（`W_o → Wₒ`），同一句里的 `W_g`/`W_c` 没有对应字形，
    // 会出现「一个有下标、一个还是下划线」的混排，反而更乱（2026-11-17 实测）。
    .replace(/_(\d)/g, (m, d) => SUB[d] ?? `_${d}`)
    .replace(/\^\{([^{}]*)\}/g, (m, s) => (/^\d$/.test(s) ? SUP[s] : holdSub(`^{${s}}`)))
    .replace(/\^([0-9])/g, (m, d) => SUP[d] ?? `^${d}`);

  // 7) 剩下的花括号只是分组符号，去掉；再把上标/下标还原
  out = out.replace(/[{}]/g, '').replace(/\u0001(\d+)\u0001/g, (m, i) => holds[Number(i)]);
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * 行内 `$...$` 一律做成知乎行内公式卡（`data-eeimg="1"`）。
 *
 * 2026-11-17 实测：把 `<span class="ztext-math" data-eeimg="1" data-tex="…">`
 * 放进粘贴的 HTML，知乎会当场渲染成行内公式（MathJax，宽高正常），
 * 与「手动插卡」效果一致，不必逐个点工具栏。
 *
 * 曾经只把「复杂式」做成卡片、简单符号降级成 Unicode 纯文本，理由是「别让正文被卡片切碎」。
 * 用户明确否掉了这个折中（「还是有些不是公式的，你能不能全部改掉的」）：
 * 同一段里一半是真公式、一半是 `B(x_{k-1},x_k)` 这种带下划线的纯文本，
 * 读起来更乱。现在**没有例外**，所有行内公式都走卡片。
 * texToPlain 只保留给 figcaption（图片注释框是纯文本输入框，塞不进公式卡）。
 */
function inlineMathSpan(tex) {
  const t = tex.trim();
  // 注意：tex 到这里**已经过 esc()**（inline() 先转义整段再匹配 `$…$`）。
  // 再 esc 一次会变成 `x_{&amp;lt;k}`，粘进知乎后 data-tex 里是坏的 TeX。
  //
  // span 的文本内容放**可读纯文本**而不是 TeX 源码：知乎的公式卡在编辑器里
  // 未获得焦点前会原样显示这部分内容（`FormulaCSR isEditable`），
  // 放 TeX 就会出现满屏 `\mathcal{V}`（2026-11-18 实测截图）。渲染成功后
  // MathJax 会把内容整体替换掉，所以这只影响「还没渲染」的那一瞬。
  return `<span class="ztext-math" data-eeimg="1" data-tex="${t}">${esc(texToPlain(t))}</span>`;
}

const inline = (s) => {
  // 链接要落成真正的 <a>：之前把 [文字](url) 降级成纯文字，理由是「粘贴后编辑器会自己
  // 识别链接」——实际不会，读者看到的是点不动的文字（2026-11-14 用户反馈）。
  // 裸 URL 同理，个人站架构图那一行就是裸链接，必须自己包成 <a>。
  const anchors = [];
  const hold = (html) => `\u0000${anchors.push(html) - 1}\u0000`;
  let out = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\$([^$\n]+)\$/g, (m, tex) => hold(inlineMathSpan(tex)))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, text, url) => hold(`<a href="${url}">${text}</a>`))
    .replace(/https?:\/\/[^\s<）)，。；]+/g, (url) => hold(`<a href="${url}">${url}</a>`));
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => anchors[Number(i)]);
};

/**
 * 表格单元格专用：和 inline 一样处理加粗和链接，但**不产出公式卡**。
 *
 * 为什么必须另写一个：Draft.js 把 HTML 表格转成自己的表格块时，只保留纯文本，
 * 单元格里的 `ztext-math` 整个节点被丢弃——卡片没了、内容留成裸 TeX。
 * eagle3 的「三个版本的设计对照」表里两个格子带 `$l_{\text{fea}} + l_{\text{token}}$`，
 * 粘完只剩 `l_{fea}+l_{token}` 这串源码，验收的卡片数也对不上（63 → 61）。
 * 单元格里给可读纯文本（`l_feа+l_token` 这类），读者能看懂，也不会有残留。
 */
const tableCell = (s) => {
  const anchors = [];
  const hold = (html) => `\u0000${anchors.push(html) - 1}\u0000`;
  let out = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\$([^$\n]+)\$/g, (_m, tex) => hold(esc(texToPlain(tex))))
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

// 数据表一律贴截图（2026-11-19 起）。下面的紧凑表替换默认不执行，由 TABLES_AS_IMAGES 控制。
//
// 之前会把有 LaTeX 表源的「表 N」自动换成 HTML 窄表，理由是「截图在手机上读不了」。
// 但窄表的代价更大：主表被拆成（1/2）（2/2）几张、相邻两列并成 `5.15× / 6.53`，
// 读者没法回论文原表逐格核对。截图是论文排版的最终结果，放大就能看。
// 保留开关而不是删代码：真需要窄表时改一个常量就能回来。
const TABLES_AS_IMAGES = true;
if (!TABLES_AS_IMAGES) {
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
    // 单元格用 tableCell 而不是 inline：Draft.js 粘贴表格时会把单元格里的
    // `ztext-math` 节点整块压平——卡片消失、只留下它的纯文本内容。
    // 结果就是卡片数对不上（eagle3 实测 63 → 61），而且剩下的 TeX 源码
    // 会原样印在表里。单元格里用 texToPlain 的可读文本，段落里仍然是卡片。
    return `<table><thead><tr>${head.map((c) => `<th>${tableCell(c)}</th>`).join('')}</tr></thead><tbody>${rest
      .map((r) => `<tr>${r.map((c) => `<td>${tableCell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
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
  // format: inline 让 compare.json 里的 `$B_k$`、`$c_k^*$` 也落成行内公式卡；
  // 不传的话它们会以纯文本印出（模型写 ours/values 时保留了 TeX 记号）。
  //
  // plainFormat 是给**表格单元格**用的：Draft.js 粘贴表格时会把单元格里的
  // `ztext-math` 节点压平，公式卡全变成它的纯文本内容（2026-11-18 实测 155 个
  // 公式卡粘完只剩 153）。表格里改用 texToPlain 的可读文本，段落里仍然是卡片。
  ? renderExtrasNarrow(extras, {
    imgTag: extrasDiagramTag, small: 13, format: inline, matrixTable: true, articleMd: source,
    plainFormat: (s) => esc(String(s ?? '')).replace(/\$([^$\n]+)\$/g, (_m, tex) => esc(texToPlain(tex))),
  })
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
