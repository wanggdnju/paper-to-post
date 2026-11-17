/**
 * 从 LaTeX 源表抽结构化事实：`facts.json`。
 *
 *   node scripts/facts.mjs --slug=dspine [--src=/tmp/dspine-src] [--write]
 *   → articles/<slug>/facts.json
 *
 * 为什么做这件事：稿件里最危险的错误不是「写得不深」，而是**数字张冠李戴**——
 * 把 GSM8K 位置 8 的单点值 31.8 当成三位置均值、把采样时对 DSpark 的领先 12.8%
 * 当成「DSpark 比 DFlash2 高」。这类错自检脚本查不出，因为它需要知道
 * 「这个数字在论文里属于哪个表的哪一行哪一列」。
 *
 * facts.json 就是这个对照表：写稿时模型只能引用有 ID 的事实，发布前
 * `publish-check` 扫全文数字，凡不在 facts 里的都会报出来。
 *
 * 解析的 LaTeX 结构（论文常规写法，不是通用 LaTeX 解析器）：
 *   \begin{table} \caption{..} \label{..}
 *     \begin{tabular}{...}
 *       表头行 \\ \midrule
 *       数据行 \\        ← 第一格留空表示沿用上一行的模型名
 *     \end{tabular}
 *   \end{table}
 * 特殊写法：`4.25\,/\,3.96`（同格两个温度）、`\textbf{}`、`\underline{}`、
 * `\multicolumn{n}{c}{}`、`\rowcolor{}`、`x\,$\pm$\,y`。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/facts.mjs --slug=<slug> [--src=<LaTeX 源目录>] [--write]');
  process.exit(1);
}
const slug = String(args.slug);
const outPath = join(ROOT, 'articles', slug, 'facts.json');

/** 递归找所有 .tex */
function texFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...texFiles(full));
    else if (name.endsWith('.tex')) out.push(full);
  }
  return out;
}

/**
 * LaTeX 里的希腊字母 → Unicode。
 *
 * 为什么要映射而不是原样留着：这些符号会进**列名**，列名又会进 fact ID
 * （`tab:alpha@T=0/Vicuna 7B:\tau = 3.94`）。模型复制这种 ID 时几乎必然漏掉反斜杠，
 * 于是「数字明明在表里」却校验不过，全是假阳性。
 * ID 必须是「看一眼就能原样打出来」的字符串。
 */
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/**
 * 论文自定义宏：`\newcommand{\method}{D-cut}`、`\def\modelname{DFlare}`。
 *
 * 这类宏在表里被写成 `\method (16)`，不展开的话方法和值都带着反斜杠：
 *   - facts 里的 method 变成 `\method (16)`，稿件写「D-cut (16)」永远对不上；
 *   - 值里也可能带（`\hl 4.15`）。
 * 解析一遍 preamble，把**无参数**的宏替换成它的展开文本。带参数的宏（如
 * `\newcommand{\hl}[1]{...}`）不处理——它们在 cleanCell 里另有规则。
 */
const CUSTOM_MACROS = new Map();

/** 从 `text[pos]` 处的 `{` 开始，返回配平的内部文本与结束位置。 */
function braceBody(text, pos) {
  if (text[pos] !== '{') return null;
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (!depth) return { body: text.slice(pos + 1, i), end: i + 1 }; }
  }
  return null;
}

/**
 * 论文自定义宏：`\newcommand{\method}{\textbf{D-cut}\xspace}`。
 *
 * 这类宏在表里被写成 `\method (16)`，不展开的话方法名和值都带着反斜杠：
 *   - facts 的 method 变成 `\method (16)`，稿件写「D-cut (16)」永远对不上；
 *   - 值里也可能带（`\hl 4.15`）。
 * 解析一遍 preamble，把**无参数**的宏替换成展开文本。带参数的（`{\hl}[1]`）不处理，
 * 它们在 cleanCell 里另有规则。
 *
 * 展开体里常有嵌套花括号（`{\textbf{D-cut}\xspace}`），所以不能用 `\{([^{}]*)\}`
 * 这种单层正则——D-cut 的 \method 就是这么漏掉的。
 */
