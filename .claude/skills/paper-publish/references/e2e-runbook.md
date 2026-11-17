# 端到端流程：从一个 arXiv URL 到三平台发布

> 这份是**执行清单**，不是原理说明。原理和坑在各自的 reference 里，这里只列「按顺序做什么、
> 每步的验收判据、哪些要停下来找用户」。
>
> 适用：用户丢来一个 `https://arxiv.org/abs/XXXX.XXXXX` 或 `arxiv.org/pdf/...` 链接。

## 0. 开工前五分钟

```sh
node --version                            # 需要 >= 20.18
npm run publish -- --status               # 看板：当前所有文章的状态
```

读一遍（顺序有讲究，别跳）：

| 读什么 | 为什么 |
| --- | --- |
| `publish/config.yaml` | 账号定位、读者画像、**各平台发布意图**。用户会改它，以它为准 |
| `publish/writing-spec.md` | 写作规范 |
| `publish/checklist.md` | 人审项 |

**确定 slug**：用论文方法的短名（`dspine`、`dflash`），全小写、无连字符，和目录名一致。

**确认平台范围**：`config.yaml` 里 `platforms.*.status` 决定发哪几个。默认三平台全发。

---

## 1. 建档（`new`）

```sh
npm run publish -- --slug=<slug> --stage=new --arxiv=<id 或完整 URL>
```

**`--arxiv` 三种写法都行**，内部统一归一化成裸 ID：

```
https://arxiv.org/abs/2609.36173
https://arxiv.org/pdf/2609.36173v2.pdf
arxiv:2609.36173
2609.36173
```

归一化在 [scripts/lib/arxiv.mjs](../../scripts/lib/arxiv.mjs)，`publish` / `fetch:pdf` / `fetch:figures` /
`research:paper` 四个入口共用同一套规则——这样不管从哪一步进来，`article.yaml` 里存的都是裸 ID。
（早期每个脚本各写一行 `replace(/^arxiv:/i,'')`，粘 URL 进去会把整个 URL 当 ID 存下，
后续取图、调研**静默拿不到数据且不报错**。）

从 arXiv API 拉标题和作者（`--title=` 可覆盖），写出 `articles/<slug>/article.yaml` 的骨架。
**状态机**：`new → drafted → reviewed → rendered → published`，不能跳阶段。

验收：`articles/<slug>/article.yaml` 存在，`status: new`，且 **`arxiv_id` 是裸 ID（12 位或旧式编号），不是 URL**。
API 没返回标题时会当场告警——补 `--title="..."`，别在空标题上继续跑。

---

## 2. 取素材（论文全文 + 图 + 原表 + 落地链接）

```sh
# 一条命令并发取三样（PDF + 图 + 外部调研），随后自动跑 extract:links
npm run fetch:all -- --slug=<slug> --arxiv=<id>

# 等价的单步命令（调试时用）：
npm run fetch:pdf -- https://arxiv.org/pdf/<id> --out=/tmp/<slug>.pdf
npm run fetch:figures -- --arxiv=<id 或 URL> --slug=<slug>
npm run extract:links -- --slug=<slug> --pdf=/tmp/<slug>.pdf
npm run render:table -- --slug=<slug> --pdf=/tmp/<slug>.pdf --page=<页> --caption="Table 1" --out=main
# 找不到 caption 或表格跨页时退回首选之外的方案：
npm run render:table -- --slug=<slug> --tex=<path-to-main.tex> --out=main
```

`fetch:all` 只并发**互不依赖**的步骤：fetch:pdf、fetch:figures、research:paper 同时跑；
`extract:links` 依赖 fetch:figures 落盘的 e-print，放在第二组。
`render:table` 要知道表在第几页，平台侧调研要走登录态浏览器，都**不**自动化。

- `fetch:figures` 会把 e-print 里的矢量 PDF 渲染成 2x PNG，并写 `assets/figures.json`（caption + 章节）。
  **必须肉眼看一遍**：出现深灰边 / 工具栏 / 缩略图侧栏说明裁切坏了，先修脚本再往下走（见 figures.md）。
  > **教程类（`kind: guide`）不要跑这一步**（2026-11-15 用户确认）。抽图是为论文里现成的
  > 架构图/实验图服务的；教程没有可抽的原始矢量图，配图自己画（`npm run diagram`）。
  > 这一步只对 `--arxiv` 进来的论文适用。
