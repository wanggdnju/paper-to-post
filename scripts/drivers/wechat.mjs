/**
 * 微信公众号驱动（官方 API）。
 *
 *   node scripts/publish-platform.mjs --slug=<slug> --to=wechat [--dry] [--thumb=path.png] [--new]
 *
 * 只做「建草稿」，不做群发。群发不可撤回，脚本不提供这个动作——这是设计决定，
 * 不是没写完。
 *
 * 需要 .env：
 *   WECHAT_APPID / WECHAT_APPSECRET   公众号后台「开发 → 基本配置」
 *   （需要把本机出口 IP 加进「IP 白名单」，否则拿 token 会报 40164）
 *
 * 可选：
 *   WECHAT_AUTHOR        作者名（公众号限制 8 字节，超出会被截断）
 *   SITE_ORIGIN          你自己的站点根地址，用于「阅读原文」链接
 *                        没配就退化成 arXiv 原文链接
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getToken, uploadThumb, addDraft, updateDraft, getDraft } from '../wechat-api.mjs';
import { envGet } from '../lib/env.mjs';
import { parseArticle, stringifyArticle } from '../lib/frontmatter.mjs';

/** 把任意封面图压成公众号要求的 900×383 JPG（thumb 上限 64KB）。 */
async function makeThumb(srcPath, outPath) {
  const [{ chromium }, { launchOptions }] = await Promise.all([
    import('playwright'), import('../lib/chromium.mjs'),
  ]);
  const browser = await chromium.launch(launchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 383 } });
    const b64 = readFileSync(srcPath).toString('base64');
    const jpg = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = 900; canvas.height = 383;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(900 / img.naturalWidth, 383 / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      ctx.fillStyle = '#f4f1ea'; ctx.fillRect(0, 0, 900, 383);
      ctx.drawImage(img, (900 - w) / 2, (383 - h) / 2, w, h);
      return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
    }, b64);
    writeFileSync(outPath, Buffer.from(jpg, 'base64'));
  } finally {
    await browser.close();
  }
}

