#!/usr/bin/env node
/**
 * browser-skill 的薄封装：处理「每次动作都要重新 sync」和瞬时错误重试。
 *
 *   import { sync, run, press, click, pasteHtml, waitForHandback } from './bsk-retry.mjs';
 *   const S = 'abcd';
 *   await run(S, `document.title`);
 *
 * 注意：bsk 的 sync 输出里偶有控制字符，JSON.parse 前必须先清掉（strict=False 也救不了）。
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * bsk 可执行文件。
 *
 * 不直接用 `bsk`：官方安装器把二进制放到 `~/.local/bin`，而那个目录**不在默认 PATH 里**。
 * 调用方（驱动）已经探到了可用路径，通过 BSK_BIN 传进来；否则每个 execFileSync
 * 都要依赖调用者的 PATH，出现「上游说找到了、下游说找不到」这种自相矛盾的报错。
 */
export const BSK = process.env.BSK_BIN || 'bsk';

export function sync(session) {
  const raw = execFileSync(BSK, ['cooperate', 'sync', '--session', session], {
    encoding: 'utf8', maxBuffer: 1e8,
  });
  return JSON.parse(raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
}

/** evaluate：每次重取 context + observation，失败重试（表格/编辑类页面状态会频繁变化）。 */
export async function run(session, expr, tries = 5) {
  let last;
  // sync 失败要独立计数：编辑器粘贴/上传后页面会「settling」十几秒（浏览器直接拒绝 CDP），
  // 和 evaluate 的普通重试共用 5 次额度的话，4 秒就把额度烧光然后抛栈退出。
  let syncFails = 0;
  for (let i = 0; i < tries; i++) {
    // ⚠️ sync 本身也会失败（`Previous operation is still settling`、CDP 掉线），
    // 它必须在 try 里面——放在外面时一次抖动就让整个脚本抛栈退出，
    // 一次灌稿跑到一半挂掉、草稿停在半成品状态。
    let d;
    try {
      d = sync(session);
      syncFails = 0;
    } catch (e) {
      last = e;
      if (++syncFails > 20) throw e;
      i--;                       // sync 失败不消耗 evaluate 的尝试次数
      await sleep(2000);
      continue;
    }
    try {
      const out = execFileSync(BSK, ['evaluate', expr, '--session', session,
        '--context', d.context_id, '--observation', d.observation_id], { encoding: 'utf8', maxBuffer: 1e8 });
      return out.trim().split('\n').pop();
    } catch (e) { last = e; await sleep(800); }
  }
  throw last;
}

/**
 * 真按键（对 Draft.js / CodeMirror 这类受控编辑器必须用真按键，evaluate 派发不生效）。
 *
 * ⚠️ 必须同时带 `--observation`：在 target policy 下，`press --selector` 属于
 * **untargeted action**，只给 `--context` 会报
 *   `this action needs an explicit current observation`
 * 而这条报错是**非阻塞**——外层的 try/catch 吞掉后脚本继续往下走，
 * 结果是 Backspace/Enter 全都没生效、光标还停在上一个位置，
 * 公式卡被插到了正文末尾（2026-11-11 实际发生：三张卡全跑到文末，占位符还留着）。
 */
/** 真按键发送；`combo` 形如 `Meta+a` 会被拆成 key + --modifiers（bsk 的 `--modifiers` 才是真修饰键，
 *  把 `Meta+a` 当成整个 key 传进去会**静默成功但什么都不按**——2026-11-11 实际踩到）。 */
export async function combo(session, spec, selector, tries = 5) {
  const m = spec.match(/^([A-Za-z]+)\+(.+)$/);
  const [key, mods] = m ? [m[2], m[1]] : [spec, ''];
  let last;
  for (let i = 0; i < tries; i++) {
    let d;
    try { d = sync(session); } catch (e) { last = e; await sleep(800); continue; }
    const extra = ['--session', session, '--context', d.context_id, '--observation', d.observation_id];
    if (mods) extra.push('--modifiers', mods);
    if (selector) extra.push('--selector', selector);
    try {
      return execFileSync(BSK, ['press', key, ...extra], { encoding: 'utf8', maxBuffer: 1e8 }).trim();
    } catch (e) { last = e; await sleep(500); }
  }
  throw last;
}

export async function press(session, key, selector, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    let d;
    try { d = sync(session); } catch (e) { last = e; await sleep(800); continue; }
    try {
      return execFileSync(BSK, ['press', key, '--selector', selector, '--session', session,
        '--context', d.context_id, '--observation', d.observation_id],
      { encoding: 'utf8', maxBuffer: 1e8 }).trim();
    } catch (e) { last = e; await sleep(500); }
  }
  throw last;
}

export async function click(session, ref, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    let d;
    try { d = sync(session); } catch (e) { last = e; await sleep(800); continue; }
    try {
      // ref 指向 DOM 节点时 --context 足够；带 --observation 兼容 untargeted 场景
      return execFileSync(BSK, ['click', ref, '--session', session,
        '--context', d.context_id, '--observation', d.observation_id],
      { encoding: 'utf8', maxBuffer: 1e8 }).trim();
    } catch (e) { last = e; await sleep(500); }
  }
  throw last;
}

/**
 * 把一段 HTML 整段粘贴进 Draft.js 编辑器（知乎、公众号编辑器都是这套）。
 * 只有带 DataTransfer 的 paste 事件能被 Draft.js 识别；innerHTML 和 execCommand 都会被忽略。
 */
export async function pasteHtml(session, html, { selector = '.public-DraftEditor-content', waitMs = 2500 } = {}) {
  return run(session, `(async () => {
    const ed = document.querySelector(${JSON.stringify(selector)});
    if (!ed) return 'no-editor';
    ed.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    const dt = new DataTransfer();
    dt.setData('text/html', ${JSON.stringify(html)});
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, ${waitMs}));
    return JSON.stringify({ blocks: ed.querySelectorAll('[data-block]').length, tables: ed.querySelectorAll('table').length });
  })()`);
}

/** 用户正在操作标签页时，bsk 会拒绝动作；轮询直到交还控制权（单次 timeout 上限 25s）。 */
export async function waitForHandback(session, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    const out = execFileSync(BSK, ['cooperate', 'wait', '--session', session, '--timeout-ms', '20000'],
      { encoding: 'utf8', maxBuffer: 1e8, stdio: 'pipe' });
    if (!/error/i.test(out)) return true;
    await sleep(3000);
  }
  return false;
}
