# 知乎发布：步骤与坑

> 本文件是**人工发布**的操作指南，也是自己实现驱动的规格说明。
> 本仓库不内置知乎自动化（见 [drivers.md](drivers.md)）。

> 2026-11-09 用 DFlash 首次跑通（含事故记录）；2026-11-10 DSpine 二次验证并补充坑位。
> 下次照做，**每一步都要先确认再点**。

## 一句话版本

```sh
npm run render:zhihu -- --slug=<slug>       # → dist/zhihu/<slug>.html（公式已是原生节点）
（你的驱动）--slug=<slug> [--reset]
```

本仓库产出 `dist/zhihu/<slug>.html`——公式已经是居中的行间公式，图片是压好的 JPEG，
正文可直接整段粘贴进编辑器。要全自动灌入，按 [drivers.md](drivers.md) 自己实现驱动。

## 前置

- 登录态在你自己浏览器的 `zhuanlan.zhihu.com`；过期了就重新登录。
- 自动化工具里，**每个动作前都要重新取一次页面快照**，否则报
  `observation changed` 或 `the user has control of this tab`。
- 400 KB–1 MB 的 HTML **不要当命令行参数传**（macOS `ARG_MAX` 是 1048576，会撞上限）：
  走文件读取或剪贴板。

## 步骤

1. 打开编辑器
   ```sh
   S=$(   自动化 navigate "https://zhuanlan.zhihu.com/write" --session $S
   ```
   首页「创作 → 写文章」会在用户窗口开新标签，**借用需要用户确认**，不要依赖；直接导航 `/write` 最省事。

2. 跑你的驱动（标题、正文、图片、图注、公式一次做完）
   ```sh
   （你的驱动）--slug=<slug> --reset
   ```
   `--reset` 用于**重建已存在的草稿**（清空当前编辑器再灌）；新草稿不要加。

3. HTML 由 `scripts/render-zhihu.mjs` 从 `articles/<slug>/zhihu.md` 生成：`<p>`/`<h2>`/`<h3>`/`<ul>`/`<table>`，
   **行间公式直接写成知乎的原生节点** `<span class="ztext-math" data-eeimg="2" data-tex="…">`。

   为什么不是占位符 + 工具栏：那条路要「选中占位符 → Backspace → Enter×2 → 点公式 → 敲 TeX → 确认」，
   ① 每次留两个空段落（**公式前好几个空行**）；
   ② 产出的是 `data-eeimg="1"`（行内公式），**永远左对齐**——知乎阅读页的居中靠
      `.ztext-math[data-eeimg="2"]{display:block;text-align:center}`，只有 `2` 才有。
   直接贴 `data-eeimg="2"` 的节点，粘贴完就是居中的行间公式，位置也准确（2026-11-11 实测）。

4. 图片走「文件粘贴」，图注填进 figcaption
   - data URI 的 `<img>` 知乎**不再上传**（会变成「图片导入失败」占位图），必须用 `File` 粘贴；
   - 图注不是正文文字，而是图片块自己的 `figcaption`：点图片下方注释区 → 出现
     `.Image-captionInput textarea` → 原生 setter 写值 + `input` → **真按键 Enter 提交**。
     直接改 value 不按 Enter 只改了显示，Draft 的实体数据没变，切块后注释会回退成占位文字。
   - 成功判据不是「src 里有 zhihu」：失败占位图是 `blob:https://zhuanlan.zhihu.com/…`，同样匹配、
     `naturalWidth` 也有值。要判 `https://pic*.zhimg.com/…` 且块里没有 `.Editable-imageUploader`。

