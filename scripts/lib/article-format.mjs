/**
 * 正文排版的三件「机器该做的事」：元信息块、图表编号、标题编号。
 *
 * 为什么放在代码里而不是写进写作提示词：
 *   这三样都是**结构性约束**，不是内容判断。让模型写，结果一定是「这篇有、那篇没有」
 *   —— 实测 eagle 的 8 个二级标题全都没编号，三级标题却从 4.1 开始；
 *   caption 有的带「图 1 ·」有的不带；开头元信息块干脆整个丢了。
 *   模型每次都在重新决定同一件事，而代码只决定一次。
 *
 * 所有函数都是**幂等**的：对已经格式化过的正文再跑一遍，输出不变。
 * 这样「生成时拼装」和「事后补跑」用的是同一套规则，不会互相打架。
 */

// ---------------------------------------------------------------- 元信息块

/**
 * 从 article.yaml + research.md + assets/links.json 拼出开头的元信息块。
 *
 * 字段来源是有讲究的，不要随便回退：
 *   论文 —— 英文原题来自 research.md 的 `- 标题：`，那是 arXiv 元数据抓的；
 *           拿不到才退回 yaml 的中文标题（此时会短一截，但至少不空着）
 *   作者 —— yaml 的 authors（人工校对过，比 arXiv 原样抓的干净）
 *   链接 —— arXiv abs / pdf，项目页只收真正的项目页
 */
export function buildMetaLines({ meta, research = '', links = null }) {
  const arxiv = String(meta.arxiv_id ?? '').trim();
  // venue 常见三种写法：`ICML 2026`、`arXiv 2609.36173`、空。
  // 后一种是 yaml 建档时的占位，去掉 arXiv 前缀后只剩一串数字，
  // 拼进「（2609.36173，arXiv:2609.36173）」会重复两遍编号。
  const rawVenue = String(meta.venue ?? '').trim();
  const venue = /^arxiv\b/i.test(rawVenue) ? '' : rawVenue;
  const jsonTitle = String(meta.title ?? '').replace(/^[^：:]*[：:]\s*/, '').trim();
  const enTitle = research.match(/^-\s*标题[：:]\s*(.+)$/m)?.[1]?.trim() || '';
  // research.md 的标题偶尔带着 arXiv 的分类尾巴，砍掉
  const paperTitle = (enTitle || jsonTitle).replace(/\s*\((?:arXiv|cs\.[A-Z]+)[^)]*\)\s*$/i, '').trim();
  const suffix = [venue, arxiv ? `arXiv:${arxiv}` : ''].filter(Boolean).join('，');

  const lines = [];
  // 教程类（kind: guide）没有英文原题，拿中文标题拆出来的「副标题」冒充论文标题是错的。
  // 2026-11-13 投机解码入门稿就出现过 `**论文** 先猜一段，再让大模型验收`。
  if (paperTitle && String(meta.kind ?? 'paper') === 'paper') {
    lines.push(`**论文**　${paperTitle}${suffix ? `（${suffix}）` : ''}`);
  }

  const authors = String(meta.authors ?? '').trim();
  if (authors) lines.push(`**作者**　${authors}`);

  // 链接：arXiv 一定有；项目页只认「主页型」地址。
  // /blog/ 这类路径是**别人方法的博客文章**（eagle 的 links.json 里那条 lmsys.org/blog
  // 其实是 Lookahead 的介绍页），收进项目页会让读者以为那是这篇的官方主页。
  const projectPages = (links?.project ?? []).filter((e) => {
    try {
      const p = new URL(e.url).pathname;
      return p === '/' || p === '' || !/\/(?:blog|posts?|news)\//i.test(p);
    } catch { return false; }
  });
  const linkBits = [
    arxiv ? `[arXiv:${arxiv}](https://arxiv.org/abs/${arxiv})` : '',
    arxiv ? `[论文 PDF](https://arxiv.org/pdf/${arxiv})` : '',
    ...projectPages.map((e) => `[项目页](${e.url})`),
  ].filter(Boolean);
  if (linkBits.length) lines.push(`**链接**　${linkBits.join(' ｜ ')}`);

  // 代码仓：related 里和 github 重复的不算（同一个仓出现两次只是噪音）
  const repos = dedupe([...(links?.github ?? []), ...(links?.huggingface ?? []), ...(links?.modelscope ?? [])]);
  const github = repos.filter((e) => e.host === 'github.com' || /github\.com/.test(e.url));
  if (github.length) {
    lines.push(`**代码**　${github.map((e) => `[${e.repo ?? e.url}](${e.url})`).join(' ｜ ')}`);
  }
  const weights = repos.filter((e) => !github.includes(e));
  if (weights.length) {
    // 标签只留「HF 集合 / HF 模型名」，不带 `owner/`：一行里出现三次
    // `HuggingFace tencent/Qwen3-8B-DSpine-b16` 会把元信息块撑成一屏。
    const labels = weights.map((e) => {
      const hf = e.host.includes('huggingface') || e.host === 'hf.co';
      const name = String(e.repo ?? '').split('/').pop();
      if (hf) return `[HF ${e.kind === 'collection' ? '集合' : name || '模型'}](${e.url})`;
      return `[魔搭 ${name || ''}](${e.url})`.replace(' ]', ']');
    });
    lines.push(`**模型**　${labels.join(' ｜ ')}`);
  }
  return lines;
}

