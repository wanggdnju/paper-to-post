#!/usr/bin/env node
/**
 * 生成「交付清单」：这一篇产生了哪些素材、分别在哪、你还需要做什么。
 *
 *   node scripts/deliverable-report.mjs --slug=dspine
 *   → articles/<slug>/交付清单.md
 *
 * 设计原则：**全部从磁盘现状读取**，不写死数字。
 * 素材是渲染出来的、草稿是上传过的，手写清单一定会和实际产物脱节
 * （README 里的「14 张」就过期成了 10 张）。所以这里每次都重新扫一遍并实测。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/deliverable-report.mjs --slug=<slug>');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
if (!existsSync(join(dir, 'article.yaml'))) {
  console.error(`✗ 没有 articles/${slug}/article.yaml`);
  process.exit(1);
}
const { data: meta } = parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8'));
const title = meta.title ?? slug;

// ---- 小工具 ----
const kb = (file) => {
  try { return `${(statSync(file).size / 1024).toFixed(0)} KB`; } catch { return '—'; }
};
const pngSize = (file) => {
  try {
    const buf = readFileSync(file).subarray(0, 24);
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    return `${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)}`;
  } catch { return null; }
};
const rel = (p) => relative(ROOT, p);
const exists = (p) => existsSync(join(ROOT, p));

// ---- 1. 小红书切图 ----
const xhsDir = join(ROOT, 'dist/xhs');
const xhsAll = existsSync(xhsDir) ? readdirSync(xhsDir).sort() : [];
const covers = xhsAll.filter((n) => n === `${slug}-00-cover.png`);
const slides = xhsAll.filter((n) => new RegExp(`^${slug}-\\d+\\.png$`).test(n) && !n.includes('cover'));
const slideLabels = readLabels(slides);

// ---- 2. 其它平台产物 ----
const artifacts = [
  { name: '小红书切图', path: `dist/xhs/${slug}-00-cover.png`, note: `${slides.length + covers.length} 张` },
  { name: 'H5 单文件', path: `dist/html/${slug}.html` },
  { name: '知乎 HTML', path: `dist/zhihu/${slug}.html` },
  { name: '公众号 HTML', path: `dist/wechat/${slug}.html` },
];

// ---- 3. 正文源文件 ----
const sources = [
  ['article.md', '完整解读（H5 / 公众号正文的来源）'],
  ['xhs-article.md', '小红书精简版正文（切图来源）'],
  ['xhs.md', '小红书发布文案（带话题标签）'],
  ['zhihu.md', '知乎发布稿（render:zhihu 的输入，行间公式在文首清单里）'],
];

// ---- 4. 各平台状态与要你做的事 ----
const platforms = meta.platforms ?? {};
// 平台草稿建好之后，清单要说「草稿在哪、去核对」，而不是「可以灌进去」——
// 用户会照着清单去草稿箱找，找不到就以为没建。判据两处都认：显式 id，或状态机里标成 draft。
const isDraft = (name) => platforms[name]?.status === 'draft';
const todo = [];
const collect = (name, items) => { if (items.length) todo.push({ name, items }); };

if (exists(`dist/zhihu/${slug}.html`)) {
  const html = readFileSync(join(ROOT, `dist/zhihu/${slug}.html`), 'utf8');
  // 公式已经是原生节点（data-eeimg=2），不再是【公式N】占位符
  const formulaN = (html.match(/class="ztext-math"/g) ?? []).length;
  const imgN = (html.match(/<img /g) ?? []).length;
  const tableN = (html.match(/<table/g) ?? []).length;
  // 已经灌过就报「草稿在哪」，别再说「可以灌进去」——用户会去草稿箱找，找不到就以为没建
  const zhihuDraft = meta.zhihu_draft_id ? String(meta.zhihu_draft_id) : (isDraft('zhihu') ? '已建' : '');
  collect('知乎', [
    zhihuDraft
      ? `草稿已进草稿箱（${zhihuDraft === '已建' ? '创作中心 → 内容管理 → 草稿箱' : `id \`${zhihuDraft}\``}）：打开后过一眼排版`
      : `正文+图片+公式可以灌进编辑器：把 examples/drivers/ 装到 drivers/ 后跑 \`npm run publish:platform -- --slug=${slug} --to=zhihu\`（标题、${imgN} 图、${tableN} 表、${formulaN} 个公式一次做完，不点发布）`,
    zhihuDraft ? '' : '重建已存在的草稿加 `--reset`',
    zhihuDraft ? '**重点看图注**：图片注释在 figcaption，不是图片下面的正文段落' : '',
    zhihuDraft ? '**重点看公式**：`data-eeimg` 必须是 `2`（行间、居中），不是 `1`（行内、左对齐）' : '',
    '在编辑器里过一眼排版（图片是否上传完成、表格是否可编辑、公式是否居中）',
    '**点「发布」不可撤回**，确认后再点；这一步只能你自己来',
  ].filter(Boolean));
}

if (slides.length) {
  collect('小红书', [
    isDraft('xiaohongshu')
      ? `草稿已存（${slides.length + covers.length} 张图已传、标题与正文已写）：creator.xiaohongshu.com → 发布笔记 → 草稿箱 → 打开核对`
      : `上传 ${slides.length + covers.length} 张图（封面在前，顺序 00 → ${String(slides.length).padStart(2, '0')}）`,
    isDraft('xiaohongshu')
      ? '**点「发布」不可撤回**，确认后再点；这一步只能你自己来'
      : '正文复制 `articles/' + slug + '/xhs.md` 的「正文」一节（含话题标签）',
    covers.length ? '封面已是 3:4 手机比例，不用再裁' : '⚠️ 没找到封面图，先跑 render:article',
  ]);
}

const wechatDraft = meta.wechat_draft_id ? String(meta.wechat_draft_id) : '';
// 元信息块有没有外链决定公众号产物有没有二维码。教程类（kind: guide）常常一条外链都没有，
// 那时清单里不该再让人「长按二维码」——照着找会找不到（2026-11-16 primer 就是这种）。
const articleMdPath = join(dir, 'article.md');
const articleHead = existsSync(articleMdPath)
  ? (readFileSync(articleMdPath, 'utf8').split(/\n##\s/)[0] ?? '')
  : '';
const hasMetaLink = /https?:\/\//.test(articleHead);
collect('公众号', [
  wechatDraft
    ? `草稿已进草稿箱（media_id \`${wechatDraft}\`）：mp.weixin.qq.com → 内容管理 → 草稿箱 → 预览`
    : '还没建草稿：`npm run publish:platform -- --slug=' + slug + ' --to=wechat`（需要 .env 里的公众号凭据）',
  '预览时重点看：公式图片大小、表格在手机上的效果、图片能否点开放大',
  hasMetaLink
    ? '元信息块那排二维码：长按一枚试试能否识别（公众号正文外链天然不可点，只能靠扫码）'
    : '元信息块没有外链，公众号产物里没有二维码（教程类不挂 arXiv / 代码链接）',
  '「阅读原文」已指向个人站本篇页面，发布前可以点一下确认没 404',
  '**发送必须你自己在后台点**——脚本只建草稿，不调群发接口',
]);

if (exists(`dist/html/${slug}.html`)) {
  collect('H5', [
    `预览：\`npm run serve:html -- --slug=${slug}\` → http://127.0.0.1:8088/${slug}.html`,
    `或直接打开 [dist/html/${slug}.html](dist/html/${slug}.html)（单文件、可发给别人）`,
  ]);
}

// ---- 5. 组装 Markdown ----
const lines = [];
lines.push(`# 交付清单：${title}`, '');
lines.push(meta.arxiv_id
  ? `> arXiv:${meta.arxiv_id}　生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
  : `> 来源:${meta.source_title || meta.kind || '—'}　生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
lines.push('> 这份文件由 `node scripts/deliverable-report.mjs --slug=' + slug + '` 自动生成，每次渲染后可重跑。', '');

lines.push('## 一、产生了哪些素材', '');
lines.push('| 产物 | 路径 | 大小 | 规格 |', '| --- | --- | --- | --- |');
if (covers.length) {
  const p = join(xhsDir, covers[0]);
  lines.push(`| 小红书封面 | \`${rel(p)}\` | ${kb(p)} | ${pngSize(p) ?? '—'} |`);
}
if (slides.length) {
  const dims = pngSize(join(xhsDir, slides[0]));
  const total = slides.reduce((s, n) => s + statSync(join(xhsDir, n)).size, 0);
  lines.push(`| 小红书正文切图 | \`dist/xhs/${slug}-01…${String(slides.length).padStart(2, '0')}.png\` | 共 ${(total / 1024 / 1024).toFixed(1)} MB | 每张 ${dims ?? '—'}，${slides.length} 张 |`);
}
for (const a of artifacts.slice(1)) {
  if (exists(a.path)) lines.push(`| ${a.name} | \`${a.path}\` | ${kb(join(ROOT, a.path))} | — |`);
}
lines.push('');

if (slides.length) {
  lines.push('### 小红书每屏讲什么', '');
  lines.push('| 屏 | 内容 |', '| --- | --- |');
  lines.push('| 封面 | 大数字 + 四张数据卡 |');
  slides.forEach((name, i) => {
    const label = slideLabels[i] ? slideLabels[i].replace(/\|/g, '\\|') : '—';
    lines.push(`| ${String(i + 1).padStart(2, '0')} | ${label} |`);
  });
  lines.push('');
}

lines.push('## 二、正文源文件', '');
lines.push('| 文件 | 用途 | 字数 |', '| --- | --- | --- |');
for (const [file, desc] of sources) {
  const p = join(dir, file);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  const zh = (text.match(/[一-龥]/g) ?? []).length;
  lines.push(`| \`articles/${slug}/${file}\` | ${desc} | ${zh.toLocaleString()} |`);
}
lines.push('');

lines.push('## 三、你还需要做什么', '');
if (!todo.length) lines.push('_没有需要你操作的事项。_', '');
for (const { name, items } of todo) {
  lines.push(`### ${name}`, '');
  for (const it of items) lines.push(`- [ ] ${it}`);
  lines.push('');
}

lines.push('## 四、平台状态', '');
lines.push('| 平台 | 状态 |', '| --- | --- |');
for (const [k, v] of Object.entries(platforms)) {
  lines.push(`| ${k} | ${v?.status ?? '—'} |`);
}
lines.push('');

const outPath = join(dir, '交付清单.md');
writeFileSync(outPath, `${lines.join('\n')}\n`);
console.log(JSON.stringify({
  out: rel(outPath),
  slides: slides.length,
  covers: covers.length,
  todoSections: todo.map((t) => t.name),
}, null, 1));

/**
 * 每屏讲什么：render-article 会把 labels 写进 dist/xhs/<slug>-labels.json。
 * 没有这个文件（旧产物）就退回标题，不至于整列空着。
 */
function readLabels(names) {
  const p = join(xhsDir, `${slug}-labels.json`);
  if (existsSync(p)) {
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      if (Array.isArray(data) && data.length) return data;
    } catch { /* 退回下方 */ }
  }
  return names.map(() => '');
}
