#!/usr/bin/env node
/**
 * 把正文和图片灌进知乎编辑器：**文字走 HTML 粘贴，图片走「文件粘贴」**。
 *
 *   node examples/drivers/zhihu-fill.mjs <session> --slug=eagle
 *
 * 为什么不沿用「正文里内嵌 data URI 图片」：
 *   2026-11-11 实测，知乎编辑器对 `<img src="data:image/png;base64,...">` 的 HTML 粘贴
 *   **已经不再上传**。8 张图会变成同一张 240×120 的「图片导入失败」占位图
 *   （8 个 <img> 的 URL 哈希完全相同，naturalWidth=0）。
 *   最小复现：只贴一张 340 字节的纯色 PNG，结果一样——所以不是图片太大。
 *
 *   仍然可用的是**文件粘贴**（等价于从访达复制图片后 Cmd+V）：
 *     const dt = new DataTransfer(); dt.items.add(new File([bytes], 'x.png', {type:'image/png'}));
 *     ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }))
 *   知乎会把它传到 pic-private.zhihu.com 并返回可用地址（实测 80×40 的图能正确显示）。
 *
 * 所以顺序是：正文按图片位置切成 N+1 段，交替粘贴「文字段 → 图片文件」。
 * 插入位置由**光标锚点**决定（落在最后一个块的内部），不靠占位图定位。
 *
 * 四件在 2026-11-11 之后改掉的事：
 *   ① **行间公式不再走工具栏**。render-zhihu 现在直接把公式写成
 *      `<span class="ztext-math" data-eeimg="2">`，粘进编辑器就是居中的行间公式卡。
 *      原来那条路要「选中占位符 → Backspace → Enter×2 → 点公式 → 敲 TeX → 确认」，
 *      每次留两个空段落（公式前好几个空行），而且产出的是 `data-eeimg="1"`（行内、左对齐）。
 *   ② **图片注释填进 figcaption**。以前图注是 `<img><br>图注`，粘完变成图片下面
 *      一段普通文字；现在图注在 alt 里，这里点开图片的注释框填进去。
 *   ③ 文字段按 `<p>` 边界切，图片是独立的完整 `<p>`，不会留下 `</p><p>` 碎片。
 *   ④ **光标锚点必须是块内部**。`selectNodeContents(editor)` 折叠到末尾会被 Draft
 *      归一化到第一个块的开头，后续粘贴全部插到文档最前面，整篇变成旋转错位。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { run, press, combo, click, sleep } from './bsk-retry.mjs';

const session = process.argv[2];
const args = Object.fromEntries(process.argv.slice(3).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!session || !args.slug) {
  console.error('用法：node zhihu-fill.mjs <session> --slug=<slug> [--title=...] [--reset]');
  process.exit(1);
}
const ROOT = process.cwd();
const slug = String(args.slug);
const html = readFileSync(join(ROOT, 'dist/zhihu', `${slug}.html`), 'utf8');
const meta = readFileSync(join(ROOT, 'articles', slug, 'article.yaml'), 'utf8');
const title = args.title ?? meta.match(/^title:\s*"?([^"\n]+)"?$/m)?.[1] ?? '';

// 文章话题（知乎发布设置里的 chip），和 xhs 的话题标签同源：article.yaml 的 topics。
// 话题 chip 的判据（内联到每段 evaluate 里，只在浏览器端跑）：
// div 下恰好两个子节点，第一个是纯文字 div，第二个 button 里的 svg 是 CircleClose。
// 2026-11-14 第一版用「有 button 有 svg 的 div」当判据，把工具栏的
// 标题/列表/目录/图片/导入全点了一遍，还打开了两个弹窗。
const CHIP_FN = `(function chips() {
  return [...document.querySelectorAll('div')].filter((d) => {
    if (d.children.length !== 2) return false;
    const [label, btn] = d.children;
    if (btn.tagName !== 'BUTTON' || label.children.length) return false;
    const name = label.textContent.trim();
    return name && name.length < 20 && !!btn.querySelector('svg[class*="CircleClose"]') && d.getBoundingClientRect().height > 0;
  });
})`;

// 知乎文章话题**最多 3 个**（2026-11-14 实测：第 3 个加完，「添加话题」按钮就消失，
// 话题行只剩「chip… + 隐藏的搜索框」）。所以 yaml 里分成两份：
//   zhihu_topics —— 3 个，知乎发布设置用；
//   xhs_tags     —— 6 个，小红书正文末尾的 #标签用（那边没有数量限制，多几个更容易被搜到）。
const topics = (() => {
  const m = meta.match(/^zhihu_topics:\s*\n((?:\s+-\s+.+\n)+)/m);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
})();

// 图片素材：直接用 dist/zhihu/<slug>.html 里已经压好的 JPEG data URI。
//
// 不要拿 assets/ 里的原始 PNG：它们有 2–5 MB，base64 之后塞进 bsk evaluate 的
// 命令行参数会直接撞 ARG_MAX（实测报 E2BIG: spawnSync bsk）。render-zhihu 已经把图
// 压到 800px / q0.82（每张 30–150 KB），正好可以直接用。
const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => {
  const tag = m[0];
  const src = tag.match(/src="data:image\/(jpeg|png);base64,([^"]+)"/);
  return {
    mime: src ? `image/${src[1]}` : null,
    b64: src ? src[2] : null,
    caption: (tag.match(/alt="([^"]*)"/)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
  };
});

// ---- 前置
// 旧的 dist/zhihu/*.html 里还是【公式N】占位符，粘进去会原样显示成方块字。
// 与其在编辑器里补救，不如让渲染重跑一遍——那种「补」出来的公式卡至今没有一次是对的。
if (/【公式\d/.test(html)) {
  console.error('✗ dist/zhihu/' + slug + '.html 里还有【公式N】占位符。先重跑：npm run render:zhihu -- --slug=' + slug);
  process.exit(1);
}

// 编辑器必须为空（脚本不幂等）。`--reset` 显式允许先清空当前草稿——重建整篇时用它，
// 比新建一篇留一堆重复草稿干净。
if (args.reset) {
  // 清空之前先等**旧草稿完全加载完**。
  //
  // 2026-11-12 的事故：navigate 之后 14 秒就开始清，编辑器其实还在异步拉旧稿。
  // 第一轮 Backspace 删掉的是"加载了一部分"的内容，加载完成后剩下的旧图/旧表
  // 又出现在 DOM 里；此时脚本已判定「清空成功」并开始灌新内容，于是旧表格截图
  // （标题还带着已废弃的「论文原表」字样）和新内容混在一起——
  // 验证报「图片 6/4、表格 10/12」，看起来像是粘贴坏了，其实是清空没做干净。
  // 判据：连续两次采样文本长度完全一致，说明加载停了。
  let prev = -1;
  for (let i = 0; i < 20; i++) {
    const cur = Number(await run(session,
      `(document.querySelector('.public-DraftEditor-content')?.innerText ?? '').trim().length`).catch(() => '-1'));
    if (cur === prev && cur >= 0) break;
    prev = cur;
    await sleep(1000);
  }
  console.log(`旧草稿已加载（${prev} 字符），开始清空`);

  // 清空：DOM range 全选整篇 → 裸发 Backspace（**不带 `--selector`**）。
  //
  // 三条实测结论（2026-11-11，都是静默失败，不报错但什么都不发生）：
  //   ① `--selector` 会在按键前重新 focus 一次，把刚设好的选区塌缩掉 →
  //      Backspace 只删掉一个字符。所以设置选区在 evaluate 里做，按键**不带 selector**。
  //   ② 组合键（`Meta+a`、`--modifiers Meta`）在知乎编辑器里不生效，只能用 DOM range 全选。
  //   ③ **标签页必须在前台**（`document.visibilityState === 'visible'`）。
  //      隐藏标签页的键盘事件会被浏览器丢弃，打字/Backspace 全部无效——
  //      所以会话要用 `bsk session start --focus` 启动。
  for (let attempt = 1; attempt <= 3; attempt++) {
    const selected = await run(session, `(() => {
      const ed = document.querySelector('.public-DraftEditor-content');
      if (!ed) return 'no-editor';
      ed.focus();
      const r = document.createRange(); r.selectNodeContents(ed);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      return String(sel.toString().length);
    })()`, 4);
    await sleep(500);
    try { await combo(session, 'Backspace'); } catch { /* 忽略瞬时错误 */ }
    await sleep(2000);
    // 判据必须包含**图片和表格**：它们没有 innerText，只看字符数会把
    // 「文字删干净了但图还在」误判成清空成功。2026-11-12 的实际后果：
    // EAGLE-2/3 重灌后多出一张旧图、少两个表——旧内容没删干净，新内容又叠上去。
    const left = await run(session, `(() => {
      const ed = document.querySelector('.public-DraftEditor-content');
      if (!ed) return JSON.stringify({ chars: -1, imgs: -1, tables: -1 });
      return JSON.stringify({
        chars: (ed.innerText ?? '').trim().length,
        imgs: ed.querySelectorAll('img').length,
        tables: ed.querySelectorAll('table').length,
      });
    })()`);
    let L; try { L = JSON.parse(left); } catch { L = { chars: -1, imgs: -1, tables: -1 }; }
    console.log(`清空草稿（第 ${attempt} 轮）：选中 ${selected} 字符 → 剩 ${L.chars} 字符 / ${L.imgs} 图 / ${L.tables} 表`);
    if (L.chars === 0 && L.imgs === 0 && L.tables === 0) break;
  }
}
{
  const state = await run(session, `JSON.stringify({
    blocks: document.querySelectorAll('.public-DraftEditor-content [data-block]').length,
    tex: document.querySelectorAll('[data-tex]').length,
    imgs: document.querySelectorAll('.public-DraftEditor-content img').length,
    tables: document.querySelectorAll('.public-DraftEditor-content table').length,
    text: (document.querySelector('.public-DraftEditor-content')?.innerText ?? '').trim().length,
  })`);
  let s; try { s = JSON.parse(state); } catch { s = null; }
  if (!s) { console.error(`✗ 读不到编辑器状态：${state}`); process.exit(1); }
  // `--topics-only`：只补话题（和清理不合适的话题），不动正文。
  // 用途是「稿子已经灌好了，只想修发布设置」——走 --reset 会把整篇重灌一遍，
  // 十几分钟上传全白费，而且图注回填有失败率。
  if (args['topics-only']) {
    console.log('· --topics-only：跳过正文/图片/公式，只处理文章话题');
    await applyTopics();
    const st = await run(session, `JSON.stringify({ ok: true })`, 2);
    console.log(`最终状态： ${st}`);
    console.log('⛔ 不要点「发布」。');
    process.exit(0);
  }
  if (s.tex > 0 || s.blocks > 1 || s.text > 0 || s.imgs > 0 || s.tables > 0) {
    console.error(`✗ 编辑器里已有内容（blocks=${s.blocks} tex=${s.tex} 图=${s.imgs} 表=${s.tables} chars=${s.text}）。先新建一篇，或加 --reset 清空当前草稿。`);
    process.exit(2);
  }
}

