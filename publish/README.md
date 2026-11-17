# 发布流水线

每篇论文解读都走同一套五阶段流程，**每个阶段结束都停住等确认**。
骨架参考 [aiworkskills/wechat-article-skills](https://github.com/aiworkskills/wechat-article-skills)
的「选题 → 写作 → 审稿 → 排版 → 配图 → 发布」分阶段设计，但内容规则换成了论文解读专用。

```
new ──► drafted ──► reviewed ──► rendered ──► published
选题    写稿+自检   审稿清单     长图+封面    逐平台发布
```

## 目录

| 路径 | 作用 |
| --- | --- |
| `publish/config.yaml` | 账号级配置：读者画像、结构骨架、配图密度、平台发布意图（draft / published） |
| `publish/writing-spec.md` | 写作规范，写稿前必读 |
| `publish/checklist.md` | 审稿清单；机器能查的打 ✅，其余人工 |
| `publish/sensitive-words.txt` | 敏感词 + AI 味句式（正则） |
| `articles/<slug>/article.yaml` | 本篇元数据与状态，驱动脚本唯一读写的地方 |
| `articles/<slug>/article.md` | 完整解读（知乎长文 / 公众号正文） |
| `articles/<slug>/xhs.md` | 小红书短文案 |
| `articles/<slug>/zhihu.md` | 知乎发布稿，公式用 `【公式N】` 占位 |
| `articles/<slug>/review.md` | 审稿报告（`reviewed` 阶段自动生成） |
| `dist/xhs/<slug>-00-cover.png` | 封面（1080×1440 @2x） |
| `dist/xhs/<slug>-NN.png` | 正文长图（自动分页） |

## 命令

```bash
npm run publish -- --status                                  # 所有文章的进度看板
npm run publish -- --slug=dflash --stage=new --arxiv=2602.06036
npm run publish -- --slug=dflash --stage=drafted --digest="80–128 字摘要"
npm run publish -- --slug=dflash --stage=reviewed            # 跑自检，失败就停
npm run publish -- --slug=dflash --stage=rendered            # 渲染封面 + 长图
npm run publish -- --slug=dflash --stage=published --confirm --zhihu=<url> --xiaohongshu=<url>
```

阶段只能顺序推进，跳步会报错；`published` 必须显式 `--confirm`。

## 各阶段做什么

### 1. `new` — 选题

- 必须给 arXiv ID，标题与作者从 arXiv API 拉，不手猜。
- 生成 `article.yaml` 骨架，状态 `new`。
- 选题本身（写哪篇）由用户决定；agent 可以从 `dist/xhs`、站点 Inbox 或分支综述里推荐候选，但要等用户点名。

### 2. `drafted` — 写稿

按 `publish/writing-spec.md` 写 `article.md` + `xhs.md`，然后：

```bash
npm run publish:check -- --slug=dflash   # 不过就先改，别推进状态
npm run publish -- --slug=dflash --stage=drafted --digest="..."
```

自检查什么（`scripts/publish-check.mjs`）：

| 项 | 规则 |
| --- | --- |
| A1 | 元数据齐全 + 正文存在 |
| A2 | 8 个必需小节都在（TL;DR / 引言 / 问题 / 方法 / 实验设置 / 主要结果 / 深入分析 / 讨论与判断） |
| A3 | 摘要 80–128 字，且不是正文首段原句 |
| A4 | 加粗够密（平均 ≤ 160 中文字一处），每节至少 2 处 |
| A5 | 表格 ≥ 3 个 |
| A6 | 行间公式全部单行（长图分页依赖它） |
| A7 | 所有公式用 KaTeX 真实渲染一次，渲染失败即 ❌ |
| A8 | 正文里的 `x.xx×` 是否都能在表格找到（表格外的列出来人工确认） |
| B1/B2 | 敏感词、AI 味句式 |
| B4 | 结论与 TL;DR 数字一致 |

### 3. `reviewed` — 审稿

再跑一遍自检，并把结果写成 `articles/<slug>/review.md`。
人工部分（数字与论文对账、限定语、长图抽看）按 `publish/checklist.md` 执行，
**由人或 agent 逐条确认后**再推进——agent 不得跳过这一步直接渲染。

### 4. `rendered` — 排版与配图

`scripts/render-article.mjs` 输出：统一 Markdown（带 front matter）、小红书短版、封面、分页长图。
封面信息来自 `article.yaml` 的 `cover` 块：

| 字段 | 说明 |
| --- | --- |
| `big` | 视觉主角，≤ 4 个字符（如 `6×`） |
| `hook` | 一句话钩子，回答「凭什么点开」 |
| `num` / `unit` | 主数字 + 单位，必须与正文一致 |
| `vs` | 对比条（如 `EAGLE-3 只有 2.23×`），制造反差 |
| `cards` | 4 条佐证，`标签~值` 用 `||` 分隔；**必须包含一条「诚实代价」** |

### 5. `published` — 发布

平台走可插拔驱动（`scripts/drivers/`，见 [docs/drivers.md](../docs/drivers.md)）：

- **公众号**：`npm run publish:platform -- --to=wechat`，只建草稿，人审后再发。
- **知乎**：粘贴 `dist/zhihu/<slug>.html`（公式已是居中行间公式），或自己实现驱动。
- **小红书**：上传 `dist/xhs/<slug>-*.png`（封面在前），正文用 `xhs.md`，或自己实现驱动。

全部发完后：

```bash
npm run publish -- --slug=dflash --stage=published --confirm \
  --zhihu="https://zhuanlan.zhihu.com/p/..." --xiaohongshu="..." 
```

会把 `publish_completed` 置 `true` 并记录链接。**发布到公网不可撤回，`--confirm` 就是这道闸。**

## 知乎发布

1. 打开知乎写文章页，填标题（标题只填一次，之后不要选中标题框再操作）。
2. 正文以**单个元素**粘贴：在正文框内 `evaluate` 注入 HTML（`innerHTML` 会被 Draft.js 吃掉，
   必须先分发 `paste` 事件的 `DataTransfer`）。
3. 公式：`render:zhihu` 已把公式写成 `data-eeimg="2"` 的居中行间公式，粘贴即可，
   不需要再逐个插公式卡。
4. 公式卡在 Draft.js 里是一个 atomic block，**插入后正文光标会跳走**，下一个占位符要重新定位。
5. 保存草稿后截图确认：公式卡数量 = `【公式N】` 数量，标题未被污染。

这套步骤目前是半自动：agent 做 1–4，第 5 步由人看一眼。
