# 公众号发布：已跑通（只建草稿，不群发）

> 2026-11-10 DSpine 跑通。**群发必须由用户在后台点**，脚本只做草稿。

## 一句话版本

```sh
npm run publish:platform -- --slug=dspine --to=wechat   # 渲染 + 传图 + 建草稿
node scripts/deliverable-report.mjs --slug=dspine      # 刷新交付清单（会带上 media_id）
```

去 mp.weixin.qq.com → 内容管理 → 草稿箱 → 预览 → **用户自己点发送**。

## 接口流程

`.env` 里配 `WECHAT_APPID` / `WECHAT_APPSECRET`（用户放，**不要让他贴进对话**）。
解析 `.env` 要用逐行解析，**不能 `source`**——某个值里带 `(`，shell 会报语法错。

1. `cgi-bin/token` 换 `access_token`（缓存 2 小时）
2. `material/add_material` 传正文图片 → 拿到微信域名的 URL
3. 封面：`material/add_material` 传 thumb，**必须 < 64 KB**，
   公众号驱动会把小红书封面压成 900×383 JPEG（约 40 KB）
4. `draft/add` 建草稿，返回 `draft_media_id`
5. `draft/batchget` / `draft/get` 核对，`draft/delete` 删旧的

**红线：不调 `freepublish/submit`。** 群发不可撤回。

## 稿子怎么生成（`scripts/render-wechat.mjs`）
公众号编辑器的限制，按踩坑顺序：

- 剥离 `<style>`、class、id：**所有样式必须内联在 `style` 属性里**
- 不渲染 KaTeX/MathML：公式转 PNG
- 白名单标签：`<section> <p> <span> <img> <table>` 可用；`<figure>`/`<figcaption>` 会被削
- **外链 `<a>` 会被整段剥掉，连标签都不留**（2026-11-15 实测：提交
  `<a href="https://arxiv.org/abs/…">…</a>`，`draft/get` 读回 `anchors=0`，只剩文字）。
  公众号正文**没有任何可点外链**，这不是排版问题、改 HTML 也绕不过去。能给的替代只有两个：
  - **二维码**：`render-wechat.mjs` 给元信息块每条链接生成一枚 68px 二维码（`qrcode` 包），
    上传成普通素材图片，元信息块底部排成一行、下面写「arXiv 原文 / 论文 PDF / 代码仓库 /
    动态架构图」这类短名。读者长按识别即可打开。
  - **阅读原文**：`content_source_url` 每条草稿只有一个名额，现在指向个人站本篇页面
    `${SITE_ORIGIN}/papers/<slug>.html`（站内有代码/架构图/全部外链），
    比指向 arXiv PDF 有用。
  - 纯文本 URL 仍然保留在正文，方便复制。
- **`draft/update` 原地改草稿**，不要每次 `draft/add`。之前每改一版就多一份同名草稿，
  草稿箱里堆到 5 份根本分不清；公众号驱动现在读 `article.yaml` 的
  `wechat_draft_id` 走 update，失败才新建（`--new` 可强制新建）。
- **文末标签**取 `article.yaml` 的 `wechat_tags`（没有就退回 `xhs_tags`），单条 ≤12 字、
  6–10 个。公众号不把纯文本 `#话题` 识别成可点实体，这行只负责「一眼看出归类」和站内搜索。
- 图片必须是微信域名，相对路径和 `data:` 都会被丢弃

**论文原表（`表 N`）不走图片管线。** 手机正文 ~343px，18 列的原表截图缩进去每个数字
只剩 4–5px，和站点当初是同一个问题，而且公众号连横向滚动都没有。有 LaTeX 表源时
`scripts/lib/paper-tables.mjs` 会把它替换成几张窄表（按任务拆分、Speedup/τ 合并成一格，
详见 [publish-failure-modes.md](publish-failure-modes.md) §4.20）。没有表源的表保持截图。

> ⚠️ **不要删原表后面的切片表**。旧规则的理由是「原表已经是图片了，切片表重复」，
> 但那张图片手机上看不清，删掉等于删掉唯一可读的版本。现在原表变成窄表之后，
> 切片表才由替换逻辑按需删除。