function loadCustomMacros(dir) {
  const strip = (t) => t
    .replace(/\\xspace\b/g, '')
    // 表内 `\def\hl{\cellcolor{HYLightBlue!55}}` 这类宏展开的是**底色标记**，不是名字。
    // 整条删掉（连花括号一起），宏体变空后就不注册——cleanCell 的通用规则会把它当空白。
    // 漏这一步会把 `\hl` 展开成 `\cellcolorHYLightBlue!55`（strip 去掉了花括号），
    // 后面的 `\cellcolor{...}` 规则匹配不到，值里留下一串垃圾（2026-11-17 实际发生）。
    .replace(/\\(?:cellcolor|rowcolor|color|textcolor)\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:cellcolor|rowcolor|color|textcolor)\b[^{\s]*/g, '')
    .replace(/\\textbf\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\textit\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\mathrm\s*\{([^{}]*)\}/g, '$1')
    .replace(/[{}]/g, '')
    .trim();
  for (const file of texFiles(dir)) {
    const text = readFileSync(file, 'utf8').replace(/(?<!\\)%.*$/gm, ' ');
    for (const m of text.matchAll(/\\(?:newcommand|renewcommand|providecommand)\*?\s*\{\\([A-Za-z]+)\}/g)) {
      // 跳过带参数的宏：`{\hl}[1]{...}`
      const after = text.slice(m.index + m[0].length);
      if (/^\s*\[/.test(after)) continue;
      const open = after.indexOf('{');
      if (open < 0 || /\S/.test(after.slice(0, open))) continue;
      const b = braceBody(after, open);
      if (b) { const v = strip(b.body); if (v) CUSTOM_MACROS.set(m[1], v); }
    }
    for (const m of text.matchAll(/\\def\\([A-Za-z]+)\s*\{/g)) {
      const open = text.indexOf('{', m.index + m[0].length - 1);
      const b = open >= 0 ? braceBody(text, open) : null;
      if (b) { const v = strip(b.body); if (v) CUSTOM_MACROS.set(m[1], v); }
    }
  }
  // 宏可能套宏（\method → \modelname → D-cut），展开两轮
  for (let round = 0; round < 2; round++) {
    for (const [k, v] of CUSTOM_MACROS) {
      let next = v;
      for (const [k2, v2] of CUSTOM_MACROS) if (k2 !== k) next = next.split(`\\${k2}`).join(v2);
      CUSTOM_MACROS.set(k, next);
    }
  }
}

function expandMacros(s) {
  let out = String(s);
  for (const [k, v] of CUSTOM_MACROS) out = out.split(`\\${k}`).join(v);
  return out;
}

/** LaTeX 单元格 → 纯文本。保留 `a / b` 的双值写法，其余符号剥掉。 */
function cleanCell(raw) {
  let s = expandMacros(raw)
    .replace(/\\rowcolor\{[^}]*\}/g, '')
    .replace(/\\cellcolor\{[^}]*\}/g, '')
    // \shortstack{None\\(DFlash)} —— 表头里用它换行写两行，要去掉换行合并成一句
    .replace(/\\shortstack\{([\s\S]*?)\}(?=\s|&|\\|$)/g, (_, body) => body.replace(/\\\\/g, ' '))
    .replace(/\\(textbf|textit|underline|emph|textsc|mathrm|text)\s*\{([^{}]*)\}/g, '$2')
    .replace(/\\\\(toprule|midrule|bottomrule|hline)\b/g, '')
    // 无参数的「高亮宏」：`\hl 4.15`、`\hlg 1.32\times`。
    //
    // 论文习惯先定义 `\newcommand{\hl}[1]{\textbf{#1}}` 再写成不带花括号的形式，
    // 于是单元格里的值变成 `\hl 4.15`。上面的通用规则只把 `\hl` 原样留着，
    // 值就成了一串带宏的字符串——verify-numbers 做精确匹配时永远对不上，
    // 一整列 D-cut 的数字全被判「无出处」（2026-11-17 D-cut 的 τ 4.15/5.21 就是这么报的）。
    // 这里直接把它们当空白删掉，剩下的 `4.15` 才是值。
    .replace(/\\(?:hlrow|hlg|hlb|hlr|hl|best|ours)/g, '')
    .replace(/\\cmidrule(\([^)]*\))?\{[^}]*\}/g, '')
    .replace(/\\multicolumn\{(\d+)\}\{[^}]*\}\{([^{}]*)\}/g, '$2')
    // \multirow 有两种写法：{n}{width}{text} 和 {n}[fixup]{width}{text}。
    // 漏掉可选参数 `[2]` 会让整串落到下面的通用规则里，变成 `6[2]*T=0`——
    // EAGLE 那张分组表就是这么坏掉的（分组名本该是 `T=0`）。
    .replace(/\\multirow\{(\d+)\}(?:\[[^\]]*\])?\{[^}]*\}\{([^{}]*)\}/g, '$2')
    .replace(/\$?\\pm\$?/g, '±')
    .replace(/\\,/g, ' ')
    .replace(/\\&/g, '&')          // 表头里的「refinement \& injection」是转义的 &
    // 列名里残留的 `\%`、`$$...$$` 会进 ID，模型复制时必然漏掉反斜杠——
    // ID 必须是「看一眼就能原样打出来」的字符串，否则校验全是假阳性。
    .replace(/\\%/g, '%')
    .replace(/\\([a-zA-Z]+)/g, (m, name) => GREEK[name] ?? m)
    .replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1')   // `\gamma` 这类要留，`\foo{x}` 取 x
    .replace(/\$/g, '')
    .replace(/[{}]/g, '')
    .replace(/~|\\ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // `4.25 / 3.96` 这种双值规范化成 `4.25/3.96`
  s = s.replace(/\s*\/\s*/g, '/');
  return s;
}

