#!/usr/bin/env node
/**
 * LaTeX tabular → HTML 表格。
 *
 *   node scripts/latex-table.mjs --tex=articles/eagle3/source/tables/main.tex
 *   node scripts/latex-table.mjs --tex=... --caption="表 1" --macros-file=articles/dflash/source/tables/macros.json
 *
 * 为什么不用论文原表的截图：
 *   原表是 2600–4800px 的位图，压到正文宽（720px）或手机（354px）之后，
 *   14 列的表每列只有 25px，字号缩到 4–5px —— 图「在」，但一个字都认不出。
 *   用户 2026-11-12 两次指出这件事。HTML 表格能自适应容器、能选中复制、
 *   能横向滚动，还能按屏幕宽度折行。
 *
 * 2026-11-12 重写。DFlash / DSpine 两张表之前一直解析不了、只能退回截图，
 * 根因都是**用正则处理带嵌套花括号的 LaTeX 参数**：
 *   - 列定义 `{c p{1.8cm} @{\hspace{1.2em}} cc}`（列参数里还有花括号）
 *   - `\multicolumn{2}{c@{\hspace{1.2em}}}{Math}`（列格式里带 @{}）
 *   - `\multirow{2}[2]{*}{Model}`（可选参数 + 宽度参数）
 * 现在所有参数都按花括号配对读取，行内宏也改成逐个展开，不再用 `[^}]*` 猜。
 */
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 从 s[i] === '{' 开始，读出配对花括号里的内容。返回 [内容, 右括号之后的下标]。 */
function readBraced(s, i) {
  if (s[i] !== '{') return ['', i];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }        // \{ \} 不参与配对
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) return [s.slice(i + 1, j), j + 1]; }
  }
  return [s.slice(i + 1), s.length];
}

/** 无副作用的排版宏：直接吃掉 */
const EAT = () => '';
/** 只影响间距的宏：换成一个空格 */
const SPACE = () => ' ';

/** 有参数的排版宏。rec 递归展开参数内部（\textbf{\textit{...}} 也要对）。 */
const FORMAT = {
  textbf: (a, rec) => `<b>${rec(a[0] ?? '')}</b>`,
  textit: (a, rec) => `<i>${rec(a[0] ?? '')}</i>`,
  underline: (a, rec) => `<u>${rec(a[0] ?? '')}</u>`,
  uline: (a, rec) => `<u>${rec(a[0] ?? '')}</u>`,
  emph: (a, rec) => `<i>${rec(a[0] ?? '')}</i>`,
  mathbf: (a, rec) => `<b>${rec(a[0] ?? '')}</b>`,
  // 只影响排版、不影响语义的宏：留文字，去命令
  textsc: (a, rec) => rec(a[0] ?? ''),
  sc: (a, rec) => rec(a[0] ?? ''),
  secondarycolor: (a, rec) => rec(a[0] ?? ''),
  textcolor: (a, rec) => rec(a[1] ?? ''),
  mathrm: (a, rec) => rec(a[0] ?? ''),
  hspace: SPACE,
  mspace: SPACE,
  hphantom: SPACE,
  phantom: SPACE,
  hfill: SPACE,
  quad: SPACE,
  qquad: SPACE,
  ',': SPACE,
  ';': SPACE,
  ':': SPACE,
  '!': EAT,
  cline: EAT,
  cmidrule: EAT,
  hline: EAT,
  rowcolor: EAT,
  cellcolor: EAT,
  toprule: EAT,
  midrule: EAT,
  bottomrule: EAT,
  tabsmall: EAT,
  small: EAT,
  footnotesize: EAT,
  scriptsize: EAT,
  centering: EAT,
  resizebox: EAT,
  arraybackslash: EAT,
  xspace: EAT,
};

/**
 * 展开一段 LaTeX 文本（不含 tabular 结构，只处理行内排版命令）。
 * macros 是论文自己定义的宏，比如 `{"method": "DFlash"}`。
 */
