#!/usr/bin/env node
/**
 * 机制结构图：声明式 spec → SVG（可选 PNG）。
 *
 *   node scripts/diagram.mjs --slug=dspine            # 渲染 articles/<slug>/diagram.json
 *   node scripts/diagram.mjs --slug=dspine --gen      # 先让模型起草 spec，再渲染
 *   node scripts/diagram.mjs --slug=dspine --png      # 额外导出 PNG（知乎/公众号用）
 *
 * 为什么要「声明式 spec + 确定性渲染」，而不是让模型直接画 SVG：
 *
 *   模型画 SVG 的通病是**坐标随手写**——框重叠、箭头穿字、线接头错位，
 *   而且每次重跑都不一样，没法 diff、没法小改。这里把「画什么」和「怎么摆」
 *   拆开：模型（或人）只写节点和连线，坐标全由渲染器算。
 *   于是改一条边的标签不用重跑模型，重跑也不会把图改乱。
 *
 * spec 里只放论文说得清的东西，画不出来的就不画：
 *   columns  竖列（一层 / 一个阶段 / 一个位置）
 *   nodes    框。col/row 是网格坐标，kind 决定形状
 *   edges    连线。style 决定虚实和颜色
 *   groups   把若干格框起来的底色区域（如「骨干 N 层」）
 *
 * spec 的 schema 见 docs/diagram-compare.md。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/diagram.mjs --slug=<slug> [--gen] [--png] [--spec=<file.json>] [--out=<basename>]');
  process.exit(1);
}

const ROOT = process.cwd();
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const assetDir = join(dir, 'assets');
const specPath = args.spec ? String(args.spec) : join(dir, 'diagram.json');
// 默认输出 fig-<slug>-diagram，是给「站点机制图」区块用的（paper-extras 按这个名字找）。
// --out 让同一篇能画多张：机制主线一张，正文里另配一张流程/对照图时用得上。
const outBase = args.out ? String(args.out) : `fig-${slug}-diagram`;

// ---------------------------------------------------------------- 配色
// 和站点同一套（site.css 的 :root），但这里必须写死：SVG 要能单独导出成 PNG，
// 不能依赖页面的 CSS 变量。
const C = {
  bg: '#faf8f4', card: '#ffffff', fg: '#1d1d1d', muted: '#6b655c',
  line: '#e3ddd1', accent: '#b8451f', accentSoft: '#f7e3c4',
  green: '#2f7d4f', greenSoft: '#e2efdf',
  orange: '#b06a1f', orangeSoft: '#fbeedd',
  blue: '#2f5d8a', blueSoft: '#e4ecf5',
};
const TONES = {
  plain: { fill: C.card, stroke: C.line, text: C.fg },
  accent: { fill: C.accentSoft, stroke: C.accent, text: C.fg },
  green: { fill: C.greenSoft, stroke: C.green, text: C.fg },
  orange: { fill: C.orangeSoft, stroke: C.orange, text: C.fg },
  blue: { fill: C.blueSoft, stroke: C.blue, text: C.fg },
  ghost: { fill: 'none', stroke: C.line, text: C.muted },
};
const EDGES = {
  solid: { stroke: C.fg, dash: '' },
  accent: { stroke: C.accent, dash: '' },
  green: { stroke: C.green, dash: '' },
  orange: { stroke: C.orange, dash: '' },
  blue: { stroke: C.blue, dash: '' },
  dashed: { stroke: C.muted, dash: '6 5' },
  faint: { stroke: C.line, dash: '4 4' },
};

// ---------------------------------------------------------------- 布局
const PAD = 28;
const COL_GAP = 68;
const ROW_GAP = 20;
const ROW_H = 52;
const TITLE_H = 46;
const HEAD_LINE = 16;  // 列标题每行高度
const BUS_LANE_H = 30; // 底部跨列连线的车道高度（标签要放得下）
const CHAR_W = 13.2;   // 15px 中文大致的字宽，用来估最小列宽

/** 转义：标签里可能出现 `&`、`<`（例如 "x < y"）。 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 按估算宽度折行。中文没有空格，只能按字数硬折；英文按空格折。 */
function wrap(text, maxChars) {
  const s = String(text);
  if (s.length <= maxChars) return [s];
  const lines = [];
  let cur = '';
  for (const ch of s) {
    cur += ch;
    if (cur.length >= maxChars && !/[A-Za-z0-9-]/.test(ch)) {
      lines.push(cur);
      cur = '';
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function layout(spec) {
  const columns = spec.columns ?? [];
  const nodes = spec.nodes ?? [];
  const rows = Math.max(1, ...nodes.map((n) => (n.row ?? 0) + 1), spec.rows ?? 0);

  // 每列的宽度：该列所有节点的最大估算宽度，再取统一下限。
  // 只按第一行估会漏掉折行后的长行，所以取所有行的最大值。
  const widestIn = (labels, maxChars) => {
    let w = 0;
    for (const label of labels) {
      for (const line of wrap(label, maxChars)) w = Math.max(w, line.length * CHAR_W);
    }
    return w;
  };
  const colW = columns.map((c, ci) => {
    const inCol = nodes.filter((n) => (n.col ?? 0) === ci);
    const fixed = Math.max(0, ...inCol.map((n) => n.w ?? 0));
    const widest = widestIn(inCol.map((n) => n.label ?? ''), 12);
    const titleW = Math.max(widestIn([c.label ?? ''], 8), widestIn([c.note ?? ''], 8) * 0.78);
    return Math.max(126, widest + 34, fixed, Math.min(titleW + 16, 240));
  });

  // 列标题也要折行：note 往往比 label 长，直接画会压到隔壁列。
  // 表头高度按最长的那一列算，所有列共用同一基线，才不会高低不齐。
  const headLines = columns.map((c) => ({
    label: wrap(c.label ?? '', 9),
    note: wrap(c.note ?? '', 11),
  }));
  const headRows = Math.max(1, ...headLines.map((h) => h.label.length + (h.note.length ? h.note.length : 0)));
  const HEAD_H = Math.max(24, headRows * HEAD_LINE + 10);

  const colX = [];
  let x = PAD;
  for (let i = 0; i < Math.max(columns.length, 1); i++) {
    colX.push(x);
    x += colW[i] + COL_GAP;
  }
  const contentW = x - COL_GAP + PAD;
  // 分组名和列标题是两回事时，它要单独占表头上方的一行。
  // 和列标题同名的分组（模型很爱这么写）不画名字，白占一行高度。
  const groupLabels = (spec.groups ?? []).filter((g) => {
    if (!g.label) return false;
    const cs = g.cols ?? [];
    return !cs.some((ci) => (columns[ci]?.label ?? '') === g.label);
  });
  const groupLabelH = groupLabels.length ? 20 : 0;
  // 分组框会从第一行往上探 12px，表头最后一行文字必须在这之上。
  const groupTopGap = (spec.groups ?? []).length ? 16 : 0;
  // headTop 是表头文字的**起点**，必须和网格起点 top 分开算：
  // 两者都相对 top 定位的话，表头会被挤到网格里，被分组框压住。
  const headTop = PAD + (spec.title ? TITLE_H : 0);
  const top = headTop + HEAD_H + groupLabelH + groupTopGap;
  const rowY = (r) => top + r * (ROW_H + ROW_GAP);

  // 节点框：box 铺满整列（表格感），pill / op 按文字宽度收紧（形状感）。
  // 全部铺满会让每个节点看起来一样重，读者分不出「阶段」和「操作」。
  const box = new Map();
  for (const n of nodes) {
    const ci = n.col ?? 0;
    const full = colW[ci] ?? 140;
    const hug = n.kind === 'pill' || n.kind === 'op';
    const textW = Math.max(...wrap(n.label ?? '', 12).map((l) => l.length)) * (n.size ?? 13.5) * 0.98;
    const w = n.w ?? (hug ? Math.min(full, Math.max(76, textW + 34)) : full);
    const h = n.h ?? ROW_H;
    box.set(n.id, {
      x: colX[ci] + (full - w) / 2,
      y: rowY(n.row ?? 0) + (ROW_H - h) / 2,
      w, h, col: ci, node: n,
    });
  }

  // 跨列连线走底部总线，每条占一条车道。底部要多留出车道的高度，
  // 否则箭头和总线会被 viewBox 切掉（PNG 导出时尤其明显）。
  const busEdges = (spec.edges ?? []).filter((e) => {
    const a = box.get(e.from);
    const b = box.get(e.to);
    return a && b && Math.abs((a.col ?? 0) - (b.col ?? 0)) >= 2;
  }).length;
  const busTop = rowY(rows - 1) + ROW_H + 22;
  const busHeight = busEdges ? 18 + busEdges * BUS_LANE_H : 0;
  const height = busTop + busHeight + PAD + (spec.footer ? 30 : 0);
  return { columns, colX, colW, rowY, box, width: contentW, height, top, headTop, headLines, HEAD_H, rows, busTop, busHeight };
}

// ---------------------------------------------------------------- 连线
/** 选两个框之间的锚点。按相对位置决定从哪条边出发，避免线穿过框。 */
function anchors(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) > 40 && Math.abs(dx) >= Math.abs(dy) * 0.7) {
    // 横向为主
    return dx > 0
      ? [{ x: a.x + a.w, y: ac.y, d: 'r' }, { x: b.x, y: bc.y, d: 'l' }]
      : [{ x: a.x, y: ac.y, d: 'l' }, { x: b.x + b.w, y: bc.y, d: 'r' }];
  }
  // 纵向为主
  return dy > 0
    ? [{ x: ac.x, y: a.y + a.h, d: 'b' }, { x: bc.x, y: b.y, d: 't' }]
    : [{ x: ac.x, y: a.y, d: 't' }, { x: bc.x, y: b.y + b.h, d: 'b' }];
}

function path(a, b) {
  const [p, q] = anchors(a, b);
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const horiz = p.d === 'l' || p.d === 'r';
  if (horiz) {
    // 同一条水平线上直接走直线，否则用对称三次贝塞尔，视觉上最稳
    if (Math.abs(dy) < 2) return { d: `M ${p.x} ${p.y} L ${q.x} ${q.y}`, mid: { x: (p.x + q.x) / 2, y: p.y } };
    const k = Math.max(28, Math.abs(dx) * 0.45);
    const c1 = { x: p.x + (p.d === 'r' ? k : -k), y: p.y };
    const c2 = { x: q.x + (p.d === 'r' ? -k : k), y: q.y };
    return {
      d: `M ${p.x} ${p.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${q.x} ${q.y}`,
      mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
    };
  }
  const k = Math.max(20, Math.abs(dy) * 0.45);
  const c1 = { x: p.x, y: p.y + (p.d === 'b' ? k : -k) };
  const c2 = { x: q.x, y: q.y + (p.d === 'b' ? -k : k) };
  return {
    d: `M ${p.x} ${p.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${q.x} ${q.y}`,
    mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
  };
}

/**
 * 跨越多列时的走线：从框底下去「总线」，横向走，再回到目标框的底下。
 *
 * 直接用贝塞尔会从图中间斜穿过去，压住中间几列的框——图一复杂就成一团。
 * 网格最底下那条横带是空的，走那里一定不压任何框；代价是线变长，
 * 但读得清比走得短重要。每条跨列线占一条独立车道（lane），不共用一条，
 * 否则三条线重合、三个标签叠在一起，等于没有标注。
 */
function corridorPath(a, b, L, lane = 0) {
  const busY = L.busTop + lane * BUS_LANE_H;
  const acx = a.x + a.w / 2;
  const bcx = b.x + b.w / 2;
  const ay = a.y + a.h;
  const by = b.y + b.h;
  // 从 a 底部下到车道 → 横移到目标列 → 上到 b 底部
  const d = [
    `M ${acx} ${ay}`,
    `L ${acx} ${busY}`,
    `L ${bcx} ${busY}`,
    `L ${bcx} ${by}`,
  ].join(' ');
  // 标签放在横向段靠右一点，避开竖段的转角；同车道不同边时不打架
  return { d, mid: { x: bcx - Math.abs(acx - bcx) * 0.28, y: busY - 10 } };
}

// ---------------------------------------------------------------- 渲染
function renderSvg(spec) {
  const L = layout(spec);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" width="${L.width}" height="${L.height}" role="img" aria-label="${esc(spec.title || '机制结构图')}">`);
  out.push(`<defs>`);
  for (const [k, v] of Object.entries(EDGES)) {
    out.push(`<marker id="arw-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${v.stroke}"/></marker>`);
  }
  out.push(`</defs>`);
  out.push(`<rect width="100%" height="100%" fill="${C.bg}"/>`);

  if (spec.title) {
    out.push(`<text x="${PAD}" y="${PAD + 20}" font-family="'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif" font-size="17" font-weight="700" fill="${C.fg}">${esc(spec.title)}</text>`);
  }

  // 列标题：多行、统一起排。用 muted 色，让框里的内容更突出。
  L.headLines.forEach((h, i) => {
    const cx = L.colX[i] + (L.colW[i] ?? 140) / 2;
    const startY = L.headTop + HEAD_LINE + 2;
    h.label.forEach((line, li) => {
      out.push(`<text x="${cx}" y="${startY + li * HEAD_LINE}" text-anchor="middle" font-family="'PingFang SC',sans-serif" font-size="13.5" font-weight="600" fill="${C.muted}">${esc(line)}</text>`);
    });
    h.note.forEach((line, li) => {
      out.push(`<text x="${cx}" y="${startY + (h.label.length + li) * HEAD_LINE}" text-anchor="middle" font-family="'PingFang SC',sans-serif" font-size="11.5" fill="${C.muted}" opacity="0.8">${esc(line)}</text>`);
    });
  });

  // 分组底色：先画，保证在框下面
  for (const g of spec.groups ?? []) {
    const cs = g.cols ?? [];
    if (!cs.length) continue;
    const x0 = L.colX[Math.min(...cs)] - 16;
    const x1 = L.colX[Math.max(...cs)] + (L.colW[Math.max(...cs)] ?? 140) + 16;
    const r0 = g.rows?.[0] ?? 0;
    const r1 = g.rows?.[1] ?? 0;
    const y0 = L.rowY(r0) - 12;
    const y1 = L.rowY(r1) + ROW_H + 12;
    const tone = TONES[g.tone ?? 'plain'];
    out.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="12" fill="${g.fill ?? tone.fill}" stroke="${g.stroke ?? 'none'}" stroke-width="1.2"${g.dash ? ' stroke-dasharray="6 5"' : ''}/>`);
    if (g.label) {
      // 分组名如果和列标题是一回事（模型经常这么写），就不要再画一遍——
      // 两行一模一样的字叠在一起，读者会以为是两个不同的东西。
      const sameAsHeader = cs.some((ci) => (L.columns[ci]?.label ?? '') === g.label);
      if (!sameAsHeader) {
        // 画在框**上面**，不是在框里——框里第一行就是节点，写在里面必然压字。
        out.push(`<text x="${x0 + 2}" y="${y0 - 6}" font-family="'PingFang SC',sans-serif" font-size="12" font-weight="600" fill="${g.tone ? TONES[g.tone].stroke : C.muted}">${esc(g.label)}</text>`);
      }
    }
  }

  // 先算所有连线的几何，标签最后画，保证不被框盖住
  const edges = [];
  const skippedLabels = [];
  let busLane = 0;
  for (const e of spec.edges ?? []) {
    const a = L.box.get(e.from);
    const b = L.box.get(e.to);
    if (!a || !b) {
      console.warn(`⚠️ 边引用了不存在的节点：${e.from} → ${e.to}`);
      continue;
    }
    const style = EDGES[e.style ?? 'solid'];
    // 跨 2 列以上走底部总线：贝塞尔斜穿会把中间那几列的框压掉。
    const spansCols = Math.abs((a.col ?? 0) - (b.col ?? 0));
    const p = spansCols >= 2 ? corridorPath(a, b, L, busLane++) : path(a, b);
    out.push(`<path d="${p.d}" fill="none" stroke="${style.stroke}" stroke-width="${e.width ?? 1.8}" ${style.dash ? `stroke-dasharray="${style.dash}"` : ''} marker-end="url(#arw-${e.style ?? 'solid'})" opacity="${e.opacity ?? 1}"/>`);
    if (e.label) edges.push({ mid: e.labelAt ?? p.mid, label: e.label, color: style.stroke });
  }

  // 节点
  for (const [id, b] of L.box) {
    const n = b.node;
    const tone = TONES[n.tone ?? 'plain'];
    const rx = n.kind === 'pill' ? b.h / 2 : n.kind === 'op' ? b.h / 2 : 9;
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" fill="${n.fill ?? tone.fill}" stroke="${n.stroke ?? tone.stroke}" stroke-width="${n.bold ? 2 : 1.4}"${n.dash ? ' stroke-dasharray="6 5"' : ''}/>`);
    const lines = wrap(n.label ?? '', 12);
    const fs = n.size ?? 13.5;
    const lh = fs + 4;
    const startY = b.y + b.h / 2 - ((lines.length - 1) * lh) / 2 + fs / 3;
    lines.forEach((line, i) => {
      out.push(`<text x="${b.x + b.w / 2}" y="${startY + i * lh}" text-anchor="middle" font-family="'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif" font-size="${fs}" font-weight="${n.bold ? 700 : 500}" fill="${n.color ?? tone.text}">${esc(line)}</text>`);
    });
    void id;
  }

  // 连线标签：白底衬一下，压在线上才看得清。
  // 几条线汇到同一个框时，中点会撞在一起（「残差流」压「前驱特征」那种），
  // 所以记下已占的矩形，撞了就往上/下让开——宁可标签离线，也不能叠字。
  //
  // ⚠️ 还必须**避开节点框本身**：短连线（相邻两行之间）的中点正好落在框的边缘上，
  // 标签会盖住框里的文字。EAGLE 那张图上「特征」两个字就压在「超前一步 token」框里。
  const nodeRects = [...L.box.values()].map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
  const overlap = (r, q) => !(r.x + r.w < q.x || q.x + q.w < r.x || r.y + r.h < q.y || q.y + q.h < r.y);
  // 标签不许跑出内容区：上边界是表头底、下边界是底边。跑到标题区或图外都不是「让开」，
  // 而是把标签丢失在读者不会看的地方。
  const yMin = L.top - 6;
  const yMax = L.height - (spec.footer ? 40 : 16) - 22;
  const placed = [];
  const collides = (r) => r.y < yMin || r.y + r.h > yMax
    || placed.some((q) => overlap(r, q)) || nodeRects.some((q) => overlap(r, q));
  for (const e of edges) {
    const w = e.label.length * 11.5 + 10;
    const rect = { x: e.mid.x - w / 2, y: e.mid.y - 10, w, h: 20 };
    // 先试小位移，实在放不下才往外挪；`[0, -18, 18, -36, 36, -54, 54]` 比
    // 大跨度的 `±96` 更不容易把标签甩到图上不相关的位置。
    const steps = [0, -18, 18, -36, 36, -54, 54, -72, 72];
    let placedOk = false;
    for (const dy of steps) {
      const cand = { ...rect, y: rect.y + dy };
      if (!collides(cand)) { rect.y = cand.y; placedOk = true; break; }
    }
    // 所有位置都被框占满时**宁可不画标签**，也不能压字。
    // 标签压在节点框上，读者会以为那两个字是框里的内容
    //（EAGLE 图上「特征」就压在「超前一步 token」框里，看起来像框的一部分）。
    if (!placedOk) { skippedLabels.push(e.label); continue; }
    placed.push(rect);
    out.push(`<rect x="${rect.x}" y="${rect.y}" width="${rect.w}" height="${rect.h}" rx="5" fill="${C.bg}" opacity="0.94"/>`);
    out.push(`<text x="${rect.x + rect.w / 2}" y="${rect.y + 14}" text-anchor="middle" font-family="'PingFang SC',sans-serif" font-size="11.5" font-weight="600" fill="${e.color}">${esc(e.label)}</text>`);
  }

  if (skippedLabels.length) {
    console.warn(`⚠️ 有 ${skippedLabels.length} 个连线标签放不下，已省略：${skippedLabels.join('、')}（宁可少标注，也不能压字）`);
  }

  if (spec.footer) {
    out.push(`<text x="${PAD}" y="${L.height - 14}" font-family="'PingFang SC',sans-serif" font-size="12" fill="${C.muted}">${esc(spec.footer)}</text>`);
  }

  out.push(`</svg>`);
  return out.join('\n');
}