- `extract:links` 产出 `assets/links.json`，**归属要人工确认**——论文常引用别人的仓库。
- `render:table` 默认**从论文 PDF 里按 caption 裁图**，得到的是论文排版的最终结果，逐行逐列与原文一致。
  之前的 `--tex` 路线要自己写 LaTeX 子集解释器，每加一种写法就多一个 bug，而且错得很安静
  （2026-11-11：`\multicolumn` 贪婪正则把两列合并，页面上印出「2 HumanEval」「2cGSM8K」，数字检查全过）。
  **优先用原表图片，不要自己抄表**（用户明确要求过）。

验收：`assets/` 下有 `fig-*.png`、`tab-*.png`、`figures.json`、`links.json`。

### 2b. 外部调研（写稿前做，别跳过）

```sh
npm run research:paper -- --slug=<slug>        # → articles/<slug>/research.md
```

论文正文只回答「作者想让你知道什么」。深度解读还需要**论文没写的东西**，脚本去抓：

| 抓什么 | 为什么有用 |
| --- | --- |
| arXiv 版本历史 | `published` 和 `updated` 差很久 = 改过稿，要读最新版 |
| 官方代码仓 README | 常含论文没写的部署要求、额外支持的模型、后续更新 |
| **仓库 open issues** | 质疑、复现问题、部署坑——**信息量最大的一块** |
| Semantic Scholar 引用 | 引言「领域演进」按 references 排谱系 |
| HN / Reddit 讨论 | 社区质疑如果成立就写进「局限」 |
| 项目页 / HF 模型卡 | 作者补充的实测数字 |

**这一条不是可选的。** DSpine 就是靠 issue #1 发现：论文说用 ShareGPT 训练，
但发布权重用的是 Open-PerfectBlend，两者训练预算不同（论文 batch 112 / 3655 步，
发布版 batch 168 / 50528 步）。这种信息论文正文永远不会写。

> 脚本只产出**线索**，不产出结论。三条纪律：
> - 搜到的仓库**未必是官方实现**，要核对仓库名 + 描述是否指向本论文；
> - issue 里的质疑要判断成不成立，不成立就写清为什么不成立；
> - 第三方复现的数字（「我在 XX 上跑出 30 tok/s」）**不能当论文数据引用**，最多当旁证。

> ⚠️ 脚本走 shell 的 `curl`。**不要用 WebSearch / WebFetch**——某些环境下被企业网络策略拦截
> （实测 arxiv.org 返回 "Unable to verify if domain is safe"）。

### 2c. 平台侧调研（看别人怎么讲，定差异）

本仓库**不包含**这一步的脚本：它需要读取你已登录的浏览器去搜知乎/小红书，
属于浏览器自动化，绑定具体工具（见 [drivers.md](../../../docs/drivers.md) 的说明）。

手工做也只要十分钟：在知乎搜「<方法名>」，记下**已有人写过的角度**。用途是**定差异，不是抄**：

| 对照结果 | 我们怎么办 |
| --- | --- |
| 别人已讲透 | 写得更深（补数字、补推导），或直接略过 |
| 没人讲 | 这就是差异，优先写、放显眼位置 |
| **标题雷同** | 必须换角度 |
| 评论区的问题 | 直接当小节标题 |

> **实测案例**：某篇并行草稿论文，知乎已有两篇从机制切入的解读，标题几乎一样。
> 结论：我们改从**结果**切入（接受长度 3.77 → 4.82），而不是重复讲机制。

### 2d. 通用网页抓取（Scrapling，备选通道）

前两步覆盖不了的公开页面，用 Scrapling（Python，静态抓取 + CSS 选择器 + stealth 浏览器）：

```sh
npm run research:scrape -- --url=<URL> [--out=path.md] [--max-words=3000]
npm run research:scrape -- --urls=urls.txt --out=articles/<slug>/raw/   # 批量
```

首次使用要先建环境（已 gitignore，不会进仓库）：

```sh
python3 -m venv .venv-scrapling
.venv-scrapling/bin/pip install -r scripts/requirements-scrapling.txt
```

**什么时候用它、什么时候不该用**：

