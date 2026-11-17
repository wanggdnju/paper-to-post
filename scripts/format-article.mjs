#!/usr/bin/env node
/**
 * 把 article.md 排成「可发布」的结构：补齐开头元信息块、给图表编号、给标题编号、
 * 修掉模型生成的粘连表格。
 *
 *   node scripts/format-article.mjs --slug=eagle          # 预览 diff 摘要
 *   node scripts/format-article.mjs --slug=eagle --write  # 写回 article.md
 *
 * 为什么要单独一步，而不是让模型在写稿时就写对：
 *   这几件事都是结构性约束（不是内容判断），模型每次都在重新决定，
 *   结果就是「这篇有、那篇没有」——eagle 的 8 个二级标题一个都没编号，
 *   三级标题却从 4.1 开始；caption 有的带「图 1 ·」有的不带；开头元信息块整个丢失。
 *   代码只决定一次，而且可以事后补跑。
 *
 * 幂等：对已经格式化过的正文再跑一遍，输出不变。generate.mjs 拼装时调的是同一个函数，
 * 所以「生成时自动做」和「事后手动补」用的是同一套规则。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { formatArticle } from './lib/article-format.mjs';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/format-article.mjs --slug=<slug> [--write]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const metaPath = join(dir, 'article.yaml');
const articlePath = join(dir, 'article.md');
if (!existsSync(articlePath)) {
  console.error(`✗ 没有 articles/${slug}/article.md`);
  process.exit(1);
}

const meta = existsSync(metaPath) ? parseArticle(readFileSync(metaPath, 'utf8')).data : {};
const researchPath = join(dir, 'research.md');
const linksPath = join(dir, 'assets', 'links.json');
const research = existsSync(researchPath) ? readFileSync(researchPath, 'utf8') : '';
const links = existsSync(linksPath) ? JSON.parse(readFileSync(linksPath, 'utf8')) : null;

const before = readFileSync(articlePath, 'utf8');
const after = formatArticle(before, { meta, research, links });

const heads = (t) => (t.match(/^#{2,3}\s.*$/gm) ?? []).join('\n');
const caps = (t) => (t.match(/^!\[.*$/gm) ?? []).join('\n');
const changes = {
  metaBlock: !/^>\s*\*\*论文\*\*/m.test(before.split(/\n##\s/)[0]) && /^>\s*\*\*论文\*\*/m.test(after),
  headings: heads(before) !== heads(after),
  captions: caps(before) !== caps(after),
  // 「粘连」只在**非表格行**里算：表头 `| 模型（T=0） | …` 本身就以 `）` 结尾，
  // 拿全文正则去数会把正常表头当成粘连，永远显示「有改动」。
  tables: glued(before) && !glued(after),
};

/** 是否存在「段落与表格挤在同一行」的行 */
function glued(t) {
  return t.split('\n').some((l) => !l.trimStart().startsWith('|') && /[。！？；】）)]\s*\|/.test(l));
}

if (args.write) {
  if (after !== before) {
    writeFileSync(`${articlePath}.bak`, before, 'utf8');
    writeFileSync(articlePath, after, 'utf8');
  }
  console.log(JSON.stringify({ slug, written: after !== before, changes }, null, 1));
} else {
  // 预览：只打印「哪些行会变」，不落盘
  const b = before.split('\n');
  const a = after.split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) diff.push({ line: i + 1, before: (b[i] ?? '').slice(0, 100), after: (a[i] ?? '').slice(0, 100) });
  }
  console.log(JSON.stringify({ slug, wouldChange: after !== before, changes, diff: diff.slice(0, 40), totalDiff: diff.length }, null, 1));
}
