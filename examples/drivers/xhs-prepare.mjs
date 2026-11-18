#!/usr/bin/env node
/**
 * 小红书「准备」阶段：切到图文模式 → 传全部切图 → 填标题。
 *
 *   node xhs-prepare.mjs <session> --slug=<slug> [--title=...] [--dry]
 *
 * 为什么单独一个脚本、和写正文分开：
 *
 *   小红书编辑器是 ProseMirror，**一次性大段写入会被判成非人工输入**，交还控制权
 *   且不自愈。所以顺序是死的：先把所有不碰编辑器的动作做完（传图、填标题、关浮层），
 *   最后才写正文。分成两个脚本，谁先谁后不会被误用；也让「只重传图片」这种
 *   局部重试成为可能，不用把正文再灌一遍。
 *
 * 踩过的坑（都在 docs/xiaohongshu-workflow.md 里）：
 *
 *   - 页面上有**两个**「上传图文」标签，第一个点了没反应，必须点第二个。
 *     判据不是位置，是「点完出现『上传图片，或写文字生成图片』」。
 *   - 图片必须**一次全传**。逐个传时文件输入框的 ref 在第一次之后就失效，
 *     后续 upload 被静默忽略——现象是「传了 10 次，计数还是 1/18」。
 *   - 标题 ≤ 20 字，且必须在**新建时**写对：事后改可能被旧快照回写覆盖。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { BSK, run, sync, sleep } from './bsk-retry.mjs';

const session = process.argv[2];
const args = Object.fromEntries(process.argv.slice(3).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!session || !args.slug) {
  console.error('用法：node xhs-prepare.mjs <session> --slug=<slug> [--title=...] [--dry]');
  process.exit(1);
}

const ROOT = process.cwd();
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const yamlSrc = readFileSync(join(dir, 'article.yaml'), 'utf8');
const yamlScalar = (key) => yamlSrc.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?$`, 'm'))?.[1] ?? '';

// ---- 切图清单：必须按 00 → 01 → … 的顺序，首图是封面
const imgDir = join(ROOT, 'dist', 'xhs');
if (!existsSync(imgDir)) {
  console.error(`✗ 没有 dist/xhs/，先跑 npm run render:article -- --slug=${slug}`);
  process.exit(1);
}
const images = readdirSync(imgDir)
  .filter((f) => f.startsWith(`${slug}-`) && /\.(png|jpe?g|webp)$/i.test(f))
  .sort();
if (!images.length) {
  console.error(`✗ dist/xhs/ 里没有 ${slug}-*.png，先跑 npm run render:article -- --slug=${slug}`);
  process.exit(1);
}

const title = String(args.title ?? yamlScalar('xhs_title') ?? '').trim();
if (!title) {
  console.error(`✗ 没有标题。article.yaml 里加 xhs_title，或用 --title=... 指定（≤20 字）`);
  process.exit(1);
}
// 小红书按字符数算，不按字节：20 个汉字或 40 个西文字母都能放下，这里按汉字口径卡
const titleLen = [...title].length;
if (titleLen > 20) {
  console.error(`✗ 标题 ${titleLen} 字，超过 20 字上限：「${title}」`);
  process.exit(1);
}

console.log(`图片 ${images.length} 张（封面 ${images[0]}），标题「${title}」（${titleLen} 字）`);
if (args.dry) {
  for (const f of images) console.log(`  dist/xhs/${f}`);
  process.exit(0);
}

/** 切到图文模式：点第二个「上传图文」，并用「出现上传区」确认真的切过去了。 */
async function switchToImageTab() {
  const picked = await run(session, `(() => {
    const tabs = [...document.querySelectorAll('.creator-tab')]
      .filter((x) => (x.innerText || '').trim() === '上传图文');
    if (!tabs.length) return JSON.stringify({ ok: false, why: 'no-tab' });
    // 页面上有两个同名标签，第一个点击无效果。倒着点：最后一个才是真正的入口。
    const t = tabs[tabs.length - 1];
    for (const e of ['mousedown', 'mouseup', 'click']) {
      t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true }));
    }
    return JSON.stringify({ ok: true, count: tabs.length });
  })()`, 3);
  await sleep(2500);
  const ready = await run(session, `(() => {
    const t = document.body.innerText || '';
    return /上传图片，或写文字生成图片/.test(t) ? 'ready' : 'not-ready';
  })()`, 3);
  if (ready !== 'ready') throw new Error(`切到图文模式失败（${picked}），页面没有出现上传区`);
  return picked;
}

