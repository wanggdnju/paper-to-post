# 命令速查表

> 主流程见 [SKILL.md](../SKILL.md)。这里只列命令和参数，不解释原理。
> 新增 npm script 时同步这张表。

## 一条链跑完

```bash
npm run publish -- --slug=X --stage=new --arxiv=2602.06036   # 1. 建档
npm run fetch:all -- --slug=X --arxiv=2602.06036             # 2. 素材（PDF+图+调研，并发）
npm run briefing -- --slug=X                                 # 3. 写作简报
npm run pipeline -- --slug=X --paper=/tmp/X.txt --jobs=8     # 4. 写稿全链（含润色）
npm run finalize -- --slug=X                                 # 5. 状态机+渲染+预览
npm run site                                                 # 6. 个人站
```

## 状态机与看板

```bash
npm run publish -- --status                                  # 全篇看板
npm run publish -- --slug=X --stage=new --arxiv=<id>         # new
npm run publish -- --slug=X --stage=outlined                 # 大纲出齐（要求每节有 claim）
npm run publish -- --slug=X --stage=drafted --digest="80–128 字"
npm run publish -- --slug=X --stage=checked [--strict]       # critic 检查
npm run publish -- --slug=X --stage=reviewed                 # 跑 publish-check 的 25 项
npm run publish -- --slug=X --stage=rendered                 # 切图 + 交付清单 + 复检
npm run publish -- --slug=X --stage=report                   # 只刷新交付清单，不推进状态
npm run publish -- --slug=X --stage=published --confirm --zhihu=<url> --xiaohongshu=<url>
```

状态不能跳：`new → outlined → drafted → checked → reviewed → rendered → published`。

## 素材

```bash
npm run fetch:all -- --slug=X --arxiv=<id> [--jobs=4] [--skip=figures,links,research,pdf]
npm run fetch:pdf -- https://arxiv.org/pdf/<id> --out=/tmp/X.pdf   # 浏览器会话下载
npm run fetch:figures -- --arxiv=<id> --slug=X [--jobs=4]           # e-print 矢量图 → PNG
npm run extract:links -- --slug=X --pdf=/tmp/X.pdf                  # GitHub/HF/魔搭/项目页
npm run render:table -- --slug=X --pdf=/tmp/X.pdf --page=6 --caption="Table 1" --out=main
npm run render:table -- --slug=X --tex=<table.tex> --out=main       # 退路：LaTeX 转 HTML
```

## 调研

```bash
npm run research:paper -- --slug=X              # 官方仓 README/issues + 引用谱系 + HN/Reddit
npm run research:platform -- --slug=X [--query="..."] [--limit=4]   # 知乎同题（走已登录浏览器，只读）
npm run research:scrape -- --url=<URL> --out=path.md [--max-words=3000]   # Scrapling
npm run briefing -- --slug=X [--paper=/tmp/X.txt]                   # 三路调研 → briefing.md
```

## 写稿

```bash
npm run facts -- --slug=X --src=/tmp/X-src --write    # LaTeX 表 → facts.json（数字对照）
npm run glossary -- --slug=X                          # 术语中英对照
npm run outline -- --slug=X [--dry]                   # → outline.json + outline.md
npm run generate -- --slug=X [--only=s4 --force] [--best-of=2] [--jobs=8]
npm run polish -- --slug=X [--only=s4] [--dry] [--no-write] [--jobs=6]
npm run qa -- --slug=X [--n=9] [--dry] [--no-write] [--jobs=3]   # 文末问答（数字溯源）
npm run critic -- --slug=X [--max=20] [--jobs=8]      # 缺陷清单，不改稿
npm run derive -- --slug=X [--only=zhihu|zhihu,xhs] [--force]   # 三平台变体
npm run format:article -- --slug=X [--write]          # 补元信息块/编号/修粘连表格
npm run titles -- --slug=X --n=6                      # 标题候选 + 知乎同题查重
npm run pipeline -- --slug=X [--from=stage] [--to=stage] [--jobs=8] [--dry]
```

`pipeline` 的 `--from` / `--to` 取值：`facts glossary outline generate polish qa critic derive compare diagram score`。

## 质检与评分

```bash
npm run publish:check -- --slug=X          # 25 项（A/B/C/D 四组）
npm run verify:numbers -- --slug=X         # 每个小数必须能在 facts.json 找到
npm run verify:table -- --slug=X [--json]  # 论文原表逐格校验
npm run score -- --slug=X [--record] [--compare=Y]
npm run regress [--diff=a,b]               # 全局面板
npm run preview -- --slug=X                # 发布前那一屏
```

## 排版与产物

```bash
npm run render:article -- --in=articles/X/xhs-article.md --out=dist/xhs \
  --slug=X --id=<arxiv> --venue="<会议>" \
  --big="1.28×" --num="1.28×" --unit="..." --vs="..." --hook="..." --cards-data="..."
npm run render:html -- --in=articles/X/article.md --out=dist/html/X.html --arxiv=<id> --venue="<会议>"
npm run render:zhihu -- --slug=X                 # → dist/zhihu/X.html（≤500KB）
npm run render:wechat -- --slug=X --upload       # → dist/wechat/X.html（上传图床）
npm run finalize -- --slug=X                     # 上面几步 + 状态推进 + 预览
npm run serve:html -- --slug=X                   # 本地预览 H5
```

## 发布（驱动）

```bash
npm run publish:platform -- --slug=X                     # manual：列出 dist/ 全部产物
npm run publish:platform -- --slug=X --to=wechat [--dry] [--thumb=path.png]
                                                         # 公众号：只建草稿，自动读回
```

知乎 / 小红书需要自己实现驱动（`drivers/<id>.mjs`），见
[docs/drivers.md](../../../docs/drivers.md)；人工流程见
[docs/zhihu-workflow.md](../../../docs/zhihu-workflow.md) 与
[docs/xiaohongshu-workflow.md](../../../docs/xiaohongshu-workflow.md)。

## 自己的站点（可选）

本仓库不含站点构建。内容在 `articles/<slug>/`（markdown + yaml + assets），
直接用即可。

## 诊断与运维

```bash
npm run bench:llm -- --n=16 --jobs=8 [--max-tokens=1200]   # 网关并发压测
npm run html-to-md -- --in=dist/html/X.html                # 应急：从渲染页反推 markdown
npm run test:tools                                         # scripts/lib 单测
npm run publish:prompt -- --slug=X --paper=/tmp/X.md       # 拼提示词（不调模型）
```