/** 按 `\\` 切行，但 `\\` 前若是换行命令块要忽略（`\\[2pt]`） */
function splitRows(tabular) {
  const rows = [];
  let depth = 0;
  let cell = '';
  const s = tabular;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    // `\\` 且不在命令括号里 → 换行
    if (ch === '\\' && s[i + 1] === '\\' && depth === 0) {
      rows.push(cell);
      cell = '';
      i += 1;
      // 吃掉可选的 [2pt]
      const opt = s.slice(i + 1).match(/^\s*\[[^\]]*\]/);
      if (opt) i += opt[0].length;
      continue;
    }
    cell += ch;
  }
  if (cell.trim()) rows.push(cell);
  return rows;
}

/**
 * 一行拆成单元格：按未嵌套的 `&` 切。
 * `\multicolumn{n}{...}{text}` 展开成 n 格（第一格放文字，其余留空）——
 * 不展开的话，双层表头（「Math」跨 2 列 + 下一行 GSM8K/MATH-500）列会整体错位，
 * 抽出来的 facts 会把值挂到错误的列名上，比不抽还危险。
 */
function splitCells(row) {
  const cells = [];
  let depth = 0;
  let cur = '';
  for (const ch of row) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === '&' && depth === 0) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);

  const expanded = [];
  for (const cell of cells) {
    const mc = cell.match(/\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}\s*$/);
    if (mc) {
      const span = Number(mc[1]);
      expanded.push(cleanCell(mc[2]));
      for (let i = 1; i < span; i++) expanded.push('');
      continue;
    }
    expanded.push(cleanCell(cell));
  }
  return expanded;
}

/**
 * 解析一个 tabular：第一行是表头，之后是数据行。
 * 表头可能是两层（\multicolumn 跨列），这里把两层拼起来当列名。
 */
/**
 * 表头行里每一列**所属的组名**（来自 `\multicolumn`）。
 *
 * 为什么要单独算一遍：`\multicolumn{2}{c}{HumanEval} & \multicolumn{2}{c}{GSM8K}`
 * 展开后第一列拿到组名、第二列是空填充。于是「HumanEval / Speedup」对，
 * 但紧接着的 `τ` 列只叫 `τ`——而 GSM8K、Alpaca 下也各有一个 `τ`，
 * 三列**同名**，后写的事实覆盖前面的，三个基准的 τ 全混成一格。
 *
 * 返回的数组长度和 `splitCells` 一致，只是空填充位换成了它所属的组名。
 */
