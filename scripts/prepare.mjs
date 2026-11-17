#!/usr/bin/env node
/**
 * 素材一次性取齐：PDF + 全文文本 + 论文原图 + 落地链接 + 外部调研。
 *
 *   node scripts/prepare.mjs --slug=<slug> [--arxiv=<id>] [--jobs=4] [--skip=figures,links]
 *
 * 为什么要这个脚本：这五步原来是一条一条手动跑的，而且**互不依赖**——
 *   - fetch:pdf   ：浏览器会话下载 PDF（3–10s）
 *   - fetch:figures：下载 e-print、解包、Chromium 逐图渲染（10–40s）
 *   - extract:links：扫 LaTeX 源码抽仓库/模型/项目页（秒级，依赖 e-print）
 *   - research:paper：arXiv API + GitHub + Semantic Scholar + HN/Reddit（10–30s）
 *   - fetch 文本抽取：pypdf（秒级，依赖 PDF）
 *
 * 依赖关系只有两条：extract:links 要 e-print（fetch:figures 会落盘 source/latex/eprint.tar.gz），
 * 文本抽取要 PDF。所以分两组：
 *
 *   第 1 组（并发）：fetch:pdf、fetch:figures、research:paper
 *   第 2 组（并发）：extract:links（等 e-print 落盘）
 *
 * 串行时是几段时间相加，并发后约等于最慢的那一段。
 *
 * 不做的事（明确留给人工/别的脚本）：
 *   - render:table 要知道表格在第几页，必须人看 PDF 后指定；
 *   - research:platform 要走用户已登录的浏览器，有登录态和“别乱点”的约束；
 *   - briefing 依赖 research-deep.md（子智能体产出），不在这里。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { parseArxivId } from './lib/arxiv.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/prepare.mjs --slug=<slug> [--arxiv=<id>] [--jobs=4] [--skip=figures,links,research,pdf]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const yamlPath = join(dir, 'article.yaml');
if (!existsSync(yamlPath)) {
  console.error(`✗ 没有 articles/${slug}/article.yaml，先 npm run publish -- --slug=${slug} --stage=new --arxiv=<id>`);
  process.exit(1);
}

let arxivId = '';
try {
  const raw = args.arxiv
    ?? readFileSync(yamlPath, 'utf8').match(/^arxiv_id:\s*"?([^"\n]+)"?$/m)?.[1]
    ?? '';
  arxivId = parseArxivId(raw).id;
} catch {
  arxivId = '';
}
if (!arxivId) {
  console.error('✗ 拿不到 arXiv ID（article.yaml 的 arxiv_id，或 --arxiv=<id>）');
  process.exit(1);
}

const skip = new Set(String(args.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const pdfPath = `/tmp/${slug}.pdf`;
const txtPath = `/tmp/${slug}.txt`;

/** 跑一个 npm script（用 node 直接跑脚本文件，避免 npm 的额外进程与输出噪音） */
function run(label, script, argv) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, script), ...argv], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`✗ ${label}: ${error.message}`);
      resolve({ label, ok: false, seconds: 0 });
    });
    child.on('close', (code) => {
      resolve({ label, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000) });
    });
  });
}

const wave1 = [];
if (!skip.has('pdf')) {
  wave1.push(run('fetch:pdf', 'scripts/fetch-pdf.mjs', [
    `https://arxiv.org/pdf/${arxivId}`, `--out=${pdfPath}`, `--text=${txtPath}`,
  ]));
} else {
  console.log('⏭ 跳过 fetch:pdf');
}
if (!skip.has('figures')) {
  wave1.push(run('fetch:figures', 'scripts/fetch-figures.mjs', [
    `--arxiv=${arxivId}`, `--slug=${slug}`, `--jobs=${args.jobs ?? 4}`,
  ]));
} else {
  console.log('⏭ 跳过 fetch:figures');
}
if (!skip.has('research')) {
  wave1.push(run('research:paper', 'scripts/research-paper.mjs', [`--slug=${slug}`, `--arxiv=${arxivId}`]));
} else {
  console.log('⏭ 跳过 research:paper');
}

console.log(`\n第一组并发：${wave1.length} 个任务（pdf + 图 + 调研）`);
const r1 = await Promise.all(wave1);
for (const r of r1) console.log(`${r.ok ? '✓' : '✗'} ${r.label} ${r.seconds}s`);

// 第二组：链接抽取依赖 e-print（fetch:figures 落盘）
const wave2 = [];
if (!skip.has('links')) {
  const eprint = join(dir, 'source', 'latex', 'eprint.tar.gz');
  if (existsSync(eprint)) {
    wave2.push(run('extract:links', 'scripts/extract-links.mjs', [`--slug=${slug}`, `--pdf=${pdfPath}`]));
  } else {
    console.log('⏭ 没有 e-print（fetch:figures 失败？），跳过 extract:links');
  }
}
const r2 = wave2.length ? await Promise.all(wave2) : [];
for (const r of r2) console.log(`${r.ok ? '✓' : '✗'} ${r.label} ${r.seconds}s`);

// 论文全文落盘到 articles/<slug>/source/。
//
// 以前只写 /tmp/<slug>.txt：几天后再跑 critic 就找不到原文，于是它对着一篇「没有论文」
// 的稿子只查内部一致性，然后大段报「论文里没有这个数字」——全是假阳性
// （2026-11-16 DFlare 的 γ0=4.5、63 个标量、附录 A.1 的 γ 调度都被判成无出处）。
// 落进仓库后 critic / 人工复核都能直接引用。
{
  const srcDir = join(dir, 'source');
  mkdirSync(srcDir, { recursive: true });
  for (const [from, name] of [[pdfPath, 'paper.pdf'], [txtPath, 'paper.txt']]) {
    if (existsSync(from)) copyFileSync(from, join(srcDir, name));
  }
}

const failed = [...r1, ...r2].filter((r) => !r.ok).map((r) => r.label);
console.log(`\n素材完成。PDF：${pdfPath}　全文：${txtPath}`);
console.log(`已归档：articles/${slug}/source/paper.pdf、paper.txt`);
console.log(`下一步：npm run research:platform（可选）→ npm run briefing → npm run pipeline -- --slug=${slug} --src=<LaTeX 目录>`);
if (failed.length) {
  console.error(`⚠️ 失败：${failed.join('、')}（其余产物已生成，可按需重跑）`);
  process.exit(1);
}