// ---- 1) 标题
if (title) {
  await run(session, `(() => {
    const ta = document.querySelector('textarea[placeholder*="标题"]');
    if (!ta) return 'no-title';
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(title)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  console.log('✓ 标题');
}

/**
 * 整段 HTML 粘贴（正文一次粘完）。
 *
 * `first` 时从第一个块的开头插入；否则接在最后一个块之后。
 * 两种情况的锚点都必须是**具体的 [data-block]**——把范围设成编辑器根节点
 * （`selectNodeContents(editor)`）会被 Draft 归一化到第一个块 offset 0，
 * 后续内容全部插到文档最前面（2026-11-11 实际发生过）。
 */
async function pasteText(chunk, first = false) {
  return run(session, `(async () => {
    const ed = document.querySelector('.public-DraftEditor-content');
    ed.focus();
    let blocks = [...ed.querySelectorAll('[data-block]')];
    const anchor = ${first} ? blocks[0] : blocks[blocks.length - 1];
    if (!anchor) return JSON.stringify({ error: 'no-block' });
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(anchor);
    range.collapse(${first});
    sel.removeAllRanges(); sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData('text/html', ${JSON.stringify(chunk)});
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 3500));
    blocks = [...ed.querySelectorAll('[data-block]')];
    return JSON.stringify({
      blocks: blocks.length,
      // 空草稿自带的那个空段落是否还在最顶上（会渲染成顶部一行空白）
      firstEmpty: !(blocks[0]?.innerText ?? '').trim() && !blocks[0]?.querySelector('img,table,[data-tex]'),
    });
  })()`, 3);
}

/** 把一张图片以「文件」形式粘进去（知乎会自动上传到图床） */
async function pasteImage(asset, idx) {
  const { mime, b64 } = asset;
  await run(session, `(() => {
    const ed = document.querySelector('.public-DraftEditor-content');
    const bin = atob('${b64}');
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], 'img${idx}.png', { type: '${mime}' });
    const dt = new DataTransfer(); dt.items.add(file);
    ed.focus();
    // 不要在这里重置选区：调用方已经**把光标放在待替换的标记块里**，
    // 图片就应该落在那里。早先这里把选区设到「最后一个块的末尾」，
    // 结果图片全跑到文末；再早先设到编辑器根节点末尾，图片全跑到开头。
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    return 'pasted';
  })()`, 2);

  // 上传是异步的：**在 Node 侧轮询**，每次只问一句「现在什么状态」。
  // 不能把 `await sleep(25s)` 写在 evaluate 里：bsk 的页面操作有超时，
  // 长轮询会报 `the browser operation did not finish cancellation in time`，
  // 而且这个报错发生在粘贴之后，图其实已经贴上去了，重试会贴两张。
  //
  // ⚠️ 判成功不能只看 src 里有没有 zhihu：失败的占位图 src 是
  //   blob:https://zhuanlan.zhihu.com/...，同样匹配 zhihu、naturalWidth 也有值。
  //   2026-11-11 实际踩到：8 张里 2 张停在「上传失败」，脚本却报成 ✓。
  //   成功判据 = 出现新的 `https://pic*.zhihu.com/...` 图片（真实主机名是
  //   真实域名有 pic1.zhimg.com / picx.zhimg.com / pic-private.zhihu.com 等多种，
  //   2026-11-14 之前只认 zhihu.com，导致 zhimg.com 的图全被判失败）
  //   且块里没有 .Editable-imageUploader。
  // **zhimg.com 和 zhihu.com 两种都会出现**——2026-11-14 实测：同一篇里
  // 既有 `pic1.zhimg.com/80/...` 也有 `picx.zhimg.com/...`，而历史上的判据只认
  // `pic*.zhihu.com`。结果图片明明传上去了，脚本永远数不到，每张都判 timeout、
  // 重试三轮、整篇没有图。判据必须两个域名都收。
  const UPLOADED = /^https?:\/\/pic[^/]*\.(?:zhimg|zhihu)\.com\//;
  const probe = `(() => {
    const ed = document.querySelector('.public-DraftEditor-content');
    const ok = [...ed.querySelectorAll('img')]
      .filter((i) => /^https?:\\/\\/pic[^/]*\\.(?:zhimg|zhihu)\\.com\\//.test(i.src) && i.naturalWidth > 0);
    return JSON.stringify({
      n: ok.length,
      failed: !!ed.querySelector('.Editable-imageUploader-status.is-error'),
      last: ok.slice(-1).map((i) => i.naturalWidth + 'x' + i.naturalHeight)[0] ?? null,
    });
  })()`;
  const base = JSON.parse(await run(session, probe));
  // 等多久：原来 30×1.5s = 45 秒。2026-11-14 反复出现「4 张图全部 timeout」，
  // 而同一张图用更长的轮询就能传上去——说明不是坏了，是**真的慢**（知乎图床
  // 这段时间单张要 45–90 秒）。45 秒的阈值刚好卡在边界上，于是每张都判失败、
  // 每张都重试，最后整篇没有图。改成 80×2s = 160 秒，给足余量。
  // 判失败的条件仍然是「出现 is-error」，不是单纯超时——超时只说明还没传完。
  for (let t = 0; t < 80; t++) {
    await sleep(2000);
    let s; try { s = JSON.parse(await run(session, probe)); } catch { continue; }
    if (s.failed) return { ok: false, reason: 'upload-error', uploaded: s.n };
    if (s.n > base.n) return { ok: true, reason: 'ok', uploaded: s.n, last: s.last };
  }
  return { ok: false, reason: 'timeout', uploaded: base.n };
}