4.5 目录（侧边浮动 TOC，2026-11-13 起自动做）
   - 知乎的「目录」不是正文里的一段 HTML，而是**编辑器工具栏的一个开关**（快捷键 ⌘⌥J）。
     点开后编辑器在左侧渲染 `Editable_CatalogV2` 浮动面板，条目由正文的 H1/H2/H3
     **自动收集**——所以标题必须是真标题块；用加粗段落伪装的「标题」不会进去。
     我们的 `zhihu.md` 用 `##`/`###`，粘贴后就是标题块，直接生效。
   - 状态保存在草稿里：点完刷新页面，面板仍在。阅读页上就是截图里那个左侧「目录 / 收起」。
   - 驱动收尾时点一次；判据在**点完之后**（面板存在且条数 >0），
     因为按钮点击失败时不报错、静默无效。不要加 `--no-toc` 除非故意不要目录。
   - `zhihu-verify.mjs` 的 V10 只提示不判失败：老草稿没有目录不算坏稿。

5. 保存草稿 / 发布
   - 编辑器右下角会自动「草稿保存中」，**关掉页面即可，草稿在「创作中心 → 内容管理 → 草稿箱」**。
   - 「发布」按钮一旦点击就是**公开发布**，没有二次确认。**只有在用户明确说「发」之后才能点**。
   - 获取链接：发布成功后地址栏变成 `https://zhuanlan.zhihu.com/p/<id>`。

## 事故记录（2026-11-09）

- 误把「点发布」和「填标签」当成一步，脚本连点两次，文章直接公开发出，无法撤回。
  → 以后：**点发布前必须单独确认**，且用户当轮消息里出现过「发」字。
- 公式 3 个没生效（`c`、`Q`、`42MB`），因为 Repair 流程跳过了两次 Enter。
  → 以后：公式轮全部做完再整体过一遍 `data-tex` 列表。

## 事故记录（2026-11-10，DSpine）

这一轮踩了 5 个坑，前 3 个是我自己制造的，都已加防护。

1. **在项目根 `scripts/` 找自动化脚本，没找到就断言「知乎只能手动」。**
   → 找工具先全局 grep，不要只看一个目录。

2. **手动把整个 HTML 当命令行参数传给浏览器脚本。**
   知乎 HTML 有 400 KB–1 MB，macOS `getconf ARG_MAX` 是 1048576，直接撞上限。
   就算不撞上限，`evaluate` 也会因为页面内执行太久让扩展 `cleanup` 超时。
   → 用 `pasteHtml()`，它内部已经把 HTML 序列化进表达式；**不要手搓**。

3. **对同一个编辑器跑了两遍灌入。**
   脚本不幂等：正文是「粘贴」进去的，第二遍会在末尾追加第二份；公式卡也会重复。
   现象是 `blocks` 从 210 翻到 412、`data-tex` 从 11 变 18、`【公式N` 残留错位。
   → 已给脚本加**前置校验**：编辑器非空（`blocks>1` 或 `tex>0` 或 `text>0`）直接退出码 2 拒绝执行。
   → 一旦已经污染，只能导航到 `/write` 重开一个干净编辑器重来。

4. **图片压到 1500px 宽导致 HTML 过大。**
   6 张图 base64 合计 972 KB（总 1.03 MB），粘进 Draft.js 卡到 30s+ 超时，
   之后连 `cooperate status` 都报 `Previous operation is still settling`，整个标签的 DevTools 会话需要重载。
   → `render-zhihu.mjs` 默认宽度改成 **800px / quality 0.82**（知乎正文容器才 690px 宽），
   总大小降到 417 KB。可用 `ZHIHU_IMG_WIDTH` / `ZHIHU_IMG_QUALITY` 环境变量覆盖。
   → 判据：**HTML 超过 500 KB 就有卡死风险**，先压图再粘。

5. **`【公式1】` 定位失败导致后面 10 个全部错位。**
   第 1 个选中失败时脚本 `continue`，但没提示顺序问题；实际现象是「TPOT 排到了最后」。
   补插时又多插了一个，变成 12 个。
   → 跑完必须核对：`data-tex` 数量 == 公式数、正文无 `【公式N` 残留、且**第 1 个是 TPOT**
   （公式顺序由 zhihu.md 清单决定，第一个是 1.1 的 TPOT 分解）。
   → 补插单个公式时，先在编辑器里定位它在 `[data-block]` 里的下标，插完再确认没有多出来。

## 2026-11-11：三处「静默产出坏稿」的坑

这一轮三个 bug 的共同点是**不报错**，只是产出的东西是坏的：

