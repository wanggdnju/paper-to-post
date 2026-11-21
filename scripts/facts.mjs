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
import { dirname, join, relative } from 'node:path';
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

/**
 * 递归找所有 .tex
 *
 * 返回值同时给出 `all`（盘上全部 .tex）与 `inlined`（每个文件展开了 \input 之后的文本）。
 * 为什么要展开 \input：论文常把每张表拆成独立片段（`\input{results_table}` 放在
 * `\begin{table}` 里），表格环境横跨两个文件。不展开时 `\begin{table}` 匹配不到
 * `\end{table}`，整张表静默消失——数字「明明在论文里」却在校验时找不到出处。
 */
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
 * 把一个 .tex 里的 `\input{name}` / `\include{name}` 就地展开（递归，带环保护）。
 * 只展开能解析到同目录/子目录下同名 .tex 的引用；外部宏包等保持原样。
 */
function inlineInputs(file, seen = new Set()) {
  if (seen.has(file)) return '';
  seen.add(file);
  const dir = dirname(file);
  let text = readFileSync(file, 'utf8');
  // 去掉注释再找 \input，避免被注释掉的片段被展开
  text = text.replace(/\\input\{([^}]+)\}|\\include\{([^}]+)\}/g, (whole, a, b) => {
    const name = String(a ?? b).trim();
    // arXiv 的 e-print 解包会把子目录拍平：`sections/intro.tex` 变成
    // `sections_intro.tex`。原样按 `sections/intro.tex` 找不到，整段 \input
    // 就留在原地，里面的表也就跟丢了（REAL Loss 的 12 张表全部走这条路径，
    // 第一次跑 facts 得到 0 张表）。所以再试一次把 `/` 换成 `_` 的扁平名。
    const flat = name.replace(/\//g, '_');
    for (const cand of [name, `${name}.tex`, flat, `${flat}.tex`]) {
      const p = join(dir, cand);
      if (existsSync(p)) return inlineInputs(p, seen);
    }
    return whole;
  });
  return text;
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
// 带参数的宏：name → { argc, body }。见 loadCustomMacros 里的说明。
const ARG_MACROS = new Map();
// 宏体里引用了带参宏的无参宏（`\dpalRenyi` → `\dpal{R\'enyi}`）：
// 必须原样保留花括号，否则参数边界没了、带参宏展开不了。
const RAW_MACROS = new Map();

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
    // 其余「取参数」的字体命令也要先剥掉：`\newcommand{\real}{\textsc{REAL}}`
    // 只处理 textbf/textit/mathrm 时，body 里的 `\textsc{REAL}` 会在下面去掉花括号后
    // 变成 `\textscREAL`——宏展开后单元格里留着一个反斜杠命令，cleanCell 的
    // 「\word{} 取参数」规则也匹配不到（花括号已经没了），末位变成 `\textscREAL`。
    // REAL Loss 那张表因此有一行的行标签变成空串，`hasGroupColumn` 误判为真，
    // 整张表的 `Method` 列被当成数值列——`4.740` 成了方法名。
    .replace(/\\(?:textsc|textsf|texttt|textnormal|textup|textsl|textmd|textsuperscript|text|mathbf|mathit|mathsf|mathtt|boldsymbol)\s*\{([^{}]*)\}/g, '$1')
    // `\&` 是**转义的 &**，在表格里是普通字符，不是列分隔符。
    // strip 阶段不处理它，`\&` 就会被拆成 `\` + `&`：反斜杠留在方法名里，
    // 而裸 `&` 会被 splitCells 当成列分隔符，整行右移一格
    // （2026-11-18 realloss 的 `REAL w/o CE\` 就是这么来的）。
    .replace(/\\&/g, '&')
    .replace(/[{}]/g, '')
    .trim();
  for (const file of texFiles(dir)) {
    const text = readFileSync(file, 'utf8').replace(/(?<!\\)%.*$/gm, ' ');
    for (const m of text.matchAll(/\\(?:newcommand|renewcommand|providecommand)\*?\s*\{\\([A-Za-z]+)\}/g)) {
      const after = text.slice(m.index + m[0].length);
      // 带参数的宏：`\newcommand{\dpal}[1]{\mbox{\dpalname[#1]}}`。
      // 以前整条跳过，于是 `\dpalRenyi` → `\dpal{Rényi}` 后没人展开，
      // 方法名里留着反斜杠（`\dpalRényi`），既进 fact ID 又印到页面上。
      // 这里把「宏体 + 参数个数」记成模板，expandMacros 照模板套参数展开。
      const argc = after.match(/^\s*\[(\d)\]\s*(?:\[[^\]]*\])?\s*/);
      if (argc) {
        const rest = after.slice(argc[0].length);
        const open = rest.indexOf('{');
        if (open !== 0) continue;
        const b = braceBody(rest, open);
        if (b) ARG_MACROS.set(m[1], { argc: Number(argc[1]), body: b.body });
        continue;
      }
      const open = after.indexOf('{');
      if (open < 0 || /\S/.test(after.slice(0, open))) continue;
      const b = braceBody(after, open);
      if (b) {
        // 宏体里如果含带参宏调用（`\dpalRenyi` → `\dpal{R\'enyi}`），
        // 不能走 strip：strip 末尾会无条件剥掉所有花括号，`\dpal{R\'enyi}`
        // 就变成 `\dpalR\'enyi`，参数边界消失，带参宏再也展开不了。
        // 这种宏原样存进 ARG_DEPENDENT，交给 expandMacros 按原串替换。
        const raw = b.body.trim();
        if (new RegExp(`\\\\(${[...ARG_MACROS.keys()].join('|')})\\s*\\{`).test(raw)) {
          RAW_MACROS.set(m[1], raw);
        } else {
          const v = strip(raw);
          if (v) CUSTOM_MACROS.set(m[1], v);
        }
      }
    }
    for (const m of text.matchAll(/\\def\\([A-Za-z]+)\s*\{/g)) {
      const open = text.indexOf('{', m.index + m[0].length - 1);
      const b = open >= 0 ? braceBody(text, open) : null;
      if (b) { const v = strip(b.body); if (v) CUSTOM_MACROS.set(m[1], v); }
    }
  }
  // 宏可能套宏（\method → \modelname → D-cut），展开两轮。
  // 同样必须带边界：`\dpalname` 和 `\dpal` 是两个不同的宏，裸 split 会把
  // `\dpalname` 的前缀 `\dpal` 替换掉，`\dpal[#1]` 就永远合不成 `D-PAL[...]`。
  for (let round = 0; round < 2; round++) {
    for (const [k, v] of CUSTOM_MACROS) {
      let next = v;
      for (const [k2, v2] of CUSTOM_MACROS) {
        if (k2 === k) continue;
        next = next.replace(new RegExp(`\\\\${k2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z])`, 'g'), () => v2);
      }
      CUSTOM_MACROS.set(k, next);
    }
  }
}