function splitHeaderGroups(row) {
  const cells = [];
  let depth = 0;
  let cur = '';
  for (const ch of row) {
    if (ch === '{') depth += 1;
    if (ch === '}') depth -= 1;
    if (ch === '&' && depth === 0) { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);

  const groups = [];
  for (const cell of cells) {
    const mc = cell.match(/\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*)\}\s*$/);
    if (mc) {
      // 跨 n 列：每一列都属于这个组，所以要 push n 次
      const label = cleanCell(mc[2]);
      for (let i = 0; i < Number(mc[1]); i++) groups.push(label);
      continue;
    }
    groups.push('');
  }
  return groups;
}

function parseTabular(headerLines, bodyRows) {
  const headerRows = headerLines.map(splitCells);
  const groupRows = headerLines.map(splitHeaderGroups);
  const width = Math.max(...[...headerRows, ...bodyRows.map(splitCells)].map((r) => r.length), 0);
  // 列名：多层表头按列拼（去掉空层）。
  const bare = [];
  const withGroup = [];
  for (let c = 0; c < width; c++) {
    const parts = headerRows.map((r) => r[c] ?? '').filter(Boolean);
    bare.push(parts.join(' / ') || `col${c + 1}`);
    // 空位（\multicolumn 的填充列）用该列**所属的组名**补上
    const grouped = headerRows
      .map((r, i) => (r[c] ?? '') || (groupRows[i]?.[c] ?? ''))
      .filter(Boolean);
    withGroup.push(grouped.join(' / ') || `col${c + 1}`);
  }
  // 只在**列名撞车**时才加组名前缀。
  //
  // 为什么不一刀切全加：列名会进 fact ID，而 ID 是写进 outline.json / compare.json
  // 的稳定契约。已经发布的稿子（dspine）用的是裸列名，一刀切会让 40+ 个 ID 失效。
  // 而 EAGLE 那张 `HumanEval | τ | GSM8K | τ | Alpaca | τ` 是**真的撞车**——
  // 三个 `τ` 同名，后写的覆盖前面的，三个基准的接受长度混成一格数据。
  // 所以：能区分就不动，区分不了才补组名。
  const seen = new Map();
  for (const name of bare) seen.set(name, (seen.get(name) ?? 0) + 1);
  const columns = bare.map((name, c) => (seen.get(name) > 1 ? withGroup[c] : name));
  return { columns, width };
}

