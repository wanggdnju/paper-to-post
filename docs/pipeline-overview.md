# 文稿生成全流程与产出清单

从一篇 arXiv 论文到三平台可发布素材，一共经过 **6 个阶段、21 个脚本**。
本文按实际执行顺序讲清每一步「输入什么、产出什么、为什么需要它」，
以及最终 `articles/<slug>/` 里每个文件是干嘛的。

```
① 取料   → ② 调研 → ③ 结构化 → ④ 写稿 → ⑤ 质检派生 → ⑥ 排版发布
 fetch:pdf    research:paper    facts       outline    critic      render:html
 fetch:figures research:platform glossary    generate   verify:numbers render:article
 extract:links research-deep*   briefing    titles     derive       render:zhihu
 render:table                  (子智能体)              compare      render-wechat
                                                       diagram      wechat-publish
                                                       score/regress
```

`*` 标的是唯一没有对应脚本的一步：`research-deep.md` 由子智能体产出，`publish.mjs` 会强制检查它存在。

---

## ① 取料：把论文本身的东西拿到本地

| 脚本 | 输入 | 产出 | 关键约束 |
| --- | --- | --- | --- |
| `fetch-pdf` | arXiv URL/ID | `/tmp/<slug>.pdf` + `.txt` | 必须走浏览器会话：裸 curl 拿到的是 HTML 跳转页或 403 |
| `fetch-figures` | `--arxiv=<id>` | `assets/fig-*.png` + `figures.json` | 从 e-print 的 `figures/*.pdf` 取，不从 PDF 抽图（抽出来是空白或碎块） |
| `extract-links` | LaTeX 源 / PDF | `assets/links.json` | 只收集分类，**不判断归属**（论文常引用别人的仓库） |
| `render-table` | 论文 PDF + caption | `assets/tab-*.png` | **首选**：按 caption 定位、PDFKit 裁图，与论文排版逐字一致 |
| `render-table --tex` | 表格 `.tex` | `assets/tab-*.png` | 退路：LaTeX→HTML→KaTeX→Chromium 截图（要自己解释 LaTeX，容易错） |

`figures.json` 是后面写稿的插图依据：每张图带 `section` / `caption` / `label` / `width`，
模型按它决定「这张图放哪一节」。没有这些元数据的条目（logo、icon）要过滤掉。

---

## ② 调研：论文没写、但影响结论可信度的东西

三路并行，互不依赖，失败一条不影响其余：

| 脚本 | 走什么通道 | 产出 | 回答什么 |
| --- | --- | --- | --- |
| `research-paper` | curl（公开 API） | `research.md` | 这篇在谱系里什么位置、社区有没有质疑、作者还有哪些工作 |
| 平台侧调研（手工/自建） | 浏览器 | `research-platform.md` | 知乎/小红书别人怎么讲这篇——哪些已讲透，哪些没人讲 |
| 子智能体 | 任意 | `research-deep.md` | 穷举 GitHub issue/PR、第三方复现、论坛；每条标「论文说的/仓库说的/第三方说的」 |

分开跑的理由是失败模式不同：`research-paper` 撞的是网络策略（实测 arxiv.org 报
"Unable to verify if domain is safe"，所以只用 curl 不走 WebFetch）；
`research-platform` 撞的是登录态和风控。合成一个脚本，一条挂了整步都废。

**`research-deep.md` 的约定驱动**：影响写稿判断的结论必须写成 `> **写稿影响**：…`，
`briefing.mjs` 只认这个标记。早期版本用正则匹配具体句子（`/对真正最强的基线只领先 3\.7%/`），
换一篇论文全部匹配不上，**安静地输出空列表**——比报错更糟。

---

## ③ 结构化：把材料变成「模型只能照着说」的约束

这一步是整个流程可信度的地基。三个产物都是**给后面的模型当护栏用的**：

### `facts.json` —— 数字对照表

从 LaTeX 源表抽出 402 条事实，每条形如：