function expandMacros(s) {
  let out = String(s);
  // 宏体里可能再引用别的宏：`\ealp` 定义为 `\real{} \text{w/o RB}`，而 `\real`
  // 自己也定义了。单趟替换按 Map 的插入顺序跑，若 `\real` 排在前面，
  // `\ealp` 展开出来的 `\real` 就再也不会被替换（REAL Loss 的行标签因此成了
  // `real w/o RB`）。迭代到不动点（上限 5 轮防环）。
  //
  // ⚠️ 必须按**宏名边界**替换，不能用 `split('\\'+name).join(v)`：
  // 论文里遍布单/双字母宏（本节 ealwtv 有 `\ro`、`\re`、`\ra`…共 417 个），
  // 裸 split 会把 `\rotatebox` 的前缀 `\ro` 当成宏替换掉，剩下 `otatebox`。
  // 于是 `\multirow{8}{*}{\rotatebox…}` 变成 `8*otatebox[origin=c]90Greedy`，
  // 这个垃圾串一路进 fact ID 和站点上的「横向对比」表（2026-11-18 用户看到
  // 的 `1-d_TV(p,q)`、`% 5*rotatebox…` 就是这条链的末端）。
  // TeX 的宏名是「反斜杠 + 连续字母」，所以边界判据是「后面不跟字母」。
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = false;
    // 带参宏（`\dpal[1]{\mbox{\dpalname[#1]}}`）：先套参数展开成无参形式，
    // 再交给下面的无参循环，这样 `\dpalRenyi` → `\dpal{Rényi}` → `D-PAL[Rényi]`。
    for (const [k, { argc, body }] of ARG_MACROS) {
      const re = new RegExp(`\\\\${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^{}]*)\\}`, 'g');
      const next = out.replace(re, (_m, arg) => (argc > 1 ? body : body.split('#1').join(arg)));
      if (next !== out) { out = next; changed = true; }
    }
    for (const [k, v] of CUSTOM_MACROS) {
      const re = new RegExp(`\\\\${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z])`, 'g');
      const next = out.replace(re, () => v);
      if (next !== out) { out = next; changed = true; }
    }
    // RAW_MACROS 存的是含带参调用的原串（`\dpal{R\'enyi}`），要排在
    // 带参宏那一轮**之后**、无参那一轮**之前**，这样它展开出来的
    // `\dpal{...}` 能在下一轮被 ARG_MACROS 接住。
    for (const [k, v] of RAW_MACROS) {
      const re = new RegExp(`\\\\${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-zA-Z])`, 'g');
      const next = out.replace(re, () => v);
      if (next !== out) { out = next; changed = true; }
    }
    if (!changed) break;
  }
  return out;
}