| 场景 | 用什么 |
| --- | --- |
| 公开免登录页面（项目页、GitHub Pages、博客） | **Scrapling**（输出干净、无浏览器协调开销） |
| 需要登录态的站点（知乎、小红书） | 本仓库不提供，见 docs/drivers.md |
| 服务端不给数据的（小红书 PC 搜索） | **都不行**，别浪费时间 |

> 实测（2026-11-10）：知乎专栏页 Scrapling 直接 **403**（要登录态）；小红书搜索页
> 静态/浏览器都返回空壳（`__INITIAL_STATE__` 里没有 `noteList`、没有 `xsec_token`，
> 服务端在 SSR 阶段就不给数据）。**换工具解决不了服务端反爬。**

> ⚠️ Scrapling 的 stealth 浏览器（Camoufox）需要额外下载几百 MB，当前网络从 GitHub
> Releases 拉不下来，所以脚本默认只走静态抓取；`--dynamic` 开关在但不可用。
> Python 3.9 能跑（实测），无需升级。

**已知限制**：
- 静态抓取拿不到知乎搜索页（持续异步更新），要抓就得驱动浏览器并等页面稳定；
- **小红书抓不到**：PC 搜索需要 `xsec_token`，登录态正常也返回空结果壳。这是服务端反爬，
  不是登录问题，换工具也解决不了。要参考小红书内容只能人工看。

---

### 2e. 合成写作简报（三路调研 → 一份可读的东西）

```sh
npm run briefing -- --slug=<slug> [--paper=/tmp/<slug>.txt]
# → articles/<slug>/briefing.md
```

前四步产出的是**原始材料**（research.md 9k + research-deep.md 8k + research-platform.md 7k ≈ 2.8 万字），
写稿时读不动。简报把它们压到约 4–5 千字，只留三件事：

| 段落 | 内容 | 用途 |
| --- | --- | --- |
| ① 论文 vs 外部 | 深度调研标的「写稿影响」+ 训练配置口径差异 + 官方仓 open issues | 写进「局限」「实验设置」——**这是深度解读比论文摘要多出来的价值** |
| ② 别人写过什么 | 知乎同题文章标题清单；小红抓不到时会明说 | 定标题和角度，避免撞车 |
| ③ 数字口径陷阱 | 高频数字 + 每个要核对什么 | 防「31.8 当成均值」「12.8% 张冠李戴」这类错 |

`publish-prompt.mjs` 会自动优先注入 `briefing.md`（没有才退回 research.md），
并且把**缺了哪份材料**直接写进提示词，让模型在拿不准的地方留余地。

##### ①-a 靠一个约定来收集，不靠正则猜

深度调研里凡是「影响写稿判断」的结论，**必须**写成这样：

```markdown
> **写稿影响**：仓库那组数据里，对真正最强的基线只领先 3.7%，不是论文口径的 10.0%。
```

`briefing.mjs` 把所有 `> **写稿影响**：` 开头的行抽出来组成 ①-a。`>` 后面的续行会拼成一句。

为什么用约定而不是自动识别：早期版本用正则匹配具体句子（`/对真正最强的基线只领先 3\.7%/`），
**只能命中 DSpine 那一篇**；换论文全部匹配不上，安静输出空列表——比报错更糟。
现在换论文不用改脚本，标记漏写还会告警。

> 一条都没标时 `briefing.mjs` 会往 stderr 打告警，`--stage=drafted` 也会硬拦。

##### 深度调研的固定骨架（交给子智能体时直接复制）

```markdown
# 外部调研（深度）：<方法名>

> <日期> 由子智能体完成。可信度分级：本文件每一条都标来源，「论文说的 / 仓库说的 / 第三方说的」三者不混。
> ⚠️ 本环境限制（影响可查范围）：<写清哪些站点不可达>

## 一、<最要紧的一处矛盾，例如训练配置口径>
<表格并列各方说法 + 出处链接>
> **写稿影响**：<一句话，写稿时该怎么用/怎么限定>

## 二、<口径问题，例如 block size / 评测设置>
> **写稿影响**：<...>

## 三、<第三方实测>
> **写稿影响**：<哪些数字能引、哪些只能当旁证>

## 四、<部署门槛>
> **写稿影响**：<...>

## 五、谱系定位（写「领域演进」用）
## 六、论文本身的可写局限
## 七、明确查不到的（不要猜）
```