1. **`render-zhihu.mjs` 的正文切分退回整份文件。**
   它靠 `## 正文（…）` 这个标题切出要贴的部分，代码写的是 `source.split(...)[1] ?? source`。
   那次重新生成 `zhihu.md` 时没写这个标题，切分拿到 `undefined`，兜底成了整份文件——
   于是「用法：正文一次性粘贴…」和公式清单表格被当成正文灌进知乎，第一章变成了使用说明。
   → 现在没有 `## 正文` 直接**报错退出**，不再兜底；
   → `derive-variants.mjs` 生成时一定会写这个标题。

2. **`自动化 press --selector` 缺 `--observation`。**
   报错 `this action needs an explicit current observation`，但外层 try/catch 吞掉后继续跑。
   结果是 Backspace/Enter 全没生效，三张公式卡全部插到了正文末尾，正文里的 `【公式N】` 还留着。
   → 所有 `press` / `click` 都要求带最新快照；
   → 灌入后在 Backspace 之后**核对占位符真的消失了**，没消失就跳过该公式并告警，
     不再「以为自己插好了」。

3. **行内 `$...$` 公式原样贴进知乎。**
   知乎支持行内公式，但只能一张张手动插卡；正文里有几十处（eagle 有 76 个 `$`），
   粘贴后显示成 `$T_{\mathrm{draft}}$` 这样的 TeX 源码。
   → `render-zhihu.mjs` 增加 `texToPlain()`：`\tau`→τ、`\hat{p}`→p̂、
     `T_{\mathrm{draft}}`→`T_draft`，分式等转换不了的结构也至少去掉美元符号。
   → 同时把 `[文字](url)` 转成纯文字（知乎粘贴后自己识别链接，留着 markdown 语法会原样显示）。

另外：`【表N】` 之前没被识别，表格图会变成一行纯文本占位。
现在图和表**分开编号**（图 1–7、表 1–4），渲染器按同一规则建「编号 → 素材路径」映射，
不能拿编号直接当数组下标（会指错图）。

## 2026-11-11（第二次）：data URI 图片不再上传

现象：草稿建好了，但**一张图都没有**——编辑器里 8 个 `<img>` 全是同一个 240×120 的
「图片导入失败」占位图，`naturalWidth = 0`，8 个 URL 哈希完全相同。

根因：知乎编辑器不再为 `<img src="data:image/...;base64,...">` 触发上传。
最小复现是**只贴一张 340 字节的纯色 PNG**，结果一模一样——所以和图片大小、格式都无关，
是通道变了。

仍然可用的是**文件粘贴**（等价于从访达复制图片再 Cmd+V）：

```js
const dt = new DataTransfer();
dt.items.add(new File([bytes], 'x.png', { type: 'image/png' }));
ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
```

知乎会自己上传到 `pic-private.zhihu.com` 并返回可用地址（实测 80×40 的图能正确显示）。

→ **正确做法**：正文按 `<img>` 切成 N+1 段，交替粘贴「文字段 → 图片文件」，

→ 图片要**用 `dist/zhihu/<slug>.html` 里已经压好的 JPEG**（30–150 KB），
不要拿 `assets/` 里的原始 PNG：2–5 MB 的图 base64 后塞进命令行参数会直接撞 `ARG_MAX`（`E2BIG`）。
→ 官方上传对话框（工具栏「图片 → 本地图片上传」）也能用，但一次只能插一张，
  且插入位置固定在光标处，不如文件粘贴好控制。

## 每次跑完的验收清单

**不要手敲一堆 evaluate 自查，直接跑验收脚本**——它会强制刷新再读，这一步是硬要求：

```sh
node .claude/skills/paper-publish/scripts/zhihu-verify.mjs $S --slug=<slug> \
  --url="https://zhuanlan.zhihu.com/p/<draft-id>/edit"
```

