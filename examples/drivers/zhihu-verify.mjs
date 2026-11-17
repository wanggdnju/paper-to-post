#!/usr/bin/env node
/**
 * 知乎草稿的**落盘验收**：强制刷新页面，再拿服务器上的真实内容和 dist HTML 对账。
 *
 *   node examples/drivers/zhihu-verify.mjs <session> --slug=eagle
 *
 * 为什么必须单独一个脚本、而且必须先刷新：
 *   2026-11-11 出现过「编辑器里逐项核对全过、刷新后还是最早那一版」。
 *   Draft.js 的编辑器状态是**内存态**，和服务器草稿是两回事；
 *   只在当前 DOM 里核对，等于什么都没验证。
 *
 * 退出码：0 全部通过；1 有不符项。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { run, sleep, sync, BSK } from './bsk-retry.mjs';

const session = process.argv[2];
const args = Object.fromEntries(process.argv.slice(3).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!session || !args.slug) {
  console.error('用法：node zhihu-verify.mjs <session> --slug=<slug> [--url=<草稿编辑页>]');
  process.exit(1);
}
const ROOT = process.cwd();
const slug = String(args.slug);

// 期望值全部从 dist/zhihu/<slug>.html 推出来——不手写数字，否则换一篇就要改代码
const html = readFileSync(join(ROOT, 'dist/zhihu', `${slug}.html`), 'utf8');
const expect = {
  formulas: (html.match(/class="ztext-math"/g) ?? []).length,
  // 2026-11-17 起 render-zhihu 会把复杂行内式也写成真公式卡（data-eeimg="1"），
  // 所以「行内卡数」不再恒等于 0，要和 dist HTML 对上。
  inlineFormulas: (html.match(/class="ztext-math" data-eeimg="1"/g) ?? []).length,
  images: (html.match(/<img\b/g) ?? []).length,
  tables: (html.match(/<table/g) ?? []).length,
  // 首段：dist HTML 的第一个 <p> 或 <h2> 的纯文本。
  // 比较前两边都要归一化：正文里用的是全角空格 `　`（「论文　EAGLE」），
  // 编辑器 innerText 里同样是全角，但 `\s+` 压缩会把两边压成不一样的形态。
  firstText: norm((html.match(/<(p|h[2-4])[^>]*>([\s\S]*?)<\/\1>/) ?? [])[2]
    ?.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '')).slice(0, 8),
};

/** 比对用的归一化：去掉所有空白（含全角空格）和标点 */
function norm(s = '') {
  return String(s).replace(/[\s　]/g, '').replace(/[·・:：,，。．.\-—]/g, '');
}

const url = args.url
  ?? readFileSync(join(ROOT, 'articles', slug, 'article.yaml'), 'utf8').match(/^zhihu_draft_url:\s*"?([^"\n]+)"?$/m)?.[1];
if (!url) {
  console.error('✗ 没有草稿 URL。用 --url=<编辑页地址> 指定（形如 https://zhuanlan.zhihu.com/p/<id>/edit）');
  process.exit(1);
}

// ---- 强制刷新：这是整个脚本存在的理由
//
// ⚠️ 三个坑都得处理：
//   ① navigate 要带 context/observation，且每次重新 sync；
//   ② 新 session 的标签页是 `about:blank`，此时 `cooperate sync` 会报
//      `page interaction coverage is unavailable`——**先导航再 sync**，
//      所以第一次导航允许「sync 失败也照发」（不带 context 也能导航）；
//   ③ session 默认闲置 5 分钟就被回收，长任务中途报 `session stopped after its idle timeout`。
console.log('↻ 刷新页面，读取服务器上的草稿…');
{
  let ok = false;
  let last;
  for (let i = 0; i < 6 && !ok; i++) {
    let args = ['navigate', url, '--session', session];
    try {
      const d = sync(session);
      args = ['navigate', url, '--session', session,
        '--context', d.context_id, '--observation', d.observation_id];
    } catch { /* about:blank 时 sync 会失败：裸导航即可（首次导航不需要 context） */ }
    try {
      execFileSync(BSK, args, { encoding: 'utf8', maxBuffer: 1e8 });
      ok = true;
    } catch (e) { last = e; await sleep(1500); }
  }
  if (!ok) {
    console.error('✗ 导航失败：', String(last?.stderr ?? last).slice(0, 240));
    console.error('  若是 `session stopped after its idle timeout`，重开一个 session 再跑。');
    process.exit(1);
  }
}
await sleep(9000);