**每一节都要至少有一条 `> **写稿影响**：`**——这正是简报 ①-a 的来源。
第七节尤其重要：写清楚「查不到」才能防止写稿时凭空补全。

## 3. 写稿（`drafted`）

**先读 `articles/<slug>/briefing.md`**（上一步生成的），再读 `article.md` 现有结构或 writing-spec 骨架。
原始细节需要回查时，再去 `research-deep.md` / `research-platform.md`。

### 3a. 自动化链路（一条命令）

```sh
npm run pipeline -- --slug=<slug> --src=/tmp/<slug>-src --paper=/tmp/<slug>.txt
```

按顺序跑 `facts → glossary → outline → generate → polish → critic → derive → compare/diagram → score`，
失败停住、可从断点续跑（`--from=generate`）、每步耗时记在 `pipeline-log.json`。
`--dry` 先看一遍会跑哪些阶段。

| 阶段 | 产物 | 作用 | 缺它会怎样 |
| --- | --- | --- | --- |
| `facts` | `facts.json` | 从 LaTeX 源表抽「值 → 表/行/列」对照表 | 数字溯源退化成 A8 的粗查 |
| `glossary` | `glossary.json` | 定死术语中英对照 | 分节生成时术语漂移 |
| `outline` | `outline.json` + `.md` | 8 节大纲，每节带 claim / factIds | — |
| `generate` | `draft/sN.md` → `article.md` | 分节生成 | — |
| `polish` | `polish.json`（原地改写 `article.md`） | 跨节连贯 + 拆长句，只改表达 | 节与节接不上、句子晦涩 |
| `critic` | `critic.json` + `.md` | 独立模型逐段挑「站不住的说法」 | 查不出 overclaim / 归因错 |
| `derive` | `zhihu.md` / `xhs.md` / `xhs-article.md` | 从 article.md 派生三平台变体 | 四份稿子会各自漂移 |
| `score` | `score.json` + `history/scores.jsonl` | 0–100 分，可比 | prompt 调整全是盲调 |

### 3b. 大纲：过去的人工审阅点，现在可选

```sh
cat articles/<slug>/outline.md      # 一页纸，8 行，每个小节一句话
```

**默认不停下来等审阅。** 用户明确要求「不要人工审核，只在发布时看一眼」。
大纲仍然是质量上限最高的干预点，想调就改 `outline.json` 里对应小节的 `claim` 再重生成：

```sh
npm run generate -- --slug=<slug> --only=s4 --force && npm run polish -- --slug=<slug> --only=s4
```

### 3c. 分节生成的关键约束

- 每节的上下文 = 全文论点 + 本节 claim + 邻节**摘要**（不给全文）+ 术语表 + 允许引用的 fact + 论文片段；
- `factIds` 之外的数字模型不该写；写了会被 `verify:numbers` 抓出来；
- `--best-of=2` 每节生成两版按分数选优（成本翻倍，改稿阶段才用）；
- **拼装前会检查字数**：结果比现有 `article.md` 短于 70% 时拒绝覆盖并自动备份。

> ⚠️ 不要用 `--only` 重写一节之后手工拼装。脚本在「不是所有小节都在」时**不会**覆盖 article.md。

### 3d. critic：缺陷清单，不改稿

```sh
npm run critic -- --slug=<slug>
```

逐段问「这句凭什么这么说」，只报四类问题：overclaim / misattribution / unsupported / overreach。

**high 不再阻断流程**（它是编辑判断，不是机器错误）：`finalize` / `publish --stage=checked`
会告警，并在 `publish/preview.mjs` 的一屏里再列一次。需要严格把关时加 `--strict`。

它的证据来自三处：`facts.json`（这个数属于哪张表哪一格）、论文原文里关键词重叠的句子、
以及**按数字锚定的句子**（这段话里出现的每个小数，去原文找含它的那一句）。

**论文全文必须归档**：`prepare.mjs` 会把 `/tmp/<slug>.txt` 复制到
`articles/<slug>/source/paper.txt`，critic 优先读这一份。只留在 `/tmp` 时，
隔一天再跑 critic 就「没有论文」，它退化成只查内部一致性，然后对附录里的设定
（γ₀=4.5、块长 8）大段报「无出处」——2026-11-16 DFlare 实际踩到。

