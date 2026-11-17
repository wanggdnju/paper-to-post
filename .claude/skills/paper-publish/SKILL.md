---
name: paper-publish
description: >
  论文解读发布流水线：arXiv → 素材 → 大纲 → 正文 → 润色 → 质检 → 排版 → 三平台草稿。
  适用于任何项目里一篇论文解读的生产与分发。
  触发词：「发下一篇」「写一篇解读」「发布这篇」「把这篇文章发出去」「润色这篇」
  「出小红书图」「生成 H5」「更新发布状态」「从 arXiv 链接到发布」。
---

# 论文解读发布流水线

从 arXiv 链接到四份产物（H5 长文 / 知乎稿 / 公众号稿 / 小红书切图），全程一条链。
平台发布走可插拔驱动（`scripts/drivers/`），内置公众号 API 与手动复制两种。

**默认全自动跑到「可发布」**，不停下来等人审稿。唯一必须停的是**点发布/群发之前**——
不可逆动作，要让用户看一屏 `npm run preview` 再决定。

```
建档 → 取素材 → 简报 → 写稿(并发) → 润色 → 终检 → 渲染 → 三平台草稿 → 【停】用户看一屏 → 发布
```

> **最省事的入口**：`/paper <arXiv 链接或 ID> [slug]`。
> 它按下面的 9 步一路跑到三平台草稿，然后停下来等一个「发」字。

## 全流程（9 步，可直接照做）

```bash
# 1. 建档：拉标题/作者，写状态机
npm run publish -- --slug=<slug> --stage=new --arxiv=<id 或 URL>

# 2. 取素材：PDF + 论文原图 + 外部调研 并发跑，随后抽落地链接（约 15–25s）
npm run fetch:all -- --slug=<slug> --arxiv=<id>

# 2b. 论文原表：需要人指定页码，不自动
npm run render:table -- --slug=<slug> --pdf=/tmp/<slug>.pdf --page=<页> --caption="Table 1" --out=main

# 3. 简报：三路调研 → 一页写作简报
npm run briefing -- --slug=<slug>

# 4. 写稿 + 润色（并发 8，约 1 分钟）+ 质检 + 派生三平台变体
npm run pipeline -- --slug=<slug> --paper=/tmp/<slug>.txt --jobs=8

# 5. 终检：推进状态机到 rendered + H5/知乎产物 + 一屏预览
npm run finalize -- --slug=<slug>

# 6. 发布（全部停在草稿/输入框，不点发送）
npm run publish:platform -- --slug=<slug>                  # 手动：列出 dist/ 里的产物路径
npm run publish:platform -- --slug=<slug> --to=wechat      # 公众号：建草稿 + 读回验证
# 知乎 / 小红书：需要自己实现驱动，见 docs/drivers.md

# 7. 你自己的站点（可选；没有站点就跳过）
# npm run site   ← 在站点仓库里跑

# 8. 【停下来】把 npm run preview -- --slug=<slug> 的一屏给用户，等他一个「发」字

# 9. 用户确认后（只有这时才能点平台发布按钮）
npm run publish -- --slug=<slug> --stage=published --confirm --zhihu=<url> --xiaohongshu=<url>
```

> 第 4 步里的 `pipeline` 依次跑 `facts → glossary → outline → generate → polish → qa → critic → derive → compare/diagram → score`，
> 独立阶段自动并发；失败可从断点续跑 `--from=generate`。

## 每一步的验收判据

| 步骤 | 判据 | 不通过怎么办 |
| --- | --- | --- |
| 建档 | `article.yaml` 里 `arxiv_id` 是**裸 ID**，`status: new` | 补 `--title="..."` 手动指定 |
| 取素材 | `assets/` 有 `fig-*.png`、`figures.json`、`links.json` | 肉眼看图：深灰边/工具栏/缩略图侧栏说明裁切坏了 |
| 简报 | `briefing.md` 含「直接影响结论的几件事」 | 跑 `research:platform` 或补 `research-deep.md` |
| 写稿 | 8 节齐全、字数 5,000–9,000 | `--from=generate` 续跑；`--only=s4 --force` 重写单节 |
| 润色 | `polish.json` 里 `sections_rejected` 可接受 | 被拦的小节保留原文，不会改坏事实 |
| 问答 | `qa.json` 里 `failing` 为空 | 打回重写仍不过就只有那一题，看它列出的数字/长度问题 |
| 终检 | `publish-check` 无 ❌ | **必须修**，那是数字/表格/结构真错了 |
| 渲染 | 切图 780×1040、知乎 HTML ≤500KB | 别带 `--cards`；超了先压图 |
| 草稿 | 平台读回一致（公众号）/ 刷新后验收（知乎） | 当前页面看着对不算验收 |
| 站点（可选） | 列表页有本篇链接，线上 200 | 先 `--stage=rendered` 再跑站点构建 |