const tables = [];
const srcDir = String(args.src ?? '/tmp');
if (!existsSync(srcDir)) {
  console.error(`✗ 找不到 LaTeX 源目录：${srcDir}`);
  console.error('  先跑 `npm run fetch:pdf` 之后解包 e-print，或用 --src=<目录> 指定。');
  process.exit(1);
}
loadCustomMacros(srcDir);
for (const file of texFiles(srcDir)) {
  const text = readFileSync(file, 'utf8');
  const relFile = relative(srcDir, file);
  // 逐个 table 环境
  for (const m of text.matchAll(/\\begin\{table\*?\}([\s\S]*?)\\end\{table\*?\}/g)) {
    const env = m[1];
    const caption = cleanCell(env.match(/\\caption\{([\s\S]*?)\}(?=\s*\\label|\s*\n)/)?.[1] ?? '');
    const label = env.match(/\\label\{([^}]+)\}/)?.[1] ?? '';
    // 同一 label 下可能有多张 tabular（左右并排两个 minipage）：加 #2 #3 后缀区分
    let subIndex = 0;
    // 一个 table 里可能有多张 tabular（如左右并排两个 minipage，各一张表）
    // 必须同时匹配 tabular / tabular* / tabularx —— 论文里 `\begin{tabular*}{\linewidth}{...}`
    // 很常见，漏了这个模式会整张表消失，而且不报错。
    for (const t of env.matchAll(/\\begin\{tabular\*?\}(?:\{[^}]*\})?(?:\{[^}]*\})?([\s\S]*?)\\end\{tabular\*?\}/g)) {
      // 把各种规则线都当分隔符，包括 \cmidrule —— 论文用它分隔同一个 table 里的
      // 不同模型组（`Qwen3-8B` / `Qwen3-4B`）。漏掉它，两个模型组的行会被归到同一段，
      // 组名只能从「第 0 列非空的那一行」往后生效，前面几行就丢了组名（4.82 正确、
      // 但 DFlash 那几行 group 为空，写稿时不知道是哪个模型的数）。
      let raw = t[1]
        .replace(/\\cmidrule(\([^)]*\))?\{[^}]*\}/g, '\n@@RULE@@\n')
        .replace(/\\toprule|\\midrule|\\bottomrule|\\hline/g, '\n@@RULE@@\n');
      // 规则线把表切成若干段。去掉空段（\toprule 前面、\bottomrule 后面都是空的），
      // 剩下的：前两段是表头（可能是双层），其余全部是数据。
      // 注意不能简单地「最后一段是数据」——\bottomrule 会产生一个尾随空段，
      // 那样 body 永远是空的，整张表被静默丢掉。
      const segments = raw.split('\n@@RULE@@\n').filter((s) => cleanCell(s) !== '');
      if (segments.length < 2) continue;   // 只有表头没有数据
      // 第一段可能是 tabular 列格式残留（如 `cl*{8}{c}@{}`，不含 `&`）。
      // 判据：拆出来只有 1 格且不是表头样（含 & 的才是表头）。命中就跳过它。
      let start = 0;
      const firstRow = splitRows(segments[0])[0] ?? '';
      if (splitCells(firstRow).length <= 1 && !segments[0].includes('&')) start = 1;
      if (segments.length - start < 2) continue;
      // 表头：从 start 起，把所有「不含数字」的段都算表头。
      // `\cmidrule` 会把双层表头切成好几段（Math 组 / Code 组 / Chat 组各一段），
      // 之前固定取 2 段，导致列名只剩 `Math` 而不是 `Math / GSM8K`。
      //
      // 判据必须用 **拆完单元格后的文本**，且判断的是「这一格是不是纯数值」，
      // 不能是「含不含数字」——基准名 `MATH-500`、`MT-Bench` 都含数字，
      // 用「含数字」会让第二行表头被当成数据，列名就只剩 `Math` 而不是 `Math / GSM8K`。
      const isNumericCell = (cell) => /^[+\-−]?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(cell.replace(/\s/g, ''));
      const headerSegs = [];
      let cursor = start;
      while (cursor < segments.length) {
        const rows = splitRows(segments[cursor]).filter((r) => cleanCell(r) !== '');
        if (!rows.length) { cursor += 1; continue; }
        const looksHeader = rows.every((r) => !splitCells(r).some(isNumericCell));
        if (!looksHeader) break;
        headerSegs.push(segments[cursor]);
        cursor += 1;
      }
      if (!headerSegs.length) { headerSegs.push(segments[start]); cursor = start + 1; }
      const headerRows = headerSegs.flatMap((seg) => splitRows(seg)).filter((r) => cleanCell(r) !== '');
      const bodyRows = segments.slice(cursor).flatMap((seg) => splitRows(seg)).filter((r) => cleanCell(r) !== '');
      // 分组：每条规则线之间的一段就是一组（`Qwen3-8B` / `Qwen3-4B` 各自一段）。
      // 不能靠「第 0 列留空沿用上一行」——论文常把模型名写在这一组的中间某行，
      // 那样前几行会拿到上一组的模型名，facts 的数字归属就全错了。
      const bodyGroups = segments.slice(cursor)
        .map((seg) => splitRows(seg).filter((r) => cleanCell(r) !== ''))
        .filter((rows) => rows.length);
      if (!bodyRows.length) continue;
      const { columns } = parseTabular(headerRows.length ? headerRows : ['col1'], bodyRows);
      subIndex += 1;
      const tableLabel = subIndex > 1 ? `${label || relFile}#${subIndex}` : label;
      tables.push({ file: relFile, caption, label: tableLabel, columns, bodyRows, bodyGroups });
    }
  }
}