> critic 的 high **默认是假阳性候选人**，不是结论。它的检索是关键词 + 数字，
> 论文附录、表格单元格、图注经常召不到。逐条回原文核过再改：
> `grep -n "<关键词>"` 打 LaTeX 源（`articles/<slug>/source/latex/eprint.tar.gz` 解开），
> 核对结果写进 `review.md` 的「人工核对记录」，**不要为了让 critic 闭嘴改掉正确的内容**。

### 3e. 平台变体派生

```sh
npm run derive -- --slug=<slug>                  # 已有文件默认跳过，加 --force 覆盖
npm run derive -- --slug=<slug> --only=zhihu     # 纯规则，不调模型
```

| 变体 | 派生方式 | 自动校验 |
| --- | --- | --- |
| `zhihu.md` | 纯规则：`$$...$$` → `【公式N】`，图 → `【图N】`，文首附 TeX 清单 | 公式数 == 原文公式数 |
| `xhs.md` | LLM 压缩 | ≤ 1000 字、话题 ≥ 3 |
| `xhs-article.md` | LLM 裁剪到 12–14 屏 | 1200–2000 字、≥ 6 个 h2 |

三个变体都会比对数字集合，**多出来的数字直接报错**（压缩时最容易凭空算一个数出来）。

### 3f. 评分卡与回归

```sh
npm run score -- --slug=<slug> --record       # 算一篇的分，追加到 history
npm run score -- --slug=<slug> --compare=<另一篇>
npm run regress                               # 全局面板：所有文章最新分数
npm run regress -- --diff=dflash,dspine       # 两篇逐项对比
```

| 指标 | 权重 | 来源 |
| --- | --- | --- |
| 数字准确率 | 40 | `verify:numbers` |
| 机器自检通过率 | 25 | `publish-check` |
| critic 扣分 | 20 | high −10、medium −2 |
| 篇幅在目标区间 | 10 | `config.yaml` 的 `target_word_count` |
| 变体齐全 | 5 | 三个变体都在 |

`--record` 追加到 `history/scores.jsonl`。**改一次 prompt 就跑一次 `npm run regress`**，
这是唯一能回答「这次改动让它变好还是变坏」的东西。

### 3f-2. 标题候选（定稿前跑）

```sh
npm run titles -- --slug=<slug> --n=6
```

产出 6 个候选，每个带角度（result / mechanism / cost / lineage），
并自动和 `research-platform.md` 里抓到的知乎同题标题查重：

- 判据是**字级 Jaccard ≥ 0.45 且最长公共子串 ≥ 6 字**——两个信号都高才算撞车；
- 撞车的标记 ⚠️ 并说明和哪篇重合，全部撞车时退出码 1。

标题决定点击率，而它现在是在写稿时随手定的一个。**跑一下再定，成本 30 秒。**

### 3f-3. 阶段检查点

状态机现在是 `new → outlined → drafted → checked → reviewed → rendered → published`：

| 阶段 | 门槛 | 为什么多加这一级 |
| --- | --- | --- |
| `outlined` | `outline.json` 存在、非 `--dry` 空壳、每节都有 claim | 大纲是**唯一值得人工审的地方**，一页纸 30 秒 |
| `checked` | 正文存在 + `critic.json` 存在 + high 级问题为 0 | 生成几分钟到十几分钟，中途崩溃要靠状态表达「写到哪了」 |

`--allow-high` 可以把 high 级问题判为误报强行推进（会打印出来，留痕）。

### 3g. 手写稿仍然可以走这条路

不生成、只手写也可以：跳过 `outline` / `generate`，直接从 `facts` → 手写 → `critic` → `derive` → `score`。
`pipeline.mjs --from=critic` 支持这种用法。

**但状态机仍然要 `outline.json`**（`publish --stage=outlined` 会检查它存在且每节有 claim）。
手写稿不用手编大纲，直接回推：

```sh
npm run publish -- --slug=<slug> --stage=outlined --from-article
# 从 article.md 的 h2 + 各节首段生成 outline.json / outline.md（字段口径与 outline.mjs 一致）
```

回推出来的大纲是「这篇实际怎么写成的」，比事后编一份对不上正文的大纲更诚实；
`finalize` 后续会带着 `--allow-missing-research` 跳过 briefing/research-deep 的检查。
**`xhs-article.md` 是 `--stage=rendered` 的硬前置**：没有它切图阶段直接失败，
手写稿也要写一份（≥1 张架构图 + ≥1 张结果图 + ≥1 个表格，14 屏以内）。