/** 已上传到图床的图片张数（判重试/去重都用它） */
async function countUploaded() {
  const out = await run(session, `[...document.querySelectorAll('.public-DraftEditor-content img')]
    .filter((i) => /^https?:\\/\\/pic[^/]*\\.(?:zhimg|zhihu)\\.com\\//.test(i.src) && i.naturalWidth > 0).length`);
  return Number(out) || 0;
}

/** 删掉最后一个失败的图片块，返回是否删掉了 */
async function dropFailedImage() {
  return run(session, `(() => {
    const bs = [...document.querySelectorAll('.public-DraftEditor-content [data-block]')];
    const b = [...bs].reverse().find((x) => x.querySelector('.Editable-imageUploader'));
    if (!b) return 'none';
    b.scrollIntoView({ block: 'center' });
    const r = document.createRange(); r.selectNodeContents(b);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    const ed = document.querySelector('.public-DraftEditor-content'); ed.focus();
    sel.removeAllRanges(); sel.addRange(r);
    return 'sel';
  })()`);
}

/**
 * 填写图片注释。
 *
 * 知乎的图注不是正文里的文字，而是图片块自己的 figcaption：点击后弹出
 * `.Image-captionInput textarea`，回车提交。以前图注是 `<img><br>图注`，
 * 粘完只是图片下面一段普通段落——读者分不清那是图注还是正文（用户看到的
 * 「图片没有描述」就是这个）。
 *
 * ⚠️ 提交必须用**真按键 Enter**：直接改 textarea.value 再派发 input 只更新了
 * 显示，Draft.js 的实体数据没改，切到别的块图注就回退成「添加图片注释」。
 */