/** LaTeX 单元格 → 纯文本。保留 `a / b` 的双值写法，其余符号剥掉。 */
function cleanCell(raw) {
  let s = expandMacros(raw)
    .replace(/\\rowcolor\{[^}]*\}/g, '')
    .replace(/\\cellcolor\{[^}]*\}/g, '')
    // \shortstack{None\\(DFlash)} —— 表头里用它换行写两行，要去掉换行合并成一句。
    // `\shortstack[l]{…}` 的对齐参数必须一起吃，否则整串掉进通用规则，
    // 变成 `3*\shortstack[l]Qwen3-Coder-\\30B-A3B-Instruct`（dscout 的实际形态）。
    .replace(/\\shortstack(?:\[[^\]]*\])?\{([\s\S]*?)\}(?=\s|&|\\|$)/g, (_, body) => body.replace(/\\\\/g, ' '))
    // \textcolor{red}{4.503} —— 排名高亮。漏掉这一步，最后一个通用规则会把它拆成
    // `red` + `{4.503}`，值变成 `red4.503`，按 `4.503` 精确匹配永远查不到。
    .replace(/\\(?:textcolor|colorbox|cellcolor)\{[^{}]*\}/g, '')
    // \rotatebox[origin=c]{90}{Greedy} —— 竖排表头，两个必选参数：角度和文字。
    // 必须在 \multirow 之前剥掉，否则 `\multirow{8}{*}{\rotatebox…}` 里的 `{*}` 和
    // 后面的花括号会互相咬住，分组名变成 `8*otatebox[origin=c]90Greedy`
    // （2026-11-18 ealwtv 的 1004 条事实全挂这串垃圾，根因就是 `\rotate` 被
    // 泛化规则吃掉、只剩 `otatebox`）。
    .replace(/\\rotatebox(?:\[[^\]]*\])?\{[^{}]*\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '$1')
    // `\makecell{...}` / `\thead{...}` 里也可能裹着 \\ 换行，按 shortstack 同样处理
    .replace(/\\makecell\{([\s\S]*?)\}(?=\s|&|\\|$)/g, (_, body) => body.replace(/\\\\/g, ' '))
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
    // \multicolumn 的第三个参数常带嵌套花括号：`{\textbf{Acceptance Length}}`。
    // 用 `[^{}]*` 匹配不到，整串会掉进下面 `\\[a-zA-Z]+\{(...)\}` 的通用规则，
    // 变成 `{c}{\textbf{Acceptance Length}}` 这种残渣，列名跟着坏掉
    // （2026-11-18 ealwtv 的主结果表 bodyRows 变 0 就是这么来的）。
    .replace(/\\multicolumn\{(\d+)\}\{[^{}]*\}\{(?:[^{}]|\{[^{}]*\})*\}/g, (m0, n) => {
      const inner = m0.replace(/^\\multicolumn\{\d+\}\{[^{}]*\}\{/, '').replace(/\}$/, '');
      return inner;
    })
    // \multirow 有两种写法：{n}{width}{text} 和 {n}[fixup]{width}{text}。
    // 漏掉可选参数 `[2]` 会让整串落到下面的通用规则里，变成 `6[2]*T=0`——
    // EAGLE 那张分组表就是这么坏掉的（分组名本该是 `T=0`）。
    .replace(/\\multirow\{(\d+)\}(?:\[[^\]]*\])?\{[^}]*\}\{([^{}]*)\}/g, '$2')
    .replace(/\$?\\pm\$?/g, '±')
    .replace(/\\,/g, ' ')
    .replace(/\\&/g, '&')          // 表头里的「refinement \& injection」是转义的 &
    // 纯排版命令：不承载内容，留着只会进 method / group 名。
    // `\addlinespace[1.5pt]` 是行间距（dpal 的 grouped_results.tex 每段之间都有），
    // `\Xhline`/`\specialrule` 同类；不删的话方法名会变成
    // `\addlinespace[1.5pt] \dpalR'enyi`，站点上原样印出来。
    .replace(/\\(?:addlinespace|specialrule|Xhline|Xcline|hhline|noalign)(?:\[[^\]]*\])?(?:\{[^{}]*\}){0,3}/g, ' ')
    .replace(/\\arraystretch\s*/g, '')
    // 字号/字体切换同样只是排版：`{\fontsize{6}{7}\selectfont Speedup}` 里
    // 真正的内容只有 `Speedup`，`\fontsize{6}{7}` 和 `\selectfont` 都是外壳。
    .replace(/\\fontsize\{[^{}]*\}\{[^{}]*\}/g, '')
    .replace(/\\selectfont/g, '')
    .replace(/\\(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge|bfseries|itshape|ttfamily|sffamily|rmfamily)\b/g, '')
    // 数学符号的文本化：`^\dagger` 是脚注标记，`\dagger` 出现在方法名里时
    // 读者看到的是反斜杠（dscout 的 `PARD-2 (15)^\dagger`）。转成 Unicode。
    .replace(/\^\s*\\dagger/g, '†')
    .replace(/\\dagger/g, '†')
    .replace(/\^\s*\\ddagger/g, '‡')
    .replace(/\\ddagger/g, '‡')
    // 数学定界符 `\(…\)` / `\[…\]` 只是「这里是行内公式」的标记，去掉定界符、
    // 留住内容——angelspec 的分组名 `\(+\) AR head` 就是靠在加号两侧套定界符写的。
    .replace(/\\\(|\\\)|\\\[|\\\]/g, '')
    // TeX 重音转义：`R\'enyi` / `R\'{e}nyi` → `Rényi`。
    // 不处理的话方法名里留着 `R\'enyi`，模型抄进正文和对比表时必然漏反斜杠，
    // 显示成 `\dpalR\'enyi` 这种（2026-11-18 dpal 的 20 条事实）。
    .replace(/\\(['`^"~=.])\{?([A-Za-z])\}?/g, (m, accent, ch) => {
      const map = {
        "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', y: 'ý', c: 'ć', n: 'ń' },
        '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù' },
        '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û' },
        '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü' },
        '~': { a: 'ã', n: 'ñ', o: 'õ' },
      };
      return map[accent]?.[ch] ?? ch;
    })
    // 列名里残留的 `\%`、`$$...$$` 会进 ID，模型复制时必然漏掉反斜杠——
    // ID 必须是「看一眼就能原样打出来」的字符串，否则校验全是假阳性。
    .replace(/\\%/g, '%')
    // 带参数的自定义宏（如 `\dpal{R\'enyi}` → `D-PAL[Rényi]`）在宏加载阶段被跳过了，
    // 到这里还留着反斜杠。按「取最后一个参数」降级成可读文本：
    // `\dpal{X}` → `D-PAL[X]` 需要知道宏体，代价太大；退一步只留参数名，
    // 至少不会让 `\dpalR\'enyi` 这种带反斜杠的串进 fact ID 和读者眼前。
    .replace(/\\([a-zA-Z]+)\s*\{([^{}]*)\}/g, (_m, name, arg) => {
      const slim = arg.replace(/\\([a-zA-Z]+)/g, (x, n) => GREEK[n] ?? n);
      return name ? `${slim}` : slim;
    })
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
    // `\&` 是转义的 &：它是单元格里的普通字符，不是列分隔符。
    // 不判这个的话 `\real{} w/o CE\&RB` 会被切成 `…CE\` 和 `RB`，
    // 反斜杠留在方法名里、整行右移一格（2026-11-18 realloss 的 ce-ablation 表）。
    if (ch === '&' && depth === 0 && cur.endsWith('\\')) {
      cur = `${cur.slice(0, -1)}&`;
      continue;
    }
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
    // 同 splitCells：`\&` 是转义的 &，不是列分隔符
    if (ch === '&' && depth === 0 && cur.endsWith('\\')) {
      cur = `${cur.slice(0, -1)}&`;
      continue;
    }
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