写作要点见 `publish/writing-spec.md`（写稿提示词里会注入），其中几条是用户反馈过的硬约束：

- 加粗**不要以标点开头**（`**「xx」**` 在 CommonMark 下不成立，会印出星号）
- 中文引号统一用 `「」`，不要 ASCII `"`
- **每个数字后跟一句归因**

补齐 `article.yaml` 的 `digest`（80–128 字）和 `cover`（`big` / `num` / `unit` / `vs` / `hook` / `cards`）。
`cover.num` 必须能在正文里找到依据，否则自检 C2 不过。

```sh
npm run publish -- --slug=<slug> --stage=drafted --digest="..."
```

## 4. 自检 + 人审（`reviewed`）

```sh
npm run publish -- --slug=<slug> --stage=reviewed
```

跑 `publish-check.mjs`（A/B/C/D 四组），**有 ❌ 不许推进**——用户说「先发吧」也要先把 ❌ 列给他确认。
过了之后生成 `articles/<slug>/review.md`。

机器查不了的几项要人工过：A8（加速比逐个对原文）、B5（质疑是否带限定语）、C4/C5（长图抽看）。

---

## 5. 排版（`rendered`）

```sh
npm run publish -- --slug=<slug> --stage=rendered
```

这一步会跑 `render-article.mjs` 产出小红书切图，**并顺手刷新 `articles/<slug>/交付清单.md`**。

> ⚠️ `render-article.mjs` 看到 `--cards` 就会切成老的卡片模式（1080×1440），把手机长图顶掉。
> `publish.mjs` 已经处理成「有 `xhs-article.md` 就不传 `--cards`」；**手工重跑时别自己加**。
> 自检 C1b 会检查切图是不是 780×1040，不是就报错。

接着生成另外两个平台的 HTML：

```sh
node scripts/render-html.mjs --in=articles/<slug>/article.md --out=dist/html/<slug>.html --title="..."
node scripts/render-zhihu.mjs --slug=<slug>          # → dist/zhihu/<slug>.html
```

验收：

| 产物 | 判据 |
| --- | --- |
| `dist/xhs/` | `00-cover` + `01…NN`，**每张 780×1040** |
| `dist/html/<slug>.html` | 单文件，图片内联 |
| `dist/zhihu/<slug>.html` | **500 KB 以内**（超了先压图，见下） |

> 知乎 HTML 超过 500 KB 会让 Draft.js 粘贴卡死（实测 1 MB 时直接把标签页拖到 DevTools 会话失效）。
> `render-zhihu.mjs` 默认压到 800px/0.82，约 420 KB。可用 `ZHIHU_IMG_WIDTH` 覆盖。

---

## 6. 发布

**红线**：发布/群发按钮不可逆，只有用户当轮消息里明确说「发」才能点。

```sh
npm run publish:platform -- --slug=<slug>                  # 手动：列出 dist/ 全部产物
npm run publish:platform -- --slug=<slug> --to=wechat      # 公众号：建草稿 + 读回验证
```

### 6.1 公众号（内置驱动，全自动到草稿）

渲染 → 传图 → 生成并上传二维码 → 压封面（<64 KB）→ `draft/update`（无旧稿才 `draft/add`）
→ **`draft/get` 读回比对**。会把 `wechat_draft_id` 写回 `article.yaml`。**不调群发接口。**

改稿一律**原地 update**：草稿箱里始终只有一份，不用在两份同名文章里猜哪份最新
（`--new` 可强制新建）。

公众号正文**没有可点外链**（`<a>` 会被整段剥掉，实测 `anchors=0`），
所以元信息块每条链接挂一枚二维码，「阅读原文」指向 `SITE_ORIGIN`（没配则退回 arXiv）。
详见 [wechat-publish.md](wechat-publish.md)。

> ⚠️ **改了稿子就要整套重跑**，不能只重跑 `render:wechat`。
> 草稿是建草稿那一刻的快照，之后重新渲染多少遍都不影响草稿箱里那份。
> 2026-11-11 就出现过「yaml 记着 media_id、草稿箱里却是旧版本」——
> 现在驱动最后会读回比对，不一致直接退出码 1 并提示「这份是坏的，不要发布」。

