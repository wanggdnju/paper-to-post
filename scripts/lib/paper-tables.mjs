/**
 * 论文原表 → 窄屏紧凑表（知乎 / 公众号用）。
 *
 * 站点能给 1240px 容器 + 横向滚动，原表整张渲染就行（scripts/latex-table.mjs 的 toHtml）。
 * 知乎正文宽 ~690px、公众号手机端 ~343px，18 列塞进去每格只有 20–30px，
 * 和截图一样读不出来。所以这两个平台换一种表示：按任务拆成几张窄表，
 * 「Speedup / τ」两列并成一格，每张表都自带 Model / Method，能单独复制。
 *
 * 一个表源都没有时返回 null，调用方退回原来的截图逻辑。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toCompact } from '../latex-table.mjs';

/** 表源目录里的 tex，main.tex 排第一（与 build-site 的编号规则一致） */
function tableFiles(dir) {
  const texDir = join(dir, 'source/tables');
  if (!existsSync(texDir)) return { texDir, files: [] };
  const files = readdirSync(texDir)
    .filter((f) => f.endsWith('.tex'))
    .sort((a, b) => (a === 'main.tex' ? -1 : b === 'main.tex' ? 1 : a.localeCompare(b)));
  return { texDir, files };
}

function macrosFor(texDir) {
  const p = join(texDir, 'macros.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

/**
 * 单元格里的 `<b>/<i>/<u>` 统一成 `<strong>/<em>/<span>`。
 *
 * 每个渲染器自己决定怎么落地：
 *   - 知乎走 `inline()`，它先 `esc()`，所以要把 HTML 先转成 `**…**`（见 cellMarkdown）；direct
 *     塞 `<b>` 会变成字面上的 `&lt;b&gt;`；
 *   - 公众号产物本身就是 HTML，保留标签即可（`<b>` 不在白名单，换成 `<strong>`）。
 * 所以这里**保留原始 HTML**，转换交给调用方。
 */
function normalizeCell(html) {
  return String(html ?? '')
    .replace(/<b>/g, '<strong>').replace(/<\/b>/g, '</strong>')
    .replace(/<i>/g, '<em>').replace(/<\/i>/g, '</em>')
    .replace(/<u>/g, '<span style="text-decoration:underline;">').replace(/<\/u>/g, '</span>');
}

/** 单元格 HTML → Markdown 强调（知乎那条会先转义的管线用） */
export function cellMarkdown(html) {
  return normalizeCell(html)
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
}

/** 去掉所有行内标签，只留文字（表头用） */
export function plainCell(html) {
  return String(html ?? '').replace(/<[^>]+>/g, '').trim();
}

/** 图注太长会挤满手机上的一屏，标题只留到第一个句号 */
export function shortTitle(caption, n) {
  const head = String(caption ?? '')
    // 「（论文原表）」是截图时代的标记；现在这里是重排过的表，留着会误导
    .replace(/[（(]论文原表[）)]/g, '')
    .split(/[。；]/)[0]
    .replace(/^表\s*\d+\s*[·:：]\s*/, '')
    .trim();
  // 表号必须留着：读者要拿它去对照论文原表
  return head ? `表 ${n} · ${head}` : `表 ${n}`;
}

/**
 * 第 n 张表的紧凑版。
 *
 * @param dir   articles/<slug>
 * @param n     正文里的「表 N」
 * @param caption 正文图注（用来在同一个 tex 里的多张 tabular 中挑对的那张）
 * @returns {{tables: Array<{title, header, rows}>, problems: string[]} | null}
 */
export function compactForTable(dir, n, caption) {
  const { texDir, files } = tableFiles(dir);
  const file = files[n - 1];
  if (!file) return null;
  const tex = readFileSync(join(texDir, file), 'utf8');
  const macros = macrosFor(texDir);
  // 图注全文只用来**挑 tabular**（一个 tex 文件可能有好几张表）；
  // 标题用截短版，否则手机上标题就占掉一整屏
  const r = toCompact(tex, { caption: shortTitle(caption, n), hint: caption ?? '', macros });
  if (r.problems.length) return r;
  return {
    ...r,
    tables: r.tables.map((t) => ({
      ...t,
      // 表头走**纯文本**：`<i>Avg.</i>` 转成强调也未必被各平台解析，星号更难看
      header: t.header.map(plainCell),
      // 单元格保留 HTML 强调，由调用方（知乎 → Markdown，公众号 → 原标签）落地
      rows: t.rows.map((row) => row.map(normalizeCell)),
    })),
  };
}
