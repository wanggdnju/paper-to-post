#!/usr/bin/env node
/**
 * 把正文 + 话题一次性写进小红书编辑器，并可顺手存草稿。
 *
 *   node examples/drivers/xhs-fill.mjs <session> --slug=<slug> [--save] [--dry]
 *
 * 前提：图片**已经传好**、标题**已经填好**（见 references/xhs-publish.md 的步骤 1–4）。
 * 这个脚本只负责最后那一步——正文和话题。
 *
 * 为什么必须一步写完：
 *   tiptap/ProseMirror 里任何一次 `execCommand` 都会被扩展记成「真人编辑」，
 *   控制权当场交还并进入 editing 挂起，之后所有 bsk 动作被拒、且不会自己恢复。
 *   所以「写一段→核对→再写」等于每轮重启会话（30–60 秒），
 *   2026-11-15 在 EAGLE-2 上因此反复了 8 轮。一次灌完、只核对一次是最优解。
 *
 * 为什么话题要走联想：
 *   直接 insertText('#大模型') 只是纯文本，详情页里不可点。真正的话题是编辑器里的
 *   话题实体（`a.tiptap-topic`），必须打 `#词` 等联想面板、点选 `<div class="item">` 才生成。
 *   所以话题和正文必须在**同一次** evaluate 里完成，不能分两轮。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { run, sync, click, sleep } from './bsk-retry.mjs';

const session = process.argv[2];
const args = Object.fromEntries(process.argv.slice(3).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!session || !args.slug) {
  console.error('用法：node xhs-fill.mjs <session> --slug=<slug> [--save] [--dry] [--title=...]');
  console.error('  前提：图片已上传、标题已填。本脚本只写正文+话题。');
  process.exit(1);
}
const ROOT = process.cwd();
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
const md = readFileSync(join(dir, 'xhs.md'), 'utf8');
const yamlSrc = readFileSync(join(dir, 'article.yaml'), 'utf8');
const yamlList = (key) => {
  const m = yamlSrc.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n)+)`, 'm'));
  return m ? m[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean) : [];
};
const title = String(args.title ?? yamlSrc.match(/^xhs_title:\s*"?([^"\n]+)"?$/m)?.[1] ?? '');
const tags = yamlList('xhs_tags');

// 正文分块：按空行切；去掉 `# 小红书文案` 这行标题，以及末尾那行纯文本话题
// （话题用实体生成，纯文本留着会在详情页多出一行点不动的 #xxx）。
const blocks = md.split('\n\n').map((b) => b.trim()).filter(Boolean)
  .filter((b) => !/^#\s/.test(b))
  .filter((b) => !/^#[^\n#]+(\s+#[^\n#]+)*$/.test(b));

if (!blocks.length) { console.error('✗ xhs.md 里没有正文块'); process.exit(1); }
if (!tags.length) console.error('⚠️ article.yaml 没有 xhs_tags，正文末尾不会有可点话题');

const script = `(async () => {
  const P = ${JSON.stringify(blocks)};
  const TAGS = ${JSON.stringify(tags)};
  const e = document.querySelector('.ProseMirror');
  if (!e) return 'no-editor';
  e.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  for (let i = 0; i < P.length; i++) {
    // 块之间两个换段：一个换段、一个留空行。
    // 只留一个时详情页会把相邻段落压成一片（2026-11-14 用户截图反馈「都连在一起」）。
    if (i > 0) { document.execCommand('insertParagraph', false, null); document.execCommand('insertParagraph', false, null); }
    document.execCommand('insertText', false, P[i]);
  }
  const rr = document.createRange(); rr.selectNodeContents(e); rr.collapse(false);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rr);
  document.execCommand('insertParagraph', false, null);
  document.execCommand('insertParagraph', false, null);
  const picked = [];
  for (const tag of TAGS) {
    document.execCommand('insertText', false, '#' + tag);
    await new Promise(r => setTimeout(r, 1500));
    // 联想面板的选择器是 .item；.recommend-topic-wrapper .tag 是右下角常驻推荐条（与正文无关）
    const items = [...document.querySelectorAll('.item')]
      .filter(x => (x.innerText || '').trim().startsWith('#' + tag) && x.offsetHeight > 0);
    const exact = items.find(x => (x.innerText || '').trim().split(/\\s|\\|/)[0] === '#' + tag);
    const pick = exact || items[0];
    if (pick) {
      // 只 click() 不生效，必须三个事件都派发
      pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      pick.click();
      picked.push((pick.innerText || '').trim().split(/\\s|\\|/)[0]);
      await new Promise(r => setTimeout(r, 700));
    } else picked.push('MISS:' + tag);
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  return JSON.stringify({ bodyLen: e.innerText.length, picked });
})()`;

if (args.dry) {
  console.log(`# ${blocks.length} 段正文、${tags.length} 个话题、标题「${title}」`);
  console.log(script);
  process.exit(0);
}

// 写入会触发 editing 挂起：bsk 会在 evaluate **返回之后**把控制权交还，
// 于是这一次调用常常抛 `the user has control of this tab`——但内容其实已经写进去了。
// 不能让它把脚本打断（2026-11-17 第一次跑就崩在这里），按「可能成功」继续往下核对。
let out = '';
try {
  out = await run(session, script, 3);
} catch (e) {
  console.warn(`⚠️ 写入调用报错（通常是 editing 挂起）：${String(e.message).split('\n')[0].slice(0, 80)}`);
  console.warn('   内容通常已经写进去了，继续核对；不要重跑，重跑会多写一遍。');
}
let result = null;
try { result = JSON.parse(out); } catch { /* 挂起时返回值不是 JSON */ }