### 6.2 知乎 / 小红书（自己接驱动）

本仓库**不内置**这两个平台的自动化：它们只有网页编辑器，自动化必然绑定具体的浏览器工具，
写进主流程别人就跑不了。渲染产物已经就绪：

| 平台 | 产物 | 人工流程 |
| --- | --- | --- |
| 知乎 | `dist/zhihu/<slug>.html`（公式已是居中行间公式） | [zhihu-workflow.md](../../docs/zhihu-workflow.md) |
| 小红书 | `dist/xhs/<slug>-00..NN.png` + `articles/<slug>/xhs.md` | [xiaohongshu-workflow.md](../../docs/xiaohongshu-workflow.md) |

要全自动，按 [drivers.md](../../docs/drivers.md) 在项目根建 `drivers/<id>.mjs`。

**验收必须在刷新之后。** 在编辑器当前 DOM 里核对等于没验证——知乎编辑器是内存态，
关掉页面内容就没了，必须显式存草稿。

### 6.3 交给用户

发布前把「标题 + 首段 + 图片数 + 平台」列出来让他确认一次。
三平台里**只有「点发布/群发」必须用户来**。

---

## 7. 收尾

```sh
npm run publish -- --slug=<slug> --stage=published --confirm --zhihu=<url> --xiaohongshu=<url>
node scripts/deliverable-report.mjs --slug=<slug>
```

`published` 会写 `urls` 和 `platforms.*.status`。`deliverable-report` 刷新交接单。

---

## 时间与成本参考（DSpine 实测）

| 阶段 | 耗时 | 备注 |
| --- | --- | --- |
| 建档 + 取素材 | 10–20 分钟 | 取决于论文图多少 |
| 写稿 | 最长的一段 | 5,000–9,000 字，且要逐条核对数字 |
| 自检 + 修 | 20–40 分钟 | 第一遍几乎总有 ❌ |
| 排版 | 5 分钟 | |
| 发布三平台 | 15–30 分钟 | 小红书正文写入最费时 |

### 2026-11-12 并发改造后的实测（同一篇 EAGLE-2，8 节）

| 环节 | 改造前 | 改造后 | 怎么做到的 |
| --- | --- | --- | --- |
| 正文 8 节 | 158s | **27s** | `generate.mjs` 分节并发（每节上下文只由大纲决定） |
| critic 20 段 | ~150s（串行 6–15s/段） | **7s** | `critic.mjs` 逐段并发 |
| 外部调研 | 28s | **11s** | `research-paper.mjs` 网络请求并发预热；Reddit/HF 超时只算一次 |
| 派生 xhs + xhs-article | 两次相加 | 取较慢一次 | `derive-variants.mjs` 两个变体并发 |
| 论文原图 | 每张 ~2s 串行 | 1/4 墙钟 | `fetch-figures.mjs` 每张一个 page 并发 |
| 公众号图片上传 | 每张 1–2s 串行 | 4 并发 | `render-wechat.mjs` 图片与公式图并发上传 |

两个前提条件，换环境要重新确认：

1. **`.env` 的 `LLM_MAX_CONCURRENCY` 要调高**（现为 8）。默认 2 会把并发全压掉，
   改代码也没用——这个键在 `.env` 里出现过两次时，**后者生效**，改的时候一起检查。
2. **并发数不是越高越好**。实测 8 → 12 → 16 → 24 都能成功，但 16 以上单请求延迟从
   10s 涨到 15–17s，墙钟不再下降。换网关或换时段先跑 `npm run bench:llm -- --n=16 --jobs=8`。

## 停下来等用户的地方：只有一处

**点发布/群发之前。** 那是不可逆动作，必须用户当轮消息里有「发」字。

其余环节全部自动：机器检查有 ❌ 就修到过，critic 的 high 只告警，
大纲和自检报告都**不用等**审阅（用户 2026-11-13 明确要求去掉人工审核环节，
只在发布时简单看看）。

发布前的「看一眼」用一屏解决：

```sh
npm run preview -- --slug=<slug>
```

输出标题、arXiv、字数、结构、TL;DR 首段、图表链接数、自检结论、未处理的 high、
切图张数、三平台产物是否就绪。看完这一屏就可以决定发不发。
