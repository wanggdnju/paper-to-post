# 取图与落地信息：原理、参数与已知坑

`npm run fetch:figures` 和 `npm run extract:links` 的实现说明。改脚本前先读这份。

## 为什么不能直接从 PDF 抽图

论文里的图九成是矢量：要么是 Form XObject（LaTeX 编译进去的 PDF 流程图），要么是内嵌 PDF 文件。
`pypdf` 的 `page.images` 对这类图返回空，`pdfimages` 抽出来是空白或碎片。
**唯一可靠的源是 arXiv e-print 里的 `figures/*.pdf` 原文件。**

```sh
https://export.arxiv.org/e-print/<id>    # 返回 gzip(tar)，里面有 .tex 与 figures/
```

## 渲染流程

1. 下载 e-print，解压到 `/tmp/eprint-<id>/`；
2. 扫描所有 `.tex`，按 `\begin{figure}...\end{figure}` 取块，解析 `\includegraphics`、`\caption`、最近一个 `\section` 标题；
3. 用 Chromium 打开 `figures/*.pdf`，**必须带 `#toolbar=0&navpanes=0&view=FitH`**；
4. 截图（`scale: 'device'`，2x），在页面内用 OffscreenCanvas 找白色纸张的外接框并裁剪；
5. 输出 `articles/<slug>/assets/fig-<原名>.png` 和 `figures.json`。

## 已知坑（按发生顺序）

| 日期 | 现象 | 原因 | 修法 |
| --- | --- | --- | --- |
| 2026-11-09 | 图左侧有一大块深灰/黑框 | 没关 PDF 查看器 UI，截图里含缩略图侧栏和顶部工具栏；按「白色像素」裁切时，深灰侧栏不是白色但白色纸面被裁成两段，侧栏就留在了结果里 | URL 加 `#toolbar=0&navpanes=0&view=FitH`，UI 消失后整页只有白纸是白的 |
| 2026-11-09 | 输出 72 DPI 模糊 | 默认截图是 CSS 像素 | `scale: 'device'` + `deviceScaleFactor=2` |
| 2026-11-09 | `crop failed: Failed to fetch` | 在 `file://` 页面里 `fetch()` 本地文件被阻止 | 把截图读成 base64 data URL 再传进页面 |
| 2026-11-09 | 没有任何 Python 图像库可用（PIL/sharp 都缺） | 环境干净 | 全部裁切在 Chromium 页面内用 OffscreenCanvas 完成，Node 只负责写文件 |

## 落地信息抽取

`extract:links` 扫 LaTeX 源码（和可选 PDF 文本）：

- `\url{}`、`\href{}`、裸 URL、`github.com/owner/repo`；
- 分类：GitHub / HuggingFace（含 `hf.co`）/ ModelScope / 项目主页 / 其它；
- **过滤**：邮箱被当成 URL（`zhijian@ucsd.edu`）、论文自身的 arxiv.org 链接。

**脚本只分类，不判断归属。** 论文常引用别人的仓库（「类似 vLLM 的方案」），归属要人看
intro / abstract 里有没有「我们开源了」。

## 写稿时的插图规则

- 必插两张：**架构 / 方法示意图**（放「方法」第一段后）和**主实验对比图**（放「主要结果」表后）。
- 其余图每节最多一张，取「能改变判断」的那张。训练流程、消融只在正文真的展开时才插。
- 图注写「这张图说明了什么」，不要照抄论文 caption。
- 路径相对 markdown 文件写：`![图注](assets/fig-xxx.png)`。
- 自检 A9 会在图片缺失或少于 2 张时报 ❌。

## H5 渲染

`render-html.mjs` 输出**相对路径引用**的 HTML（不内联 base64）。预览与分发：

```bash
npm run render:html -- --in=articles/<slug>/article.md --out=dist/html/<slug>.html --arxiv=<id> --venue="<会议>"
npm run serve:html  -- --slug=<slug>     # 组装 html+assets 并起本地服务器 → http://127.0.0.1:8088/<slug>.html
```

单文件分发（发给别人看）时把 `dist/html/<slug>.html` 连同 `articles/<slug>/assets` 一起打包即可。

## H5 插图：2026-11-09 的两起事故

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| 图注整段从图片下方"漏"成正文，页面里出现一长串 `Wc 融合成上下文特征…">` 字样 | 图注里写了 `$W_c$`，KaTeX 渲染出的 `<span class="katex">…` 被塞进 `alt="…"` 属性，双引号提前闭合 | 图注里的 `$...$` **只保留文字、不做公式渲染**；图片占位改用 `base64(JSON)` 承载数据，再在还原时 HTML 转义 |
| `render-html` 卡住 2 分钟以上不结束 | 把图片内联成 base64（单张 500KB+）后，`marked` 解析这种超长单行会指数级变慢 | **不内联**：HTML 里写相对路径，`npm run serve:html -- --slug=X` 会自动把 html 和 assets 组装成可预览目录 |
| 截图里图片位置空白 | `<img loading="lazy">` 在无头截图时不会加载 | 去掉 lazy |

**知乎稿的图**：`zhihu.md` 里写 `【图N：说明】`，`render:zhihu` 按 `article.md` 里图片顺序取第 N 张，缩到 1500px 宽转 JPEG 后以 data URI 嵌入（粘贴知乎编辑器自动上传）。不压缩的话原表 PNG 会把 HTML 撑到 11MB，粘贴直接卡死。

**结论**：写图注时不要放行内公式；预览一律用 `npm run serve:html`，不要直接 `python3 -m http.server`（相对路径会指到 项目外）。
