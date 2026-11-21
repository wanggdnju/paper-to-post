/**
 * 论文的两个「派生区块」：本站绘制的机制图 + 横向对比。
 *
 * 数据源是两个独立脚本的产物：
 *   articles/<slug>/diagram.json + assets/fig-<slug>-diagram.png   ← npm run diagram
 *   articles/<slug>/compare.json                                   ← npm run compare
 *
 * 为什么做成共享模块、在**渲染期**拼接，而不是写进 article.md：
 *   两者都是派生产物，重跑脚本就会变。写进手稿等于把生成结果固化——下次重跑要么
 *   覆盖人工改动，要么新旧并存。2026-11-13 之前它们只出现在个人站；
 *   用户要求「三个平台都要有」，于是抽成一份数据、按平台能力渲染三种形态。
 *
 * 三者的差别是**排版能力**，不是内容：
 *   wide    H5 / 个人站：五列矩阵表放得下，数字表给全列；
 *   narrow  知乎（正文约 690px）：五列会挤成一团，机制维度改成「维度 + 各方一句」；
 *   wechat  公众号（约 343px）：只能用窄表，数字表只留 Speedup / τ。
 *
 * 图一律标「本站绘制」：原文插图是论文的证据，本站画的是对论文的理解，
 * 混在一起读者会以为是作者画的。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadExtras(root, slug) {
  const dir = join(root, 'articles', slug);
  const out = { diagram: null, compare: null };
  const png = join(dir, 'assets', `fig-${slug}-diagram.png`);
  const specPath = join(dir, 'diagram.json');
  if (existsSync(png) && existsSync(specPath)) {
    try { out.diagram = { png, spec: JSON.parse(readFileSync(specPath, 'utf8')) }; } catch { /* 坏了就当没有 */ }
  }
  const cmpPath = join(dir, 'compare.json');
  if (existsSync(cmpPath)) {
    try {
      const data = JSON.parse(readFileSync(cmpPath, 'utf8'));
      if (data.numeric?.length || data.dimensions?.length) out.compare = data;
    } catch { /* 同上 */ }
  }
  return out;
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * compare.json 里残留的 LaTeX 表头碎片 → 可读文本。
 *
 * 这些是从论文表格里抠出来的，`facts.mjs` 的 cleanCell 已经清过一轮，但
 * 它只覆盖自己认识的宏；遇到少见的（`\makebox`、`\shortstack[l]`、被拆坏的
 * `\textnormalotatebox`）仍旧漏网，最后原样印在读者面前：
 *   `Math / \makebox[0pt]GSM8K`   `3*\shortstack[l]Qwen3-Coder-\\30B-A3B-Instruct`
 * （2026-11-18 扫 dist 时在 bvloss / dpal / dscout / ealwtv 里各抓到几十到几百处。）
 *
 * 只清**没有 `$` 包裹**的部分：`$…$` 是作者写的公式，该由渲染器变成公式卡，
 * 不能在这里被抹掉。所以先把 `$…$` 段摘出来，清完再放回去。
 */
function scrubTexJunk(s) {
  const held = [];
  const keep = (x) => `\u0002${held.push(x) - 1}\u0002`;
  let t = String(s ?? '').replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (m) => keep(m));
  t = t
    .replace(/\\makebox\s*\[[^\]]*\]\s*/g, '')
    .replace(/\\shortstack\s*(\[[^\]]*\])?\s*/g, '')
    .replace(/\\rotatebox\s*(\[[^\]]*\])?\s*\{[^{}]*\}\s*/g, '')
    // `\rotatebox` 被上游拆坏后可能是 `\textnormalotatebox[origin=c]{90}`：
    // 必须整串吃掉。单删 `\textnormal` 会剩 `otatebox[origin=c]90`，
    // 再被兜底规则留成 `otatebox90…`（2026-11-18 ealwtv 实测）。
    .replace(/\\textnormal\s*otatebox\s*(\[[^\]]*\])?\s*\{[^{}]*\}\s*/g, '')
    .replace(/\\times\b/g, '×')
    .replace(/\\dagger\b/g, '†')
    .replace(/\\Pr\b/g, 'Pr')
    .replace(/\\ge\b/g, '≥').replace(/\\le\b/g, '≤')
    .replace(/\\in\b/g, '∈')
    .replace(/\\[a-zA-Z]+\s*(\[[^\]]*\])?\s*/g, '')  // 兜底：其余命令名整体删掉
    .replace(/\\\\/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t.replace(/\u0002(\d+)\u0002/g, (_m, i) => held[Number(i)]);
}