function dedupe(entries) {
  const seen = new Set();
  return entries.filter((e) => {
    const k = e.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 元信息块的开头字段：论文类用 `论文`，教程类用 `作者` / `来源` / `链接` / `原文`。
//
// 只认 `论文` 会出事：guide 类稿件的块以 `作者` 开头，applyMetaBlock 判定「没有元信息块」，
// 于是**每次 format:article 都再补一行作者**。2026-11-16 DFlash 2 的正文就这样攒出
// 三行 `> **作者**　Inco AI`，还一路带进了知乎和公众号草稿。
// 与 publish-check 的 A9c 用同一组字段，避免两处口径不一致。
const META_START = /^>\s*\*\*(?:论文|作者|链接|来源|原文|代码)\*\*/m;

/** 元信息块在正文里的位置：`# 标题` 之后、其它内容之前。 */
export function hasMetaBlock(md) {
  const head = md.split(/\n##\s/)[0];
  return META_START.test(head);
}

/**
 * 把元信息块写进正文。
 *
 * 只在**缺失**时补，已有的块一律不动：
 * dflash 那块是手写的，英文原题、作者带了「UC San Diego」、代码链接写的是完整 URL，
 * 自动生成只能给中文标题和 `owner/repo` 短名——覆盖它等于把更好的内容换成更差的。
 * 这个函数负责「补漏」，不负责「重写」。
 *
 * 块用 `\` 在行尾续行——marked 的 breaks:true 会把它渲染成 `<br>`，
 * render-html 的 formatMetaBlock 再拆成左标签右内容的栅格。
 * 少了这个反斜杠，整个块会挤成一行。
 */
export function applyMetaBlock(md, lines) {
  if (!lines.length) return md;
  // 正文前部已有 `> **论文** …` 之类的块 → 保留原样
  const head = md.split(/\n##\s/)[0] ?? '';
  if (META_START.test(head)) return md;
  const block = lines.map((l) => `> ${l}`).join('\\\n');
  const h1 = md.match(/^#\s+[^\n]*\n/);
  if (!h1) return `${block}\n\n${md}`;
  return `${h1[0]}\n${block}\n\n${md.slice(h1[0].length).replace(/^\n+/, '')}`;
}

// ---------------------------------------------------------------- 图表编号

/**
 * 给每张插图和每张 Markdown 表格编号：图与表各走一条计数，按文档顺序。
 *
 * 两类表格都算「表」：
 *   · `![…](assets/tab-*.png)` —— 论文原表裁图，编号写在图注里；
 *   · 表格上方独立一行的 `表 N · 标题` —— Markdown 切片表，编号写在这行。
 * 共享一个计数器，所以读者按号去找一定找得到。
 *
 * 判定原表看文件名前缀（`tab-*` 是 render:table 的产物），文件名不可靠时
 * 再看原有图注的第一个词。
 */
export function numberCaptions(md) {
  let fig = 0;
  let tab = 0;
  return md.split('\n').map((line) => {
    const img = line.match(/^!\[([^\]]*)\]\(([^)]*)\)/);
    if (img) {
      const [, alt, src] = img;
      const isTable = /(?:^|\/)tab-/.test(src) || /^\s*表/.test(alt);
      const n = isTable ? ++tab : ++fig;
      const kind = isTable ? '表' : '图';
      // 先剥掉旧编号：`图 1 ·` / `表1：` / `图 2.` 都算
      const rest = alt.replace(/^\s*(?:图|表)\s*\d+\s*(?:[·・:：,，.．\-—]\s*)?/, '').trim();
      return `![${kind} ${n} · ${rest}](${src})`;
    }
    const cap = line.match(/^表\s*\d+\s*·\s*(.*)$/);
    if (cap) return `表 ${++tab} · ${cap[1]}`;
    return line;
  }).join('\n');
}

/**
 * 检查正文里的「图 N / 表 N」引用能不能对上实际编号，对不上的列出来。
 *
 * 这是「图表很多都不对」里最难靠人眼发现的一类：图注编号是对的，
 * 正文引用也是通顺的，但两者说的不是同一张图。eagle 的初稿引用的是
 * **论文原文**的图号（图 3、图 4、图 8、表 2、表 5、表 7），而文章自己的
 * 插图只有 图 1–7 / 表 1，读者按号去找必然找到别的东西。
 */
export function checkFigureRefs(md) {
  const captions = [
    ...[...md.matchAll(/^!\[((?:图|表)\s*\d+)\s*·/gm)].map((m) => m[1]),
    ...[...md.matchAll(/^(表\s*\d+)\s*·/gm)].map((m) => m[1]),
  ].map((s) => s.replace(/\s+/g, ' '));
  const available = new Set(captions);
  const bad = [];
  md.split('\n').forEach((line, i) => {
    if (/^!\[/.test(line) || /^表\s*\d+\s*·/.test(line)) return;
    // 「论文图 3」「论文原文 Table 2」是明确指向论文的，不算错
    for (const m of line.matchAll(/(?<!论文)(?<!原文)(图|表)\s*(\d+)/g)) {
      const ref = `${m[1]} ${m[2]}`;
      if (!available.has(ref)) bad.push({ line: i + 1, ref, text: line.slice(0, 60) });
    }
  });
  return { available: [...available], bad };
}

// ---------------------------------------------------------------- 标题编号

const UNNUMBERED_H2 = /^(?:TL;?\s*DR|摘要|附[：:]|附录)/i;

/**
 * 二级标题从 1 开始编号、三级标题编成 `N.M`。
 *
 * 约定对齐 dflash / dspine 两份旧稿（它们本来就是这么写的）：
 *   - `## TL;DR` / `## 附：…` / `## 附录` 不编号，它们不是正文的一节；
 *   - `## 1. 引言` … `## 7. 讨论与判断`，三级标题跟着父节号走；
 *   - 父节不编号时（例如 TL;DR 下面有三级标题），三级标题也不编号。
 *
 * 为什么要**先剥再加**：eagle 的三级标题写成了 4.1–4.5 和 7.1–7.4，
 * 但它的二级标题一个都没有，4 和 7 这个编号凭空出现。重编后统一从 1 开始。
 */
export function numberHeadings(md) {
  let h2n = 0;
  let h3n = 0;
  let numbered = false; // 当前二级标题是否参与编号
  return md.split('\n').map((line) => {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      const text = h2[1].trim().replace(/^\d+[.、]\s*/, '');
      h3n = 0;
      if (UNNUMBERED_H2.test(text)) {
        numbered = false;
        return `## ${text}`;
      }
      numbered = true;
      h2n += 1;
      return `## ${h2n}. ${text}`;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      const text = h3[1].trim().replace(/^\d+(?:\.\d+)*[.、]?\s*/, '');
      if (!numbered) return `### ${text}`;
      h3n += 1;
      return `### ${h2n}.${h3n} ${text}`;
    }
    return line;
  }).join('\n');
}

// ---------------------------------------------------------------- 表格粘连

/**
 * 修「段落和表格挤在同一行」。
 *
 * 这是模型生成时的高频错误，而且**机器检查看不出来**：`|` 行数还是那么多，
 * 但 marked 会把整行当成段落文字，页面上出现一长串 `| 0.79 | 0.74 |`。
 * eagle 的 α 衰减表就是这样整张没渲染出来。
 *
 * 只在「行末是句末标点、后面紧跟一个完整的表格行」时才拆，避免误伤正文里的竖线。
 */
export function repairGluedTables(md) {
  return md.split('\n').map((line) => {
    if (line.trimStart().startsWith('|')) return line;
    // ⚠️ 不能用 `^(.*[。！？；】）)])\s*(\|.*\|)$` 这种「贪婪取最后一句末」的写法：
    // 表头里的 `（T=0）` 也以 `）` 结尾，贪婪匹配会把 `| 模型（T=0）` 一起吞进正文，
    // 剩下的表头变成 `| 0-α | 1-α | …`，**列名整列消失**——比不修更糟。
    // 正确做法是找「第一个满足条件的切点」：切口之前的文字以句末标点收尾，
    // 之后的整段是一个合法的多列表格行。
    for (let i = 1; i < line.length; i++) {
      if (line[i] !== '|') continue;
      const head = line.slice(0, i).trimEnd();
      const tail = line.slice(i).trim();
      if (!/[。！？；】)]$/.test(head)) continue;
      if (!/^\|.*\|$/.test(tail)) continue;
      const cols = tail.split('|').filter((s) => s.trim()).length;
      if (cols < 2) continue;
      return `${head}\n\n${tail}`;
    }
    return line;
  }).join('\n');
}

/** 三个修正一次做完，顺序有依赖：先补元信息，再修表格，最后编号。 */
/**
 * 修「元信息块被拆成好几个引用块」+「同一字段重复多行」。
 *
 * 公众号渲染只把**第一个** blockquote 当元信息块：第二个块里的 `原文` 链接既不进
 * 元信息区、也不会生成二维码（2026-11-16 DFlash 2 的 D6b 就是被这个卡住的）。
 * 知乎那边则会显示成一串重复的作者行。两种形态都能在本地拦下，不必等平台读回。
 */
export function repairMetaBlock(md) {
  const lines = md.split('\n');
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 < 0) return md;
  let i = h1 + 1;
  while (i < lines.length && !lines[i].trim()) i++;
  if (!(lines[i] ?? '').trimStart().startsWith('>')) return md;

  const collected = [];
  let j = i;
  let lastBlockEnd = i;
  let skipped = 0;   // 被丢掉的重复行数
  let groups = 1;    // 连续的引用块个数；>1 说明块被拆开了，需要合并
  while (j < lines.length) {
    const line = lines[j];
    if (line.trimStart().startsWith('>')) {
      const text = line.replace(/^>\s?/, '').replace(/\\+$/, '').trimEnd();
      const key = (text.match(/^\*\*([^*]+)\*\*/) ?? [])[1];
      // 同一字段、同一内容的重复行直接丢（三行「作者 Inco AI」就是这样来的）
      // 重复行也推进 lastBlockEnd：块区域是连续的，重建时要把它整个替换掉，
      // 否则被丢掉的重复行会从「保留行之后」再被拼回去（写完发现原样输出就是这个）。
      if (key && collected.some((c) => c.key === key && c.text === text)) { skipped++; lastBlockEnd = j; j++; continue; }
      collected.push({ key, text });
      lastBlockEnd = j;
      j++;
      continue;
    }
    if (!line.trim()) {
      let k = j + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      // 只合并「以字段名开头」的下一块（**来源**、**本篇** …）。
      // 正文导语也是一段独立的 `>` 引用，把它并进元信息块会把导读变成标签行。
      const next = (lines[k] ?? '').trimStart();
      if (next.startsWith('>') && /^>\s*\*\*[^*]+\*\*/.test(next)) { groups++; j = k; continue; }
    }
    break;
  }

  const block = collected.filter((c) => c.text);
  // 没有重复行、也没有被拆成多块 → 原样返回（幂等）
  if (!skipped && groups === 1) return md;

  // 用行尾 `\` 续行：marked 的 breaks:false 下块内换行必须靠硬换行符
  const merged = block.map((c, idx) => `> ${c.text}${idx < block.length - 1 ? '\\' : ''}`);
  let rest = lastBlockEnd + 1;
  while (rest < lines.length && !lines[rest].trim()) rest++;
  return [...lines.slice(0, h1 + 1), '', ...merged, '', ...lines.slice(rest)].join('\n');
}

export function formatArticle(md, { meta = null, research = '', links = null } = {}) {
  let out = md;
  out = repairMetaBlock(out);
  if (meta) out = applyMetaBlock(out, buildMetaLines({ meta, research, links }));
  out = repairGluedTables(out);
  out = numberCaptions(out);
  out = numberHeadings(out);
  return out;
}