// 列格式外面的花括号里可能套两层：`{l c@{\hspace{4pt}} ccccccccc}` 的最外层
// 包着 `{\hspace{4pt}}`，而后者自己又包着 `{4pt}`。只写一层 `\{[^{}]*\}` 时，
// 最外层匹配失败，引擎从内层 `{` 重新起匹，于是 `l c@` 这段残留下来当成表头第一格，
// 整张表右移一列、第一列（方法名）被当成数据——REAL Loss 主表就是这样把
// `Method` 列读丢、让 `4.740` 变成方法名的。所以按层数写清楚。
const _LV1 = String.raw`\{[^{}]*\}`;
const _LV2 = String.raw`\{(?:[^{}]|` + _LV1 + String.raw`)*\}`;
const TAB_SPEC = String.raw`\{(?:[^{}]|` + _LV2 + String.raw`)*\}`;
// ⚠️ 正则里的 `\s` 只能写一次：用 String.raw 时再写成 `\\s` 就成了「字面反斜杠 + s」，
// 整条正则永远匹配不上（曾经因此让所有表静默消失，facts 变成 0 张表）。
const TABULAR_RE = new RegExp(String.raw`\\begin\{tabular\*?\}(?:` + TAB_SPEC + String.raw`)?(?:` + TAB_SPEC + String.raw`)?([\s\S]*?)\\end\{tabular\*?\}`, 'g');

