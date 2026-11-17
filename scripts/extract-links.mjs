#!/usr/bin/env node
/**
 * 从论文 PDF / LaTeX 源码里抽取「落地信息」：代码仓库、模型权重、数据集、项目主页。
 *
 *   npm run extract:links -- --slug=dflash                       # 读 articles/<slug>/source/latex/tree/*.tex
 *   npm run extract:links -- --slug=dflash --pdf=/tmp/paper.pdf  # 也从 PDF 文本里找
 *   npm run extract:links -- --slug=dspine                       # 顺手合并 research.md 里的官方仓
 *
 * 产物：articles/<slug>/assets/links.json
 *   { github: [...], huggingface: [...], modelscope: [...], project: [...], else: [...],
 *     related: [...] }   ← 官方 README 里提到的、属于别人 / 上游的链接
 *
 * ⚠️ 论文里经常出现「类似 xxx 的方案」这种引用式 GitHub 链接，需要人工确认是不是论文自己的仓库；
 * 脚本只做收集与分类，不判断归属。
 *
 * ── 为什么还要读 research.md ──
 * 论文正文常常**根本不写代码仓地址**：某篇论文的 LaTeX 里只有项目页，仓库是调研阶段
 * 从 GitHub 搜索找到的。只解析 PDF/tex 就会得到 `github: []`，
 * 而这个空数组不是「这篇没开源」，是「我们没找到」——两者在下游完全不一样
 * （H5 页头没有代码链接，读者也点不到仓库）。
 *
 * ── 只合并官方仓，不合并同名仓 ──
 * research.md 的仓库表是按关键词搜出来的，里面混着完全无关的同名项目
 * （`aster2013/Urho3DSpine` 是 Urho3D 的 Spine 运行时，`denizzzka/dspine` 是 D 语言绑定）。
 * 把它们塞进 `github` 会直接误导读者。所以只认 research.md 里
 * `### 疑似官方仓：<owner>/<repo>` 这一节，这是 `research-paper.mjs` 写出的稳定契约。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/extract-links.mjs --slug=<slug> [--pdf=/tmp/paper.pdf]');
  process.exit(1);
}
const ROOT = process.cwd();
const slug = String(args.slug);
const srcDir = join(ROOT, 'articles', slug, 'source', 'latex', 'tree');

let text = '';
const eprint = join(ROOT, 'articles', slug, 'source', 'latex', 'eprint.tar.gz');
let scanDir = srcDir;
if (!fs.existsSync(scanDir) && fs.existsSync(eprint)) {
  // 没解压过：从 e-print 包里临时解到 /tmp 再扫描
  const tmp = join('/tmp', `links-${slug}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  spawnSync('tar', ['xzf', eprint, '-C', tmp]);
  scanDir = tmp;
}
if (fs.existsSync(scanDir)) {
  for (const f of walkTex(scanDir)) text += fs.readFileSync(f, 'utf8') + '\n';
}
if (args.pdf && fs.existsSync(String(args.pdf))) {
  const out = spawnSync('python3', ['-c', `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
print("\\n".join((p.extract_text() or "") for p in r.pages))
`, String(args.pdf)], { encoding: 'utf8', maxBuffer: 1e8 });
  if (out.status === 0) text += '\n' + out.stdout;
  else console.warn('PDF 文本抽取失败（pypdf 不可用？），只用 LaTeX 源码');
}
if (!text.trim()) {
  console.error(`没有可检索的文本：先跑 npm run fetch:figures -- --arxiv=<id> --slug=${slug}，或用 --pdf 指定 PDF`);
  process.exit(1);
}

// LaTeX 里链接常见写法：\url{...}、\href{...}、\footnote{\url{...}}，以及裸 URL
const candidates = new Set();
for (const m of text.matchAll(/\\(?:url|href)\{([^}]+)\}/g)) candidates.add(m[1]);
for (const m of text.matchAll(/https?:\/\/[^\s)}\]"'，。、]+/g)) candidates.add(m[0]);
for (const m of text.matchAll(/github\.com\/[\\\w.-]+\/[\\\w.-]+/g)) candidates.add(m[0]);

const clean = (u) => u.replace(/\\_/g, '_').replace(/\\%/g, '%').replace(/[.,;]+$/, '').replace(/\\$/g, '');
const groups = { github: [], huggingface: [], modelscope: [], project: [], paper: [], other: [], related: [] };
for (const raw of [...candidates].map(clean)) {
  if (/^https?:\/\/[^/]+@/.test(raw)) continue; // 把邮箱当成 URL 了
  if (raw.includes('@') && !/github\.com\//.test(raw)) continue; // 邮箱被当成了 URL
  const url = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
  const entry = { url, host };
  if (host === 'github.com') {
    const [owner, repo] = new URL(url).pathname.split('/').filter(Boolean);
    if (!owner || !repo) continue;
    entry.repo = `${owner}/${repo}`.replace(/\.git$/, '');
    groups.github.push(entry);
  } else if (host.includes('huggingface.co') || host === 'hf.co') {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    entry.kind = ['datasets', 'spaces', 'collections'].includes(parts[0]) ? parts[0].slice(0, -1).replace(/es$/, 'e') : 'model';
    const offset = ['datasets', 'spaces', 'collections'].includes(parts[0]) ? 1 : 0;
    entry.repo = parts.slice(offset, offset + 2).join('/');
    groups.huggingface.push(entry);
  } else if (host.includes('modelscope')) {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    entry.kind = parts[0] === 'datasets' ? 'dataset' : parts[0] === 'models' ? 'model' : 'other';
    entry.repo = parts.slice(-2).join('/');
    groups.modelscope.push(entry);
  } else if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    continue; // 论文自身不算落地信息
  } else {
    // 项目主页：常见的 xxx.github.io / xxx.ai / 个人主页。
    //
    // `/blog/`、`/posts/` 这类路径**不是项目页**，是别人方法的介绍文章。
    // eagle 的 PDF 里引了一条 `lmsys.org/blog/2023-11-21-lookahead-decoding/`
    // 讲的是 Lookahead；按 host 后缀归到 project 后，页头会显示成「项目页」，
    // 读者点进去发现是竞品的博客。宁可漏收，不要错收。
    const isArticlePage = /\/(?:blog|posts?|news|papers?)\//i.test(new URL(url).pathname);
    (/(github\.io|\.ai$|\.org$|\.io$)/.test(host) && !isArticlePage ? groups.project : groups.other).push(entry);
  }
}

// 去重
for (const key of Object.keys(groups)) {
  const seen = new Set();
  groups[key] = groups[key].filter((e) => {
    const k = e.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------- 合并 research.md 的官方仓
// 论文正文常常完全不写仓库地址（dspine 就是），只解析 tex 会得到 github: []，
// 而那不是「没开源」而是「没找到」。这里把调研阶段确认过的官方仓补进来。
// 注意：只认 `### 疑似官方仓：owner/repo` 这一节，不碰上面那张同名仓表格——
// 表里混着 Urho3D 的 Spine 运行时之类的无关项目，收进来会误导读者。
const researchPath = join(ROOT, 'articles', slug, 'research.md');
if (fs.existsSync(researchPath)) {
  const research = fs.readFileSync(researchPath, 'utf8');
  const official = [...research.matchAll(/^###\s*疑似官方仓[：:]\s*([\w.-]+\/[\w.-]+)/gm)].map((m) => m[1]);
  for (const full of official) {
    const url = `https://github.com/${full}`;
    if (groups.github.some((e) => e.repo?.toLowerCase() === full.toLowerCase())) continue;
    groups.github.push({ url, host: 'github.com', repo: full, source: 'research.md' });
  }

  // 官方 README 里的权重 / 数据集（research.md 会把 README 前 60 行贴进 details 块）。
  // 只在「这一行同时提到官方仓所属组织」时才收：README 里链接到别人的基线权重
  // （z-lab/Qwen3-8B-DFlash-b16）是常事，全收进来会把别人的模型算成这家的。
  const owners = new Set(official.map((f) => f.split('/')[0].toLowerCase()));
  for (const m of research.matchAll(/https:\/\/huggingface\.co\/(?:collections\/)?([\w.-]+)\/([\w.-]+)/g)) {
    const [owner, repo] = [m[1], m[2]];
    if (!owners.has(owner.toLowerCase())) continue;
    const url = m[0];
    if (groups.huggingface.some((e) => e.url.replace(/\/$/, '') === url)) continue;
    const kind = /\/collections\//.test(url) ? 'collection'
      : /\/datasets\//.test(url) ? 'dataset'
      : /\/spaces\//.test(url) ? 'space' : 'model';
    groups.huggingface.push({ url, host: 'huggingface.co', kind, repo: `${owner}/${repo}`, source: 'research.md' });
  }

  // 「相关但不是我家的」代码：训练代码合并进上游框架、复现仓之类。
  // 单独放 related，不混进 github —— github 那一栏在 H5 页头显示成「代码 · xxx」，
  // 混进别人的仓会让读者以为那个仓就是这篇的实现。
  //
  // 只扫**非表格行**：research.md 里那张「按关键词搜到的高星仓」表格是纯噪音
  // （Urho3DSpine 是 Urho3D 的 Spine 运行时、denizzzka/dspine 是 D 语言绑定），
  // 说明列已经写明「未必是这篇的官方实现」。正文里出现的仓库（如「训练代码合并进
  // SpecForge」）才是真相关的。
  const prose = research.split('\n').filter((line) => !line.trimStart().startsWith('|')).join('\n');
  const officialLower = new Set(official.map((f) => f.toLowerCase()));
  for (const m of prose.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)/g)) {
    const full = m[1].replace(/\.git$/, '');
    if (officialLower.has(full.toLowerCase())) continue;
    const url = `https://github.com/${full}`;
    if (groups.related.some((e) => e.repo?.toLowerCase() === full.toLowerCase())) continue;
    groups.related.push({ url, host: 'github.com', repo: full, source: 'research.md' });
  }
}

const result = { slug, generatedAt: new Date().toISOString(), ...groups };
fs.mkdirSync(join(ROOT, 'articles', slug, 'assets'), { recursive: true });
fs.writeFileSync(join(ROOT, 'articles', slug, 'assets', 'links.json'), JSON.stringify(result, null, 2));

const line = (label, list) => list.length ? `${label}（${list.length}）\n` + list.map((e) => `  · ${e.repo ?? e.url}`).join('\n') : `${label}：无`;
console.log([line('GitHub', groups.github), line('HuggingFace', groups.huggingface),
  line('ModelScope', groups.modelscope), line('项目主页', groups.project), line('其它', groups.other)].join('\n\n'));
console.log(`\n→ articles/${slug}/assets/links.json`);
void execFileSync;

/** 递归收集 .tex 文件 */
function walkTex(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTex(p));
    else if (entry.name.endsWith('.tex')) out.push(p);
  }
  return out;
}