async function fillCaption(idx, caption) {
  if (!caption) return 'no-caption';
  let last = 'unknown';
  // 注释框可能因为自动保存/滚动自己收起，也可能图片块还没渲染出 figcaption，
  // 重开一次通常就好。注释是可选步骤，失败了不能打断整篇灌稿。
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await fillCaptionOnce(caption, idx);
    if (last === 'ok') return 'ok';
    if (last === 'no-figure') break;
    await sleep(900);
  }
  return last;
}

async function fillCaptionOnce(caption, nth = null) {
  const opened = await run(session, `(() => {
    // 优先用**第 nth 张**（按文档顺序，和 imgs[] 一一对应）；
    // 没给 nth 时退回「光标附近那张还没注释的图」。
    //
    // 为什么要有 nth：图片是按占位标记就地插入的，插入完成的瞬间
    // figure/figcaption 可能还没渲染出来（Draft 的原子块异步挂载），
    // 按「光标附近」找会拿到上一张或找不到，实测 8 张全部报 no-figcaption。
    const ed = document.querySelector('.public-DraftEditor-content');
    const figs = [...ed.querySelectorAll('figure')]
      // 主机名两种都收：真实地址可能是 pic1.zhimg.com / pica.zhimg.com（zhimg），
      // 也可能是 pic-private.zhihu.com（zhihu）。只认一个会让所有 figure 被过滤掉，
      // 图注回填全部报 no-figure——2026-11-17 实际发生。
      .filter((f) => f.querySelector('img[src*=".zhimg.com/"], img[src*=".zhihu.com/"]'));
    if (!figs.length) return 'no-figure';
    let pick = null;
    const nth = ${nth === null ? 'null' : nth};
    if (nth !== null && figs[nth]) pick = figs[nth];
    if (!pick) {
      const sel = getSelection();
      const at = sel.anchorNode;
      const withPlaceholder = figs.filter((f) => {
        const fc = f.querySelector('figcaption');
        return fc && /is-placeholder/.test(fc.className);
      });
      const pool = withPlaceholder.length ? withPlaceholder : figs;
      pick = pool.find((f) => f.contains(at)) || pool.find((f) => {
        const c = f.compareDocumentPosition(at);
        return c & Node.DOCUMENT_POSITION_FOLLOWING;
      }) || pool[pool.length - 1];
    }
    if (!pick) return 'no-figure';
    pick.scrollIntoView({ block: 'center' });
    const fc = pick.querySelector('figcaption');
    if (!fc) return 'no-figcaption';
    const r = fc.getBoundingClientRect();
    for (const t of ['mousedown', 'mouseup', 'click']) {
      fc.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window }));
    }
    return 'ok';
  })()`);
  if (opened !== 'ok') return opened;
  await sleep(700);
  const filled = await run(session, `(() => {
    const ta = document.querySelector('.Image-captionInput textarea');
    if (!ta) return 'no-textarea';
    ta.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(caption)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta.value.length ? 'ok' : 'empty';
  })()`);
  if (filled !== 'ok') return filled;
  await sleep(400);
  // 注释框会在失焦/自动保存时自己收起，那时 press 的选择器匹配不到元素直接抛错。
  // 注释是**可选项**，不能让它把整篇灌稿打断——失败就返回状态，交给调用方告警。
  try {
    await press(session, 'Enter', '.Image-captionInput textarea');
  } catch {
    return 'caption-closed';
  }
  await sleep(900);
  const done = await run(session, `(() => {
    const ed = document.querySelector('.public-DraftEditor-content');
    const sel = getSelection();
    const at = sel.anchorNode;
    const figs = [...ed.querySelectorAll('figure')];
    // 复核光标所在（或最近的）那张图，而不是固定的最后一张
    const f = figs.find((x) => x.contains(at)) || figs[figs.length - 1];
    const fc = f?.querySelector('figcaption');
    if (!fc) return 'no-figcaption';
    return /is-placeholder/.test(fc.className) ? 'placeholder' : 'ok';
  })()`);
  return done === 'ok' ? 'ok' : `caption-${done}`;
}