/**
 * 从一个 LaTeX 片段里抽出所有 tabular，登记成 `tables` 条目。
 *
 * @param env      要扫描的文本（一个 table 环境整体，或一段裸 tabular 所在的原文）
 * @param caption  表标题（裸 tabular 传空串）
 * @param label    默认表名（裸 tabular 传合成名）
 * @param relFile  源文件名，用于兜底命名
 * @param forceLabel  true 时忽略片段里的 \label，一律用传入的 label
 */
function collectTabulars(tablesAcc, env, { caption, label, relFile, forceLabel = false }) {
  let subIndex = 0;
  let lastOwnLabel = null;
  for (const t of env.matchAll(TABULAR_RE)) {
    // 同一 table 环境里可能并排放两张**不同的**表（各带自己的 \label，如
    // tab:smoothing + tab:targets）。表名必须取这张 tabular **之前**最近的 \label，
    // 取环境里第一个 \label 会把后一张表也挂到前一张的名字上。
    const before = env.slice(0, t.index);
    const ownLabel = forceLabel
      ? label
      : ([...before.matchAll(/\\label\{([^}]+)\}/g)].at(-1)?.[1] ?? label);
    // 把各种规则线都当分隔符，包括 \cmidrule —— 论文用它分隔同一个 table 里的
    // 不同模型组（`Qwen3-8B` / `Qwen3-4B`）。漏掉它，两个模型组的行会被归到同一段，
    // 组名只能从「第 0 列非空的那一行」往后生效，前面几行就丢了组名。
    const raw = t[1]
      .replace(/\\cmidrule(\([^)]*\))?\{[^}]*\}/g, '\n@@RULE@@\n')
      .replace(/\\toprule|\\midrule|\\bottomrule|\\hline/g, '\n@@RULE@@\n');
    // 规则线把表切成若干段。去掉空段（\toprule 前面、\bottomrule 后面都是空的），
    // 剩下的：前面若干段是表头（可能双层），其余全部是数据。
    const segments = raw.split('\n@@RULE@@\n').filter((s) => cleanCell(s) !== '');
    if (segments.length < 2) continue;   // 只有表头没有数据
    let start = 0;
    const firstRow = splitRows(segments[0])[0] ?? '';
    if (splitCells(firstRow).length <= 1 && !segments[0].includes('&')) start = 1;
    if (segments.length - start < 2) continue;
    // 表头：从 start 起，把所有「不含纯数值格」的段都算表头。
    // 判据必须看拆完单元格后的整格，不能看「含不含数字」——基准名 `MATH-500`、
    // `MT-Bench` 都含数字，用「含数字」会让第二行表头被当成数据，
    // 列名就只剩 `Math` 而不是 `Math / GSM8K`。
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
    // 只有「同一 env 里并排多张 tabular」才需要 #2 后缀；换了 label 就重新计数
    if (ownLabel !== lastOwnLabel) { subIndex = 0; lastOwnLabel = ownLabel; }
    subIndex += 1;
    const tableLabel = subIndex > 1 ? `${ownLabel || relFile}#${subIndex}` : ownLabel;
    tablesAcc.push({ file: relFile, caption, label: tableLabel, columns, bodyRows, bodyGroups });
  }
}