function expand(s, macros) {
  let out = '';
  for (let i = 0; i < s.length;) {
    if (s[i] !== '\\') { out += s[i]; i++; continue; }
    if (s[i + 1] === '\\') { i += 2; continue; }         // 残留的换行符：丢掉
    const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
    if (!m) { out += s[i]; i++; continue; }
    const name = m[1];
    let j = i + 1 + name.length;
    // 可选参数：\multirow{2}[2]{*} 是 []，\cmidrule(lr){..} 是 ()
    while (s[j] === '[' || s[j] === '(') {
      const k = s.indexOf(s[j] === '[' ? ']' : ')', j);
      if (k === -1) break;
      j = k + 1;
    }
    const args = [];
    while (s[j] === '{') { const [c, n] = readBraced(s, j); args.push(c); j = n; }
    const rec = (t) => expand(t, macros);
    if (Object.hasOwn(macros, name)) out += rec(String(macros[name]));
    else if (FORMAT[name]) out += FORMAT[name](args, rec);
    // 不认识的宏原样保留，交给自检报「残留 LaTeX 命令」——宁可退回截图，也不吞内容
    else if (args.length) out += `\\${name}` + args.map((a) => `{${a}}`).join('');
    else out += `\\${name}`;
    i = j;
  }
  return out;
}

/** 单元格文本：展开宏 → 数学符号换字面量 → 压空白 */
function cleanInline(raw, macros) {
  let s = expand(esc(raw), macros);
  s = s.replace(/\$([^$]*)\$/g, (_, math) => math
    .replace(/\\times/g, '×')
    .replace(/\\tau/g, 'τ')
    .replace(/\\approx/g, '≈')
    .replace(/\\pm/g, '±')
    .replace(/\\,|\\;|\\:|\\!/g, ' ')
    .replace(/\\([a-zA-Z]+)/g, '$1'));
  return s.replace(/~/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 解析一个单元格：剥掉 \rowcolor / \multirow / \multicolumn 外壳，拿到
 * colspan / rowspan 和正文。这层必须读花括号配对——
 * `\multicolumn{2}{c@{\hspace{1.2em}}}{Math}` 的列格式里就带 @{}。
 */
function parseCell(raw, macros) {
  let s = String(raw ?? '').trim();
  const cell = { text: '', rowspan: 1, colspan: 1, isModel: false, skip: false };
  s = s.replace(/^\s*\\rowcolor\s*\{[^{}]*\}/, '').trim();
  for (;;) {
    const m = /^\\(multirow|multicolumn)\s*\{(\d+)\}/.exec(s);
    if (!m) break;
    if (m[1] === 'multirow') { cell.rowspan = Number(m[2]); cell.isModel = true; }
    else cell.colspan = Number(m[2]);
    let j = m[0].length;
    if (s[j] === '[') j = s.indexOf(']', j) + 1;     // \multirow{2}[2]{*}
    if (s[j] === '{') [, j] = readBraced(s, j);       // 宽度 / 列格式
    let body = '';
    if (s[j] === '{') [body, j] = readBraced(s, j);   // 正文
    s = (body + s.slice(j)).trim();
  }
  cell.text = cleanInline(s, macros);
  return cell;
}

/** 从 tex 里找出所有 tabular，按顺序返回（一篇文章可能有多张表）。 */
function extractAllTablulars(tex) {
  const out = [];
  const marker = '\\begin{tabular}';
  let i = 0;
  while ((i = tex.indexOf(marker, i)) !== -1) {
    let p = i + marker.length;
    // 列定义是 `{...}`，内部还有嵌套花括号（p{1.8cm}、@{\hspace{1em}}），
    // 必须按括号配对跳过，不能用 [^}]* —— DFlash 的表就是这样漏掉的。
    if (tex[p] === '{') [, p] = readBraced(tex, p);
    const end = tex.indexOf('\\end{tabular}', p);
    if (end === -1) break;
    // 往上找最近的 \caption{...}，用于和正文图注匹配
    const before = tex.slice(0, i);
    const capIdx = before.lastIndexOf('\\caption{');
    const caption = capIdx === -1 ? '' : readBraced(tex, capIdx + '\\caption'.length)[0];
    out.push({ body: tex.slice(p, end), caption });
    i = end + '\\end{tabular}'.length;
  }
  return out;
}

/**
 * 按 caption 相似度挑出正文要的那张表。
 *
 * 不能按「表 N 取第 N 个 tabular」——EAGLE 的 source 是整篇论文（8 张表），
 * 序号完全对不上。用正文图注里的关键词给每张表的 caption 打分最稳。
 */
function pickTabular(tabulars, captionHint = '') {
  if (tabulars.length <= 1) return tabulars[0] ?? null;
  if (!captionHint.trim()) return tabulars[0];
  const words = captionHint.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const score = (t) => {
    const c = t.caption.toLowerCase();
    return words.reduce((s, w) => s + (c.includes(w) ? 1 : 0), 0);
  };
  const best = tabulars.map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => b.s - a.s)[0];
  return best && best.s > 0 ? best.t : tabulars[0];
}

/** 按 & 切单元格，但跳过花括号里的内容（\multicolumn{..}{..}{a & b} 不会被切开） */
function splitCells(raw) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') { buf += ch + (raw[i + 1] ?? ''); i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === '&' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.map((c) => c.trim());
}