/** 文本字段：先清 LaTeX 碎片再转义。compare.json 的表头残留（`\makebox`、
 *  `\shortstack[l]`、被拆坏的 `\textnormalotatebox`）不处理就会原样印给读者。 */
const T = (v) => esc(scrubTexJunk(v));

/** 平台字体大小下限：公众号靠调用方传 FS，其它地方用默认 */
const cap = (txt, small) => `<span style="font-size:${small}px;line-height:1.7;color:#8a8376;">${txt}</span>`;

function diagramCaptionHtml(spec) {
  const cols = (spec.columns ?? []).map((c) => c.label).filter(Boolean);
  // 不重复 spec.footer：那句话已经画在 PNG 底边上了，图注再说一遍是同句话出现两遍。
  return `<strong>本站绘制的机制图</strong>${spec.title ? `：${esc(spec.title)}` : ''}。`
    + (cols.length ? `从左到右是${cols.map((c) => esc(c)).join(' → ')}。` : '')
    + '<br>这不是论文原图——原图见正文方法一节。这张是读过方法后的重新组织，用来先看懂数据怎么流动，细节仍以论文为准。';
}

const baselineLines = (cmp) => (cmp.baselines ?? []).map((b) => ({
  name: b.name,
  // lineage 本身可能已经带括注（「同一路线（从目标模型内部榨草稿）」），
  // 再包一层就出现嵌套括号。已经有括注就原样输出。
  lineage: b.lineage ?? '',
  text: [b.mechanism, b.cost ? `代价：${b.cost}` : ''].filter(Boolean).join('　'),
}));

/**
 * lineage 显示。
 * 名字或 lineage 本身已经带括注时（「投机采样（小模型草稿）」+「经典基线」），
 * 再包一层括号会变成 `（…）（…）` 两个括号连着，读起来像笔误；这种情况下用间隔点。
 */