// ---- 2) 正文一次性粘贴，图片按**占位标记**逐张替换
//
// 早先是「按图片位置把正文切段 → 交替粘贴文字/图片」，插入位置靠当前光标。
// 这条路不可靠：Draft 的内部 selection 在某些时机（自动保存、失焦、focus 归位）
// 会回到文档开头，于是图片和后面的文字被插到最前面，
// 文档变成「中间几段 + 开头 + 结尾」的旋转错位（2026-11-11 反复复现）。
//
// 现在改成**位置由占位标记决定**：
//   ① 把每张图换成一段独一无二的标记文字 `⟦IMG3⟧`，正文一次粘完（顺序天然正确）；
//   ② 再逐张找到标记所在的块，选中它的内容 → 删除 → **就地**粘图片文件。
//      光标在那一块里，插入位置和段落顺序无关，也就不会错位。
const MARK = (i) => `⟦IMG${i + 1}⟧`;
let imgCursor = 0;
const markedHtml = html.replace(/<p><img\b[^>]*><\/p>/g, () => `<p>${MARK(imgCursor++)}</p>`);

{
  const failures = [];

  // ① 正文（含占位标记）一次粘完
  {
    const out = await pasteText(markedHtml, true);
    let r; try { r = JSON.parse(out); } catch { r = null; }
    console.log('✓ 正文', r ? `${r.blocks} 块` : out);
  }

  // ② 逐张把标记替换成图片
  for (let imgIdx = 0; imgIdx < imgs.length; imgIdx++) {
    const file = imgs[imgIdx];
    if (!file || !file.b64) { console.error(`✗ 第 ${imgIdx + 1} 张图没有素材`); continue; }

    // 定位标记块 → 删内容。整套重试两次：
    // 实测「标记块没删掉」是最常见的单点失败（2026-11-16 两篇都撞上第 1 张），
    // 而它通常是时序问题——Draft 在自动保存/重绘时把选区弄丢了。
    // 重新定位一次就能过，不必让整篇 `--reset` 重灌。
    let markerState = 'missing';
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        console.warn(`  ↻ 图 ${imgIdx + 1} 的标记块还在，重新定位再试一次`);
        await sleep(1200);
      }
      const sel = await run(session, `(() => {
        const b = [...document.querySelectorAll('.public-DraftEditor-content [data-block]')]
          .find((x) => (x.innerText || '').includes('${MARK(imgIdx)}'));
        if (!b) return 'missing';
        b.scrollIntoView({ block: 'center' });
        const r = document.createRange(); r.selectNodeContents(b);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        const ed = document.querySelector('.public-DraftEditor-content'); ed.focus();
        s.removeAllRanges(); s.addRange(r);
        return 'ok';
      })()`, 4);
      if (sel !== 'ok') { markerState = 'missing'; break; }
      await sleep(300);
      // 删掉标记块的内容。
      // ⚠️ Backspace **不能带 `--selector`**：那会先把编辑器重新 focus 一次，
      //   刚刚设好的选区被塌缩到光标点，Backspace 删不掉任何东西（静默无效）。
      //   单块的 DOM range 选区 Draft 认；只有「整篇」的 DOM 选区它不认（见 --reset）。
      try { await combo(session, 'Backspace'); } catch { /* 已空 */ }
      await sleep(700);
      markerState = await run(session, `document.querySelector('.public-DraftEditor-content').innerText.includes('${MARK(imgIdx)}') ? 'still' : 'gone'`, 3);
      if (markerState === 'gone') break;
    }
    if (markerState === 'missing') { console.error(`✗ 图 ${imgIdx + 1}：找不到占位标记 ${MARK(imgIdx)}`); failures.push(imgIdx + 1); continue; }
    if (markerState === 'still') { console.error(`✗ 图 ${imgIdx + 1}：占位标记没删掉（已重试一次）`); failures.push(imgIdx + 1); continue; }

    // 上传偶尔失败（实测 8 张里 1–2 张）。重试：先删掉失败的占位块再重贴。
    //
    // ⚠️ 超时**不等于失败**：轮询 30 次没等到，图可能几秒后才传完，此时再贴一遍
    //   就会在草稿里留下**两张一模一样的图**（2026-11-11 实际发生，第一张重复）。
    //   所以超时后先复查一次「已上传张数是否变多」，变多了就当成功。
    const beforeCount = await countUploaded();
    let r = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      r = await pasteImage(file, imgIdx);
      if (r.ok) break;
      if (r.reason === 'timeout') {
        await sleep(6000);
        const now = await countUploaded();
        if (now > beforeCount) { r = { ok: true, reason: 'late', uploaded: now }; break; }
      }
      console.warn(`  ↻ 图 ${imgIdx + 1} 第 ${attempt} 次上传失败（${r.reason}），重试`);
      const dropped = await dropFailedImage();
      if (dropped === 'sel') { try { await press(session, 'Backspace', '.public-DraftEditor-content'); } catch { /* 忽略 */ } await sleep(700); }
      await sleep(1500);
    }
    // 插图时**不填注释**：figure/figcaption 是异步挂载的，此刻填必然失败；
    // 更要紧的是失败图会让下标错位，`figs[imgIdx]` 越界后会回落到「最后一张」，
    // 把注释写到别的图上（2026-11-12 实际发生：图1 失败 → 后 3 张注释全错）。
    // 统一交给 ③ 的收尾回填，那里按成功张数校验过再写。
    const cap = 'deferred';
    console.log(`${r?.ok ? '✓' : '✗'} 图 ${imgIdx + 1}/${imgs.length}`,
      r?.ok ? `${r.uploaded} 张已上传，最新 ${r.last}` : `上传失败：${r?.reason ?? '?'}`,
      `｜注释 ${cap}`);
    if (!r?.ok) failures.push(imgIdx + 1);
    await sleep(400);
  }

  // ③ 收尾补注释：按**文档顺序**给每张图重填一遍 alt 里的注释。
  //
  // 为什么不在插图时顺手填：图片块（figure/figcaption）是异步挂载的，
  // 刚粘完那一刻经常还没渲染出来，当场填必然 `no-figcaption`（实测 8 张里 6 张失败）。
  // 等全部插完再统一补，DOM 已经稳定，按顺序对应也不会串图。
  //
  // ⚠️ **前提是每张图都插进去了**。少一张图时 `figures[i]` 会和 `imgs[i]` 整体错位，
  //    结果四张图分别拿到「表1、图3、图4、表1」四个不相干的注释——2026-11-12 实际发生。
  //    所以先核对数量，对不上就整段跳过并报错，让人重灌而不是把错图注留在草稿里。
  await sleep(2000);
  const countable = failures.length === 0;
  if (!countable) {
    console.error(`✗ 有 ${failures.length} 张图没插进去，跳过图注回填（否则会整体错位）。`);
    console.error('  修好上传后用 --reset 重灌一遍。');
    process.exitCode = 1;
  }
  let captionFixed = 0;
  for (let i = 0; countable && i < imgs.length; i++) {
    const caption = imgs[i]?.caption;
    if (!caption) continue;
    const state = await run(session, `(() => {
      const f = [...document.querySelectorAll('.public-DraftEditor-content figure')]
        .filter((x) => x.querySelector('img[src*=".zhimg.com/"], img[src*=".zhihu.com/"]'))[${i}];
      if (!f) return 'no-figure';
      const fc = f.querySelector('figcaption');
      if (!fc) return 'no-figcaption';
      return /is-placeholder/.test(fc.className) ? 'placeholder' : 'done';
    })()`, 3);
    if (state === 'done') continue;
    const r = await fillCaption(i, caption);
    if (r === 'ok') captionFixed++;
    else console.log(`  · 图 ${i + 1} 注释仍未填上（${r}）`);
  }
  if (captionFixed) console.log(`补填图注 ${captionFixed} 条`);

  console.log(`完成：${imgs.length} 张图`);
  if (failures.length) console.error(`✗ 这些图没传上去：第 ${failures.join('、')} 张`);
}