```json
{ "id": "tab:main-acceptance@Qwen3-8B/DSpine (ours):Overall / Avg.",
  "table": "tab:main-acceptance", "group": "Qwen3-8B",
  "method": "DSpine (ours)", "column": "Overall / Avg.", "value": "4.82/4.42" }
```

为什么必须做：稿件最危险的错误不是「写得不深」，而是**数字张冠李戴**——
把 GSM8K 位置 8 的单点值 `31.8` 当成三位置均值、把采样时对 DSpark 的领先 `12.8%`
当成「DSpark 比 DFlash2 高」。两者都语法正确，任何「数加粗、数表格」的检查都发现不了。

### `glossary.json` —— 术语锁定

分节生成时模型看不到别的节写了什么，术语**一定漂移**：这节叫「并行草稿」，
下节叫「并行 draft 网络」，再下节叫「候选生成器」。先把高频英文术语捞出来定死中文名，
之后每节都注入同一份。`--no-llm` 也能用（只出候选英文术语，人工填中文）。

### `briefing.md` —— 写稿前必须知道的三条对照

**不是**把两份调研拼给模型（1.6 万字原始材料，信噪比太低），而是提取成：

1. **冲突点**：论文说的 vs 外部查到的 → 这是深度解读的价值所在
2. **差异点**：别人讲过的 vs 还没人讲的 → 决定我们写什么
3. **口径陷阱**：哪些数字必须小心 → 最容易写错的地方

不调模型，纯结构化提取 + 人工可读清单。

---

## ④ 写稿：大纲 → 分节生成 → 标题

### `outline.json` —— 决定上限的那一页

```json
{ "id": "s6", "heading": "主要结果：两个模型、两个温度、七个基准全胜，但领先幅度分层明显",
  "claim": "…", "factIds": [11 条], "figures": [2 张], "words": 1500, "notes": "…" }
```

先写大纲不直接写正文，三个理由：**大纲决定上限**（每节论断若只是「介绍方法」，正文必然平庸）；
**审阅成本差一个数量级**（一页三十秒看完 vs 8000 字半小时）；分节生成时上下文干净。

约束是硬的：`factIds` 限定这节能引用哪些数字，`figures` 限定插哪张图。

### `generate` —— 分节写，不是一次写 8000 字

每节上下文 = 全文论点 + 本节 claim + **邻节摘要** + 术语表 + **允许引用的 fact** + 原始材料。
不给全文，也不给其它节的成稿——避免上下文被自己的旧输出带跑。

一次生成长文的实际表现是「前 3 节详、后 5 节水」，第 6 节之后开始复读；
而且单节不满意重跑几十秒，重跑全文要几分钟。

每节落盘 `drafts/<section-id>.md`，最后拼成 `article.md`。每节按目标字数扣分
（`score -= |实际-目标|/目标 * 10`），低于目标 60% 直接报问题。

### `titles` —— 标题候选 + 查重

单独做是因为标题决定点击率，而现在是在写稿时随手定的。
**必须查重**：`research-platform.md` 已经抓到知乎同题文章，撞车的后果是读者一眼认为「这篇我看过了」。
查重不调模型：字级 Jaccard + 最长公共子串，两个信号都高才算撞车。

---

## ⑤ 质检与派生：让错误在发布前暴露

| 脚本 | 产出 | 抓什么 |
| --- | --- | --- |
| `critic` | `critic.json` / `.md` | 论断有没有依据、因果是不是作者自己补的、第三方数字有没有当论文数据用 |
| `verify:numbers` | 退出码 + 报告 | 正文每个小数能否在 `facts.json` 找到出处 |
| `derive` | `zhihu.md` / `xhs.md` / `xhs-article.md` | 四份稿子的一致性 |
| `format:article` | 原地改写 `article.md` | 补元信息块、图表编号、标题编号、修粘连表格 |
| `compare` | `compare.json` | 与同线方法的机制差异 + 数字对比 |
| `diagram` | `diagram.json` + PNG | 机制怎么流动 |
| `score` / `regress` | `score.json` / `history/` | 改了提示词之后变好还是变坏 |