// 等图片真的解码完。
// ⚠️ 两个坑叠在一起：
//   ① 刷新后立刻读 `naturalWidth` 一定是 0——图床的图还没下载完，不是「坏图」；
//   ② 知乎的正文图片是**懒加载**的，不滚进可视区就永远不下（complete 恒为 false）。
//   所以要先逐张 scrollIntoView，再轮询到全部 `complete && naturalWidth > 0`。
{
  console.log('… 逐张滚动触发懒加载');
  // 滚动要慢一点：一次跳 8 张图，前面几张可能还没开始下载就被滚过去了。
  // 然后**再滚一轮**——第一轮触发下载，第二轮把已下载的显示出来。
  for (let round = 0; round < 2; round++) {
    await run(session, `(async () => {
      const imgs = [...document.querySelectorAll('.public-DraftEditor-content img')];
      for (const i of imgs) {
        i.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 400));
      }
      return 'scrolled';
    })()`, 3);
    await sleep(2500);
    const pending = await run(session, `[...document.querySelectorAll('.public-DraftEditor-content img')]
      .filter((i) => !(i.complete && i.naturalWidth > 0)).length`, 3);
    if (Number(pending) === 0) break;
  }
  // 最后再给 20 秒兜底轮询
  for (let i = 0; i < 10; i++) {
    let n;
    try { n = Number(await run(session, `[...document.querySelectorAll('.public-DraftEditor-content img')]
      .filter((x) => !(x.complete && x.naturalWidth > 0)).length`, 3)); } catch { n = null; }
    if (n === 0) break;
    await sleep(2000);
  }
}

const state = JSON.parse(await run(session, `(() => {
  const ed = document.querySelector('.public-DraftEditor-content');
  if (!ed) return JSON.stringify({ error: 'no-editor' });
  const bs = [...ed.querySelectorAll('[data-block]')];
  const imgs = [...ed.querySelectorAll('img')];
  return JSON.stringify({
    blocks: bs.length,
    firstText: (bs[0]?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 12),
    images: imgs.length,
    // 失败占位图的 src 是 blob:https://zhuanlan.zhihu.com/…，同样含 zhihu、naturalWidth 也有值，
    // 所以不能只查「含 zhihu」。这里刻意**不用正则**：外层是模板字符串，正则里的斜杠
    // 要跨两层转义，数错一次就静默变成「匹配反斜杠」（实测踩了两次）。
    // 直接查前缀：真图一定 http(s) 开头，失败占位图一定 blob: 开头。
    //
    // ⚠️ naturalWidth === 0 不能单独当失败判据。知乎的图是 loading=lazy，
    //    而 bsk 的标签页常年 visibilityState=hidden；后台标签页里懒加载
    //    根本不会触发，naturalWidth 恒为 0，即使草稿里的图完全正常
    //    （2026-11-12 实际发生：脚本报 5 张异常，截图里 5 张图都在）。
    //    所以判据改成三层：src 必须是 pic*.zhihu.com（这是「真上传了」的硬证据）；
    //    只有**页面可见**时才额外要求 naturalWidth > 0。
    // 硬失败只有一种：src 不是知乎图床（blob: 就是「图片导入失败」占位图）。
    // naturalWidth 单独统计成 unloaded，只提示不判失败——懒加载要时间，
    // 后台标签页里永远不加载，两种情况下图都可能是好的（截图已验证）。
    // ⚠️ 主机名两种都要收：真实地址既可能是 pic1.zhimg.com / pica.zhimg.com /
    //    picx.zhimg.com（**zhimg**），也可能是 pic-private.zhihu.com（**zhihu**）。
    //    这条判据漏了 zhimg 时，好图会被全部判成 blob: 占位——
    //    2026-11-17 实际发生：fill 明明成功，verify 报「2 张是 blob: 占位」，
    //    排查两轮才发现是判据本身错（zhihu-fill 早修过同一个域名问题，这里没跟上）。
    badImages: imgs.filter((i) => i.src.indexOf('blob:') === 0
      || i.src.indexOf('http') !== 0
      || !(i.src.indexOf('.zhimg.com/') > 0 || i.src.indexOf('.zhihu.com/') > 0)).length,
    unloaded: imgs.filter((i) => i.naturalWidth === 0).length,
    captions: [...ed.querySelectorAll('figure figcaption')].filter((f) => /is-placeholder/.test(f.className)).length,
    formulas: [...ed.querySelectorAll('[data-tex]')].length,
    inlineFormulas: [...ed.querySelectorAll('[data-tex]')].filter((z) => z.getAttribute('data-eeimg') !== '2').length,
    // 行内卡用 MathJax_SVG（非 Display），行间卡才是 MathJax_SVG_Display
    unrendered: [...ed.querySelectorAll('[data-tex]')].filter((z) => !z.querySelector('svg')).length,
    tables: ed.querySelectorAll('table').length,
    emptyBlocks: bs.filter((b) => !(b.innerText || '').trim() && !b.querySelector('img,table,[data-tex]')).length,
    placeholders: (ed.innerText.match(/【(图|表|公式)\\d+/g) || []).length,
    markers: (ed.innerText.match(/⟦IMG\\d+⟧/g) || []).length,
    // 目录面板刻意查**整页**而不是 ed 内部：Editable_CatalogV2 是编辑器的浮动层，
    // 不在 .public-DraftEditor-content 里，只查 ed 会永远得到 0。
    toc: document.querySelectorAll('.Editable_CatalogV2 .Catalog-Title').length,
  });
})()`, 6));

