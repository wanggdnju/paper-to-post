<p align="center">
  <img src="assets/logo.svg#gh-light-mode-only" alt="paper-to-post" width="330">
  <img src="assets/logo-dark.svg#gh-dark-mode-only" alt="paper-to-post" width="330">
</p>

<p align="center"><b>给一个 arXiv 链接，拿到一份已存好的草稿——全程不碰编辑器。</b></p>

<p align="center">
  调研、写稿、核对，然后自动填进平台编辑器：标题、正文、图片、<br>
  公式、图注、话题；停在发布按钮之前。<br>
  产出里的每一个数字，都能追溯到论文原文。
</p>

<p align="center">
  <a href="https://github.com/wanggdnju/paper-to-post/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/wanggdnju/paper-to-post/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520.18-5FA04E">
  <img alt="Platforms" src="https://img.shields.io/badge/output-zhihu%20%7C%20wechat%20%7C%20xiaohongshu-2f6bff">
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/pipeline-overview.md">流程</a> ·
  <a href="docs/drivers.md">驱动</a> ·
  <a href="examples/">示例</a> ·
  <a href="examples/drivers/">自动化</a> ·
  <a href="docs/zhihu-workflow.md">平台笔记</a> ·
  <a href="#贡献">贡献</a>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
</p>

---

## 为什么需要它

读论文写解读，难的不是"写"，是**写错**。

模型很擅长把"提升 3.7%"写成"提升 37%"，把 A 表的数字挪到 B 表，把"作者没测"说成"效果不好"。
这类错误在通读时几乎发现不了，只有对着原文逐条核对才会露出来——而那正是最耗时的部分。

这个仓库把这件事变成机械的：

| 机制 | 做什么 |
| --- | --- |
| `facts.json` | 从 LaTeX 源抽出全部数字、表格、对比，成为唯一事实来源 |
| `critic` | 逐条检查正文断言能否在 facts 里找到依据，标出"无依据"与"冲突" |
| `verify-numbers` | 逐个核对每个小数；对不上就退出码 1 |
| `verify-table` | 逐格核对表格；宽表与紧凑表两条渲染路径各查一遍 |
| `polish` 的机械校验 | 只改表达不改事实：标题行/表格/公式行逐字一致，数字集合必须完全相同 |

**宁可报错，也不让一个编造的数字发出去。**

## 工作流

```
建档 → 取料 → 调研 → 结构化 → 写稿(并发) → 润色 → 质检 → 渲染 → 发布
```

| 阶段 | 命令 | 产出 |
| --- | --- | --- |
| 建档 | `npm run publish -- --stage=new` | `articles/<slug>/article.yaml`（状态机） |
| 取料 | `npm run fetch:all` | 论文全文、原图、原表、落地链接 |
| 调研 | `npm run research:paper` | 谱系、社区讨论、相关工作 |
| 简报 | `npm run briefing` | 一页写作简报 |
| 结构化 | `npm run facts` `glossary` `outline` | 数字对照表、术语表、大纲 |
| 写稿 | `npm run pipeline` | `article.md`（8 节，并发生成） |
| 润色 | `npm run polish` | 只改表达；事实/表格/公式逐字校验 |
| 质检 | `npm run critic` `verify:numbers` `publish:check` | 断言级审计 + 35 项结构检查 |
| 渲染 | `npm run finalize` | `dist/{html,zhihu,wechat,xhs}` |
| 发布 | `npm run publish:platform` | 交给发布驱动 |

每个阶段都是独立脚本，可以单独重跑。`pipeline.mjs` 只负责排序、失败即停、记录耗时与花费。
中断后直接重跑即可续上（`--from=generate`），也可以只重写某一节（`--only=s4 --force`）。

## 环境要求

- Node.js ≥ 20.18
- 一个 OpenAI 兼容或 Anthropic 兼容的 LLM 网关（`LLM_PROTOCOL=openai|anthropic`）
- 可选：Playwright 的 Chromium（取图与切图渲染用）

## 安装

```bash
npm install
npx playwright install chromium   # 只有取料和渲染阶段需要
cp .env.example .env              # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
```

写稿是长输出任务，建议上下文 ≥ 32k。

## 快速开始

```bash
npm run publish  -- --slug=mypaper --stage=new --arxiv=2401.15077
npm run fetch:all -- --slug=mypaper --arxiv=2401.15077
npm run briefing  -- --slug=mypaper
npm run pipeline  -- --slug=mypaper --paper=/tmp/mypaper.txt --jobs=8
npm run finalize  -- --slug=mypaper
npm run publish:platform -- --slug=mypaper --to=wechat
```

`npm run publish -- --status` 看所有文章的状态。

## 示例

[`examples/minimal/`](examples/minimal/) 是一篇**虚构论文**的完整文章目录：
元数据、写作简报、事实表、大纲、正文、critic 报告、小红书文案、两张示意图。

它通过全部 35 项机器检查，能渲染出知乎 HTML 与自包含长文。可以直接当文件结构参考，也可以当改流水线时的回归夹具：

```bash
cp -r examples/minimal articles/minimal
npm run publish:check -- --slug=minimal
npm run render:zhihu -- --slug=minimal
```

## 发布：自动到什么程度

**一直到「草稿已保存」全是自动的。只有最后那一下点发布是人来。**

