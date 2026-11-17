/**
 * 知乎驱动（可选）——需要先安装 browser-skill 的 `bsk` CLI。
 *
 *   1. 安装 bsk 并登录知乎（在它接管的浏览器里登录一次即可）
 *   2. cp examples/drivers/*.mjs drivers/
 *   3. npm run publish:platform -- --slug=<slug> --to=zhihu
 *
 * 它做的事：打开编辑器 → 填标题 → 正文按图片位置切成 N+1 段交替粘贴
 * （文字走 HTML 粘贴，图片走「文件粘贴」，因为知乎已不再上传 data URI 图片）→
 * 图注填进 figcaption → 加话题 → 读回草稿地址 → 刷新验收。
 *
 * **不点发布。** 只把内容灌进编辑器并存草稿。
 *
 * 没有 bsk 时的表现：preflight 直接报错并说明原因，不会走到一半失败。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;

/** bsk 是否可用。除了 PATH，也看官方安装器的默认位置。 */
function findBsk() {
  const candidates = ['bsk', join(process.env.HOME ?? '', '.local/bin/bsk')];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
      return bin;
    } catch { /* 继续找 */ }
  }
  return null;
}

/** 从 `bsk session start` 的输出里取 session id（JSON 优先，退化到 `session=xxxx`）。 */
function parseSession(out) {
  try {
    const j = JSON.parse(out);
    const id = j.session_id ?? j.session ?? j.id;
    if (id) return String(id);
  } catch { /* 不是 JSON */ }
  const m = out.match(/session[=:\s"]+([A-Za-z0-9_-]{4,})/);
  if (m) return m[1];
  throw new Error(`读不出 bsk session id，原始输出：${out.slice(0, 200)}`);
}

export default {
  id: 'zhihu',
  label: '知乎（browser-skill）',
  requires: [],
  needsRendered: 'zhihu',

  async preflight(ctx) {
    const bsk = findBsk();
    if (!bsk) {
      ctx.fail('找不到 bsk。这个驱动依赖 browser-skill 的 CLI（一个浏览器自动化工具），'
        + '它的安装方式见 docs/drivers.md。没有它就用默认的 manual 驱动：手动把 '
        + `dist/zhihu/${ctx.slug}.html 粘进编辑器。`);
    }
    ctx.bsk = bsk;
    for (const f of ['zhihu-fill.mjs', 'zhihu-verify.mjs', 'bsk-retry.mjs']) {
      if (!existsSync(join(HERE, f))) ctx.fail(`驱动文件缺失：examples/drivers/${f}`);
    }
  },

  async publish(ctx) {
    const { slug, root, args, log } = ctx;
    const run = (argv, opts = {}) => execFileSync(ctx.bsk, argv, { encoding: 'utf8', stdio: 'pipe', ...opts });
    // 子脚本内部还要多次调用 bsk。把探到的路径通过 BSK_BIN 传下去，
    // 否则它按 PATH 找，而安装器的默认位置（~/.local/bin）通常不在 PATH 里。
    const env = { ...process.env, BSK_BIN: ctx.bsk };
    const node = (script, argv) => execFileSync(process.execPath, [join(HERE, script), ...argv],
      { cwd: root, encoding: 'utf8', stdio: 'inherit', env });

    // --focus 必须有：后台标签页收不到键盘事件（知乎是受控编辑器，只能走真按键）
    let session = '';
    try {
      // session 的启动也在 try 里：start 成功但 navigate 抛错时，
      // 不做这一步就会留下一排没人管的浏览器标签页。
      session = parseSession(run(['session', 'start', '--focus', '--json']));
      log(`bsk session: ${session}`);

      run(['navigate', 'https://zhuanlan.zhihu.com/write', '--session', session]);
      log('已打开知乎编辑器');

      node('zhihu-fill.mjs', [session, `--slug=${slug}`, ...(args.reset ? ['--reset'] : []),
        ...(args.title ? [`--title=${args.title}`] : [])]);

      // 验收：强制刷新后逐项比对 dist/zhihu/<slug>.html。
      // 只在当前 DOM 里核对等于没验证——编辑器是内存态，刷新之后才知道存下来的是什么。
      const verifyArgs = [session, `--slug=${slug}`];
      if (args.url) verifyArgs.push(`--url=${args.url}`);
      try {
        node('zhihu-verify.mjs', verifyArgs);
      } catch {
        log('⚠️ 验收未通过，见上方输出。草稿已在编辑器里，修好后重跑或手动核对。');
        return { message: '已灌入编辑器，但刷新验收未通过', ok: false, urls: {} };
      }

      return {
        message: '已灌入编辑器并存草稿，等你过一眼排版后点发布',
        urls: {},
        ok: true,
      };
    } finally {
      if (session) {
        try { run(['session', 'stop', session]); } catch { /* 关闭失败不影响结果 */ }
      }
    }
  },
};