| 检查 | 判据 |
| --- | --- |
| V1 图片数 | 与 `dist/zhihu/<slug>.html` 的 `<img>` 数一致 |
| V2 图片可用 | `src` 是 `http(s)` 开头（不是 `blob:`）且 `naturalWidth > 0` |
| V3 图注 | 所有 `figcaption` 都不含 `is-placeholder` |
| V4/V5 公式 | 数量一致，且**全部** `data-eeimg="2"`（行间、居中） |
| V6 表格 | 数量一致 |
| V7 空段落 | 0 |
| V8 占位残留 | 没有 `【图N】`/`【表N】`/`【公式N】`/`⟦IMGn⟧` |
| V9 首段 | 是元信息块（「论文 …」），不是「用法：…」 |

脚本内部已经处理了两个"看起来像坏图"的假象：
- **刷新后 `naturalWidth` 一定是 0**（图还没下载完）→ 要等；
- **知乎图片是懒加载**，不滚进可视区就永远不下载 → 要逐张 `scrollIntoView`。

**公式位置也要核对**：每张卡的 `data-tex` 必须与它所在小节的公式清单顺序一致。
只看数量对是不够的——三张卡全插到文末时，数量同样是 3。

再肉眼过一遍：图片是否都上传完（不是破图）、图注在不在、公式是否居中、首尾段落对不对。

## 2026-11-11：公式前空行 / 不居中 / 图表没描述

用户看到的是：公式上方好几个空行、公式左对齐、图片和表格都没有说明文字。三个独立成因：

1. **空行来自工具栏插入流程**。旧流程是「选中占位符 → Backspace → Enter×2 → 点公式 → 确认」，
   那两次 Enter 各建一个空段落，公式卡落在中间，所以前面永远空两行。
2. **不居中是 `data-eeimg` 写错了**。知乎阅读页的样式是
   `.ztext-math[data-eeimg="1"]{display:inline-block}` / `.ztext-math[data-eeimg="2"]{display:block;text-align:center}`。
   工具栏那条路只会产出 `1`。**修法**：`render-zhihu.mjs` 直接把公式写成
   `<span class="ztext-math" data-eeimg="2" data-tex="…">`，粘贴完就是居中的行间公式，不经过工具栏。
3. **图注丢了是因为图注不是正文**。旧做法 `<img><br>图注` 会让图注变成图片下面一段普通段落；
   知乎的图注在图片块的 `figcaption` 里。**修法**：图注写进 `<img alt="…">`，
   粘完图后点开注释区、写 textarea、**真实按键 Enter** 提交。

同一次还修了三个静默失败：

- **图片「上传失败」被当成功**。失败占位图的 `src` 是 `blob:https://zhuanlan.zhihu.com/…`，
  包含 `zhihu`、`naturalWidth` 也有值，旧的 `/zhimg|zhihu/.test(src)` 判据全过。
  现在判 `https://pic*.zhihu.com/`（真实主机是 `pic-private.zhihu.com`，**不是** `zhimg.com`）
  且没有 `.Editable-imageUploader`，失败自动删块重贴（最多 3 次）。
- **超时重贴导致重复图**。轮询 30 次没等到就重贴，但图可能几秒后才传完，于是草稿里出现两张一样的图。
  现在超时后先复查「已上传张数是否变多」，变多了就当成功。
- **长轮询撞 自动化 超时**。等上传不能写成 evaluate 里的 `await sleep(25s)`，
  会报 `the browser operation did not finish cancellation in time`——而那时图其实已经贴上去了，
  重试会贴两张。改成 Node 侧轮询、每次只问一次状态。

## 2026-11-11：图片错位（旋转错乱）

现象：8 张图和部分段落跑到文档最前面，正文变成「中间几段 + 开头 + 结尾」。

原因有两条，都是**插入位置靠光标**造成的：

1. `range.selectNodeContents(editor); range.collapse(false)` 会被 Draft 归一化到
   **第一个块的 offset 0**，后面的粘贴全部插到最前面。
2. 交替粘贴时每次 `ed.focus()` 都可能把内部 selection 重置到文档开头。

现在改成**位置由占位标记决定**：先把每张图换成 `⟦IMG3⟧` 这样的标记文字、正文一次粘完，
再逐张找到标记所在的块 → 选中内容 → `Backspace` → 就地粘图片文件。
粘贴图片时**不要**重置选区，光标停在标记块里，图片就落在那里。
跑完核对 `innerText` 里不该再有 `⟦IMG`。