// ---- 3) 目录（侧边浮动 TOC）
//
// 知乎的「目录」不是正文里的一段内容，而是**编辑器的一个开关**：点工具栏「目录」
// （或 ⌘⌥J）之后，编辑器在左侧渲染一个 `Editable_CatalogV2` 浮动面板，
// 条目由正文的 H1/H2/H3 **自动收集**——所以正文的标题必须是真标题块，
// 用加粗段落伪装的「标题」不会进去（我们的 zhihu.md 用 `##`/`###`，粘完就是标题块）。
//
// 它保存在草稿里：2026-11-13 验证，点完之后刷新页面，面板仍在。
// 阅读页上就是用户截图里那个左侧「目录 / 收起」。
//
// 判据放在**点完之后**：`Editable_CatalogV2` 存在且收集到 ≥1 条，
// 不能只看「点过了」——按钮点击失败时不报错。
if (!args['no-toc']) {
  const before = await run(session, `document.querySelectorAll('.Editable_CatalogV2').length`);
  if (Number(before) === 0) {
    // 先把光标放到正文第一个块的开头，再点：面板虽然浮动，但插入点决定它挂在文档哪个位置
    await run(session, `(() => {
      const b = document.querySelector('.public-DraftEditor-content [data-block]');
      if (!b) return 'no-block';
      b.scrollIntoView({ block: 'center' });
      const r = document.createRange(); r.setStart(b, 0); r.collapse(true);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      const ed = document.querySelector('.public-DraftEditor-content'); ed.focus();
      sel.removeAllRanges(); sel.addRange(r);
      return 'ok';
    })()`, 3);
    await sleep(400);
    try {
      await click(session, 'button[aria-label="目录"]');
    } catch (e) {
      console.warn(`⚠️  目录按钮点击失败（${String(e.message).slice(0, 60)}）；可手动点工具栏「目录」`);
    }
    await sleep(1200);
  }
  const toc = await run(session, `(() => {
    const c = document.querySelector('.Editable_CatalogV2');
    if (!c) return JSON.stringify({ ok: false, n: 0 });
    return JSON.stringify({ ok: true, n: c.querySelectorAll('.Catalog-Title').length });
  })()`, 3);
  let t; try { t = JSON.parse(toc); } catch { t = { ok: false, n: 0 }; }
  if (t.ok && t.n > 0) console.log(`✓ 目录（侧边 TOC，${t.n} 条，由正文标题自动收集）`);
  else console.warn('⚠️  目录没生成：正文标题块是否用的是「标题」格式？手动点工具栏「目录」看看');
}