const tables = [];
const srcDir = String(args.src ?? '/tmp');
if (!existsSync(srcDir)) {
  console.error(`✗ 找不到 LaTeX 源目录：${srcDir}`);
  console.error('  先跑 `npm run fetch:pdf` 之后解包 e-print，或用 --src=<目录> 指定。');
  process.exit(1);
}
loadCustomMacros(srcDir);
// 备份稿必须排除：e-print 里常带 main_backup.tex / main_old.tex，里面的表与正式稿
// 同 label 但数值不同。两套都进来时，verify-numbers 会给出互相矛盾的候选格，
// 稿子取哪个都可能「有出处」，反而查不出真错。
const isBackup = (f) => /(?:^|[\\/])(?:main_)?(?:backup|bak|old|copy|v\d+)(?:[_-]|\.[^/]*$)/i.test(relative(srcDir, f));

for (const file of texFiles(srcDir)) {
  if (isBackup(file)) continue;
  // 展开 \input：表格环境常常横跨 `\begin{table}`（主文件）与片段（\input 进来）
  const text = inlineInputs(file);
  const relFile = relative(srcDir, file);
  // 去掉 LaTeX 注释再找表格。作者常把旧版本整段注释掉（e-print 里留下三份
  // 同 label 的 `% \begin{tabular}`），不剥注释会把废弃表也当有效数据，
  // 于是同一个数字有多个互相矛盾的「出处」。
  const textNoComment = text.replace(/(?<!\\)%.*$/gm, '');
  // 逐个 table 环境
  // 表格环境不止 table：wraptable（被文字环绕的窄表）、sidewaystable、longtable
  // 都是正常表格。只认 `table` 会把整张表静默丢掉——D-PACE 的块大小扫描（tab:block-size）、
  // 目标概率对照（tab:target）、训练耗时（tab:training-time）三张都是 wraptable，
  // 结果「表里有、事实表里没有」，写稿引用这三个数字时 verify:numbers 全报无出处。
  // ⚠️ 这里必须写 `\\begin`：正则字面量里的 `\b` 是**词边界**，
  // `\begin\{` 会被解释成「词边界 + egin{」，永远匹配不到 `\begin{`。
  // 2026-11-18 就是这么把 realloss 的表全丢了的（0 张表，且不报错）。
  for (const m of textNoComment.matchAll(/\\begin\{(table\*?|wraptable\*?|sidewaystable\*?|longtable)\}([\s\S]*?)\\end\{\1\}/g)) {
    const env = m[2];
    const caption = cleanCell(env.match(/\\caption\{([\s\S]*?)\}(?=\s*\\label|\s*\n)/)?.[1] ?? '');
    const label = env.match(/\\label\{([^}]+)\}/)?.[1] ?? '';
    collectTabulars(tables, env, { caption, label, relFile });
  }
  // 第二遍：不在任何 table 环境里的裸 tabular。
  // 论文常用 `\begin{center}\begin{tabular}...` 放一张小表（不写 caption、不写 label），
  // 只扫 table 环境就会把它整张漏掉——BV Loss 附录 B.2 的两位置反例表
  // （`BV E[tau] 1.73 / 1.79`）就是这样丢的。
  {
    const covered = [...textNoComment.matchAll(/\\begin\{(?:table\*?|wraptable\*?|sidewaystable\*?|longtable)\}[\s\S]*?\\end\{(?:table\*?|wraptable\*?|sidewaystable\*?|longtable)\}/g)]
      .map((x) => [x.index, x.index + x[0].length]);
    let inlineIdx = 0;
    for (const t of textNoComment.matchAll(TABULAR_RE)) {
      if (covered.some(([a, b]) => t.index >= a && t.index < b)) continue;
      inlineIdx += 1;
      const before = textNoComment.slice(0, t.index);
      const label = [...before.matchAll(/\\label\{([^}]+)\}/g)].at(-1)?.[1] ?? `${relFile}#inline${inlineIdx}`;
      collectTabulars(tables, textNoComment.slice(t.index, t.index + t[0].length), { caption: '', label, relFile, forceLabel: true });
    }
  }
}

