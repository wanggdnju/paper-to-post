#!/usr/bin/env node
/**
 * 把一篇稿子交给某个发布驱动。
 *
 *   node scripts/publish-platform.mjs --slug=dspine                       # 手动模式：只列产物
 *   node scripts/publish-platform.mjs --slug=dspine --to=wechat           # 公众号建草稿
 *   node scripts/publish-platform.mjs --slug=dspine --to=wechat --dry     # 只渲染，不调 API
 *
 * 设计：主流程到这里为止，平台差异全部封装在 scripts/drivers/<id>.mjs 里。
 * 见 scripts/drivers/index.mjs 的接口说明与 docs/drivers.md。
 *
 * **这个脚本永远不会点「发送」。** 群发 / 发帖是不可撤销动作，
 * 脚本只做到草稿或输入框；最后一下必须由人点。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { loadDriver } from './drivers/index.mjs';
import { envGet } from './lib/env.mjs';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));

if (!args.slug) {
  console.error('用法：node scripts/publish-platform.mjs --slug=<slug> [--to=manual|wechat] [--dry]');
  console.error('  其它目标（zhihu / xiaohongshu）需要自己实现驱动，见 docs/drivers.md');
  process.exit(1);
}

const slug = String(args.slug);
const articleDir = join(ROOT, 'articles', slug);
if (!existsSync(join(articleDir, 'article.yaml'))) {
  console.error(`✗ 没有 articles/${slug}/article.yaml，先 npm run publish -- --slug=${slug} --stage=new --arxiv=<id>`);
  process.exit(1);
}

const target = String(args.to ?? 'manual');
const log = (msg) => console.log(msg);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

const driver = await loadDriver(target).catch((e) => fail(e.message));
if (!driver) process.exit(1);

const ctx = {
  root: ROOT,
  slug,
  articleDir,
  args,
  log,
  fail,
  meta: parseArticle(readFileSync(join(articleDir, 'article.yaml'), 'utf8')).data,
};

// 凭证缺失在 preflight 阶段就报，别等到上传了图片才失败
const missing = (driver.requires ?? []).filter((k) => !envGet(k));
if (missing.length) {
  fail(`${driver.label}需要 .env 里的 ${missing.join(' / ')}（见 .env.example）`);
}

log(`→ ${driver.label}（${driver.id}）  ${slug}`);
await driver.preflight?.(ctx);
const result = await driver.publish(ctx);

if (result?.draftId) log(`  草稿 ID：${result.draftId}`);
if (result?.message) log(`  ${result.message}`);
for (const [k, v] of Object.entries(result?.urls ?? {})) log(`  ${k}: ${v}`);
if (result?.ok === false) process.exitCode = 1;