## 三条架构约定

**1. 一篇论文一个目录，所有中间产物都收在里面。**
`articles/<slug>/` 下有 `article.yaml`（状态机，唯一事实来源）、四份稿
（`article.md` / `zhihu.md` / `xhs.md` / `xhs-article.md`）、`assets/`（图/表/links）、
`source/`（PDF + e-print）、以及各阶段的 json（`facts` `glossary` `outline` `critic` `polish` `score`）。
不要把中间产物丢在 /tmp 或项目根目录。

**2. 手改的源文件才是事实来源，`dist/` 都是产物。**
`dist/` 按平台分目录（`html` / `zhihu` / `wechat` / `xhs`），可以随时重建。
改了正文就必须重跑渲染，否则发出去的是旧的。

**3. 平台会改写你提交的内容，验收必须放在「平台读回来」之后。**
公众号把 `<li>` 拆成空项、知乎 Draft.js 是内存态，本地 HTML 干净不代表草稿箱干净。
详见 [references/publish-failure-modes.md](references/publish-failure-modes.md) 的铁律 2 和 4.14。

**4. 平台不给的东西不要假装能给——改成它允许的形态，并如实告诉用户。**
公众号正文**没有任何可点外链**（`<a>` 连标签一起被剥，`draft/get` 读回 `anchors=0`），
小红书正文外链和 tag 同理。这种情况不是「排版没调好」，改 HTML 也绕不过去。
正确做法是换成二维码 / 阅读原文 / 编号小节这类平台允许的形态，然后**明确说明是平台限制**，
不要让用户以为是我们没做。见 [references/wechat-publish.md](references/wechat-publish.md)、
[docs/xiaohongshu-workflow.md](../../docs/xiaohongshu-workflow.md)。

## 润色阶段（`polish`）为什么必须跑

分节生成保证「每节自己讲清楚」，不保证「节与节接得上」「句子不绕」。润色做两件事：

1. **接上邻节**：每节带「上一节最后一段 + 下一节第一段」进去，要求接住上文、不重复已解释内容；
   最后机械删掉跨节逐字重复的段落。
2. **改可读性**：拆长句（>40 中文字断句）、术语首次出现补白话、先结论后解释。

**只改表达、不改事实**，而且是机械校验的：标题行、表格/图片/公式行逐字一致，数字集合完全相同
（含中文数量词——「两个核心动作」改成「三个」会被拦），篇幅 ±20% 以内。
任一节不过校验就**保留该节原文**，绝不带着改动往下走。

## 文末问答（`qa`）

正文按论证链写，读者读完往往还带着几个具体问题（能快多少、为什么不用加深网络、
下载下来能不能跑出这个数）。`npm run qa -- --slug=X` 在文末补一节 `## 附：问答`，
由浅到深，每条答案 100–250 字、先给结论。

呈现成**带序号的一组「问 / 答」**（`**问题 1：…**` + `回答 1：…`，依次编号），**不分组**。
公众号渲染时会把编号收成 `问题1：` / `回答1：`（无空格、橙色加粗，见 `render-wechat.mjs`），
`问：/答：` 这种旧格式会被 `publish-check` 的 D6c 拦下。
「动机 / 机制 / 边界 / 落地」只在生成阶段用（保证由浅到深、题型齐全），不写进正文：
读者是按顺序读的，小标题只打断阅读；而且一个问题常同时属于两类，归错比不归更糟。

**答案里每个小数都必须能在正文或 `facts.json` 里找到**，找不到就打回重写（最多一次），
仍不过就保留问题、清空答案并让脚本以非零退出——绝不带着编造的数字发出去。

这一节**不参与润色**（`polish` 跳过 `## 附：`），也**不进小红书**（短文案和 14 屏长图都排不进它），
知乎稿和公众号正文是带的。重跑 `qa` 会整节替换，幂等。

## 不可逆操作红线 ⛔

- 「发布 / 发表 / 群发」一点就是公开，**没有二次确认、不能撤回**。
- **只有用户当轮消息里明确说了「发」才能点**；「看看」「试试」「先弄好」都不算。
- 发布前把「标题 + 首段 + 图片数 + 平台」列出来（`preview` 已包含），让用户最后确认一次。
- 公众号脚本只允许 `draft/add` / `draft/update`，**永远不调群发接口**。
- 改已有草稿一律**原地 update**，不要重复 `draft/add`：草稿箱里堆同名文章后用户分不清最新那份。

