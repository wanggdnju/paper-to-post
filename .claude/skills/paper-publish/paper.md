---
description: 从 arXiv 链接到三平台草稿，一条链跑完（润色、质检、排版、建草稿），发布前停下来等你确认
argument-hint: <arXiv 链接或 ID> [slug]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Skill, WebFetch, Task
---

# /paper — 一篇论文的完整发布链

输入：`$ARGUMENTS`（第一个参数是 arXiv 链接/ID，第二个可选 slug；没给 slug 就用方法短名，全小写无连字符）。

先执行 **Skill(paper-publish)** 读取完整流程与红线，再按下面顺序跑。
**跑到「三平台草稿」为止，永远不要点发布/群发。**

## 执行顺序

1. **建档**
   ```bash
   npm run publish -- --slug=<slug> --stage=new --arxiv=<id>
   ```
   确认 `articles/<slug>/article.yaml` 里 `arxiv_id` 是裸 ID。

2. **取素材（并发）**
   ```bash
   npm run fetch:all -- --slug=<slug> --arxiv=<id>
   ```
   跑完**打开 1–2 张 `articles/<slug>/assets/fig-*.png` 看一眼**：出现深灰边、工具栏、缩略图侧栏说明裁切坏了，先修脚本，不要带着坏图往下走。

3. **论文原表** —— 需要你知道表在第几页：
   ```bash
   npm run render:table -- --slug=<slug> --pdf=/tmp/<slug>.pdf --page=<页> --caption="Table 1" --out=main
   ```
   找不到页码就先跳过，后面 `publish-check` 的 D10 会提示。

4. **简报 + 写稿 + 润色 + 问答 + 质检（一条命令）**
   ```bash
   npm run briefing -- --slug=<slug>
   npm run pipeline -- --slug=<slug> --paper=/tmp/<slug>.txt --jobs=8
   ```
   写稿是并发的，8 节约 30 秒；失败就从断点续跑 `--from=generate`。
   `pipeline` 会在润色之后跑 `qa`，在文末补一节 `## 附：问答`（一组「问 / 答」，由浅到深，
   答案里的数字必须能溯源）。问答不进小红书，知乎和公众号带着发。

5. **终检**
   ```bash
   npm run finalize -- --slug=<slug>
   ```
   `publish-check` 的 ❌ 必须修到过；critic 的 high 只告警（要严格就把 `--strict` 加上）。
   `finalize` 会推进状态机到 `rendered`、生成 H5 / 知乎 HTML、并打一屏预览。

6. **发布**（都停在草稿/输入框，不点发送）
   ```bash
   npm run publish:platform -- --slug=<slug>               # 手动：列出 dist/ 产物
   npm run publish:platform -- --slug=<slug> --to=wechat   # 公众号：建草稿 + 读回
   ```
   知乎、小红书本仓库不内置自动化：渲染产物已就绪，按 `docs/drivers.md` 自己接
   （人工流程见 `docs/zhihu-workflow.md` / `docs/xiaohongshu-workflow.md`）。

7. **自己的站点**（可选，没有就跳过）
   内容都在 `articles/<slug>/`，站点构建读它即可——本仓库不包含站点。

8. **停下来报告**
   把 `npm run preview -- --slug=<slug>` 的输出原样给用户，再补一句：
   「草稿/产物已就绪，没有发布。要不要发？」

## 硬性规则

- **不要点「发布 / 发表 / 群发」**，除非用户当轮消息里明确说「发」。
- 公众号脚本只允许建草稿（`draft/add`），永远不调群发接口。
- 平台写完后**必须读回验证**（公众号驱动内置了读回比对）；只看当前页面等于没验证。
- 密钥都在 `.env` 里，不要打印、不要回显、不要让用户粘贴到聊天。
- 中途失败先看 `articles/<slug>/pipeline-log.json` 和对应 `references/*.md`，不要猜。
