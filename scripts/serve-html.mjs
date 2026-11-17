#!/usr/bin/env node
/**
 * 本地预览 H5：起一个静态服务器，并在临时目录里组装「html + assets」，
 * 保证页面在任何机器上打开都有图。
 *
 *   npm run serve:html -- --slug=dflash [--port=8088]
 *   打开 http://127.0.0.1:8088/<slug>.html
 */
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/serve-html.mjs --slug=<slug> [--port=8088]');
  process.exit(1);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(args.port ?? 8088);
const slug = String(args.slug);
const htmlPath = join(ROOT, 'dist/html', `${slug}.html`);
if (!existsSync(htmlPath)) {
  console.error(`找不到 ${htmlPath}，先跑 npm run render:html -- --in=articles/${slug}/article.md --out=dist/html/${slug}.html`);
  process.exit(1);
}
// 组装预览目录：html 与 assets 同级，图片用相对路径就能找到
const stage = join(ROOT, 'dist/.preview', slug);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(ROOT, 'articles', slug, 'assets'), join(stage, 'assets'), { recursive: true });
// 把 html 里的 ../../articles/<slug>/assets/ 改写成 assets/
const html = readFileSync(htmlPath, 'utf8').replaceAll(`../../articles/${slug}/assets/`, 'assets/');
cpSync('/dev/null', join(stage, '.keep'), { force: true });
(await import('node:fs')).writeFileSync(join(stage, `${slug}.html`), html);

const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.css': 'text/css' };
createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = join(stage, url === '/' ? `${slug}.html` : url.replace(/^\/+/, ''));
  if (!existsSync(file) || !file.startsWith(stage)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(port, '127.0.0.1', () => {
  console.log(`预览：http://127.0.0.1:${port}/${slug}.html`);
});