// ---- 展开成事实条目 ----
const facts = [];
for (const table of tables) {
  const tableId = table.label || table.file.replace(/[^\w]+/g, '-');
  const rows = table.bodyRows.map((r) => splitCells(r))
    .filter((cells) => !cells.every((c) => !c || /^[+\-=—]+$/.test(c)));

  // 有分组列吗？判据：一部分行第 0 列非空、另一部分为空。
  // （每行都填 = 第 0 列本身就是行标签；全都空 = 没有分组。）
  const filled = rows.filter((c) => c[0]).length;
  const hasGroupColumn = filled > 0 && filled < rows.length;

  // 行标签列的位置：
  //   - 有分组列时：第 1 列（第 0 列是模型名）
  //   - 没有分组列时：看第 0 列的**列名**是不是一个维度名
  //   - 再兜底：整列都不含数字才算标签列
  const labelCol = hasGroupColumn ? 1 : (() => {
    // 第 0 列的列名如果是 Dataset/Size/Batch size 这类，就是标签列。
    // ⚠️ 必须包含 size / task / type 这几个：EAGLE 的 `tab:aba-chain` 第 0 列叫
    // `Vicuna / Size`、`tab:bs` 叫 `Batch size`，值分别是 `7B` 和 `Vicuna 7B`。
    // 早先版本只认 dataset|model|method，这两张表全被判成「没有标签列」，
    // label 恒为空 → 同一张表的每一行产出**完全相同**的 fact ID
    // （18 条事实只有 6 个 ID），verify-numbers 取哪个格子都可能是错的。
    const colName = table.columns[0] ?? '';
    if (/dataset|schedule|history|setting|config|model|method|variant|size|task|type|name|hyperparameter|benchmark/i.test(colName)) return 0;
    // 否则看该列是否整列都不含数字
    const allNoDigits = rows.every((c) => !/\d/.test(c[0] ?? ''));
    return allNoDigits ? 0 : -1;   // -1 = 没有标签列，第 0 列也是数据
  })();

  // 分组：按规则线分段，一段 = 一个模型组。
  // 段内某一行写了模型名（如 `Qwen3-8B`），整段都用它——包括写在段中间的那一行之前的行。
  const groupSegments = (table.bodyGroups?.length ? table.bodyGroups : [table.bodyRows])
    .map((rows) => rows.map((r) => splitCells(r)).filter((c) => !c.every((x) => !x || /^[+\-=—]+$/.test(x))))
    .filter((rows) => rows.length);
  const groupNames = groupSegments.map((rows) => {
    const col0 = [...new Set(rows.map((r) => r[0]).filter(Boolean))];
    return col0.length === 1 ? col0[0] : '';
  });

  for (const [gi, rows] of groupSegments.entries()) {
    const groupName = groupNames[gi];
    for (const cells of rows) {
      if (cells.every((c) => !c || /^[+\-=—]+$/.test(c))) continue;
      // 有分组列时，第 0 格是模型名，行标签在第 1 格；否则第 0 格就是行标签
      const hasGroupColumn = Boolean(groupNames.some((n) => n)) && groupSegments.length === 1
        ? true
        : false;
      void hasGroupColumn;
      const label = labelCol >= 0 ? (cells[labelCol] ?? '') : '';
      const firstValue = cells.findIndex((c, i) => i > labelCol && /\d/.test(c));
      if (firstValue < 0) continue;
      // 左右并排的表（`Size | Chain | Tree | Size | Chain | Tree`）每侧**各有一个**
      // 行标签列。只取第 0 列会让右侧那几列全用左边的 size：
      // `33B` 段里 LLaMA2-Chat 本该是 `70B`，却记成 `33B`——写进稿子就是错数。
      //
      // ⚠️ 只在**确认是左右并排**时才启用（同一张表里出现 ≥2 个标签列）。
      // 单标签列的普通表必须走原来的逻辑：dspine 主表第 0 列是模型分组、
      // 第 1 列是 Method，把 `Model` 也算成「每列各自的标签列」会让
      // method 变成模型名、ID 全变，已发布的 80 条事实全部失效。
      const sideLabelCols = [];
      table.columns.forEach((name, idx) => {
        if (/^(\S+\s*\/\s*)?(size)$/i.test(name.trim())) sideLabelCols.push(idx);
      });
      const sideBySide = sideLabelCols.length >= 2;
      for (let c = firstValue; c < cells.length; c++) {
        const value = cells[c];
        if (!value || value === '—' || value === '-') continue;
        if (!/\d/.test(value)) continue;
        const colName = table.columns[c] ?? `col${c + 1}`;
        // 这一列对应的标签列 = 编号 <= c 的最后一个标签列（仅左右并排时生效）
        const ownLabelCol = sideBySide ? sideLabelCols.filter((i) => i <= c).pop() : undefined;
        const ownLabel = ownLabelCol != null ? (cells[ownLabelCol] ?? '') : label;
        // 左右并排时同一行有两组同名的 size（都是 `7B`），用列名里的组前缀区分
        const prefix = sideBySide && colName.includes(' / ') ? colName.split(' / ')[0] : '';
        const labelPart = ownLabel ? (prefix && !colName.startsWith(ownLabel) ? `${ownLabel}|${prefix}` : ownLabel) : 'row';
        facts.push({
          id: `${tableId}@${groupName ? `${groupName}/` : ''}${labelPart}:${colName}`,
          table: tableId,
          caption: table.caption.slice(0, 200),
          group: groupName,
          method: ownLabel,
          column: colName,
          value,
          // 双值（T=0/T=1）拆开便于精确匹配
          parts: value.includes('/') ? value.split('/').map((v) => v.trim()).filter(Boolean) : [value],
        });
      }
    }
  }
}

