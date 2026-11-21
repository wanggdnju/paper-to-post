#!/usr/bin/env node
/**
 * 一条命令从「稿子写完」走到「可发布」：推进状态机 + 渲染三平台产物 + 出一屏预览。
 *
 *   node scripts/finalize.mjs --slug=<slug> [--digest="..."] [--strict] [--dry]
 *
 * 只做机械活，不点任何发布按钮：
 *   outlined → drafted → checked → reviewed → rendered
 *   + render:html / render:zhihu
 *   + preview.mjs（发布前一眼）
 *
 * 为什么要它：这几步原来要手动敲六次命令，而且每次都要自己想「现在该到哪一步」。
 * 所有判断都在这条链里自动做了：
 *   - digest 没写就从 TL;DR 自动摘一段（80–128 字，且不能等于首段）
 *   - 调研不完整时自动降级为告警（这条链不再停下来等人补材料）
 *   - critic 的 high 只告警不阻断（它是编辑判断，不是机器错误）
 *   - publish-check 有 ❌ 才停——那是数字/表格/结构真错了，必须修
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = process.cwd();
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/finalize.mjs --slug=<slug> [--digest="..."] [--strict] [--dry]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const yamlPath = join(dir, 'article.yaml');
if (!existsSync(yamlPath)) {
  console.error(`✗ 没有 articles/${slug}/article.yaml`);
  process.exit(1);
}
const articlePath = join(dir, 'article.md');
if (!existsSync(articlePath)) {
  console.error(`✗ 没有 articles/${slug}/article.md（先跑 npm run pipeline -- --slug=${slug}）`);
  process.exit(1);
}

/** 从一个段落里挑 80–128 字、且不以首段 20 字开头的摘要 */
function autoDigest() {
  const md = readFileSync(articlePath, 'utf8');
  const tldr = (md.split(/^##\s+TL;DR\s*$/m)[1] ?? '').split(/^##\s+/m)[0].trim();
  const paras = tldr.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !p.startsWith('|'));
  const first = (paras[0] ?? '').replace(/[*_`]/g, '');
  const zh = (t) => (t.match(/[一-龥]/g) ?? []).length;
  for (const raw of [...paras.slice(1), ...paras]) {
    const text = raw.replace(/[*_`]/g, '').replace(/\s+/g, ' ');
    if (zh(text) < 80) continue;
    // 按句号截到 80–128 字
    let picked = '';
    for (const s of text.split(/(?<=[。！？])/)) {
      if (zh(picked + s) > 128) break;
      picked += s;
      if (zh(picked) >= 80) break;
    }
    if (zh(picked) < 80) picked = text.slice(0, 128);
    if (zh(picked) < 80 || zh(picked) > 128) continue;
    if (first.includes(picked.slice(0, 20))) continue;   // A3：不能等于首段
    return picked;
  }
  return '';
}

const meta = parseArticle(readFileSync(yamlPath, 'utf8')).data;
// yaml 里已有的 digest 优先，不必每次重算（重算出来的可能和已发布的那版不一致）。
const digest = args.digest
  ? String(args.digest)
  : ((meta.digest && String(meta.digest).trim()) || autoDigest());

function run(label, argv) {
  const started = Date.now();
  // 直接继承 stdio：这些子命令的输出（自检的 ✅/❌、切图进度、预览那一屏）就是给人看的，
  // 捕获起来只在失败时才打印，会让整个过程看起来「什么都没做」。
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: 'inherit' });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (r.status === 0) {
    console.log(`✓ ${label}（${seconds}s）`);
    return true;
  }
  console.error(`✗ ${label} 失败（退出码 ${r.status}）`);
  return false;
}

const stage = (name, extra = []) => run(`stage ${name}`, [join(ROOT, 'scripts/publish.mjs'), `--slug=${slug}`, `--stage=${name}`, ...extra]);

/**
 * 状态机不允许跳阶段，所以「已经超过某一步」时直接跳过即可；
 * 但 --stage=rendered 会重跑切图，产物在的时候没必要再花 3 秒。
 */
function ensure(name, extra = []) {
  if (order.indexOf(status) >= order.indexOf(name)) return true;
  if (!stage(name, extra)) process.exit(1);
  status = name;
  return true;
}

if (args.dry) {
  console.log(`当前状态：${meta.status}`);
  console.log(`将推进：outlined → drafted → checked → reviewed → rendered`);
  console.log(`digest：${digest || (meta.digest || '（需要 --digest）')}`);
  process.exit(digest || meta.digest ? 0 : 1);
}

let status = String(meta.status ?? 'new');
const order = ['new', 'outlined', 'drafted', 'checked', 'reviewed', 'rendered'];

ensure('outlined');

if (order.indexOf(status) < order.indexOf('drafted')) {
  // yaml 里已经有 digest 就直接用（它不是必须每次重算的字段），
  // 只有真的没有才要求自动摘要成功。原来的写法把「已有 digest」也传成空串，
  // 于是第二次跑 finalize 会莫名其妙报「自动摘要失败」（2026-11-13 实际踩到）。
  const existing = meta.digest && String(meta.digest).trim();
  const finalDigest = args.digest ? String(args.digest) : (existing || digest);
  if (!finalDigest) {
    console.error('✗ 自动摘要失败（TL;DR 里没有 80–128 字、且不等于首段的段落）。用 --digest="..." 指定。');
    process.exit(1);
  }
  ensure('drafted', [`--digest=${finalDigest}`, '--allow-missing-research']);
}

ensure('checked', args.strict ? ['--strict'] : []);
ensure('reviewed');
ensure('rendered');

// 另外两个平台的 HTML 产物（不含上传，上传在发布阶段）
const mdPath = `articles/${slug}/article.md`;
run('render:html', [join(ROOT, 'scripts/render-html.mjs'), `--in=${mdPath}`,
  `--out=dist/html/${slug}.html`, `--arxiv=${meta.arxiv_id ?? ''}`, `--venue=${meta.venue ?? ''}`]);
run('render:zhihu', [join(ROOT, 'scripts/render-zhihu.mjs'), `--slug=${slug}`]);

run('preview', [join(ROOT, 'scripts/preview.mjs'), `--slug=${slug}`]);
console.log('下一步：建草稿 —— npm run render:wechat -- --slug=' + slug
  + '（--upload 需要公众号凭据），或 npm run publish:platform -- --slug=' + slug + ' --to=<driver>。');
