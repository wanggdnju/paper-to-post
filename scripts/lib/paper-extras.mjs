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
  const head = `<tr><th>维度</th><th>${esc(cmp.self || '本工作')}</th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr>`;
  const rows = cmp.dimensions.map((d) => `<tr><th>${esc(d.name)}</th><td>${esc(d.ours)}</td>${
    names.map((n) => `<td>${esc(d.values[n] ?? '—')}</td>`).join('')}</tr>`).join('');
  void tag;
  return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

/**
 * 宽屏（H5 / 个人站）。
 * @param {{diagramHref:string, diagramAlt?:string}} opts
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

  out.push('<section class="cmp">', '<h2>横向对比</h2>',
    '<p class="cmp-intro">下面回答同一个问题的两面：<strong>机制上差在哪</strong>（可区分的设计选择），和<strong>结果上差多少</strong>（论文原始数字，逐格可核对）。</p>');

  const lines = baselineLines(cmp);
  if (lines.length) {
    out.push('<h3>对比对象</h3>', `<ul>${lines.map((b) => `<li><strong>${esc(b.name)}</strong>${esc(lineageText(b.lineage, b.name))}　${esc(b.text)}</li>`).join('')}</ul>`);
  }
  const m = matrixHtml(cmp);
  if (m) {
    // 同一份维度数据输出两套标记，靠 CSS 在 900px 处切换：
    // 手机（390px）上五列表横滑只能看到一列，而且维度名本身就占满屏宽，
    // 所以窄屏改用「维度当小标题、各方各占一行」的段落版——和知乎/公众号同一形态。
    const names = (cmp.baselines ?? []).map((b) => b.name);
    const narrow = cmp.dimensions.map((d) => `<p class="cmp-dimname">${esc(d.name)}</p>`
      + `<p class="cmp-dimval">${[['本工作', d.ours], ...names.map((n) => [n, d.values[n] ?? '—'])]
        .map(([k, v]) => `<strong>${esc(k)}</strong>：${esc(v)}`).join('<br>')}</p>`).join('');
    out.push('<h3>机制差在哪</h3>',
      '<p class="cmp-hint cmp-hint-wide">表格可左右滑动，右侧还有其它对比对象。</p>',
      `<div class="cmp-scroll">${m.replace('<table>', '<table class="cmp-matrix">')}</div>`,
      `<div class="cmp-narrow">${narrow}</div>`);
  }

  const numeric = (cmp.numeric ?? []).map((t) => {
    const groups = (t.groups ?? []).map((g) => {
      const head = (g.columns ?? []).map((c) => `<th>${esc(c)}</th>`).join('');
      const body = (g.rows ?? []).map((r) => `<tr${r.ours ? ' class="ours"' : ''}><th>${esc(r.method)}</th>${
        (r.values ?? []).map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('');
      return `<div class="cmp-group">${g.name && g.name !== '—' ? `<div class="cmp-group-name">${esc(g.name)}</div>` : ''}
<div class="cmp-scroll"><table class="cmp-table"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table></div></div>`;
    }).join('');
    return `<div class="cmp-block"><div class="cmp-caption">${esc(String(t.caption ?? '').replace(/\\tau/g, 'τ').replace(/\$/g, ''))}</div>${groups}</div>`;
  }).join('');
  if (numeric) out.push('<h3>结果差多少</h3>', '<p class="cmp-hint">表格可左右滑动。</p>', numeric);
  if ((cmp.takeaways ?? []).length) {
    out.push('<h3>判断</h3>', `<ol>${cmp.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`);
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
  const out = [];
  if (extras.diagram && opts.imgTag) {
    out.push(opts.imgTag, `<p>${cap(diagramCaptionHtml(extras.diagram.spec), small)}</p>`);
  }
  const cmp = extras.compare;
  if (!cmp) return out.join('\n');

  // 用 h2 起头会挤进正文目录；这里用加粗段落 + 分隔线，平台表现更稳。
  out.push('<h2>横向对比</h2>',
    '<p>下面回答同一个问题的两面：<strong>机制上差在哪</strong>（可区分的设计选择），和<strong>结果上差多少</strong>（论文原始数字）。</p>');

  const lines = baselineLines(cmp);
  if (lines.length) {
    out.push('<h3>对比对象</h3>');
    out.push(`<ul>${lines.map((b) => `<li><strong>${esc(b.name)}</strong>${esc(lineageText(b.lineage, b.name))}　${esc(b.text)}</li>`).join('')}</ul>`);
  }

  const names = (cmp.baselines ?? []).map((b) => b.name);
  if (names.length && (cmp.dimensions ?? []).length) {
    out.push('<h3>机制差在哪</h3>');
    for (const d of cmp.dimensions) {
      // 五列表在窄屏每格只剩一百来像素，中文一折三四行，比列表更难读：
      // 改成「维度当小标题，各方各占一行」。
      const rows = [`<strong>本工作</strong>：${esc(d.ours)}`, ...names.map((n) => `<strong>${esc(n)}</strong>：${esc(d.values[n] ?? '—')}`)];
      out.push(`<p><strong>${esc(d.name)}</strong><br>${rows.join('<br>')}</p>`);
    }
  }

  const groups = (cmp.numeric ?? []).flatMap((t) => (t.groups ?? []).map((g) => g));
  if (groups.some((g) => (g.rows ?? []).length)) {
    out.push('<h3>结果差多少</h3>');
    for (const g of groups) {
      if (!(g.rows ?? []).length) continue;
      const cols = narrowColumns(g);
      const idx = cols.map((c) => (g.columns ?? []).indexOf(c));
      const head = `<tr><th></th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`;
      const body = g.rows.map((r) => `<tr><th>${esc(r.method)}</th>${idx.map((k) => `<td>${esc(r.values[k] ?? '—')}</td>`).join('')}</tr>`).join('');
      out.push(`<p>${cap(esc(g.name === '—' ? '' : g.name), small)}</p>`, `<table><thead>${head}</thead><tbody>${body}</tbody></table>`);
    }
    out.push(`<p>${cap('这里只放 Speedup 与 τ 两列；完整逐格数字（含 0-α 到 4-α）见个人站的同名文章。', small)}</p>`);
  }

  if ((cmp.takeaways ?? []).length) {
    out.push('<h3>判断</h3>', `<ol>${cmp.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>`);
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