### critic 为什么必须换一个模型

机器自检只能数加粗、数表格、查宏，查不出「这个论断论文没说过」。
而且**必须由没写过这件稿子的模型来看**——同一个模型回头看自己的输出，倾向于认为都合理。

设计上三条：逐段过（一次喂 8000 字只会给三条泛泛建议）、
输入是「段落 + 它声称引用的数字 + 原文相关片段」（让它判断到句）、
**只出缺陷清单不改稿**（改不改由人决定，避免把对的句子改坏）。

### verify:numbers 的判定口径

- facts 里有的值 → 通过，并报出它属于哪张表哪一格
- 带 `%` / `×` 的派生值 → 通过，但要求分子分母至少一方在 facts 里（加速比本来就是算出来的）
- 其余 → 报「无出处」，逐条列出

### derive 为什么是派生不是手写

四份稿子互相独立靠人保持一致，是**注定会漂移**的结构。改了一个数字忘了改其余三份，
是这类流程最典型的错误，而且自检查不出来（每份单看都自洽）。

**派生分两种，不能混为一谈：**

| 产物 | 方式 | 是否改措辞 |
| --- | --- | --- |
| `zhihu.md` | 纯规则：公式→`【公式N】`、图→`【图N】` | 否，可逐字对应 |
| `xhs-article.md` | **抽取**：切成块，模型只挑编号，正文原样拼接 | 否，逐字来自主稿 |
| `xhs.md` | **重写**：LLM 压到 1000 字以内 | 是，只能靠校验兜底 |

早先版本 `xhs-article.md` 也是「让模型压到 1200–1800 字」，结果是模型把每段重述一遍。
数字一致性校验能过（数字没变），但**语气被改了**，实测两处：

- 主稿「这条性质本身没有多少可改的余地」→ 小红书「这块没有优化空间」
- 主稿「原文只说 accuracy，没指明模型/基准，只能当量级参考」→ 整句消失，变成断言

这类漂移比算错数字更危险：读者看不出差别，但作者原本的保留没了。所以改成抽取模式：

1. 主稿按空行切成「块」（段落 / 图 / 表 / 公式），每块编号
2. 模型**只输出编号**，不改写任何文字
3. 代码里兜底：`##` 标题必留、最多 20 块、带保留的段落优先保留
4. 修「悬空连接词」——段首是「但 / 而 / 所以」而上段被裁掉时，把上段补回来

`xhs.md` 因为必须重写，只能靠校验：主稿里带保留的句子（`约` / `只能当参考` / `未指明` /
`略优` 等）会**显式列进提示词要求照抄**，派生后再逐条核对有没有丢。

一致性校验三项：变体里每个数字必须能在 `article.md` 找到（防凭空造数）、
知乎公式数必须等于原文、保留语不能丢（`xhs-article` 额外要求每句都能在原文找到）。

> 踩过的坑：判断「保留还在吗」用的是带 `/g` 的正则 `.test()`，它会留 `lastIndex`，
> 第二次调用从上次位置继续找——同一句话判两次结果不同。必须每次新建正则实例。

---

## ⑥ 排版与发布

| 目标 | 脚本 | 产物 | 限制 |
| --- | --- | --- | --- |
| H5 单页 | `render-html` | `dist/html/<slug>.html` | KaTeX 字体内联，单文件可发给别人 |
| 小红书 | `render-article` | `dist/xhs/<slug>-00-cover.png` + `-01…` | 1080×1440 逐屏截图，分页不跨图/不切句 |
| 知乎 | `render:zhihu` | `dist/zhihu/<slug>.html` | 公式直接写成 `data-eeimg="2"` 原生节点（行间、居中）；图片走文件粘贴、图注填 figcaption |
| 公众号 | `render-wechat` + `wechat-publish` | `dist/wechat/<slug>.html` + 草稿 | 只建草稿，**不调群发接口** |
| 发布 | `publish:platform` | 交给驱动 | 见 [drivers.md](drivers.md) |