// 横线命令要连同它的可选参数和花括号参数一起吃掉：
// `\cmidrule(lr){3-18}` 只删命令名，会留下字面量 `(lr){3-18}` 混进表头。
const RULE = /\\(?:toprule|midrule|bottomrule|hline)\b|\\(?:cline|cmidrule)(?:\[[^\]]*\])?(?:\([^)]*\))?\{[^{}]*\}/g;

/**
 * 按行解析。保留「这里有一条横线」的信息：横线分隔的是**模型分组**，
 * DSpine 的模型名只写在组内某一行、其余行首格留空，要靠分组边界才补得回来。
 */
function parseTabular(body, macros) {
  const rows = [];
  let newGroup = true;
  for (const seg of body.split(/\\\\/)) {
    let raw = seg.trim();
    if (!raw) continue;
    const hadRule = RULE.test(raw);
    RULE.lastIndex = 0;
    raw = raw.replace(RULE, ' ').trim();
    if (!raw) { if (hadRule) newGroup = true; continue; }
    // 横线和内容在同一段里（`\cmidrule{1-10} & DFlash & ...`）也要算分组边界
    if (hadRule) newGroup = true;
    const cells = splitCells(raw).map((c) => parseCell(c, macros));
    if (cells.every((c) => !c.text)) continue;
    rows.push({ kind: 'data', cells, newGroup });
    newGroup = false;
  }
  return rows;
}

/**
 * 纯数字格（用来区分表头行和数据行）。
 *
 * 要认「一格塞两个数」的写法：DSpine 每格是「温度 0 / 温度 1」的 τ，
 * 写成 `4.25 / 3.96`。只认单个数字的话，那些数据行会被当成表头。
 */
function isNumericish(t) {
  const plain = String(t).replace(/<[^>]+>/g, '').replace(/\s/g, '');
  return /^[-+]?\d+(\.\d+)?(×|x|%)?([/–-][-+]?\d+(\.\d+)?(×|x|%)?)*$/.test(plain);
}

/**
 * 表头 = 开头那些「基本没有数字」的行。
 *
 * 之前是「遇到 \multirow 就停」，DFlash 第一行就是 \multirow{2}{Model}，
 * 于是表头为空、整张表报「没有识别出表头」。改成看内容：
 * 数据行以数字为主，表头行不是。多层表头（Math/Code/Chat + 任务名 + Speedup/τ）自然全被收进来。
 */
function splitHead(rows) {
  let i = 0;
  while (i < rows.length) {
    const cells = rows[i].cells;
    const nums = cells.filter((c) => isNumericish(c.text)).length;
    if (nums >= Math.max(1, cells.length * 0.4)) break;
    i++;
  }
  const head = rows.slice(0, i);
  const looksHead = head.some((r) => r.cells.some((c) => /Model|Method|Speedup|Task|Bench|Average|Avg|Mean|性能|模型|τ/i.test(c.text)));
  return looksHead ? { head, rest: rows.slice(i) } : { head: [], rest: rows };
}

/**
 * DSpine 这类表的模型列只写在组内一行（`Qwen3-8B & DSpark & ...`），
 * 其余行首格是空的，也没有 \multirow。直接渲染会变成「一列空白 + 中间某个格子冒出模型名」。
 * 这里在**组内只有一个非空首格**时，把它提升到组首并跨整组（等价于补一个 \multirow）。
 *
 * 两个约束，都是踩出来的：
 *   - 只认「数据行」（行里有数字）。否则 `Temperature = 1 & Speedup & τ…` 这种
 *     子表头行也会被当成模型名，整段数据被它跨掉；
 *   - 遇到分节行就断开分组，不然模型名会被搬到 Temperature 那一行上。
 */
function isSectionRow(r) {
  const lead = r.cells[0];
  return Boolean(lead && lead.colspan > 1 && lead.rowspan === 1
    && r.cells.slice(1).every((c) => !isNumericish(c.text)));
}