/** 「阅读原文」指向哪：优先自己的站点，其次 arXiv，最后留空。 */
function sourceUrlFor(slug, meta) {
  const origin = (envGet('SITE_ORIGIN') || '').replace(/\/+$/, '');
  if (origin) return `${origin}/papers/${slug}.html`;
  const id = String(meta.arxiv_id ?? '').replace(/^.*abs\//, '').replace(/v\d+$/, '');
  return /^\d{4}\.\d{4,5}$/.test(id) ? `https://arxiv.org/abs/${id}` : '';
}

export default {
  id: 'wechat',
  label: '微信公众号',
  requires: ['WECHAT_APPID', 'WECHAT_APPSECRET'],
  needsRendered: 'wechat',

  async preflight(ctx) {
    const thumb = String(ctx.args.thumb ?? `dist/xhs/${ctx.slug}-00-cover.png`);
    if (!existsSync(join(ctx.root, thumb))) {
      ctx.fail(`找不到封面图 ${thumb}。用 --thumb=<path> 指定，或先跑 npm run render:article 生成小红书切图（第一张是封面）。`);
    }
    ctx.thumbSrc = thumb;
    if (!ctx.meta.title) ctx.fail('article.yaml 里没有 title');
    if (Buffer.byteLength(String(ctx.meta.author ?? ''), 'utf8') > 8) {
      ctx.log(`⚠️ 作者名「${ctx.meta.author}」超过 8 字节，公众号会截断`);
    }
  },

  async publish(ctx) {
    const { slug, root, meta, args, log } = ctx;

    // 1. 渲染 + 上传图片（render-wechat --upload 会把图片换成微信域名）
    const renderOut = JSON.parse(execFileSync(process.execPath,
      ['scripts/render-wechat.mjs', `--slug=${slug}`, ...(args.dry ? [] : ['--upload'])],
      { cwd: root, encoding: 'utf8' }));
    log(`渲染：${renderOut.out}（${renderOut.images} 图 / ${renderOut.formulas} 公式）`);
    if (args.dry) return { message: '只渲染，未建草稿', urls: {} };
    const body = readFileSync(join(root, renderOut.out), 'utf8');

    // 2. 封面
    const tmp = mkdtempSync(join(tmpdir(), 'wechat-thumb-'));
    const thumbPath = join(tmp, 'thumb.jpg');
    await makeThumb(join(root, ctx.thumbSrc), thumbPath);
    log(`封面：${(statSync(thumbPath).size / 1024).toFixed(1)}KB`);

    // 3. 建草稿（有旧的就原地更新，避免草稿箱堆同名文章）
    const token = await getToken();
    const thumbMediaId = await uploadThumb(token, readFileSync(thumbPath), 'thumb.jpg', 'jpg');
    const draftPayload = {
      title: String(meta.title).slice(0, 64),
      author: envGet('WECHAT_AUTHOR') || 'Paper to Post',
      digest: String(meta.digest ?? '').slice(0, 120),
      content: body,
      thumbMediaId,
      sourceUrl: sourceUrlFor(slug, meta),
    };
    let mediaId = '';
    const prev = meta.wechat_draft_id ?? '';
    if (prev && !args.new) {
      try {
        mediaId = await updateDraft(token, prev, draftPayload);
        log(`草稿：原地更新 ${prev}`);
      } catch (e) {
        log(`⚠️ 更新旧草稿失败（${e.message.slice(0, 60)}），改为新建`);
      }
    }
    if (!mediaId) {
      mediaId = await addDraft(token, draftPayload);
      log(`草稿：新建 ${mediaId}`);
    }

    // 4. 记下 media_id（草稿箱里「哪份最新」只能靠它认）
    const yamlPath = join(ctx.articleDir, 'article.yaml');
    const source = readFileSync(yamlPath, 'utf8');
    const doc = parseArticle(source);
    doc.data.wechat_draft_id = mediaId;
    doc.data.wechat_draft_at = new Date().toISOString();
    writeFileSync(yamlPath, stringifyArticle(doc.data, source));

    // 5. 读回验证 —— 这一步不能省。
    // 微信在打开草稿时会**重写结构**（把每个 <li> 拆成「空 li + 内容 li」），
    // 本地文件完全正常，服务器上那份才是坏的。只查本地等于没查。
    const problems = [];
    try {
      const remote = await getDraft(token, mediaId);
      const remoteContent = remote?.content ?? '';
      const localImgs = (body.match(/<img\b/g) ?? []).length;
      const remoteImgs = (remoteContent.match(/<img\b/g) ?? []).length;
      if (remoteImgs !== localImgs) problems.push(`图片 ${remoteImgs} ≠ 本地 ${localImgs}`);
      if (/@@(?:IMG|FORMULA):/.test(remoteContent)) problems.push('草稿里仍有 @@ 占位（素材没上传成功）');
      if (/\*\*/.test(remoteContent)) problems.push('草稿正文有字面 **');
      const listTags = (remoteContent.match(/<(?:ul|ol|li)[\s>]/g) ?? []).length;
      if (listTags) problems.push(`草稿里有 ${listTags} 个列表标签（微信会拆成空项目符号）`);
      const emptyLabels = (remoteContent.match(/<p[^>]*>\s*：/g) ?? []).length;
      if (emptyLabels) problems.push(`${emptyLabels} 处「相关链接」标签为空`);
      if (problems.length) {
        log(`✗ 读回不一致：${problems.join('；')}`);
        log('  草稿箱里这一份是坏的，不要发布。修好后重跑。');
      } else {
        log(`✓ 读回验证通过（${remoteImgs} 图 / 无占位 / 无列表标签）`);
      }
    } catch (e) {
      log(`⚠️ 读回验证失败（${e.message.slice(0, 60)}），请到草稿箱人工确认`);
    }

    return {
      draftId: mediaId,
      message: problems.length ? '草稿已建但读回校验不通过' : '草稿已建，去 mp.weixin.qq.com 预览后手动发送',
      urls: {},
      ok: !problems.length,
    };
  },
};