/**
 * 给「上传图片」按钮打上属性，返回它的选择器。
 *
 * 不能直接指向 `input.upload-input`：那个输入框是隐藏的，没有几何尺寸，
 * bsk 会报 `element not visible`。必须由**可见按钮**触发文件选择器。
 */
async function uploadButtonSelector() {
  const sel = await run(session, `(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => (x.innerText || '').trim() === '上传图片');
    if (!b) return '';
    b.setAttribute('data-xhs-upload', '1');
    return 'button[data-xhs-upload]';
  })()`, 3);
  return sel;
}

/** 一次传完全部图片（逐个传会被静默忽略）。 */
async function uploadAll() {
  const sel = await uploadButtonSelector();
  if (!sel) throw new Error('找不到「上传图片」按钮');
  const d = sync(session);
  const argv = ['upload', sel,
    `--session=${session}`, `--context=${d.context_id}`, `--observation=${d.observation_id}`];
  for (const f of images) argv.push('--file', join(imgDir, f));
  return execFileSync(BSK, argv, { encoding: 'utf8', maxBuffer: 1e8 }).trim();
}

try {
  await switchToImageTab();
  console.log('✓ 图文模式');

  await uploadAll();
  await sleep(3000);

  // 核对计数：页面上的 "N/18"
  let counted = '';
  for (let i = 0; i < 10; i++) {
    counted = await run(session, `(() => {
      const m = (document.body.innerText || '').match(/(\\d+)\\/18/);
      return m ? m[1] : '';
    })()`, 2).catch(() => '');
    if (counted && Number(counted) >= images.length) break;
    await sleep(1500);
  }
  if (!counted) {
    console.error(`✗ 上传后没读到图片计数，请到编辑器里确认（应该是 ${images.length}/18）`);
    process.exitCode = 1;
  } else if (Number(counted) < images.length) {
    console.error(`✗ 只传上去 ${counted}/${images.length} 张。图片必须一次全传，重跑本脚本。`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 图片 ${counted}/18`);
  }

  // 填标题：input 的 placeholder 是固定文案，比 ref 稳
  await run(session, `(() => {
    const i = [...document.querySelectorAll('input')].find((x) => /标题/.test(x.placeholder || ''));
    if (!i) return 'no-input';
    i.focus();
    return 'ok';
  })()`, 3);
  const d2 = sync(session);   // 同一个观察值不能取两次
  execFileSync(BSK, ['fill', "input[placeholder*='标题']", `--value=${title}`,
    `--session=${session}`, `--context=${d2.context_id}`, `--observation=${d2.observation_id}`],
  { encoding: 'utf8', maxBuffer: 1e8 });
  await sleep(800);

  const got = await run(session, `(() => {
    const i = [...document.querySelectorAll('input')].find((x) => /标题/.test(x.placeholder || ''));
    return i ? i.value : '';
  })()`, 3);
  if (got.trim() !== title) {
    console.error(`✗ 标题没写进去（读到「${got}」）。请手动核对。`);
    process.exitCode = 1;
  } else {
    console.log('✓ 标题');
  }
} catch (e) {
  console.error(`✗ 准备阶段失败：${e.message}`);
  process.exitCode = 1;
}

// ---- 收尾：等页面真正稳定下来
//
// 传完图之后编辑器要处理图片，CDP 会持续返回 `Previous operation is still settling`，
// 这期间任何动作都被拒绝。2026-11-18 实测：连续轮询约 50 秒才恢复。
// 不等的话，紧接着写正文会立刻失败，而失败信息看起来像是「编辑器挂了」。
//
// 注意：这一步**不能关会话绕过去**——关掉会话，未保存的编辑就没了。
// prepare 和 fill 必须在同一个 session 里跑完。
async function waitSettled(maxSeconds = 120) {
  const started = Date.now();
  while ((Date.now() - started) / 1000 < maxSeconds) {
    try {
      const out = execFileSync(BSK, ['cooperate', 'sync', `--session=${session}`],
        { encoding: 'utf8', stdio: 'pipe', maxBuffer: 1e8 });
      if (!/settling|CDP|error/i.test(out)) return Math.round((Date.now() - started) / 1000);
    } catch { /* 还没好 */ }
    await sleep(3000);
  }
  return -1;
}

const waited = await waitSettled();
if (waited < 0) {
  console.error('✗ 页面 120 秒内仍未稳定。保持会话不要关，稍后手动跑 xhs-fill.mjs。');
  process.exitCode = 1;
} else {
  console.log(`✓ 页面已稳定（${waited}s）`);
}

console.log('\n同一步：node xhs-fill.mjs ' + session + ' --slug=' + slug + '   # 写正文与话题，然后暂存');