function hoistGroupModels(rows) {
  const groups = [];
  for (const r of rows) {
    if (isSectionRow(r) || r.newGroup || !groups.length) groups.push([r]);
    else groups[groups.length - 1].push(r);
  }
  for (const g of groups) {
    if (g.length < 2 || g.some(isSectionRow)) continue;
    const named = g.filter((r) => r.cells[0] && r.cells[0].text
      && r.cells[0].colspan === 1 && r.cells[0].rowspan === 1
      && r.cells.some((c) => isNumericish(c.text)));
    if (named.length !== 1) continue;
    const idx = g.indexOf(named[0]);
    if (idx === 0) continue;                       // 本来就在首行，无需搬
    const src = g[idx].cells[0];
    // 组内每一行的首格都是空的（模型名写在中间某行），先把空位清掉，再把模型名放到组首。
    // 原来写着模型名的那一行也要清掉——它已经被组首的 rowspan 覆盖了。
    for (const r of g) {
      const first = r.cells[0];
      if (first && first.colspan === 1 && (!first.text || first === src)) r.cells.shift();
    }
    g[0].cells.unshift({ text: src.text, rowspan: g.length, colspan: 1, isModel: true, skip: false });
  }
  return rows;
}

const spanSum = (row) => row.cells.reduce((s, c) => s + c.colspan, 0);

/** 展开一行的单元格：处理 multirow 的「模型名只写在第一行」 */
function expandRow(inputCells, colCount, carry) {
  let cells = inputCells;
  const out = [];
  const nextCarry = { ...carry };

  // 这一行没写模型名，但上一行的 \multirow 还覆盖着。
  // LaTeX 有两种写法：`& V13B & ...`（首格留空）或直接 `V13B & ...`（少一列）。
  // 两种都必须把第一列让出来，否则整行右移一列，最后一格溢出到表外。
  if (carry.modelLeft > 0) {
    const sum = cells.reduce((s, c) => s + c.colspan, 0);
    if (sum === colCount && cells[0] && cells[0].text === '' && cells[0].colspan === 1) {
      cells = cells.slice(1);          // 首格是占位的空串：丢掉
    }
    if (cells.reduce((s, c) => s + c.colspan, 0) === colCount - 1) {
      out.push({ skip: true });        // 少一列：补一个跳过位
    }
    nextCarry.modelLeft = carry.modelLeft - 1;
    if (nextCarry.modelLeft <= 0) nextCarry.model = '';
  }

  for (const cell of cells) {
    if (cell.isModel && cell.rowspan > 1) {
      nextCarry.model = cell.text;
      nextCarry.modelLeft = cell.rowspan - 1;
    }
    out.push(cell);
  }
  return { cells: out, carry: nextCarry };
}