## 2026-11-11 后半：图注填到了错误的图

图片改成按标记就地插入之后，`figure` 在 DOM 里的顺序不再是"最后一张 = 刚插的这张"，
而 `fillCaption` 还在取 `figs.at(-1)`，于是每张图都去填文末那张，前面的图全留着
「添加图片注释」占位。现在按**光标所在的 figure**（或离光标最近的、还没填注释的那张）来定位。

图片块（`figure`/`figcaption`）是**异步挂载**的，刚粘完那一刻经常还没渲染出来，
当场填注释必然 `no-figcaption`（实测 8 张里 6 张失败）。所以注释改成
**全部图片灌完后统一补一遍**，按文档顺序 `figs[i]` 对 `imgs[i]`，既稳定也不会串图。

## 2026-11-11 后半：改完「看起来生效了」，刷新却全变回去

最严重的一次。我在编辑器里核对全部通过（8 图 8 图注、`eeimg=2` 全居中、0 空段落），
用户却说「还是一样的」。刷新页面一看——服务器上还是最早那一版。

三个原因叠在一起，每一个都是**静默失败**：

1. **`--reset` 从来没真的清空过。** 清空用的 `range.selectNodeContents(editor)` +
   `自动化 press Backspace --selector ...`：`--selector` 会在按键前**重新 focus 一次**，
   刚设好的选区当场塌缩，Backspace 只删掉一个字符。脚本却继续往下跑，
   粘贴内容全被追加到旧正文后面（`blocks` 只从 136 涨到 137，看起来"成功"）。
2. **组合键在知乎编辑器里不生效。** `press 'Meta+a'` 是静默空操作，
   自动化 要用 `--modifiers Meta` 形式——但即便这样，知乎编辑器也不吃，
   全选仍然只能靠 DOM range。
3. **标签页在后台时键盘事件被浏览器全部丢弃。** `document.visibilityState === 'hidden'`
   时打字和 Backspace 都无效（而 `document.hasFocus()` 还照样返回 true，极具误导性）。
   会话要用 `
**正确做法（现在代码里的样子）**：
```js
// 清空：evaluate 里设 DOM range 全选 → 裸发 Backspace（不带 --selector）
const sel = /* selectNodeContents(editor) */;
await combo(session, 'Backspace');   // 不带 selector
```

**验收必须先落盘再判断**：改完立刻 `自动化 navigate` 刷新同一草稿，
重新读 `blocks` / `img.src` 的主机 / `data-eeimg` / `figcaption` 是否 `is-placeholder`。
只在当前 DOM 里核对等于什么都没验证——Draft.js 的编辑器状态和服务器草稿是两回事。

### 还有一个必须提前排除的：同一草稿开了多个标签页

用户浏览器里可能同时开着同一个 `/p/<id>/edit`（很常见：他可能正看着你改）。
旧标签页里是旧内容，**它只要触发一次自动保存就会把新内容整个覆盖掉**。
开工前先 `自动化 tab list` 确认这个草稿有几个编辑标签页；有用户的，就让用户关掉或刷新，
否则改多少次都会被打回。

## 2026-11-09：zhihu.md 的图与公式占位

- 正文里行间公式写 `【公式N：一句话说明】`（独占一行），文首「公式清单」表格给出对应 TeX；
- 图片写 `【图N：说明】`（独占一行），N = `article.md` 里第 N 张图。`render:zhihu` 会按这个顺序
  把 `assets/` 里的图缩到 **800px 宽**、转 JPEG、以 data URI 嵌进 HTML，粘贴到知乎编辑器时**自动上传**；
- 原表 PNG 动辄 5MB，不压缩会让 HTML 到 11MB 级别（粘贴卡死），一定要走上面的压缩路径；
- 平台参数必须写成 `--slug=x`（`publish.mjs` 内部 spawn 时曾误用 `--slug x`，导致与手动跑结果不一致）。
