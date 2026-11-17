#!/usr/bin/env node
/**
 * 发布前一眼：把「你要看的东西」压缩到一屏。
 *
 *   node scripts/preview.mjs --slug=<slug>
 *
 * 为什么需要：整条链路现在是自动的，人只在**发布前**看一眼。
 * 但让人去翻 7000 字正文、25 项自检、critic 清单是不现实的——
 * 这一屏只回答四个问题：
 *   ① 这篇讲什么（标题 + TL;DR 第一段 + 8 个小节名）
 *   ② 数字和素材靠不靠谱（自检 ❌ 数、未处理的 critic high 数）
 *   ③ 各平台产物齐不齐（切图张数、知乎稿、公众号草稿）
 *   ④ 文稿读起来怎么样（润色前后的句长、被保留原文的小节）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/preview.mjs --slug=<slug>');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const articlePath = join(dir, 'article.md');
if (!existsSync(articlePath)) {
  console.error(`✗ 没有 articles/${slug}/article.md`);
  process.exit(1);
}

const read = (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : '');
const meta = existsSync(join(dir, 'article.yaml'))
  ? parseArticle(readFileSync(join(dir, 'article.yaml'), 'utf8')).data
  : {};
const md = readFileSync(articlePath, 'utf8');
const glyphs = (t) => (t.match(/[一-龥]/g) ?? []).length;

const h2 = [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
const tldr = (md.split(/^##\s+TL;DR\s*$/m)[1] ?? '').split(/^##\s+/m)[0].trim();
const firstPara = (tldr.split(/\n\s*\n/).find((p) => p.trim() && !p.startsWith('|')) ?? '').trim();
const tables = (md.match(/^\|/gm) ?? []).length;
const images = (md.match(/^!\[/gm) ?? []).length;

const score = existsSync(join(dir, 'score.json')) ? JSON.parse(read('score.json')) : null;
const reviewMd = read('review.md');
const failCount = (reviewMd.match(/❌/g) ?? []).length;
const passCount = (reviewMd.match(/✅/g) ?? []).length;
const polish = existsSync(join(dir, 'polish.json')) ? JSON.parse(read('polish.json')) : null;
const critic = existsSync(join(dir, 'critic.json')) ? JSON.parse(read('critic.json')) : null;
const high = (critic?.findings ?? []).filter((f) => f.severity === 'high');

const xhsDir = join(ROOT, 'dist', 'xhs');
const slides = existsSync(xhsDir)
  ? readdirSync(xhsDir).filter((n) => n.startsWith(`${slug}-`) && n.endsWith('.png')).length
  : 0;

const zhihuHtml = existsSync(join(ROOT, 'dist', 'zhihu', `${slug}.html`));
const wechatId = meta.wechat_draft_id ? '已建' : '未建';
// 草稿标记优先看 article.yaml 的 platforms.zhihu.status：知乎草稿没有 id/url 字段，
// 原来只认 meta.zhihu_draft_url/id，导致「草稿已经灌好并验收通过」仍显示「—」。
const zhihuDraft = meta.zhihu_draft_url || meta.zhihu_draft_id
  || ((meta.platforms?.zhihu?.status === 'draft') ? '已建' : '');
const platforms = meta.platforms ?? {};

const line = '─'.repeat(64);
console.log(`\n${line}`);
console.log(`  ${meta.title ?? slug}`);
console.log(`  arXiv:${meta.arxiv_id ?? '—'}　状态:${meta.status ?? '—'}　正文 ${glyphs(md)} 中文字　${h2.length} 节`);
console.log(line);

console.log(`\n【它讲什么】\n${firstPara.slice(0, 260)}${firstPara.length > 260 ? '…' : ''}`);
console.log(`\n【结构】${h2.join(' · ')}`);

console.log(`\n【素材】图 ${images} 张　表 ${tables} 行　落地链接 ${(() => {
  // 数的是**条目数**，不是 JSON 的 key 数：以前把 slug/generatedAt/github/… 一起数，
  // 三个空分类也算进去，于是每篇都显示「9 类」——对一个只有 1 个仓库的稿子。
  try {
    const l = JSON.parse(read('assets/links.json') || '{}');
    return ['github', 'huggingface', 'modelscope', 'project', 'paper', 'other', 'related']
      .reduce((n, k) => n + (Array.isArray(l[k]) ? l[k].length : 0), 0);
  } catch { return 0; }
})()} 条`);


const checks = reviewMd
  ? `自检 ${passCount} 项通过${failCount ? ` / ${failCount} 项 ❌` : '（无 ❌）'}`
  : (score ? `评分 ${score.total ?? score.score ?? '—'}` : '自检未跑');
// qa.json 是 qa.mjs 的产物；手写问答（用户给题、人工核过）不会生成它。
// 直接数正文里的 `**问题 N：`，否则手写稿永远显示「文末问答 未生成」，
// 明明正文里躺着 8 条（2026-11-16 DFlare）。
const qaFile = existsSync(join(dir, 'qa.json')) ? JSON.parse(read('qa.json')) : null;
const qaInline = (read('article.md').match(/^\*\*问题\s*\d+[：:]/gm) ?? []).length;
const qa = qaFile ?? (qaInline ? { questions: qaInline } : null);
// 正文里问答已经不分「动机/机制」这类组了（见 qa.mjs renderSection），
// 这里也就不再按 tier 拆开报——预览是给人看的，展示一个和正文一致的数字即可。
const qaNote = qa
  ? `文末问答 ${qa.questions} 条${qa.failing?.length ? `，${qa.failing.length} 条待修` : ''}`
  : '文末问答 未生成';
console.log(`\n【质检】${checks}　` +
  `critic ${critic ? `${critic.paragraphs_reviewed} 段 / high ${high.length}` : '未跑'}` +
  `${high.length ? '  ← 发布前值得看一眼' : ''}`);
console.log(`　　${qaNote}`);
for (const f of high.slice(0, 3)) console.log(`   · ${(f.problem ?? '').slice(0, 90)}`);

if (polish) {
  console.log(`\n【可读性】平均句长 ${polish.readability.before.avg} → ${polish.readability.after.avg} 字　` +
    `>60 字长句 ${polish.readability.before.longRatio}% → ${polish.readability.after.longRatio}%　` +
    `${polish.sections_polished}/${polish.sections_total} 节改写`);
  if (polish.sections_rejected) {
    console.log(`   保留原文 ${polish.sections_rejected} 节：${polish.rejected_detail.map((r) => r.id).join('、')}`);
  }
}

console.log(`\n【产物】小红书切图 ${slides || '—'} 张　` +
  `知乎 HTML ${zhihuHtml ? '✓' : '—'}　知乎草稿 ${zhihuDraft ? '✓' : '—'}　公众号草稿 ${wechatId}`);
console.log(`   平台状态：${Object.entries(platforms).map(([k, v]) => `${k}:${v.status}`).join('  ') || '—'}`);
console.log(`${line}\n`);
