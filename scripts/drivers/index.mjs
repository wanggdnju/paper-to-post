import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 发布驱动的公共约定。
 *
 * 为什么要有这一层：三个平台的发布方式根本不是一类东西——
 *
 *   - 公众号有官方 API（建草稿 → 读回 → 删旧稿），能完整自动化；
 *   - 知乎、小红书只有网页编辑器，只能靠浏览器自动化，而浏览器自动化依赖具体的
 *     工具（本项目原来用 browser-skill 的 `bsk` CLI）。把 `bsk` 写死在主流程里，
 *     等于要求每个使用者先装同一套私有工具，这个仓库就没法被别人用起来。
 *
 * 所以主流程只认这个接口：渲染 → 交给驱动 → 驱动返回结果。驱动自己决定
 * 用 API 还是浏览器，主流程不关心。
 *
 * ── 写一个驱动 ──
 * 导出一个对象即可（见 wechat.mjs / manual.mjs）：
 *
 *   export default {
 *     id: 'wechat',
 *     label: '微信公众号',
 *     requires: ['WECHAT_APPID', 'WECHAT_APPSECRET'],  // 缺了就在 preflight 阶段报错
 *     needsRendered: 'wechat',   // 需要 dist/wechat/<slug>.html；null 表示不需要
 *     async preflight(ctx) {},   // 发布前检查：凭证、图片、封面，失败要早于任何写操作
 *     async publish(ctx) {},     // 真正发布；返回 { url?, draftId?, message }
 *   }
 *
 * ctx 里有：{ slug, articleDir, distDir, meta, args, log, fail }
 *   meta —— article.yaml 解析后的对象（title / digest / arxiv_id / ...）
 *   args —— 命令行 --key=value 原样传进来，驱动可以有自己的私有参数
 *   fail —— 抛出一个「用户看得懂」的错误，主流程会把它打到 stderr 并退出
 */

/** 读出 article.yaml 里属于这个平台的字段，用于展示与幂等判断。 */
export function platformState(meta, id) {
  return meta?.platforms?.[id] ?? {};
}

/**
 * 驱动注册表。加一个平台只需要在这里登记，CLI 的 `--to=<id>` 就认。
 *
 * `manual` 永远在最后：它不发布任何东西，只把渲染产物路径打出来，
 * 让使用者自己复制粘贴。没有配置任何平台的人也能跑完整条链。
 */
export async function loadDriver(id) {
  const builtin = {
    wechat: () => import('./wechat.mjs'),
    manual: () => import('./manual.mjs'),
  };
  if (!builtin[id]) {
    // 允许在项目根建 drivers/<id>.mjs 自己实现（不需要改本文件）。
    const local = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drivers', `${id}.mjs`);
    if (existsSync(local)) {
      const mod = await import(pathToFileURL(local).href);
      return mod.default;
    }
    const known = ['manual', 'wechat'].join(' / ');
    throw new Error(
      `还没有「${id}」的驱动。内置：${known}。\n`
      + `  自己实现一个：在项目根建 drivers/${id}.mjs，导出默认对象（见 docs/drivers.md），\n`
      + `  然后 --to=${id} 就能用。`,
    );
  }
  const mod = await builtin[id]();
  return mod.default;
}

/**
 * 知乎 / 小红书这类需要浏览器自动化的平台，本仓库只提供**接口骨架**，不提供实现。
 *
 * 曾经有过一份基于 browser-skill（`bsk` CLI）的实现，整套流程能跑通，但它是私有的：
 * 要求使用者装同一个工具、用同一个浏览器配置、开同一个调试端口。把那样的代码放进
 * 公共仓库，结果是一堆人 clone 下来发现跑不了。
 *
 * 想接自己的自动化，按 docs/drivers.md 里的骨架实现 publish(ctx)，再在
 * loadDriver 的 builtin 里登记即可——`render-zhihu` / `render-article` 的渲染产物
 * 已经就绪（HTML 与切图），驱动只需要负责「把它灌进编辑器」。
 */
export const BROWSER_DRIVEN = ['zhihu', 'xiaohongshu'];
