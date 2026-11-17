/**
 * 手动发布驱动：不碰任何平台，只把产物路径列出来。
 *
 * 这是默认驱动。没有配置公众号、也不想折腾浏览器自动化的人，
 * 跑到 `dist/` 拿到 HTML 和切图就够了——复制粘贴进编辑器，比接一套自动化快得多。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export default {
  id: 'manual',
  label: '手动复制',
  requires: [],
  needsRendered: null,

  async preflight(ctx) {
    // 只检查产物在不在，不检查任何账号或凭证。
    const expected = [
      ['知乎稿', `dist/zhihu/${ctx.slug}.html`],
      ['公众号稿', `dist/wechat/${ctx.slug}.html`],
      ['小红书切图', `dist/xhs/${ctx.slug}-00-cover.png`],
      ['H5 长文', `dist/html/${ctx.slug}.html`],
    ];
    ctx.renderables = expected
      .map(([label, rel]) => ({ label, rel, ok: existsSync(join(ctx.root, rel)) }))
      .filter((x) => x.ok);
    if (!ctx.renderables.length) {
      ctx.fail('dist/ 下没有任何渲染产物，先跑 npm run finalize（或单独的 render:zhihu / render:wechat / render:article）');
    }
  },

  async publish(ctx) {
    for (const r of ctx.renderables) ctx.log(`  ${r.label.padEnd(10)} ${r.rel}`);
    ctx.log('');
    ctx.log('  公众号：把 dist/wechat/<slug>.html 粘进 mp.weixin.qq.com 的编辑器（图片需先上传，见 docs/wechat.md）');
    ctx.log('  知乎　：打开 zhuanlan.zhihu.com/write，粘 dist/zhihu/<slug>.html');
    ctx.log('  小红书：上传 dist/xhs/<slug>-00..NN.png 六张切图 + xhs.md 里的短文案');
    return {
      message: `已列出 ${ctx.renderables.length} 份产物，等你手动发布`,
      urls: {},
    };
  },
};
