<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="paper-to-post" width="330">
  </picture>
</p>

<p align="center"><b>产出里的每一个数字，都能追溯到论文原文。</b></p>

<p align="center">
  把一篇 arXiv 论文变成可直接发布的解读稿——<br>
  正文和原文对不上时，构建直接失败。
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
| 质检 | `npm run critic` `verify:numbers` `publish:check` | 断言级审计 + 34 项结构检查 |
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

它通过全部 34 项机器检查，能渲染出知乎 HTML 与自包含长文。可以直接当文件结构参考，也可以当改流水线时的回归夹具：

```bash
cp -r examples/minimal articles/minimal
npm run publish:check -- --slug=minimal
npm run render:zhihu -- --slug=minimal
```

## 发布：可插拔驱动

平台差异全部封在 `scripts/drivers/` 里。核心流程只负责渲染，驱动决定怎么送到平台。

| 驱动 | 做什么 | 需要 |
| --- | --- | --- |
| `manual`（默认） | 列出 `dist/` 下全部产物，你自己复制粘贴 | 无 |
| `wechat` | 公众号官方 API：传图 → 建/更新草稿 → 读回验证 → 清旧稿 | `WECHAT_APPID`、`WECHAT_APPSECRET` |

```bash
npm run publish:platform -- --slug=mypaper                # 手动
npm run publish:platform -- --slug=mypaper --to=wechat    # 公众号草稿
```

知乎和小红书**没有内置**。这两个平台只有网页编辑器，自动化必须依赖具体的浏览器工具；
把某一种工具写死在主流程里，别人 clone 下来就跑不了。

但[`examples/drivers/`](examples/drivers/) 里带了**一份能用的实现**，基于 browser-skill 的
`bsk` CLI，需要时复制过去即可：

```bash
cp examples/drivers/*.mjs drivers/
npm run publish:platform -- --slug=mypaper --to=zhihu
```

接口说明见 [docs/drivers.md](docs/drivers.md)。

**任何驱动都不会点"发送"。** 只做到草稿或输入框，最后一下必须由人点。

### 为什么公众号能自动、知乎不能

| | 公众号 | 知乎 / 小红书 |
| --- | --- | --- |
| 开放 API | 有（`draft/add`、`draft/get`…） | 没有 |
| 建草稿 | HTTP 请求 | 模拟人操作编辑器 |
| 读回校验 | 能拿到服务器上的正文 | 只能刷新页面抓 DOM |
| 稳定性 | 接口变更会发公告 | 编辑器一改版，自动化全废 |

公众号的接口是给第三方工具准备的正式通道。知乎的 Draft.js、小红书的 ProseMirror
是纯前端编辑器，**没有任何公开接口能写入文章**——只能接管浏览器。

即便如此，公众号驱动也只建草稿、不调群发接口：群发不可撤回，而草稿配合
`draft/get` 读回校验，才是自动化真正的价值所在。

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