// ---- 正文数字（表格之外的论据） ----
// 论文里相当一部分关键数字写在正文里而不是表里（「补回 14.8 个点」「每轮 7.14 ms」）。
// 只收表格的话，写稿时引用这些数会被判成「无出处」——那是误报。
// 所以把 .tex 正文里的小数也收进来，带上下文，标明 source: 'text'。
const textNumbers = [];
if (!args['tables-only']) {
  for (const file of texFiles(srcDir)) {
    const text = readFileSync(file, 'utf8')
      // 去掉注释、表格环境、公式环境——表格已单独处理，公式里是符号不是结论
      .replace(/(?<!\\)%.*$/gm, ' ')
      // figure 环境整段删掉，但**留下 caption**：
      // 论文里很多关键数字只出现在图注里（D-cut 的「selector 0.56–0.58 ms、
      // 整步省 21%/35%」就全在 Figure 6 的 caption）。整段删掉会让这些数被判「无出处」。
      .replace(/\\begin\{(figure\*?)\}([\s\S]*?)\\end\{\1\}/g, (_, _e, body) => {
        const cap = body.match(/\\caption\{([\s\S]*?)\}\s*(?=\\label|\\end|$)/);
        return cap ? ` ${cap[1]} ` : ' ';
      })
      .replace(/\\begin\{(table|tabular|equation|align)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ');
    for (const m of text.matchAll(/(?<![\d.])(\d+\.\d+)\s*(%|\\%|×|ms|s\b|个点|个百分点)?/g)) {
      const before = text.slice(Math.max(0, m.index - 60), m.index).replace(/\s+/g, ' ').trim();
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
      textNumbers.push({
        id: null,   // 正文数字没有表/行/列，靠 context 定位
        table: `text:${relative(srcDir, file)}`,
        source: 'text',
        group: '',
        method: '',
        column: '',
        value: m[1].replace(/^[+−-]/, ''),
        unit: (m[2] ?? '').replace('\\%', '%'),
        context: `${before} ⟨${m[0].trim()}⟩ ${after}`.slice(0, 160),
      });
    }
  }
}

const doc = {
  slug,
  generated_at: new Date().toISOString(),
  source: String(args.src ?? ''),
  table_count: tables.length,
  fact_count: facts.length,
  text_number_count: textNumbers.length,
  tables: tables.map((t) => ({ file: t.file, label: t.label, caption: t.caption.slice(0, 200), columns: t.columns })),
  facts,
  text_numbers: textNumbers,
};

if (args.write) {
  writeFileSync(outPath, JSON.stringify(doc, null, 1), 'utf8');
  console.log(`→ articles/${slug}/facts.json（${tables.length} 张表，${facts.length} 条事实）`);
} else {
  console.log(JSON.stringify({ tables: tables.length, facts: facts.length, sample: facts.slice(0, 5) }, null, 1));
}