## 自动化边界

| 平台 | 能自动做完 | 只能用户来 |
| --- | --- | --- |
| 公众号 | 渲染 + 传图 + 二维码 + 建/更新草稿 + 读回验证（内置驱动） | 预览、点群发 |
| 知乎 | 渲染产物已就绪；灌编辑器需自己实现驱动 | — |
| 小红书 | 切图与短文案已就绪；上传需自己实现驱动 | — |
| 手动 | 列出 `dist/` 里全部产物路径（内置驱动） | 复制粘贴、点发布 |

**不要把手能做到的事写成「需要你手动完成」，也不要替用户点不可逆按钮。**

## 平台要点（细节见 references/）

**知乎**：本仓库只出渲染产物，不内置自动化。
`render:zhihu` 已经把公式写成 `data-eeimg="2"` 的居中行间公式，正文 HTML 可直接粘贴；
要全自动灌编辑器，按 [docs/drivers.md](../../docs/drivers.md) 自己实现驱动。
→ 人工流程见 [docs/zhihu-workflow.md](../../docs/zhihu-workflow.md)

**小红书**：`render:article` 出 6 张切图（780×1040）+ `xhs.md` 短文案，上传靠手动或自己的驱动。
顺序不能变 —— 传图 → 标题 → 关浮层 → **最后一次**写正文 → 立刻核对；
标题 **≤20 字符**，必须新建时写对（事后改会被旧快照回写覆盖）。
→ [docs/xiaohongshu-workflow.md](../../docs/xiaohongshu-workflow.md)

**公众号**：走官方接口，`npm run publish:platform -- --slug=X --to=wechat` 一条命令建草稿并读回比对；
改稿必须**整套重跑**（草稿是 `draft/add` 那一刻的快照）。
→ [references/wechat-publish.md](references/wechat-publish.md)

**自己的站点（可选）**：内容都在 `articles/`，想发布到自己的站，读这个目录即可
（本仓库不做站点构建）。

## 常用命令速查

```bash
npm run publish -- --status                                   # 看板
npm run fetch:all -- --slug=X --arxiv=<id>                    # PDF + 原图 + 调研 并发取齐
npm run briefing -- --slug=X                                  # 三路调研 → 写作简报
npm run pipeline -- --slug=X --paper=/tmp/X.txt --jobs=8      # 写稿全链（并发）
npm run polish -- --slug=X [--only=s4] [--dry]                # 只润色
npm run qa -- --slug=X [--n=9] [--dry]                        # 文末问答（数字溯源校验）
npm run finalize -- --slug=X                                  # 推进状态机 + 渲染 + 预览
npm run preview -- --slug=X                                   # 发布前那一屏
npm run publish:check -- --slug=X                             # 25 项机器自检
npm run publish:platform -- --slug=X [--to=wechat]            # 交给发布驱动
npm run bench:llm -- --n=16 --jobs=8                          # 网关并发压测
```

完整命令表（40+ 条，含每个子脚本的参数）见 [references/commands.md](references/commands.md)。

## 遇到问题时先读这几处

| 文件 | 什么时候读 |
| --- | --- |
| [references/publish-failure-modes.md](references/publish-failure-modes.md) | 动手发任何平台之前 |
| [references/pipeline-performance.md](references/pipeline-performance.md) | 改并发、换网关、觉得慢 |
| [references/e2e-runbook.md](references/e2e-runbook.md) | 需要更细的分步说明和原理 |
| [references/incidents.md](references/incidents.md) | 排查「以前是不是踩过这个坑」 |
| [references/writing-depth.md](references/writing-depth.md) | 觉得稿子不够深 |
| [references/figures.md](references/figures.md) | 改取图逻辑 |
| `publish/config.yaml` | 账号定位、读者画像、结构骨架（用户会改，以它为准） |
| `publish/writing-spec.md` | 写作规范，写稿前必读 |
| `publish/checklist.md` | 人工项（默认只是可选抽查） |

## 本 skill 的维护

- **新增阶段**：同时改 `scripts/publish.mjs` 的 `STAGES`、`scripts/pipeline.mjs` 的 `GROUPS` 和本文。
- **新增自检项**：改 `scripts/publish-check.mjs`，编号同步到 `publish/checklist.md`，并更新本文验收表。
- **踩到新坑**：加到 [references/incidents.md](references/incidents.md) 最上面（日期 + 现象 + 根因 + 怎么避免）。
- **命令速查表**：新增 npm script 时同步 [references/commands.md](references/commands.md)。
