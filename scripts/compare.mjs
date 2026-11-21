#!/usr/bin/env node
/**
 * 生成「横向对比」：`articles/<slug>/compare.json`。
 *
 *   node scripts/compare.mjs --slug=dspine [--table=tab:main-acceptance] [--no-llm] [--print]
 *
 * 为什么要单独一个文件，而不是让写稿模型在正文里顺手写一段对比：
 *
 *   1. **数字必须可核对**。正文里的对比表一旦由模型手写，单元格就脱离了
 *      facts.json 的 ID，`verify:numbers` 只能校验「这个数在论文里出现过」，
 *      校验不了「这个数属于哪一行哪一列」——正是最容易张冠李戴的地方。
 *      这里直接从 facts.json 拼表，每个格子自带 `tab:xxx@group/method:column`。
 *   2. **可以重跑**。换了对比对象、论文加了基线，重跑一次就更新，
 *      不用回头改已经发布的正文。
 *   3. **机制维度交给模型，但要能指回原文**。哪一列是「块内注意力」这种东西
 *      没法从数字里推，只能读论文；所以那部分由模型抽，但每条必须附一句
 *      **逐字出现在原文里**的出处，脚本会做子串校验，对不上就丢掉并报出来。
 *
 * 输出结构：
 *   { slug, generated_at, model, title,
 *     numeric:    [{ table, caption, groups: [{ name, columns, rows: [{ method, values, facts, ours }] }] }],
 *     baselines:  [{ name, lineage, mechanism, cost, source }],
 *     dimensions: [{ name, ours, values: {名称: 值}, source }],
 *     takeaways:  [string],
 *     dropped:    [{ item, reason }]        ← 出处校验没通过的条目，留着便于人工看
 *   }
 *
 * compare.json 由站点仓库（note-site）的 build-site.mjs 读，渲染成文章页末尾的
 * 「横向对比」区块，所以**不需要**把它插进 article.md —— 正文保持模型写的那一版。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/compare.mjs --slug=<slug> [--table=tab:xxx] [--no-llm] [--print]');
  process.exit(1);
}

const ROOT = process.cwd();
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const factsPath = join(dir, 'facts.json');
if (!existsSync(factsPath)) {
  console.error(`没有 ${factsPath}。先跑 npm run facts -- --slug=${slug}`);
  process.exit(1);
}
const facts = JSON.parse(readFileSync(factsPath, 'utf8'));

/** 论文简称：标题冒号前的部分。用来在对比表里认出「本工作」这一行。 */
function shortName() {
  const yamlPath = join(dir, 'article.yaml');
  if (existsSync(yamlPath)) {
    // yaml 里的 title 可能带引号（`title: "EAGLE：…"`），先剥掉再按冒号切；
    // 不剥的话表头会渲染成 `"EAGLE`（2026-11-13 在站点上看到的实际现象）。
    const title = (readFileSync(yamlPath, 'utf8').match(/^title:\s*(.+)$/m)?.[1] ?? '')
      .trim().replace(/^["']|["']$/g, '');
    const head = title.split(/[：:]/)[0].trim().replace(/^["']|["']$/g, '');
    if (head) return head;
  }
  return slug;
}
const SELF = shortName();
const isOurs = (method) => /\(?ours\)?/i.test(method) || method.toLowerCase().includes(SELF.toLowerCase());

// ---------------------------------------------------------------- 数字对比

/**
 * 从 facts.json 里挑出「适合做横向对比」的表。
 *
 * 判据：同一 group 下至少有 3 个方法、3 个指标列。消融表（固定一行方法名、
 * 列是 w/o xxx）在 facts 里 method 那一格其实是数据集名，方法数=1，会被这个
 * 判据挡掉——这是对的：消融不是「和谁比」，是「自己拆零件」。
 */
function buildNumeric({ tableFilter, maxTables = 2 } = {}) {
  const byTable = new Map();
  for (const f of facts.facts ?? []) {
    if (tableFilter && f.table !== tableFilter) continue;
    if (!f.method) continue; // 没有方法维度的表（超参表等）不参与对比
    let t = byTable.get(f.table);
    if (!t) {
      t = { table: f.table, caption: f.caption || '', groups: new Map() };
      byTable.set(f.table, t);
    }
    // `col4`、`col10` 这种是 facts.mjs 给「表头是裸数字（并发数 2/4/8）」的列
    // 起的占位名，只有当列名才看得懂才有对比价值，占位列直接跳过。
    if (/^col\d+$/.test(f.column)) continue;
    const gName = f.group || '—';
    let g = t.groups.get(gName);
    if (!g) {
      g = { name: gName, columns: [], rows: new Map() };
      t.groups.set(gName, g);
    }
    if (!g.columns.includes(f.column)) g.columns.push(f.column);
    let r = g.rows.get(f.method);
    if (!r) {
      r = { method: f.method, cells: new Map() };
      g.rows.set(f.method, r);
    }
    // 同一 (方法, 列) 可能因 LaTeX 里重复出现而有多条，取第一条即可
    if (!r.cells.has(f.column)) r.cells.set(f.column, { value: f.value, id: f.id });
  }

  const scored = [];
  for (const t of byTable.values()) {
    // 带 `\rowcolor` 强调的消融表在结构上和对比表长得一样（多行 × 多列），
    // 但它的「行」是自己的变体，不是别人。这类表的 caption 一定写着
    // ablation/analysis，挡掉——错把消融当「和谁比」是最丢分的那种错。
    if (/ablation|hyperparameter|schedule/i.test(t.caption)) continue;
    let best = 0;
    let hasOurs = false;
    for (const g of t.groups.values()) {
      if (g.rows.size < 3 || g.columns.length < 3) continue;
      best = Math.max(best, g.rows.size * g.columns.length);
      for (const m of g.rows.keys()) if (isOurs(m)) hasOurs = true;
    }
    if (best) scored.push({ t, score: best, hasOurs });
  }
  // 有「本工作」那一行的表优先：那才是真正的横向对比。
  scored.sort((a, b) => Number(b.hasOurs) - Number(a.hasOurs) || b.score - a.score);

  return scored.slice(0, maxTables).map(({ t }) => ({
    table: t.table,
    caption: t.caption,
    groups: [...t.groups.values()]
      .filter((g) => g.rows.size >= 3 && g.columns.length >= 3)
      // 方法多的排前面：一般就是主实验表
      .sort((a, b) => b.rows.size - a.rows.size)
      .map((g) => ({
        name: g.name,
        columns: g.columns,
        rows: [...g.rows.values()].map((r) => ({
          method: r.method,
          ours: isOurs(r.method),
          values: g.columns.map((c) => r.cells.get(c)?.value ?? ''),
          facts: g.columns.map((c) => r.cells.get(c)?.id ?? ''),
        })),
      })),
  }));
}

// ---------------------------------------------------------------- 机制维度（LLM）

/** 归一化：去掉 markdown 强调和多余空白，只为了做子串比对。
 *  行内公式保留**内部内容**而不是整段删掉——「所有 $L$ 层骨干」和「所有 L 层骨干」
 *  在语义上一样，删掉 `$L$` 会让两边都对不上，白白丢掉正确条目。 */
function norm(s) {
  return String(s)
    .replace(/[*_`]{1,3}/g, '')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 把出处句子在原文里找一遍。返回 true 表示「逐字出现过」（忽略强调符与空白差异）。 */
function traceable(source, haystack) {
  const needle = norm(source);
  if (needle.length < 8) return false;
  return haystack.includes(needle);
}

function readMaybe(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const articleMd = readMaybe(join(dir, 'article.md'));
const researchMd = readMaybe(join(dir, 'research.md'));
// 模型只需要「方法和基线」那几节，全文喂进去是浪费额度也稀释注意力。
function excerpt(md, limit) {
  return md.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, limit);
}

const SYSTEM = `你在帮一位算法工程师做论文的横向对比，读者是已经读过摘要、想知道「这篇和那几篇到底差在哪」的人。

规则，按重要性排序：
1. 只写原文里支持得住的东西。凡是原文没说的，一律不要写，不要用「可能」「通常」去补。
2. 每个条目必须附一句 source：**从给定材料里逐字复制**的一句话（≥15 字）。不是转述，是复制。脚本会做子串校验，对不上的条目会被直接丢掉。
3. 对比维度要选「能从机制上区分的」，不要选「效果更好」这种。好的维度例如：条件化发生的位置、条件信息的载体、注意力方向、监督信号、额外的解码开销、部署约束。
4. 判断要尖锐但不夸大。指出对方的局限时，用原文的措辞，不要自己加形容词。
5. values 里的键必须和 baselines 里的 name 完全一致；本工作那一列放在 ours 字段。
6. **所有公式一律用 $…$ 包起来**，机制与代价两栏也一样。写成 $\alpha_i$、$q_j$、$1-d_{\mathrm{TV}}(p,q)$、
   $\prod_i \alpha_i$、$c_i=\mathbf{1}[i\le j^*]$、$e^{-(i-1)/\gamma_d}$。不要写裸文本 \`q_j\`、\`α_i\`、\`∏α_i\`——
   站点会把 $…$ 交给 KaTeX 排版，裸文本只会原样印成带下划线的字符。
   单字母下标也要包：写 $p_i$ 不写 p_i。希腊字母用 LaTeX：$\alpha$ $\gamma$ $\sigma$ $\delta$ $\rho$。
   数学运算符同样：$\le$ 不写 ≤，$\approx$ 不写 ≈，$\prod$ 不写 ∏。

只输出 JSON，不要解释。`;

const USER = `论文简称：${SELF}

请输出下面的 JSON：

{
  "baselines": [
    {
      "name": "对比对象的名字（和原文一致）",
      "lineage": "同作者前作 / 同一路线 / 经典基线 / 无关",
      "mechanism": "它怎么做条件化的，一句话",
      "cost": "它的代价或缺的东西，一句话",
      "source": "逐字复制的原文句子"
    }
  ],
  "dimensions": [
    {
      "name": "对比维度名",
      "ours": "本工作在这维上的做法",
      "values": { "对比对象名": "它在这维上的做法" },
      "source": "逐字复制的原文句子"
    }
  ],
  "takeaways": ["2-4 条判断，每条要能指回上面的维度或正文里的数字"]
}

要求：
- baselines 覆盖材料里出现的所有并行草稿/竞争方法，2-6 个。
- dimensions 3-6 条，是真正区分方法的机制差异，不是性能排名。
- 维度表读起来应该像「同一张设计图上的不同选择」。

=== 材料 A：解读正文（已核过数字） ===
${excerpt(articleMd, 24000)}

=== 材料 B：检索阶段笔记（基线来源） ===
${excerpt(researchMd, 8000)}`;

async function buildMechanism() {
  const { createLlm, extractJson } = await import('./lib/llm.mjs');
  const llm = createLlm();
  if (!llm.configured) throw new Error('LLM 未配置，用 --no-llm 只生成数字部分');

  // 裸公式（`q_j`、`1-d_TV`、`∏α_i`）在站点上不排版，只会原样印出来。
  // 2026-11-18 用户指出「最后的表格里面还会有些公式」——bebop 那张对比表的
  // 39 个格子里全是这种写法。提示词已经补了规则，这里再机械验一道：
  // 发现裸公式就带反例重问一次，仍不干净才落盘并报出来，不静默放行。
  const BARE_RE = /[A-Za-zα-ωΑ-Ω][α-ωΑ-Ω]*(?:_\{[^}]{1,12}\}|_[0-9A-Za-z]|\^\{[^}]{1,12}\}|\^[0-9A-Za-z])+|[∏Σ∇∂≈≤≥∝]/;
  const bareIn = (s) => {
    if (typeof s !== 'string') return null;
    const x = s.replace(/\$\$[\s\S]*?\$\$/g, ' ').replace(/\$[^$\n]+?\$/g, ' ');
    const m = x.match(BARE_RE);
    return m ? m[0] : null;
  };
  const collectBare = (obj) => {
    const out = [];
    for (const b of obj.baselines ?? []) {
      for (const k of ['mechanism', 'cost', 'lineage']) { const v = bareIn(b?.[k]); if (v) out.push(`${b.name}.${k}: ${v}`); }
    }
    for (const d of obj.dimensions ?? []) {
      const o = bareIn(d?.ours); if (o) out.push(`${d.name}.ours: ${o}`);
      for (const [k, v] of Object.entries(d?.values ?? {})) { const w = bareIn(v); if (w) out.push(`${d.name}.${k}: ${w}`); }
    }
    for (const t of obj.takeaways ?? []) { const v = bareIn(t); if (v) out.push(`takeaway: ${v}`); }
    return out;
  };

  const ask = async (extra) => {
    const text = await llm.complete({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER + (extra ? `\n\n${extra}` : '') },
      ],
      maxTokens: 6000,
      temperature: 0.2,
      jsonMode: true,
    });
    return extractJson(text);
  };

  let parsed = await ask('');
  let bare = collectBare(parsed);
  if (bare.length) {
    console.warn(`⚠️ 上一轮有 ${bare.length} 处裸公式，带反例重问：${bare.slice(0, 4).join('；')}`);
    parsed = await ask(`上一轮这些地方写成了裸公式，全部改成 $…$ 再输出一遍：\n${bare.slice(0, 12).map((x) => `- ${x}`).join('\n')}`);
    bare = collectBare(parsed);
    if (bare.length) console.warn(`⚠️ 仍有 ${bare.length} 处裸公式（已落盘，需人工看一眼）：${bare.slice(0, 6).join('；')}`);
  }
  const haystack = norm(`${articleMd}\n${researchMd}`);

  // 出处校验：对不上的条目不进产物，但要留在 dropped 里——
  // 静默丢弃会让人以为模型就是这么写的，其实是被拦下来的。
  const dropped = [];
  const keepIfTraceable = (item, what) => {
    if (traceable(item.source, haystack)) return true;
    dropped.push({ item: what, reason: '出处句未在原文中找到', source: item.source });
    return false;
  };

  const baselines = (parsed.baselines ?? []).filter((b) => {
    if (!b?.name) return false;
    return keepIfTraceable(b, `baseline:${b.name}`);
  });
  const names = new Set(baselines.map((b) => b.name));

  const dimensions = (parsed.dimensions ?? []).filter((d) => {
    if (!d?.name) return false;
    return keepIfTraceable(d, `dimension:${d.name}`);
  }).map((d) => ({
    name: d.name,
    ours: d.ours ?? '',
    // 模型偶尔会给没出现在 baselines 里的名字，滤掉，否则表头对不上
    values: Object.fromEntries(Object.entries(d.values ?? {}).filter(([k]) => names.has(k))),
    source: d.source,
  }));

  const takeaways = (parsed.takeaways ?? []).filter((t) => typeof t === 'string' && t.trim());

  return { baselines, dimensions, takeaways, dropped, model: llm.model };
}

// ---------------------------------------------------------------- 主流程

const numeric = buildNumeric({ tableFilter: args.table ? String(args.table) : undefined });
if (!numeric.length) {
  console.error('facts.json 里没有找到「多方法 × 多指标」的表，无法生成对比。');
  process.exit(1);
}

let mechanism = { baselines: [], dimensions: [], takeaways: [], dropped: [], model: '' };
if (!args['no-llm']) {
  mechanism = await buildMechanism();
} else {
  console.log('（--no-llm：只生成数字部分）');
}

const out = {
  slug,
  generated_at: new Date().toISOString(),
  model: mechanism.model,
  title: args.title ? String(args.title) : '横向对比',
  self: SELF,
  numeric,
  baselines: mechanism.baselines,
  dimensions: mechanism.dimensions,
  takeaways: mechanism.takeaways,
  dropped: mechanism.dropped,
};

const outPath = join(dir, 'compare.json');
writeFileSync(outPath, `${JSON.stringify(out, null, 1)}\n`, 'utf8');

if (args.print) console.log(JSON.stringify(out, null, 1));

const cellCount = numeric.reduce((n, t) => n + t.groups.reduce((m, g) => m + g.rows.length * g.columns.length, 0), 0);
console.log(JSON.stringify({
  wrote: `articles/${slug}/compare.json`,
  tables: numeric.map((t) => `${t.table}(${t.groups.map((g) => `${g.name}:${g.rows.length}×${g.columns.length}`).join(',')})`),
  cells: cellCount,
  baselines: out.baselines.length,
  dimensions: out.dimensions.length,
  takeaways: out.takeaways.length,
  dropped: out.dropped.length,
  droppedDetail: out.dropped.map((d) => d.item),
}, null, 1));