## 踩过的坑（2026-11-09 ~ 11-12）

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 列表出现空项目符号、编号跳着走（1,3,5 / 2,4,6） | `breaks:true` 把单行换行转成 `<br>`，切断了 `<ul>/<ol>`；`<li>` 里再套 `<p>` 会多出一行 | `marked.parse(..., {breaks:false})`；用正则剥掉 `<li>` 内的 `<p>` |
| **`<li>` 内侧的裸换行 → 一串空圆点**（2026-11-12 第二次踩） | marked 紧凑列表输出 `<li>\n内容\n</li>`，**没有 `<p>`**，所以「剥 `<p>`」那条挡不住；公众号把标签内换行当软换行渲染 | 连带剥掉标签内侧空白（临时修法，治标） |
| **「相关链接」冒号前是空的**（2026-11-12） | `project` 类链接在 `links.json` 里没有 `repo` 字段，模板写的是 `l.repo ?? l.label ?? ''`，于是渲染成「：https://dflash.z-lab.ai」 | 标签按 `repo → label → 类型默认名（GitHub 仓库 / HuggingFace 模型 / 项目页）` 逐级回落；D6 会数 `<p>：` 的个数 |
| **抽到无关链接** | `extract-links.mjs` 会把正文里的 LaTeX 文档页、`huggingface.co/blog/` 站点首页当成落地信息 | `links.json` 生成后**人工过一眼**；eagle3 抽到过 `latex-project.org` 的 encguide.pdf |
| **微信打开草稿时会把每个 `<li>` 拆成「空 `<li>` + 内容 `<li>`」**（根因，2026-11-12） | 归一化发生在**微信侧**。同一份 HTML 没被打开过时完全正常，一打开就变成一列空圆点——所以脚本自检永远看不到，只有用户点开草稿才发现。剥 `<p>`、剥换行都挡不住 | **公众号产物里不许出现 `<ul>/<ol>/<li>`**。`render-wechat.mjs` 的 `flattenLists()` 把列表改写成 `<section style="padding-left:22px;text-indent:-16px">• 内容</section>`，符号是自己写的字符。D6 会数列表标签，非 0 直接报错 |
| 开头的「论文/作者/链接」挤成一坨 | grid/flex 在公众号里失效 | 正则先摘出 `<blockquote>`，逐行渲染成独立 `<p>` 卡片 |
| 图片点不开、不能放大 | 只写 `src` 不够 | 同时写 `data-src`（脚本用 `@@IMG:…@@` 占位，上传后统一替换） |
| 单个字母的公式渲染成 16px 小图，糊 | 全部当图片处理 | 加 Unicode 下标降级：`x_0`→`x₀`、`G_p`→`Gₚ`；**只有每个字符都有 Unicode 形式时才降级**，`G_q` 这种保持出图 |
| 内联公式看着像 `⍺` | Georgia 斜体的小写 `l` 在这个字号下形似符号 | 换 `'Times New Roman', serif` 斜体 |
| 作者名被截断 | 微信 author 字段**限 8 个 UTF-8 字节**，4 个汉字就到顶 | 默认 `Paper`；用 `WECHAT_AUTHOR` 改，代码里有 `bytesSlice()` 兜底 |
| 正文出现字面 `**星号**` | CommonMark 规定 `**` 后**紧跟标点不构成加粗**，`**「什么时候传」…**` 原样输出 | 稿子里加粗不要以标点开头；中文引号统一用 `「」`，不要写 ASCII `"` |
| 草稿箱堆了多份旧稿 | 每跑一次就多一份 | 驱动建完会遍历 `draft/batchget` 删掉同标题旧稿 |
| **草稿箱里是旧版本，和本地稿子对不上** | 建过草稿之后又改了稿、重新渲染了 HTML，但没重建草稿 | 改完必须**整套重跑** `npm run publish:platform -- --to=wechat`。驱动会 `draft/get` 读回比对，不一致就退出码 1 |

### 关于「字面星号」的通用规则（其他论文也会踩）

只要加粗内容以**标点开头**，Markdown 就不认：

```markdown
而**「超前一个时间步」在不增加复杂度的情况下…**   ← 不生效（「是标点）
1. **「统一空间」是真正的枢纽**。                     ← 生效（前面是空格）
```

把加粗的起止点放在**词上**，不要放在引号/括号上：

```markdown
而**超前一个时间步**这一项在不增加复杂度的情况下…    ← 正确
```

`publish-check` 的 **D6** 会扫 `dist/wechat/<slug>.html` 里的字面 `**`，
不用靠肉眼。

## 验收清单

```sh
# ① 建草稿（脚本内部已带读回验证）
node scripts/wechat-publish.mjs --slug=<slug>

# ② 产物自检
npm run publish:check -- --slug=<slug>     # D6：无 style/class、图都有 data-src、无字面星号

# ③ 草稿箱去重（同一篇只留最新一份）
#   draft/batchget 按标题分组 → 保留 update_time 最大的 → draft/delete 其余
```

### 两个高频误操作

**① 为了「看一眼」重跑渲染。**
`node scripts/render-wechat.mjs --slug=X`（不带 `--upload`）会把已上传的
`mmbiz.qpic.cn` URL 冲回 `@@IMG:…@@` 占位符。草稿箱里那份不变，但本地产物变成"假坏"，
后续所有检查都会对着一份假坏的产物报错。
脚本现在检测到产物里已有微信 URL 就**拒绝覆盖**（退出码 2）；真要覆盖加 `--force`，
只想看 HTML 用 `--out=/tmp/preview.html`。

> 这条守卫 2026-11-12 之前是**失效**的：它只匹配 `https://mmbiz.qpic.cn/`，
> 而微信返回的是 `http://`。结果又冲了一次 dflash 的产物，D6 立刻报
> 「8 处图片占位未替换」。改稿后验证公众号一定要用 `--upload`（重新上传会生成新 URL，
> 不会丢内容），或者用 `--out` 输出到临时路径。

**② 改了稿只重跑渲染，不重建草稿。**
草稿是 `draft/add` 那一刻的快照。改完 `article.md` 必须**整套重跑** `wechat-publish.mjs`，
否则草稿箱里还是旧文字。`wechat-publish` 现在会 `draft/get` 读回，不一致就退出码 1。

`wechat-publish.mjs` 建完草稿会：
1. 把 `wechat_draft_id` / `wechat_draft_at` 写回 `article.yaml`（**别手改**）；
2. `draft/get` 读回服务器上那份，逐项和本地渲染比对（标题 / 作者字节 / 图片数 / 无占位 / 无字面星号）；
3. 不一致 → 退出码 1，并明确说「草稿箱里这一份是坏的，不要发布」。

**别把「渲染过 HTML」当成「草稿已更新」。** 这两件事完全独立：
草稿是 `draft/add` 那一刻的快照，之后重新渲染多少遍都不会影响它。

## 当前状态

- 2026-11-09：首次打通（DFlash）
- 2026-11-10：DSpine 第二次，41 图 / 4 表 / 35 个公式 PNG / 26 个 Unicode 文本公式，0 残留
- 2026-11-11：补上「建完草稿读回验证」；修掉正文里的字面 `**`（加粗以中文引号开头）
