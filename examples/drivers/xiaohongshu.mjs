/**
 * 小红书驱动（可选，部分自动化）——需要先安装 browser-skill 的 `bsk` CLI。
 *
 *   1. 安装 bsk 并登录小红书创作平台
 *   2. cp examples/drivers/*.mjs drivers/
 *   3. npm run publish:platform -- --slug=<slug> --to=xiaohongshu
 *
 * **它只做正文。** 传图和标题仍然要手动：
 *
 *   - 图片：`dist/xhs/<slug>-00..NN.png` 六张，**一次全选上传**（逐个传会被静默忽略），
 *     顺序不能乱，`-00-cover` 是封面
 *   - 标题：≤20 字，且必须**新建时写对**（事后改会被旧快照回写覆盖）
 *
 * 为什么不把这两步也做掉：编辑器的「上传图文」有两个同名按钮，浮层交互在版本间变过多次，
 * 自动化这块的维护成本高于收益。正文才是真正麻烦的部分——ProseMirror 对注入极其敏感，
 * 一次性写入会被判成真人编辑并挂起控制权，且不自愈。
 *
 * 所以流程是：你传图、填标题 → 跑这个驱动写正文 → 它点「暂存离开」 → 你点发布。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;

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
  id: 'xiaohongshu',
  label: '小红书（browser-skill，仅正文）',
  requires: [],
  needsRendered: 'xhs',

  async preflight(ctx) {
    const bsk = findBsk();
    if (!bsk) {
      ctx.fail('找不到 bsk。这个驱动依赖 browser-skill 的 CLI，安装方式见 docs/drivers.md。'
        + '没有它也可以手动发布：图片在 dist/xhs/，文案在 articles/<slug>/xhs.md。');
    }
    ctx.bsk = bsk;
    if (!existsSync(join(ctx.articleDir, 'xhs.md'))) {
      ctx.fail(`缺少 articles/${ctx.slug}/xhs.md。先跑 npm run derive -- --slug=${ctx.slug}（需要模型）。`);
    }
    for (const f of ['xhs-prepare.mjs', 'xhs-fill.mjs', 'bsk-retry.mjs']) {
      if (!existsSync(join(HERE, f))) ctx.fail(`驱动文件缺失：examples/drivers/${f}`);
    }
  },

  async publish(ctx) {
    const { slug, root, args, log } = ctx;
    const run = (argv, opts = {}) => execFileSync(ctx.bsk, argv, { encoding: 'utf8', stdio: 'pipe', ...opts });

    // 小红书不需要 --focus：它是页面内注入，不依赖键盘焦点。
    let session = '';
    try {
      session = parseSession(run(['session', 'start', '--json']));
      log(`bsk session: ${session}`);

      // 不导航：用户已经在编辑页填好图和标题了，导航会把未保存的编辑状态冲掉
      const r = run(['cooperate', 'sync', '--session', session], { encoding: 'utf8' });
      if (!/xiaohongshu\.com/.test(r)) {
        log('⚠️ 当前标签页不是小红书。如果你还没打开编辑页，先手动打开并传好图、填好标题。');
      }

      const env = { ...process.env, BSK_BIN: ctx.bsk };
      const runStage = (script, extra = []) => execFileSync(process.execPath,
        [join(HERE, script), session, `--slug=${slug}`, ...extra],
        { cwd: root, encoding: 'utf8', stdio: 'inherit', env });

      // 1) 传图 + 填标题（都在编辑器之外，可以安全重试）
      runStage('xhs-prepare.mjs', args.title ? [`--title=${args.title}`] : []);
      // 2) 正文与话题：ProseMirror 只有一次写入机会，必须排在最后
      runStage('xhs-fill.mjs', args.title ? [`--title=${args.title}`] : []);

      return {
        message: '正文与话题已写入并暂存，等你点发布',
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