// 写入会触发 editing 挂起，验证要在**新的 sync** 里做（读 DOM 不受控制权限制）。
await sleep(1200);
const state = await run(session, `JSON.stringify({
  title: ([...document.querySelectorAll('input')].find(i => /标题/.test(i.placeholder || '')) || {}).value,
  bodyLen: (document.querySelector('.ProseMirror')?.innerText ?? '').length,
  topics: [...document.querySelectorAll('.ProseMirror a.tiptap-topic')].map(a => { try { return JSON.parse(a.getAttribute('data-topic')).name } catch (_) { return '?' } }),
  tail: (document.querySelector('.ProseMirror')?.innerText ?? '').slice(-40),
})`, 3).catch(() => '{"error":"sync-failed"}');

let st = {};
try { st = JSON.parse(state); } catch { /* 保留空对象 */ }
const missing = (result?.picked ?? []).filter((p) => String(p).startsWith('MISS:'));
const problems = [];
if (st.bodyLen === undefined || st.bodyLen < 100) problems.push(`正文只有 ${st.bodyLen ?? 0} 字符，可能没写进去`);
if (tags.length && (st.topics?.length ?? 0) !== tags.length) problems.push(`话题 ${st.topics?.length ?? 0}/${tags.length}`);
if (missing.length) problems.push(`联想里没找到：${missing.join('、')}`);
if (title && st.title && st.title !== title) problems.push(`标题「${st.title}」≠ 期望「${title}」`);

console.log('写入结果：', JSON.stringify({ picked: result?.picked ?? null, bodyLen: st.bodyLen, topics: st.topics, title: st.title }));
if (problems.length) {
  console.error(`✗ ${problems.join('；')}`);
  console.error('  编辑器可能已进入 editing 挂起：内容通常已经存进本地草稿，重新开会话核对一次即可，不要盲目重写。');
  process.exitCode = 1;
}

// 存草稿：点「暂存离开」。不点发布——那是不可逆动作。
if (args.save) {
  // bsk 的 sync 在「没有变化」时不返回 observation（只有 observation_id），
  // 直接读 observation.text 会拿到 undefined —— 以前就因此找不到按钮。
  // 这里循环几次；仍拿不到就退回 DOM 点击（按钮是原生 button，JS click 有效）。
  let ref = '';
  for (let i = 0; i < 5 && !ref; i++) {
    const obs = sync(session)?.observation?.text ?? '';
    ref = (obs.match(/@(e\d+)\s+button\s+"暂存离开"/) ?? [])[1] ?? '';
    if (!ref) await sleep(1500);
  }
  const clicked = ref
    ? await click(session, ref).then(() => true).catch(() => false)
    : await run(session, `(() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === '暂存离开');
        if (!b) return 'missing';
        for (const t of ['mousedown', 'mouseup', 'click']) b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
        b.click();
        return 'clicked';
      })()`, 2).then((r) => r === 'clicked').catch(() => false);
  if (!clicked) {
    console.error('✗ 没找到「暂存离开」按钮，草稿未保存（本地会自动存一份，但不保证）');
    process.exitCode = 1;
  } else {
    await sleep(4500);
    let done = '';
    for (let i = 0; i < 3 && !done; i++) done = sync(session)?.observation?.text ?? '';
    if (/保存成功/.test(done)) {
      console.log('✓ 草稿已保存');
      // 状态机：xiaohongshu → draft（已发布的不动）
      const { parseArticle, stringifyArticle } = await import(join(ROOT, 'scripts/lib/frontmatter.mjs'));
      const src = readFileSync(join(dir, 'article.yaml'), 'utf8');
      const doc = parseArticle(src);
      if (doc.data.platforms?.xiaohongshu?.status !== 'published') {
        doc.data.platforms = doc.data.platforms ?? {};
        doc.data.platforms.xiaohongshu = { ...(doc.data.platforms.xiaohongshu ?? {}), status: 'draft' };
        writeFileSync(join(dir, 'article.yaml'), stringifyArticle(doc.data, src));
        console.log('   平台状态：xiaohongshu → draft');
      }
    } else {
      console.error('⚠️ 没看到「保存成功」，请到草稿箱确认');
      process.exitCode = 1;
    }
  }
}

console.log('\n⛔ 不要点「发布」。');

/*
 * ── 关于「回包丢失但内容其实写进去了」（2026-11-18 实测）──
 *
 * 传完图片后编辑器会持续处理图片，CDP 在这期间返回
 * `Previous operation is still settling`。此时发起的写入动作，执行可能已经成功，
 * 但结果回包丢了——bsk 会把它记成 UNKNOWN 并冻结整个标签页（`|| bsk ledger status` 可查）。
 *
 * 实测那一次：脚本报「正文只有 0 字符」，但核对编辑器时正文 414 字、6 个话题全部
 * 转成了 `[话题]#` 形式——**内容完整，只是回包没回来**。
 *
 * 所以看到这个报错不要立刻重写：先 sync 一次读编辑器实际内容。
 * 重写会把已经正确的内容覆盖掉，而 ProseMirror 只有一次写入机会。
 *
 * 若标签页被冻结（后续动作全报 `prior action has an unconfirmed side effect`）：
 *   bsk ledger status  --session <s>     # 看哪个 op 是 UNKNOWN
 *   bsk ledger resolve --session <s> --operation-id <op>
 * 和解之后再操作，不要盲目重放。
 */