// ---------------------------------------------------------------- LLM 起草
async function generateSpec() {
  const { createLlm, extractJson } = await import('./lib/llm.mjs');
  const llm = createLlm();
  if (!llm.configured) throw new Error('LLM 未配置，无法 --gen');
  const md = readFileSync(join(dir, 'article.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  // 只要方法那几节：结构图是「机制怎么走」，不是结果。
  const method = md.slice(md.indexOf('## 3.'), md.indexOf('## 5.')) || md.slice(0, 14000);

  const text = await llm.complete({
    messages: [
      {
        role: 'system',
        content: `你在给一篇论文画**机制结构图**（不是结果图）。输出一个 JSON spec，由渲染器负责排版。

画图的取舍：
- 一张图只讲一条主线。宁可少画三个细节，也不要画成论文里那种塞满符号的图。
- 节点是「东西」（张量、模块、阶段），边是「数据怎么走」。不要把「优点」写成节点。
- 每条边都要有意义：能标就标上它传的是什么（如「前驱特征」「门控」）。
- 不超过 4 列、5 行；节点标签尽量 ≤ 10 个汉字，长概念拆成两个节点。

spec 结构：
{
  "title": "图的标题",
  "columns": [{ "label": "列名", "note": "可选副标题" }],
  "rows": 行数,
  "nodes": [{ "id": "唯一id", "col": 0, "row": 0, "label": "文字", "tone": "plain|accent|green|orange|blue|ghost", "kind": "box|pill|op", "bold": false, "dash": false }],
  "edges": [{ "from": "id", "to": "id", "label": "传的是什么", "style": "solid|accent|green|orange|blue|dashed|faint" }],
  "groups": [{ "label": "区域名", "cols": [起, 止], "rows": [起, 止], "tone": "plain|accent|green|orange|blue" }],
  "footer": "一句话总结，可选"
}

只输出 JSON。`,
      },
      { role: 'user', content: `论文：${slug}\n\n方法章节：\n${method.slice(0, 16000)}` },
    ],
    maxTokens: 4000,
    temperature: 0.2,
    jsonMode: true,
  });
  const spec = extractJson(text);
  // 基本校验：边引用的节点必须存在，否则渲染出来是缺线的图，而缺线不会报错。
  const ids = new Set((spec.nodes ?? []).map((n) => n.id));
  spec.edges = (spec.edges ?? []).filter((e) => ids.has(e.from) && ids.has(e.to));
  writeFileSync(specPath, `${JSON.stringify(spec, null, 1)}\n`, 'utf8');
  console.log(`起草完成：${specPath}（模型 ${llm.model}）。先看一眼再渲染。`);
  return spec;
}

// ---------------------------------------------------------------- 主流程

let spec;
if (args.gen) {
  spec = await generateSpec();
} else {
  if (!existsSync(specPath)) {
    console.error(`没有 ${specPath}。用 --gen 让模型起草，或手写一个 spec。`);
    process.exit(1);
  }
  spec = JSON.parse(readFileSync(specPath, 'utf8'));
}

mkdirSync(assetDir, { recursive: true });
const svg = renderSvg(spec);
const svgPath = join(assetDir, `${outBase}.svg`);
writeFileSync(svgPath, svg, 'utf8');
const result = { svg: `articles/${slug}/assets/${outBase}.svg`, width: undefined, height: undefined };
{
  // 只认 <svg> 标签上的尺寸。宽高可能是小数（列宽按字宽估算），
  // 用 \d+ 会匹配到 <marker> 里的整数，导出 PNG 时被裁成一小块。
  const m = svg.match(/<svg[^>]*\bwidth="([\d.]+)"\s+height="([\d.]+)"/);
  if (m) { result.width = Math.ceil(Number(m[1])); result.height = Math.ceil(Number(m[2])); }
}

if (args.png) {
  const { chromium } = await import('playwright');
  const { findChromium } = await import('./lib/chromium.mjs');
  const exe = findChromium();
  const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
  const p = await browser.newPage({ viewport: { width: result.width, height: result.height }, deviceScaleFactor: 2 });
  await p.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`, { waitUntil: 'load' });
  await p.waitForTimeout(300);
  const pngPath = join(assetDir, `${outBase}.png`);
  await p.screenshot({ path: pngPath, fullPage: true });
  await browser.close();
  result.png = `articles/${slug}/assets/${outBase}.png`;
}

console.log(JSON.stringify(result, null, 1));