function toHtml(tex, { caption = '', note = '', macros = {} } = {}) {
  // 一篇的 tex 里可能有多个 tabular（DFlash 主表 + thinking 表）。
  // 按 caption 挑对应的那张，不能永远取第一张——否则第二张表会渲染成第一张的内容。
  const tabulars = extractAllTablulars(tex);
  const picked = pickTabular(tabulars, caption);
  const rows = parseTabular(picked ? picked.body : tex, macros);
  const { head, rest: rawRest } = splitHead(rows);
  const rest = hoistGroupModels(rawRest);

  // 列数取「一行里 colspan 之和」的最大值（\multicolumn 和多层表头都要算进去）
  const colCount = Math.max(...rest.map(spanSum), ...head.map(spanSum), 1);

  // 表头原样渲染：论文表的第一行前面本来就是两个空单元格（Model/Method 竖跨），
  // 不要自作聪明补 corner —— 补了会和第二行的 Model/Method 错位。
  // 但**表头列数必须补齐到数据列数**，否则最后一列会溢出到表格右边、变成孤立的数字。
  //
  // 还要处理 rowspan 遮挡。DFlash 的表头是：
  //   行1: Model(rowspan2) Method(rowspan2) Math(colspan6) Code(colspan6) Chat(colspan2)
  //   行2: & & GSM8K(colspan2) …（LaTeX 里写两个空单元格占位）
  // HTML 里行1 的 rowspan 已经占了行2 的前两列，行2 那两个空 th 再输出就会把
  // 所有任务名整体右移两列（GSM8K 跑到 MATH-500 的列上）。LaTeX 的占位空单元
  // 在 HTML 里必须丢掉——这是两套模型的差别，不是源文写错。
  const thRowspans = [];
  const headHtml = head.map((r, ri) => {
    let cells = r.cells;
    let covered = thRowspans[ri] ?? 0;
    while (covered > 0 && cells.length) {
      const c = cells[0];
      if (c.colspan > 1 || c.text) break;   // 不是空占位就停，别吞真内容
      cells = cells.slice(1);
      covered--;
    }
    const rendered = cells.map((c) => {
      const attrs = `${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}`;
      for (let k = 1; k < c.rowspan; k++) thRowspans[ri + k] = (thRowspans[ri + k] ?? 0) + c.colspan;
      return `<th${attrs}>${c.text}</th>`;
    });
    const used = cells.reduce((s, c) => s + c.colspan, 0) + (thRowspans[ri] ?? 0);
    for (let i = used; i < colCount; i++) rendered.push('<th></th>');
    return `<tr>${rendered.join('')}</tr>`;
  }).join('');

  let carry = { model: '', modelLeft: 0 };
  const bodyHtml = rest.map((r) => {
    // 分节行：首格横跨多列、其余格都不是数字。
    // 只有一个格的是一整行标题（Temperature=0），带着 Speedup/τ 的是子表头。
    if (isSectionRow(r)) {
      const cls = r.cells.length === 1 ? 'sec' : 'sub';
      const tds = r.cells.map((c) => `<td${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}>${c.text}</td>`).join('');
      return `<tr class="${cls}">${tds}</tr>`;
    }
    const { cells, carry: next } = expandRow(r.cells, colCount, carry);
    carry = next;
    const td = cells.map((c) => {
      // 被上一行 rowspan 覆盖的位置**不输出 td**，否则表格会多出一列空白
      if (c.skip) return '';
      const span = `${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}`;
      return `<td${span}${c.rowspan > 1 ? ' class="model"' : ''}>${c.text}</td>`;
    }).join('');
    return `<tr>${td}</tr>`;
  }).join('');

  const html = `<div class="paper-table-html">
${caption ? `<div class="tbl-cap">${esc(caption)}</div>` : ''}
<div class="table-scroll"><table class="result-table"><thead>${headHtml}</thead><tbody>${bodyHtml}</tbody></table></div>
${note ? `<div class="tbl-note">${esc(note)}</div>` : ''}
</div>`;

  // 自检：解析干净才用。论文表格式五花八门，解析不干净的宁可退回截图 + 横向滚动，
  // 也不要吐一张错位的表格——错表比糊表更糟，读者会当成真的。
  const problems = [];
  if (!head.length) problems.push('没有识别出表头');
  const plain = html.replace(/<[^>]+>/g, '');
  if (/\\[a-zA-Z]+/.test(plain)) problems.push('残留 LaTeX 命令');
  if (/[{}]/.test(plain)) problems.push('残留花括号');
  // 列数自检：被上方 rowspan 覆盖的格子本来就不输出 td，所以逐行「实际列数」
  // 必须把仍生效的 rowspan 算进去，否则每一行都会被误判成缺列。
  const trs = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const rowspans = [];
  const spans = trs.map((tr, i) => {
    let n = 0;
    for (const m of tr.matchAll(/<t[dh]([^>]*)>/g)) {
      n += Number((m[1].match(/colspan="(\d+)"/) ?? [])[1] ?? 1);
      const rs = Number((m[1].match(/rowspan="(\d+)"/) ?? [])[1] ?? 1);
      for (let k = 1; k < rs; k++) rowspans[i + k] = (rowspans[i + k] ?? 0) + 1;
    }
    return n + (rowspans[i] ?? 0);
  }).filter((n) => n > 0);
  const mode = [...spans].sort((a, b) => spans.filter((v) => v === b).length - spans.filter((v) => v === a).length)[0];
  const offRows = spans.filter((n) => n !== mode).length;
  if (offRows > Math.max(2, spans.length * 0.2)) problems.push(`${offRows} 行列数与主列数 ${mode} 不一致`);
  return { html, problems, colCount };
}

// ---- 紧凑表：给知乎 / 公众号这类「窄屏、不能横向滚动」的平台 ----
//
// 站点能给 1240px 容器 + 横向滚动，所以原表整张渲染就行。
// 知乎正文 ~690px、公众号手机端 ~343px，18 列塞进去每格只有 20–30px——
// 和截图一样读不出来。所以这里换一种表示：
//   1. 相邻的「Speedup / τ」两列并成一格，写成 `5.15× / 6.53`（信息一点不少，列数减半）；
//   2. 按任务切成每组 2–3 个任务的窄表，每张都重复 Model / Method，**自足、可单独复制**；
//   3. 表里不出现 rowspan / colspan——知乎 Draft.js 的粘贴会重排合并单元格，公众号也会削；
//   4. 原来靠「分节行」表达的 Temperature=0/1，改成一个普通的「温度」列。