// ---- 3.5) 文章话题
//
// 知乎的「文章话题」是**发布设置面板里的一组 chip**，不是正文内容，也不是页脚的 #标签。
// 它决定文章页底部那几个蓝色话题块（用户截图里的「投机」就是自动填的，太泛）。
// 话题来自 article.yaml 的 topics 列表——同一份数据也给小红书话题标签用，
// 一处改两边一致。
//
// 面板默认是折叠的，「添加话题」按钮要先把面板滚到底才可见；点开是个
// `.Popover-content` 下拉，里面有 `搜索话题...` 输入框，输入关键词后按 resutls 精确匹配点击。
async function applyTopics() {
if (topics.length) {
  // **只看 chip，不看正文**。第一版用 `body.innerText.includes(名字)` 判断「已设置」，
  // 而文章正文里本来就有「大语言模型」「推理加速」这些词，于是永远判定为已设置，
  // 一个话题都不会加（2026-11-14 实测：报「已设置 5 个」，实际只有 3 个）。
  const current = await run(session, `JSON.stringify(${CHIP_FN}().map((d) => d.children[0].textContent.trim()))`, 3);
  let have = [];
  try { have = JSON.parse(current); } catch { have = []; }
  // 反过来也要清：草稿里已有的「不在 topics 列表里」的话题要删掉。
  // 用户 2026-11-14 反馈：文章底部挂着一个光秃秃的「投机」，太泛，比没有还糟。
  // 话题 chip 的结构是 `<div class=…><div>名字</div><button><svg 圆圈叉/></button></div>`，
  // 只要 chip 的文字不在白名单里就点它自己的删除按钮。
  const removed = await run(session, `(() => {
    const want = ${JSON.stringify(topics)};
    const chips = ${CHIP_FN}();
    const dropped = [];
    for (const c of chips) {
      const name = c.textContent.trim();
      if (want.includes(name)) continue;
      c.querySelector(':scope > button').click();
      dropped.push(name);
    }
    return JSON.stringify(dropped);
  })()`, 3);
  try {
    const dropped = JSON.parse(removed);
    if (dropped.length) console.log(`✓ 移除不合适的话题：${dropped.join('、')}`);
  } catch { /* 忽略：清理失败不影响后面的新增 */ }
  // 已存在的话题不再点一遍：重复点会把同一个话题加成两个 chip。
  // chip 名字可能是「大语言模型[话题]」这种带后缀的官方话题名，用 startsWith 匹配，
  // 精确相等会把「已经加过」误判成「没加」，然后重复点——知乎会再插一个同名 chip。
  const todo = topics.filter((t) => !have.some((h) => h === t || h.startsWith(t)));
  if (!todo.length) {
    console.log(`✓ 文章话题（已设置 ${topics.length} 个）`);
  } else {
    // 展开发布设置面板并滚到底
    await run(session, `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '发布设置');
      if (b && !document.querySelector('button[class*=AddTopic], [class*=Topic] button')) b.click();
      const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 300);
      if (el) el.scrollTop = el.scrollHeight;
      return 'ok';
    })()`, 3);
    await sleep(800);
    for (const topic of todo) {
      // 每加完一个话题，下拉会关、面板可能也收起来，所以每次都先把面板重新打开再找按钮。
      // 2026-11-14 实测：第一次能加，第二次起「添加话题」按钮不可见，
      // 直接报「找不到按钮」跳过——看起来像话题只加进去一个。
      const opened = await run(session, `(() => {
        // 面板收起时先展开并滚到底，「添加话题 / 搜索框」都在话题这一行里。
        const panelBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '发布设置');
        if (panelBtn && ![...document.querySelectorAll('button')].some((x) => x.textContent.trim() === '添加话题' && x.offsetHeight > 0)) {
          panelBtn.click();
          const el = [...document.querySelectorAll('*')].find((e) => e.scrollHeight > e.clientHeight + 200 && e.clientHeight > 300);
          if (el) el.scrollTop = el.scrollHeight;
        }
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '添加话题' && x.offsetHeight > 0);
        if (b) { b.click(); return 'ok'; }
        // 已经有话题时，这一行里是「话题 chip… + 一个 label 包着的搜索框」，没有『添加话题』按钮。
        // 点那个 label 展开输入框（点击后宽度才会从 0 变成可见）。
        const chips = ${CHIP_FN}();
        const row = chips[0]?.parentElement;
        const lab = row?.querySelector('label');
        if (lab) { lab.click(); return 'ok'; }
        return 'no-btn';
      })()`, 3);
      await sleep(600);
      if (opened !== 'ok') { console.warn(`⚠️  找不到「添加话题」按钮，跳过话题设置`); break; }
      await sleep(900);
      const typed = await run(session, `(() => {
        const i = [...document.querySelectorAll('input')].find((x) => x.placeholder === '搜索话题...' && x.offsetHeight > 0);
        if (!i) return 'no-input';
        i.focus();
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        set.call(i, ${JSON.stringify(topic)});
        i.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()`, 3);
      if (typed !== 'ok') { console.warn(`⚠️  话题输入框没出现，跳过「${topic}」`); break; }
      await sleep(2500);
      // 只在「完全同名」的候选上点：搜索结果会带长尾（`大语言模型[话题]`、`国产大语言模型`），
      // 按 includes 匹配会点到别的话题。
      const picked = await run(session, `(() => {
        const pops = [...document.querySelectorAll('.Popover-content')].filter((e) => e.offsetHeight > 0);
        for (const p of pops) {
          const b = [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(topic)});
          if (b) { b.click(); return 'ok'; }
        }
        return 'not-found';
      })()`, 3);
      if (picked === 'ok') console.log(`✓ 话题：${topic}`);
      else console.warn(`⚠️  话题「${topic}」搜不到同名结果，跳过`);
      await sleep(800);
    }
  }
} else {
  console.warn('⚠️  article.yaml 里没有 topics，跳过文章话题（建议补 3–5 个）');
}
}
if (!args['topics-only']) await applyTopics();