const lineageText = (l, name = '') => {
  if (!l) return '';
  return /[（(]/.test(l) || /[（(]/.test(name) ? `　· ${l}` : `（${l}）`;
};

/** 数字表里挑窄屏能放的列：优先 Speedup / τ，没有就取前两列 */
function narrowColumns(group) {
  const want = (group.columns ?? []).filter((c) => /speedup|τ/i.test(c));
  return want.length ? want : (group.columns ?? []).slice(0, 2);
}

function matrixHtml(cmp, { tag = 'table' } = {}) {
  const names = (cmp.baselines ?? []).map((b) => b.name);
  if (!names.length || !(cmp.dimensions ?? []).length) return '';
  const head = `<tr><th>维度</th><th>${T(cmp.self || '本工作')}</th>${names.map((n) => `<th>${T(n)}</th>`).join('')}</tr>`;
  const rows = cmp.dimensions.map((d) => `<tr><th>${T(d.name)}</th><td>${T(d.ours)}</td>${
    names.map((n) => `<td>${T(d.values[n] ?? '—')}</td>`).join('')}</tr>`).join('');
  void tag;
  return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/**
 * 正文里已经有同一份主结果表时，compare.json 的数字表不要再印一遍。
 *
 * 2026-11-18 用户把 DSpark 的主结果图换成自绘表格（按任务族拆成三张 5 列表），
 * 之后每个平台都把这个对比表重印了一次：知乎上是四张只剩两列的残表，
 * 站点上更糟——四张 13 列的表和正文一字不差，读者要滚两遍。
 *
 * 判据：数值表的列有 ≥80% 能在正文某个 Markdown 表头里找到。
 * compare.json 的列名会带任务前缀（`Math / GSM8K`），所以只比斜杠后的部分。
 */
function coveredByBodyGroups(compare, articleMd) {
  const groups = (compare.numeric ?? []).flatMap((t) => (t.groups ?? []).map((g) => g));
  const bodyTables = articleMd
    ? [...articleMd.matchAll(/^\|(.+)\|$/gm)].map((m) => m[1].split('|').map((c) => c.trim()))
    : [];
  const covered = (g) => {
    const cols = (g.columns ?? []).filter(Boolean);
    if (!cols.length || !bodyTables.length) return false;
    const hit = cols.filter((c) => bodyTables.some((row) => row.some((cell) => cell === c || cell.includes(c.split('/').pop().trim()))));
    return hit.length / cols.length >= 0.8;
  };
  return groups.filter((g) => (g.rows ?? []).length && !covered(g));
}

/**
 * 宽屏（H5 / 个人站）。
 * @param {{diagramHref:string, diagramAlt?:string, articleMd?:string}} opts
 */
export function renderExtrasWide(extras, opts = {}) {
  const out = [];
  if (extras.diagram && opts.diagramHref) {
    out.push(`<figure class="paper-fig owned">
<img src="${esc(opts.diagramHref)}" alt="${esc(opts.diagramAlt ?? extras.diagram.spec.title ?? '机制结构图')}">
<figcaption>${diagramCaptionHtml(extras.diagram.spec)}</figcaption>
</figure>`);
  }
  const cmp = extras.compare;
  if (!cmp) return out.join('\n');

  const keptWide = coveredByBodyGroups(cmp, opts.articleMd);
  out.push('<section class="cmp">', '<h2>横向对比</h2>',
    keptWide.length
      ? '<p class="cmp-intro">下面回答同一个问题的两面：<strong>机制上差在哪</strong>（可区分的设计选择），和<strong>结果上差多少</strong>（论文原始数字，逐格可核对）。</p>'
      : '<p class="cmp-intro">下面这张表回答一个问题：<strong>机制上差在哪</strong>——同一张设计图上的不同选择。结果数字见正文的主结果表。</p>');

  const lines = baselineLines(cmp);
  if (lines.length) {
    out.push('<h3>对比对象</h3>', `<ul>${lines.map((b) => `<li><strong>${T(b.name)}</strong>${T(lineageText(b.lineage, b.name))}　${T(b.text)}</li>`).join('')}</ul>`);
  }
  const m = matrixHtml(cmp);
  if (m) {
    // 同一份维度数据输出两套标记，靠 CSS 在 900px 处切换：
    // 手机（390px）上五列表横滑只能看到一列，而且维度名本身就占满屏宽，
    // 所以窄屏改用「维度当小标题、各方各占一行」的段落版——和知乎/公众号同一形态。
    const names = (cmp.baselines ?? []).map((b) => b.name);
    const narrow = cmp.dimensions.map((d) => `<p class="cmp-dimname">${T(d.name)}</p>`
      + `<p class="cmp-dimval">${[['本工作', d.ours], ...names.map((n) => [n, d.values[n] ?? '—'])]
        .map(([k, v]) => `<strong>${T(k)}</strong>：${T(v)}`).join('<br>')}</p>`).join('');
    out.push('<h3>机制差在哪</h3>',
      '<p class="cmp-hint cmp-hint-wide">表格可左右滑动，右侧还有其它对比对象。</p>',
      `<div class="cmp-scroll">${m.replace('<table>', '<table class="cmp-matrix">')}</div>`,
      `<div class="cmp-narrow">${narrow}</div>`);
  }

  // 只印正文没覆盖的组（2026-11-18：正文改成自绘表后这里会整段重复）。
  const keptNames = new Set(keptWide.map((g) => g.name ?? '—'));
  const numeric = (cmp.numeric ?? []).map((t) => {
    const groups = (t.groups ?? []).filter((g) => keptNames.has(g.name ?? '—')).map((g) => {
      const head = (g.columns ?? []).map((c) => `<th>${T(c)}</th>`).join('');
      const body = (g.rows ?? []).map((r) => `<tr${r.ours ? ' class="ours"' : ''}><th>${T(r.method)}</th>${
        (r.values ?? []).map((v) => `<td>${T(v)}</td>`).join('')}</tr>`).join('');
      return `<div class="cmp-group">${g.name && g.name !== '—' ? `<div class="cmp-group-name">${T(g.name)}</div>` : ''}
<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
    }).join('');
    if (!groups) return '';
    return `<div class="cmp-block"><div class="cmp-caption">${T(String(t.caption ?? '').replace(/\\tau/g, 'τ').replace(/\$/g, ''))}</div>${groups}</div>`;
  }).join('');
  if (numeric) out.push('<h3>结果差多少</h3>', '<p class="cmp-hint">表格可左右滑动。</p>', numeric);
  if ((cmp.takeaways ?? []).length) {
    out.push('<h3>判断</h3>', `<ol>${cmp.takeaways.map((t) => `<li>${T(t)}</li>`).join('')}</ol>`);
  }
  out.push(`<p class="cmp-note">数字来自 <code>facts.json</code>；机制维度由模型从论文抽取，每条都经过「出处句必须逐字出现在原文」的校验（本次剔除 ${cmp.dropped?.length ?? 0} 条）。</p>`, '</section>');
  return out.join('\n');
}

/**
 * 窄屏（知乎 / 公众号）。
 * @param {{imgTag?:string, small?:number}} opts imgTag 由调用方给出（含平台自己的图片样式）
 */
export function renderExtrasNarrow(extras, opts = {}) {
  const small = opts.small ?? 13;
  // 文本字段的格式化函数。默认只转义；知乎会传自己的 inline()，把
  // `$...$` 落成行内公式卡——compare.json 的 ours/values 是模型写的，
  // 里面带 `B_k`、`c_k^*` 这类公式，不处理就会印成纯文本（2026-11-17 用户反馈）。
  const F = opts.format ?? esc;
  const out = [];
  if (extras.diagram && opts.imgTag) {
    out.push(opts.imgTag, `<p>${cap(diagramCaptionHtml(extras.diagram.spec), small)}</p>`);
  }
  const cmp = extras.compare;
  if (!cmp) return out.join('\n');

  const groups = (cmp.numeric ?? []).flatMap((t) => (t.groups ?? []).map((g) => g));
  // 正文里已经有同一张主结果表时不要再印一遍。
  // 2026-11-18 用户把主结果改成自绘表格后，这里会在正文表之后再出现四张只含
  // 「GSM8K / MATH 两列」的残表——列被 narrowColumns 砍掉后既不全也重复。
  // 判据：数值表的列有 ≥80% 能在正文某个 Markdown 表头里找到。
  const bodyTables = opts.articleMd
    ? [...opts.articleMd.matchAll(/^\|(.+)\|$/gm)].map((m) => m[1].split('|').map((c) => c.trim()))
    : [];
  const coveredByBody = (g) => {
    const cols = (g.columns ?? []).filter(Boolean);
    if (!cols.length || !bodyTables.length) return false;
    const hit = cols.filter((c) => bodyTables.some((row) => row.some((cell) => cell === c || cell.includes(c.split('/').pop().trim()))));
    return hit.length / cols.length >= 0.8;
  };
  const keptGroups = groups.filter((g) => (g.rows ?? []).length && !coveredByBody(g));

  // 用 h2 起头会挤进正文目录；这里用加粗段落 + 分隔线，平台表现更稳。
  // 导语只在确实会印「结果差多少」时才提这一面。判据必须和下面印表的判据一致（keptGroups），
  // 不能只看 numeric 里有没有行——正文已有主结果表时那些行会被跳过，导语就成了空承诺（2026-11-18）。
  out.push('<h2>横向对比</h2>',
    keptGroups.length
      ? '<p>下面回答同一个问题的两面：<strong>机制上差在哪</strong>（可区分的设计选择），和<strong>结果上差多少</strong>（论文原始数字）。</p>'
      : '<p>下面这张表回答一个问题：<strong>机制上差在哪</strong>——同一张设计图上的不同选择。</p>');

  const lines = baselineLines(cmp);
  if (lines.length) {
    out.push('<h3>对比对象</h3>');
    out.push(`<ul>${lines.map((b) => `<li><strong>${F(scrubTexJunk(b.name))}</strong>${F(scrubTexJunk(lineageText(b.lineage, b.name)))}　${F(scrubTexJunk(b.text))}</li>`).join('')}</ul>`);
  }

  const names = (cmp.baselines ?? []).map((b) => b.name);
  if (names.length && (cmp.dimensions ?? []).length) {
    out.push('<h3>机制差在哪</h3>');
    if (opts.matrixTable) {
      // 表格形态：一个维度一行、一个方法一列，读者横向扫一眼就能看出差异。
      // 之前是「维度当小标题、各方各占一行」的段落式，读起来是几段连续文字，
      // 同一个维度里谁对谁完全靠记位置（2026-11-18 用户反馈「不直观」）。
      //
      // 公众号一开始没走这条路径，理由是「正文 343px 放不下四列」。2026-11-18 实测
      // 在 375px 宽下渲染：每列约 80px、单元格折 4–6 行，**完全可读**，
      // 比段落式省一半高度。所以现在三个平台统一用表格。
      // 单元格**不用**调用方的 format：知乎的 format 会产出公式卡
      // `<span class="ztext-math">`，而 Draft.js 粘贴表格时会把单元格里的这类节点
      // 压平成纯文本——卡片丢了、`data-tex` 的纯文本内容留下来，看起来还行但
      // 公式数量对不上（2026-11-18 实测少了 2 个）。表格里用可读纯文本，
      // 正文段落才走公式卡。
      const self = esc(cmp.self || '本工作');
      // 表格单元格用 plainFormat（可读纯文本），不用 F（公式卡）——原因见上。
      const P = opts.plainFormat ?? T;
      const head = `<tr><th>维度</th><th>${self}</th>${names.map((n) => `<th>${P(n)}</th>`).join('')}</tr>`;
      const body = cmp.dimensions.map((d) => `<tr><th>${P(d.name)}</th><td>${P(d.ours)}</td>${
        names.map((n) => `<td>${P(d.values[n] ?? '—')}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead>${head}</thead><tbody>${body}</tbody></table>`);
    } else {
      for (const d of cmp.dimensions) {
        // 窄屏（公众号 ~343px）四列每格只剩几十像素，中文一折五六行，比列表更难读：
        // 改成「维度当小标题，各方各占一行」。
        const rows = [`<strong>本工作</strong>：${F(scrubTexJunk(d.ours))}`, ...names.map((n) => `<strong>${F(scrubTexJunk(n))}</strong>：${F(scrubTexJunk(d.values[n] ?? '—'))}`)];
        out.push(`<p><strong>${F(scrubTexJunk(d.name))}</strong><br>${rows.join('<br>')}</p>`);
      }
    }
  }

  if (keptGroups.length) {
    out.push('<h3>结果差多少</h3>');
    for (const g of keptGroups) {
      const cols = narrowColumns(g);
      const idx = cols.map((c) => (g.columns ?? []).indexOf(c));
      const head = `<tr><th></th>${cols.map((c) => `<th>${F(scrubTexJunk(c))}</th>`).join('')}</tr>`;
      const body = g.rows.map((r) => `<tr><th>${F(scrubTexJunk(r.method))}</th>${idx.map((k) => `<td>${F(scrubTexJunk(r.values[k] ?? '—'))}</td>`).join('')}</tr>`).join('');
      out.push(`<p>${cap(F(scrubTexJunk(g.name === '—' ? '' : g.name)), small)}</p>`, `<table><thead>${head}</thead><tbody>${body}</tbody></table>`);
    }
    out.push(`<p>${cap('这里只放 Speedup 与 τ 两列；完整逐格数字见个人站的同名文章。', small)}</p>`);
  }
  if ((cmp.takeaways ?? []).length) {
    out.push('<h3>判断</h3>', `<ol>${cmp.takeaways.map((t) => `<li>${F(scrubTexJunk(t))}</li>`).join('')}</ol>`);
  }
  return out.join('\n');
}

/**
 * Markdown 版（小红书切图）。
 *
 * 小红书是「390px 宽的手机网页逐屏截图」，五列矩阵在 8px 字号下也读不出来，
 * 所以只用窄屏那套「维度 + 各方一句」。数字表不搬——正文里的主结果表已经够了，
 * 18 屏的上限也经不起再塞三张表。
 *
 * @param {{imgSrc:string, imgAlt?:string}} opts imgSrc 相对稿子目录的图片路径
 */
export function renderExtrasMarkdown(extras, opts = {}) {
  const out = [];
  const spec = extras.diagram?.spec;
  if (extras.diagram && opts.imgSrc) {
    // 图注走 alt（切图脚本会把 alt 变成 .figcap）。**不要另起一段说明**：
    // 图和图注是一个分页单元，说明是下一块，会被挤到下一屏开头，
    // 读者在新一屏先看到「这张不是论文原图…」而没有图（2026-11-13 实测）。
    // 「本站重绘」直接写进图注里，一句话说完。
    out.push('## 机制图', '');
    const alt = opts.imgAlt ?? `机制图 · ${spec?.title ?? ''}（本站重绘，非论文原图）`;
    out.push(`![${alt}](${opts.imgSrc})`, '');
  }
  const cmp = extras.compare;
  if (!cmp) return out.join('\n');

  // 标题把「机制差在哪 / 结果差多少」这两面直接写进去，不再单独一句导语：
  // 导语会单独占一块，分页时标题+导语留在上一屏、列表翻到下一屏，
  // 读者看到的是一屏没有主语的条目（2026-11-13 实测）。
  out.push('## 横向对比：机制差在哪，结果差多少', '');
  for (const b of baselineLines(cmp)) {
    out.push(`- **${b.name}**${lineageText(b.lineage, b.name)}　${b.text}`);
  }
  out.push('');
  // 机制维度**不搬**到小红书。它是「一个维度 × 五个方法」的对照，
  // 在 390px 逐屏截图里必然被分页从中间切开——维度名在一屏、取值在下一屏，
  // 读者读到的是没有主语的半句话（2026-11-13 实测，试过整段、拆行、绑定首行三种排版都不行）。
  // 小红书只保留「对比对象是谁」和「结论」，机制细节指向正文与个人站。
  if ((cmp.dimensions ?? []).length) {
    // 一句话说完，不要拆成两段：拆开后分页正好切在中间，
    // 末屏只剩「它在手机上要横向对照才能读」这种没有主语的半句。
    out.push(`逐维度的机制对照（${cmp.dimensions.length} 个）见个人站同名文章。`, '');
  }
  if ((cmp.takeaways ?? []).length) {
    out.push('### 判断', '');
    cmp.takeaways.forEach((t, i) => out.push(`${i + 1}. ${t}`));
    out.push('');
  }
  out.push('逐格结果数字（Speedup / τ / α）见正文主结果表与个人站同名文章。', '');
  return out.join('\n');
}
