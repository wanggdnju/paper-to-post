#!/usr/bin/env node
/**
 * 表格渲染校验：LaTeX 表源里的每个数字，必须原样出现在渲染出的 HTML 里。
 *
 *   node scripts/verify-table.mjs [--slug=eagle3] [--json]
 *
 * 退出码：0 全对得上；1 有丢格 / 多出来的数字。
 *
 * 为什么需要这一层：`latex-table.mjs` 的自检只查结构（表头、列数、残留命令），
 * 查不出「某一行整体少了最后一格」——那正是 multirow / multicolumn 组合最容易出的错，
 * 而且看起来完全正常。HTML 表格比截图强的唯一前提是它**逐格忠实**，
 * 这个前提现在由本脚本负责守住。
 *
 * 只比对**被选中那张 tabular** 的数字：EAGLE 的示例 tex 是整篇论文，
 * 源文件里当然有别的表的数字（还有 `\hspace{1.2em}` 这类排版尺寸），
 * 拿整份文件比会满屏误报。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { extractAllTablulars, pickTabular, toCompact, toHtml } from './latex-table.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));

/**
 * 每篇文章的表：表源路径 + 正文图注（决定挑哪张 tabular）+ 论文自定义宏。
 * 加新文章时在这里补一行，脚本才有得查。
 */
const CASES = [
  { slug: 'dflash', tex: 'main.tex', caption: '表 1 · 主结果表', macros: { method: 'DFlash' } },
  { slug: 'dflash', tex: 'reasoning.tex', caption: '表 2 · thinking', macros: { method: 'DFlash' } },
  { slug: 'dspine', tex: 'main.tex', caption: '表 1 · 主结果表' },
  { slug: 'eagle3', tex: 'main.tex', caption: '表 1 · 五个任务' },
  { slug: 'eagle2', tex: 'main.tex', caption: '表 1 · 六个任务' },
  { slug: 'eagle', tex: 'example_paper.tex', caption: '表 1 · HumanEval / GSM8K / Alpaca' },
];

const cases = args.slug ? CASES.filter((c) => c.slug === args.slug) : CASES;
if (!cases.length) {
  console.error(`没有 ${args.slug} 的表用例；先在 verify-table.mjs 的 CASES 里登记`);
  process.exit(1);
}

/** 表格里的数字 = 带小数点的值；`1.2em` 这类排版尺寸先剥掉 */
function sourceNumbers(tabular) {
  const cleaned = tabular
    .replace(/\\(?:hspace|vspace|setlength|arraystretch|tabcolsep|resizebox)\b[^{}]*\{[^{}]*\}/g, ' ')
    .replace(/\{[^{}]*em\}/g, ' ');
  return [...cleaned.matchAll(/(?<![\d.])(\d+\.\d+)\s*(?:\\times|×|x)?/g)].map((m) => m[1]);
}

let bad = 0;
const rows = [];
for (const c of cases) {
  const file = join('articles', c.slug, 'source/tables', c.tex);
  const tex = readFileSync(file, 'utf8');
  const picked = pickTabular(extractAllTablulars(tex), c.caption);
  const src = picked ? picked.body : tex;
  const srcNums = sourceNumbers(src);
  const tally = (list) => list.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map());
  const a = tally(srcNums);

  // 两条渲染路径都要逐格核对：
  //   wide    —— 站点用的整张 HTML 表（scripts/latex-table.mjs 的 toHtml）
  //   compact —— 知乎/公众号用的窄表（按任务拆分、Speedup/τ 合并成一格）
  // 窄表是**重排**过的，更容易在拆分时漏掉某一列，所以必须单独比一次。
  const variants = [
    ['wide', () => toHtml(tex, { caption: c.caption, macros: c.macros ?? {} }).html],
    ['compact', () => {
      const r = toCompact(tex, { caption: c.caption, macros: c.macros ?? {} });
      if (r.problems.length) throw new Error(r.problems.join('；'));
      return r.tables.flatMap((t) => [...t.header, ...t.rows.flat()]).join(' ');
    }],
  ];

  for (const [kind, render] of variants) {
    let html;
    let problems = [];
    try {
      html = render();
    } catch (e) {
      rows.push({ file, kind, ok: false, problems: [String(e.message)], missing: [], extra: [], countDiff: [], cells: srcNums.length, html: 0 });
      bad++;
      continue;
    }
    const plain = html.replace(/<[^>]+>/g, ' ');
    const nums = [...plain.matchAll(/(?<![\d.])(\d+\.\d+)/g)].map((m) => m[1]);
    const set = new Set(nums);
    const missing = [...new Set(srcNums)].filter((n) => !set.has(n));
    const extra = [...set].filter((n) => !srcNums.includes(n));
    // 出现次数也要对：同一个值可能在 A 行少一次、B 行多一次，集合比对看不出来
    const b = tally(nums);
    const countDiff = [];
    for (const [n, k] of a) if ((b.get(n) ?? 0) !== k) countDiff.push(`${n} 源 ${k} 次 / 输出 ${b.get(n) ?? 0} 次`);
    const ok = !missing.length && !extra.length && !countDiff.length && !problems.length;
    if (!ok) bad++;
    rows.push({ file, kind, ok, problems, missing, extra, countDiff, cells: srcNums.length, html: set.size });
  }
}

if (args.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    console.log(`${r.ok ? '✅' : '❌'} [${r.kind}] ${r.file}  ${r.cells} 个数字 / 输出 ${r.html} 种`);
    if (r.problems.length) console.log(`   解析问题：${r.problems.join('；')}`);
    if (r.missing.length) console.log(`   缺：${r.missing.join(', ')}`);
    if (r.extra.length) console.log(`   多：${r.extra.join(', ')}`);
    for (const d of r.countDiff.slice(0, 8)) console.log(`   次数不符：${d}`);
  }
}
process.exitCode = bad ? 1 : 0;