const METRIC = /^(speedup|τ|\\tau|×|加速比|acc\.?)$/i;
const SECTIONISH = /^Temperature\s*=|^T\s*=/i;

/** 一行的列数（colspan 之和） */
const cellsWidth = (cells) => cells.reduce((s, c) => s + c.colspan, 0);

/**
 * 把若干行摊平成定长二维数组。rowspan 的值**向下重复**、colspan 的值**向右重复**，
 * 所以结果里没有任何合并单元格——这正是窄屏平台要的形态。
 *
 * rowspan 的寿命要算准：`left = rowspan - 1` 表示「本行之后还要盖几行」，
 * 只能在**后续行**结束时递减。一开始写成每行无条件递减，结果第一行刚记下的
 * rowspan 当场就被扣光，第二行 Model/Method 变成两个空格。
 */
function expandMatrix(rows, colCount) {
  const out = [];
  const carry = new Array(colCount).fill(null);      // { text, left }
  for (const r of rows) {
    const section = isSectionRow(r);
    // 上方 rowspan 还盖着的前几列：LaTeX 有两种占位写法，都要让出来
    let lead = 0;
    while (lead < colCount && carry[lead]) lead++;
    let cells = r.cells;
    if (lead > 0 && cellsWidth(cells) === colCount) cells = cells.slice(lead);  // 写了空占位：丢掉
    const vals = new Array(colCount).fill('');
    for (let c = 0; c < lead; c++) vals[c] = carry[c].text;
    let c = lead;
    const fresh = [];                                  // 本行新生效的 rowspan
    for (const cell of cells) {
      if (c >= colCount) break;
      for (let k = 0; k < cell.colspan && c + k < colCount; k++) {
        vals[c + k] = cell.text;
        if (cell.rowspan > 1) {
          carry[c + k] = { text: cell.text, left: cell.rowspan - 1 };
          fresh.push(c + k);
        }
      }
      c += cell.colspan;
    }
    for (; c < colCount; c++) if (carry[c]) vals[c] = carry[c].text;
    // 分节行保留 cells：机器要拿它当分节标记，但列路径还需要它给出的
    // 「Speedup / τ」标签（DFlash 的 Avg. 组就是这样才知道两列各是什么）
    out.push(section ? { section: r.cells[0].text, cells: vals } : { cells: vals });
    // 只递减「上一行及更早」留下的 rowspan；本行刚记下的从下一行才开始消耗
    for (let i = 0; i < colCount; i++) {
      if (!carry[i] || fresh.includes(i)) continue;
      carry[i].left -= 1;
      if (carry[i].left <= 0) carry[i] = null;
    }
  }
  return out;
}

/**
 * 每列的表头路径：`['Math','GSM8K','Speedup']`。
 * 「Temperature = 0」这类分节标签不算路径（它在矩阵里会横跨前两列，混进来会把
 * Model 认成任务列）。
 */
function columnPaths(matrixRows, colCount) {
  const paths = Array.from({ length: colCount }, () => []);
  for (const r of matrixRows) {
    if (!r.cells) continue;
    for (let c = 0; c < colCount; c++) {
      const t = (r.cells[c] ?? '').trim();
      if (!t || SECTIONISH.test(t)) continue;
      if (paths[c].at(-1) === t) continue;      // 同一个标签在多层表头里重复，只记一次
      paths[c].push(t);
    }
  }
  return paths;
}

/** 「Temperature = 0」→ `0`（分节的显示值）
 *  源里常写成 `$T{=}0$`（把等号也包进数学模式，避免间距），parseCell 会
 *  原样留下 `T{=}0`——正则只认 `T = 0` 时匹配不到，页面上就是一列 `T{=}0`。 */
function sectionValue(label) {
  const v = String(label)
    .replace(/[\u0001]/g, '')
    .replace(/\{=\}/g, '=')
    .replace(/\s+/g, ' ')
    .replace(/^(?:Temperature|T)\s*=\s*/i, '')
    .trim();
  return v || null;
}