// ---- 展开成事实条目 ----
// 展开 \input 之后，同一张表可能被抓到两次：一次来自主文件（`\input` 已被内联），
// 一次来自片段文件本身（它也在 texFiles 里）。按「label + 列名」去重，保留先出现的那份，
// 否则事实条目翻倍，verify-numbers 会给出两套互相冲突的候选。
//
// 2026-11-18 补了**按内容**去重：表格片段文件（tables_xxx.tex）里往往只有一个裸
// tabular，被 \input 进主文件后 label 是 `tab:xxx`，而它自己那趟扫描拿到的是
// `tables_xxx.tex#inline1`——label 不同，只按 label 去重就漏了，REAL Loss 因此
// 从 15 张表涨到 33 张，同一格的数字有两份来源，verify:numbers 的候选全是重复的。
{
  const seenTable = new Set();
  // 有名表的内容指纹先收齐，再回头删无名副本。不能边扫边判：
  // 无名副本（tables_xxx.tex#inline1）在文件顺序上常常**早于**有名表，
  // 边扫边判会先收进副本、后到的有名表反而被判「label 不同」留下来，两张都在。
  const namedContent = new Set();
  for (const t of tables) {
    if (!/#inline\d+$/.test(String(t.label ?? ''))) {
      namedContent.add(`${(t.columns ?? []).join('|')}\n${(t.bodyRows ?? []).join('\n')}`);
    }
  }
  for (let i = tables.length - 1; i >= 0; i -= 1) {
    const t = tables[i];
    const key = `${t.label}::${(t.columns ?? []).join('|')}`;
    const content = `${(t.columns ?? []).join('|')}\n${(t.bodyRows ?? []).join('\n')}`;
    const isInline = /#inline\d+$/.test(String(t.label ?? ''));
    // 1) 同名同列：只留一份。
    // 2) 裸 tabular 那趟产生的是「无名副本」：内容已被有名表登记过就丢掉。
    if (seenTable.has(key) || (isInline && namedContent.has(content))) {
      tables.splice(i, 1);
      continue;
    }
    seenTable.add(key);
  }
}

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
    // 分组名同样要过 cleanCell：`\multirow{8}{*}{\rotatebox…{Greedy}}` 不洗就会
    // 让分组名带着 LaTeX 残渣进 fact ID（`8*otatebox[origin=c]90Greedy`）。
    // 以前这里直接用 splitCells 的原始输出，是 cleanCell 覆盖不到的一个口子。
    .map((rows) => rows.map((r) => splitCells(r).map((c) => cleanCell(c)))
      .filter((c) => !c.every((x) => !x || /^[+\-=—]+$/.test(x))))
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
          // 「4.428 (0.002)」这种「均值（标准差）」也要拆：整串当一个值的话，
          // verify:numbers 按 `4.428` 查表永远查不到，一篇稿子几十个数被判无出处。
          parts: (value.includes('/') ? value.split('/') : [value])
            .flatMap((v) => {
              const t = v.trim();
              const m = t.match(/^([−+\-]?\d[\d,]*\.?\d*)\s*[(（]([^)）]+)[)）]$/);
              return m ? [m[1].replace(/,/g, ''), ...m[2].split(/[\s,，]+/).filter((x) => /\d/.test(x))] : [t];
            })
            .filter(Boolean),
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