发布走驱动层：`manual` 只列产物路径，`wechat` 建公众号草稿。
知乎/小红书的自动化要自己实现驱动——平台只有网页编辑器，绑定具体浏览器工具的
实现没法做成通用代码。

**这个仓库不包含站点构建。** 内容都在 `articles/<slug>/`，想发布到自己的站，
读这个目录即可（markdown + yaml + assets，没有隐藏约定）。

不可逆操作红线：只有用户当轮明确说「发」才点发布。「看看」「试试」都不算。
公众号脚本只做到 `draft/add`，群发必须用户自己在后台点。

---

## 产出清单：`articles/<slug>/` 里每个文件

### 输入与素材

| 文件 | 大小（dspine） | 说明 |
| --- | --- | --- |
| `article.yaml` | 1.6 KB | 状态机，`publish.mjs` 读写，**状态字段不要手改** |
| `source/latex/eprint.tar.gz` + `tree/` | — | arXiv e-print 原始包（facts 和原图都从这里来） |
| `source/tables/main.tex` | — | 主结果表，`render:table --tex` 的输入（首选是从 PDF 裁） |
| `cover/*.pdf` | 6 张 | 论文原始矢量图（fetch-figures 另存一份） |
| `assets/fig-*.png` | 6 张 | 论文原图 |
| `assets/tab-main.png` | 276 KB | 论文原表（原表直贴，不重排） |
| `assets/figures.json` | 3.7 KB | 图注 / 章节 / 引用宽度 |
| `assets/links.json` | 1.6 KB | 代码 / 权重 / 项目页；`related` 单独一栏放相关仓 |
> `links.json` 现在除了解析 LaTeX 和 PDF，还会合并 `research.md` 里
> `### 疑似官方仓：owner/repo` 那一节的仓库。原因是论文正文常常**根本不写代码仓**
> （dspine 的 LaTeX 里只有项目页），仓库是调研阶段从 GitHub 搜索找到的。
> 只解析 tex 会得到 `github: []`，而那个空数组不是「这篇没开源」，是「我们没找到」。
>
> 合并时只认官方仓那一节，不碰上面的关键词搜索表格（里面混着 Urho3D 的 Spine 运行时
> 这类完全无关的同名项目）；README 里链接到别人的基线权重（`z-lab/Qwen3-8B-DFlash-b16`）
> 也按 owner 过滤掉。训练代码合并进的上游框架（`sgl-project/SpecForge`）放 `related`，
> 页面显示成灰色斜体的「相关 ·」，不和「代码」同等对待。

### 调研

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `research.md` | 9 KB | 外部调研线索，每条带 URL |
| `research-deep.md` | 8 KB | 深度调研，每条标可信度来源 |
| `research-platform.md` | 7 KB | 知乎同题文章对照（只读，不抄） |
| `briefing.md` / `.json` | 5 + 3 KB | 三条对照，写稿前读这个 |

### 结构化

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `facts.json` | **162 KB** | 402 条数字事实，8 张表 |
| `glossary.json` | 3 KB | 术语中英对照 |
| `outline.json` / `outline.md` | 11 + 6 KB | 8 节，每节 claim + factIds + figures + words |

### 正文与变体

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `article.md` | 31 KB / 7,435 中文字 | 最终定稿，9 个 `##`、24 个 `###`、14 张表、6 张图 |
| `zhihu.md` | 33 KB | 公式换 `【公式N】` 占位 + 文首 TeX 清单 |
| `xhs-article.md` | 4 KB | 小红书精简版（14 屏以内，切图来源） |
| `xhs.md` | 3 KB | 小红书发布文案（带话题） |