/**
 * LaTeX 表 → 若干张窄表。返回 shape：
 *   [{ title, header: [...], rows: [[...]] }]
 *
 * 只做「能保证对」的变形：数字原样搬、列顺序不变；实在拆不动的表返回 problems，
 * 调用方据此退回截图。
 */
function toCompact(tex, { caption = '', hint = '', macros = {}, maxTasks = 3 } = {}) {
  const tabulars = extractAllTablulars(tex);
  // 挑哪张 tabular 用完整图注（关键词打分），显示用的标题用短版
  const picked = pickTabular(tabulars, hint || caption);
  const rows = parseTabular(picked ? picked.body : tex, macros);
  const { head, rest: rawRest } = splitHead(rows);
  if (!head.length) return { tables: [], problems: ['没有识别出表头'] };
  const rest = hoistGroupModels(rawRest);

  const headMatrix = expandMatrix(head, Math.max(...head.map(spanSum), 1));
  const colCount = Math.max(...headMatrix.flatMap((r) => (r.cells ? [r.cells.length] : [])),
    ...rest.map(spanSum), 1);
  // 表头矩阵可能比数据窄（最后一列没写表头），用最终列数重摊一次
  const headFull = expandMatrix(head, colCount);
  const bodyFull = expandMatrix(rest, colCount);
  const paths = columnPaths(headFull, colCount);

  // 标识列（Model / Method / Temp）vs 任务列。
  // 判据是**名字**，不是「有几层表头」：DFlash 的 `Avg.` 只有一层、DSpine 的
  // `Overall` 也只有一层，它们都是任务列；反过来 `Method` 只有一层却是标识列。
  // 一开始按「层数≥2 就算任务」分，结果把所有单层任务列都当成了标识列。
  const IDENT = /^(model|method|temp\.?|temperature|模型|方法|温度|配置|setting)$/i;
  const identCols = [];
  const taskCols = [];
  for (let c = 0; c < colCount; c++) {
    const label = paths[c].filter((x) => !METRIC.test(x)).at(-1) ?? '';
    // 首列**永远**当标识列：行标签叫什么都有可能（`MTP Loss`、`Objective`、`Setting`…），
    // 靠关键字列举必然漏。真正的数据列都在它右边，把它们分错才是灾难。
    // 2026-11-19 bebop 的 `MTP Loss` 就是这样被当成任务列，导致拆表后
    // 第二片整列行标签消失（只剩 75.1 / +0.2 这种没有主语的数字）。
    (c === 0 || label === '' || IDENT.test(label) ? identCols : taskCols).push(c);
  }
  // 标识列必须是**连续的前缀**。中间夹着任务列说明分类错了，宁可退回截图。
  if (identCols.length && identCols.some((c, i) => c !== i)) {
    return { tables: [], problems: ['标识列不连续，列分类失败'] };
  }

  // 相邻两列的路径只有最后一层不同、且那一层是 Speedup/τ 这类指标 → 并成一格
  const tasks = [];
  for (const c of taskCols) {
    const prev = tasks.at(-1);
    const p = paths[c];
    const q = prev ? paths[prev.cols.at(-1)] : null;
    const sameParent = prev && q && p.length === q.length && p.length >= 2
      && p.slice(0, -1).join('/') === q.slice(0, -1).join('/')
      && METRIC.test(p.at(-1)) && METRIC.test(q.at(-1)) && p.at(-1) !== q.at(-1)
      && c === prev.cols.at(-1) + 1;             // 必须紧挨着
    if (sameParent) { prev.cols.push(c); continue; }
    const labelPath = p.filter((x) => !METRIC.test(x));
    tasks.push({
      cols: [c],
      label: labelPath.at(-1) ?? p.at(-1) ?? `列${c + 1}`,
      group: labelPath.length >= 2 ? labelPath[0] : '',
    });
  }
  if (!tasks.length) return { tables: [], problems: ['没识别出任务列'] };

  // 分节（Temperature=0/1）：首节可能藏在表头最后一行
  const headSection = [...head].reverse().find((r) => isSectionRow(r));
  let currentSection = headSection ? sectionValue(headSection.cells[0].text) : null;
  const hasSection = Boolean(currentSection) || bodyFull.some((r) => r.section);
  const sectionOf = (t) => String(t).replace(/^Temperature\s*=\s*|^T\s*=\s*/i, '').trim();

  // 标识列里的 `$T{=}0$` 归一成 `T=0`：`{=}` 是 LaTeX 里把等号包进数学模式的写法，
  // 不处理就在页面上原样印出花括号（2026-11-19 specauf 实测）。
  const tidyIdent = (s) => String(s ?? '').replace(/\{=\}/g, '=').replace(/[\u0001]/g, '').trim();
  const identLabels = identCols.map((c) => tidyIdent(paths[c].filter((x) => !SECTIONISH.test(x)).at(-1) ?? ''));
  // 首列表头本来就空（`\multirow{6}{T=0}` 那种），用「温度」兜底，否则页面上是一格空白
  if (identLabels[0] === '' && bodyFull.some((r) => r.cells && /^T\s*=\s*\d/.test(r.cells[identCols[0]] ?? ''))) {
    identLabels[0] = '温度';
  }

  const tables = [];
  for (let i = 0; i < tasks.length; i += maxTasks) {
    const chunk = tasks.slice(i, i + maxTasks);
    const group = chunk.every((t) => t.group && t.group === chunk[0].group) ? chunk[0].group : '';
    const header = [...identLabels.map((l) => l || ''), ...(hasSection ? ['温度'] : []), ...chunk.map((t) => t.label)];
    const body = [];
    currentSection = headSection ? sectionValue(headSection.cells[0].text) : null;
    for (const r of bodyFull) {
      if (r.section) { currentSection = sectionOf(r.section); continue; }
      const cells = (r.cells ?? []);
      const identVals = identCols.map((c) => tidyIdent(cells[c] ?? ''));
      // 整行都空（被上方 rowspan 完全覆盖）就跳过，否则会多出一排空行
      if (identVals.every((v) => !v) && chunk.every((t) => t.cols.every((c) => !cells[c]))) continue;
      body.push([
        ...identVals,
        ...(hasSection ? [currentSection ?? ''] : []),
        ...chunk.map((t) => t.cols.map((c) => cells[c] ?? '').filter(Boolean).join(' / ')),
      ]);
    }
    const title = `${caption}${tasks.length > maxTasks ? `（${Math.floor(i / maxTasks) + 1}/${Math.ceil(tasks.length / maxTasks)}）` : ''}${group ? ` · ${group}` : ''}`;
    tables.push({ title, header, rows: body });
  }

  // 自检：拼回去的数字必须一个不少（次数也要对），否则调用方退回截图
  const problems = [];
  const flat = (list) => list.flatMap((t) => t.rows.flat()).join(' ');
  const outText = flat(tables);
  const wanted = bodyFull.flatMap((r) => (r.cells ?? [])).join(' ');
  const numOf = (s) => [...s.matchAll(/(?<![\d.])(\d+\.\d+)/g)].map((m) => m[1]);
  const tally = (list) => list.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map());
  const a = tally(numOf(wanted));
  const b = tally(numOf(outText));
  for (const [n, k] of a) if ((b.get(n) ?? 0) !== k) { problems.push(`数字 ${n} 在紧凑表里出现 ${b.get(n) ?? 0} 次，原文 ${k} 次`); break; }
  return { tables, problems, colCount };
}