// ---- 4) 收尾：把光标移出公式块
// 知乎的公式卡在「被选中/聚焦」状态下不渲染（保留原始 TeX 以便编辑），
// 所以最后一张卡如果还处于 isFocused，核对时 `MathJax_SVG_Display` 会是 false——
// 看上去像「公式没生效」，其实点一下别处就好了。这里主动把它移开。
await run(session, `(() => {
  const bs = [...document.querySelectorAll('.public-DraftEditor-content [data-block]')];
  const p = bs.filter((b) => (b.innerText || '').trim() && !b.querySelector('img,table,[data-tex]')).at(-1);
  if (!p) return 'none';
  p.scrollIntoView({ block: 'center' });
  const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  const ed = document.querySelector('.public-DraftEditor-content'); ed.focus();
  sel.removeAllRanges(); sel.addRange(r);
  return 'ok';
})()`, 4);
await sleep(1500);

// ---- 3) 核对
const check = await run(session, `JSON.stringify({
  imgs: [...document.querySelectorAll('.public-DraftEditor-content img')].map((i) => i.naturalWidth + 'x' + i.naturalHeight),
  captions: [...document.querySelectorAll('.public-DraftEditor-content figure figcaption')]
    .map((f) => (/is-placeholder/.test(f.className) ? 'MISSING' : f.innerText.trim().slice(0, 20))),
  tex: document.querySelectorAll('[data-tex]').length,
  texRowMode: [...document.querySelectorAll('[data-tex]')].map((e) => e.getAttribute('data-eeimg')),
  texCentered: [...document.querySelectorAll('[data-tex]')].map((e) => !!e.querySelector('.MathJax_SVG_Display')),
  tables: document.querySelectorAll('.public-DraftEditor-content table').length,
  emptyBlocks: [...document.querySelectorAll('.public-DraftEditor-content [data-block]')]
    .filter((b) => !(b.innerText || '').trim() && !b.querySelector('img,table,[data-tex]')).length,
  left: (document.querySelector('.public-DraftEditor-content')?.innerText ?? '').match(/【(图|表|公式)\\d+/g) || [],
  toc: document.querySelectorAll('.Editable_CatalogV2 .Catalog-Title').length,
})`);
console.log('最终状态：', check);
console.log('\n⛔ 不要点「发布」。');

// ---- 4) 草稿地址回写：把 /p/<id>/edit 记进 article.yaml
//
// 以前这一步靠人：灌完稿再去创作中心翻草稿列表，找到最新那份、抄 id 出来。
// 2026-11-16 就因为没记，验证时用了一个**别的文章的** id，报「刷新后读不到编辑器」，
// 白查一轮还不知道错在哪。知乎在第一次自动保存后会把地址换成 /p/<id>/edit，
// 就地读一次即可，不必导航（导航会丢未保存的编辑状态）。
{
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const url = await run(session, `location.href`, 2).catch(() => '');
  const m = String(url).match(/zhuanlan\.zhihu\.com\/p\/(\d+)/);
  if (!m) {
    console.log('ℹ️  当前地址还不是 /p/<id>/edit（草稿可能还没自动保存完）。查 id 的方法：');
    console.log('   bsk navigate https://www.zhihu.com/creator/manage/creation/draft?type=article --session <session>');
  } else {
    const draftUrl = `https://zhuanlan.zhihu.com/p/${m[1]}/edit`;
    const yamlPath = join(ROOT, 'articles', slug, 'article.yaml');
    try {
      const { parseArticle, stringifyArticle } = await import(join(ROOT, 'scripts/lib/frontmatter.mjs'));
      const src = readFileSync(yamlPath, 'utf8');
      const doc = parseArticle(src);
      const published = doc.data.platforms?.zhihu?.status === 'published';
      doc.data.zhihu_draft_url = draftUrl;
      if (!published) {
        doc.data.platforms = doc.data.platforms ?? {};
        doc.data.platforms.zhihu = { ...(doc.data.platforms.zhihu ?? {}), status: 'draft' };
      }
      writeFileSync(yamlPath, stringifyArticle(doc.data, src));
      console.log(`✓ 草稿地址已写回 article.yaml：${draftUrl}`);
      if (!published) console.log('   平台状态：zhihu → draft');
      console.log(`   下一步验收：node examples/drivers/zhihu-verify.mjs ${session} --slug=${slug} --url=${draftUrl}`);
    } catch (e) {
      console.warn(`⚠️ 草稿地址 ${draftUrl} 没能写回 article.yaml：${e.message}`);
    }
  }
}