### 质检与评分

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `critic.json` / `.md` | 7 + 5 KB | 1 high / 7 medium / 1 low，逐条带原句 + 问题 + 建议 |
| `score.json` | 1 KB | 总分 70：自检 22/22、数字 61 个全溯源、critic 计数、篇幅、变体一致性 |
| `history/scores.jsonl` | — | 每次 `--record` 追加一行，供 `regress` 看趋势 |
| `review.md` | 1.1 KB | 人工审稿记录 |

### 站上用（本轮新增）

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `compare.json` | 14 KB | 1 张数字对比表（5 方法 × 8 指标 × 2 模型）+ 4 个基线 + 6 个机制维度 + 4 条判断 |
| `diagram.json` | 4 KB | 14 节点 / 16 边 / 4 列 / 3 分组 |
| `assets/fig-<slug>-diagram.svg` + `.png` | 15 KB + 220 KB | 渲染产物，PNG 供公众号/知乎用 |

### 交接

| 文件 | 说明 |
| --- | --- |
| `交付清单.md` | 给用户的交接单，**全部从磁盘现状读取**（手写一定会过期） |
| `pipeline-log.json` | 各阶段耗时与成败 |
| `generate-log.json` | 生成用量（calls / prompt tokens / completion tokens） |

---

## 一条命令跑完

```sh
node scripts/pipeline.mjs --slug=dspine --src=/tmp/dspine-src --paper=/tmp/dspine.txt
```

阶段顺序：`facts → glossary → outline → generate → critic → derive → compare → diagram → score`

注意 pipeline **不含**取料和调研（① ② 两步）：那几步依赖外部网络、登录态和 LaTeX 解包，
失败方式各不相同，不适合串进一条按顺序跑到底的链子。先手动跑完再进 pipeline。

设计要点：

- **每个阶段是独立脚本**，pipeline 只负责「按顺序跑、失败就停、记录耗时」
- 单步失败能单独重跑（大纲不满意只重跑 outline，critic 太慢可以跳过）
- **默认从第一个缺产物的阶段开始**，所以中断后直接重跑即可续上
- `--from` / `--to` 限定区间，`--dry` 只打印计划
- `facts` / `glossary` / `critic` / `compare` / `diagram` 标了 `optional`：前置条件不满足时跳过，
  不阻断后面。站上附加内容没做出来，正文照样能发。

---

## 当前 dspine 的实测状态

| 指标 | 值 |
| --- | --- |
| 自检 | 22 / 22 通过 |
| 数字溯源 | 61 个数字，0 个无出处 |
| critic | 1 high / 7 medium / 1 low（high 是标题里「并行草稿的平均接受长度」这个限定不成立） |
| 总分 | 70 / 100 |
| 篇幅 | 7,435 中文字（目标 5,000–9,000）|
| 变体一致性 | zhihu / xhs / xhs-article 三份均 0 个多出来的数字 |
| 落地信息 | 1 代码仓 + 3 HF + 1 项目页 + 1 相关仓 |
| 平台状态 | zhihu / xiaohongshu / wechat 全部 `todo`；公众号草稿已建（`wechat_draft_id` 有值） |

**已修（2026-11-11）**：`assets/links.json` 之前是 `github: []`，但 `research.md` 明明抓到了
`Tencent/DSpine`。原因是 `extract-links.mjs` 只解析 PDF/LaTeX，而论文正文根本没写仓库地址——
代码仓是调研阶段从 GitHub 搜索找到的。修法是让脚本合并 `research.md` 里
`### 疑似官方仓` 那一节（见上文 `links.json` 的说明）。现在 dspine 有
1 个代码仓 + 3 个 HF 条目 + 1 个项目页 + 1 个相关仓，`publish-check` 的 A10 从假通过
变成真的 5 条落地信息。

**渲染时的 h1 叠层**：`render-html.mjs` 会把正文开头的 `# 标题` 剥掉，
否则页面会出现两个 `<h1>`（模板一个、正文一个）。自己写站点渲染时注意这一点。