if (state.error) {
  console.error(`✗ 刷新后读不到编辑器（${state.error}）——可能被重定向到登录页，或草稿已删除`);
  process.exit(1);
}

const rows = [];
const cmp = (id, ok, desc) => rows.push({ id, ok, desc });
cmp('V1', state.images === expect.images && expect.images > 0,
  `图片 ${state.images}/${expect.images}`);
cmp('V2', state.badImages === 0, `图片主机：${state.badImages ? `${state.badImages} 张不是图床地址（blob: 占位即上传失败）` : `全部 pic*.zhimg.com / pic*.zhihu.com${state.unloaded ? `（${state.unloaded} 张尚未解码完，懒加载中，不算失败）` : ''}`}`);
cmp('V3', state.captions === 0, `图注：${state.captions ? `${state.captions} 张仍是占位` : '全部已填'}`);
cmp('V4', state.formulas === expect.formulas, `公式 ${state.formulas}/${expect.formulas}（行间 + 行内卡）`);
cmp('V5', state.inlineFormulas === expect.inlineFormulas,
  `公式模式：行内卡 ${state.inlineFormulas}/${expect.inlineFormulas}，行间卡 ${state.formulas - state.inlineFormulas}/${expect.formulas - expect.inlineFormulas}`);
cmp('V6', state.tables === expect.tables, `表格 ${state.tables}/${expect.tables}`);
cmp('V7', state.emptyBlocks === 0, `空段落：${state.emptyBlocks}`);
cmp('V8', state.placeholders === 0 && state.markers === 0,
  `占位残留：${state.placeholders ? `【图/表/公式N】×${state.placeholders}` : ''}${state.markers ? ` ⟦IMGn⟧×${state.markers}` : ''}${state.placeholders || state.markers ? '' : '无'}`);
cmp('V9', Boolean(expect.firstText) && norm(state.firstText).startsWith(expect.firstText),
  `首段「${state.firstText}」${expect.firstText ? `（期望以「${expect.firstText}」开头）` : ''}`);
// 目录是可选增强，**不参与通过/失败判定**：老草稿没有，用户也可能故意去掉。
// 有就报条数，没有就提示可以补，不能让「没目录」把整篇验收判成失败。
if (state.toc > 0) console.log(`✅ [V10] 目录：${state.toc} 条（侧边浮动 TOC 已生成，刷新后仍在）`);
else console.log('ℹ️ [V10] 目录未生成（可选；编辑器工具栏「目录」可补）');
// 公式卡「未被选中」时才渲染；刚灌完最后一张卡常是 isFocused，这里只提示不判错
if (state.unrendered) {
  console.log(`⚠️ ${state.unrendered} 个公式卡处于编辑态未渲染（点一下别处即可，不算失败）`);
}

let failed = 0;
for (const r of rows) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✅' : '❌'} [${r.id}] ${r.desc}`);
}
console.log(failed
  ? `\n${failed} 项未通过——草稿没有真正落盘或内容不对，不要告诉用户「修好了」。`
  : '\n✅ 刷新后逐项核对通过（服务器上的草稿确实是这份内容）');
process.exit(failed ? 1 : 0);