/** 窄表 → 纯 HTML 表格（知乎可以直接粘贴；公众号再补内联样式） */
function compactToHtml(tables, { titleTag = 'p' } = {}) {
  return tables.map((t) => {
    const head = `<tr>${t.header.map((h) => `<th>${h}</th>`).join('')}</tr>`;
    const body = t.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `${t.title ? `<${titleTag}>${t.title}</${titleTag}>` : ''}<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }).join('\n');
}

// ---- CLI：打印结果，供人工检查
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=') || true];
  }));
  const tex = readFileSync(String(args.tex), 'utf8');
  let macros = {};
  if (args.macros) macros = JSON.parse(String(args.macros));
  else if (args['macros-file'] && existsSync(String(args['macros-file']))) {
    macros = JSON.parse(readFileSync(String(args['macros-file']), 'utf8'));
  }
  if (args.compact) {
    const r = toCompact(tex, { caption: args.caption ?? '', macros, maxTasks: Number(args['max-tasks'] ?? 3) });
    if (r.problems.length) console.error(`⚠️ 紧凑表有问题：${r.problems.join('；')}`);
    console.log(compactToHtml(r.tables));
  } else {
    const r = toHtml(tex, { caption: args.caption ?? '', macros });
    if (r.problems.length) console.error(`⚠️ 解析可能有问题：${r.problems.join('；')}`);
    console.log(r.html);
  }
}

export { toHtml, parseTabular, extractAllTablulars, pickTabular, toCompact, compactToHtml };