| 平台 | 渲染 | 传图 | 写进编辑器 | 验收 | 最后一步 |
| --- | --- | --- | --- | --- | --- |
| 公众号 | ✓ | ✓ | ✓ | ✓ 从服务器读回草稿 | 你点群发 |
| 知乎 | ✓ | ✓ | ✓ | ✓ 刷新页面后逐项比对 | 你点发布 |
| 小红书 | ✓ | ✓ | ✓ | ✓ 字数与图片计数 | 你点发布 |
| 其他 | ✓ | — | — | — | 你自己粘 |

「写进编辑器」这一格是多数工具止步的地方。这里指的是：标题、正文、图片上传到平台
自己的图床、图注挂到对应图片、行间公式写成平台原生公式块、话题标签、以及存草稿。

### 驱动

平台差异封在 `scripts/drivers/` 里。内置两个：

| 驱动 | 自动做什么 | 需要 |
| --- | --- | --- |
| `manual`（默认） | 不自动，只列出产物让你复制 | 无 |
| `wechat` | 公众号 API：传图 → 建/更新草稿 → 读回验证 → 清旧稿 | `WECHAT_APPID`、`WECHAT_APPSECRET` |

```bash
npm run publish:platform -- --slug=mypaper                # 列产物
npm run publish:platform -- --slug=mypaper --to=wechat    # 公众号草稿
```

### 浏览器自动化（知乎、小红书）

这两个平台**没有任何接口能写入文章**，只有网页编辑器。要自动化就必须驱动真实浏览器，
而那必然依赖具体工具，所以不内置。但[`examples/drivers/`](examples/drivers/) 里带了
**一份完整可用的实现**，基于 browser-skill 的 `bsk` CLI：

```bash
cp examples/drivers/*.mjs drivers/
npm run publish:platform -- --slug=mypaper --to=zhihu
npm run publish:platform -- --slug=mypaper --to=xiaohongshu
```

不碰键盘就能完成的动作：

**知乎** —— 切到编辑器、填标题、正文按图片位置切成 N+1 段交替粘贴（文字走 HTML、
图片走「文件粘贴」，因为知乎已不再接收 `data:` URI 图片）、图注填进 figcaption、
行间公式写成原生 `data-eeimg="2"` 块、生成侧边目录、设置最多 3 个话题、
把草稿地址回写进 `article.yaml`，最后**刷新页面**逐项和渲染产物比对。

**小红书** —— 切到图文模式、六张切图**一次全传**（逐个传会被静默忽略）、
按 20 字上限填标题、正文与话题在一次 ProseMirror 写入里完成、存草稿。

两者都停在发布之前。安装见 [examples/drivers/README.md](examples/drivers/README.md)，
想接别的工具看 [docs/drivers.md](docs/drivers.md)。

### 为什么公众号能全自动、另两个要开浏览器

| | 公众号 | 知乎 / 小红书 |
| --- | --- | --- |
| 发布接口 | 有（`draft/add`、`draft/get`…） | 没有 |
| 建草稿 | 一个 HTTP 请求 | 模拟人在编辑器里输入 |
| 验收 | 从服务器读回正文 | 刷新页面抓 DOM |
| 稳定性 | 版本化接口，变更会公告 | 编辑器一改版，自动化全废 |

公众号的接口是给第三方工具准备的正式通道；知乎的 Draft.js、小红书的 ProseMirror
是纯前端编辑器，**没有写入端点**。

即便如此，公众号驱动也只建草稿、不调群发：群发不可撤回，而 `draft/get` 能读回
服务器上那份、检查平台有没有改写你的 HTML——这才是接口真正的价值。

**任何驱动都不会点「发送」。** 只做到草稿或输入框。

## 目录结构

```
scripts/            40 个阶段脚本，每个都能单独跑
scripts/lib/        LLM 客户端、frontmatter、arXiv、LaTeX 表格、并发池
scripts/drivers/    发布驱动（manual、wechat）
publish/            账号定位、写作规范、人工检查清单、敏感词表
docs/               流程说明、平台操作、驱动接口
examples/           完整示例文章 + 可选浏览器驱动
.claude/skills/     Agent 技能：把这套流程教给 agent
articles/<slug>/    每篇论文一个目录（不进版本库）
```

## 设计取舍

- **每个阶段一个脚本，不是一个巨型流水线。** 单步失败要能单独重跑；`pipeline.mjs` 只负责编排。
- **手写的源文件是唯一事实来源。** `article.md`、`article.yaml`、`assets/links.json` 是人审过的；
  `facts.json`、`outline.json`、`dist/` 都是可重建的产物。
- **验收必须放在平台读回之后。** 公众号会把 `<li>` 拆成空项、把 `<a>` 整段剥掉；
  知乎编辑器是内存态。本地 HTML 干净不代表线上干净。
- **平台限制要如实说明，而不是绕过去。** 公众号正文放不了可点外链，于是改成二维码 +
  "阅读原文"，并明确告诉读者这是平台限制。

## 测试

```bash
npm test    # 共享库的单元测试
```

## 贡献

欢迎 issue 与 PR。改流水线的 PR 请确认 `npm test` 通过，并在既有文章上跑一遍
`npm run publish:check` 没有新增失败项。

## 许可

MIT，见 [LICENSE](LICENSE)。

论文图片与 PDF 版权归原作者，本仓库只包含代码与流程，不含论文内容。
