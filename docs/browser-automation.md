# 浏览器自动化：踩过的坑

> 这份文件写给**自己实现发布驱动**的人（`drivers/zhihu.mjs` 之类）。
> 本仓库不内置浏览器自动化，但这些行为在任何工具上都一样，值得先看一遍。
>
> 平台/渲染层面的教训见
> [.claude/skills/paper-publish/references/publish-failure-modes.md](../.claude/skills/paper-publish/references/publish-failure-modes.md)。

## 一、静默失败类

> 脚本继续往下跑，日志全绿，产物是坏的。**最危险的一类。**

### 1.1 键盘事件被丢弃

| 项 | 内容 |
| --- | --- |
| 症状 | 打字、Backspace 全部无效，但 `document.hasFocus()` 返回 `true` |
| 根因 | 标签页在后台，`document.visibilityState === 'hidden'`，浏览器丢弃所有键盘事件 |
| 铁律 | 会话必须 `session start --focus`；动手前先读 `visibilityState` |
| 自查 | `evaluate 'document.visibilityState'` 必须是 `visible` |

```sh
session start --focus --json     # 不是 --json
```

### 1.2 `--selector` 会把选区塌缩掉

| 项 | 内容 |
| --- | --- |
| 症状 | `getSelection().length` 是一万多字符，Backspace 只删掉一个字符 |
| 根因 | `press/send --selector X` 在按键**前**重新 focus 一次，Draft 趁机把选区折叠到光标点 |
| 铁律 | 设选区在 `evaluate` 里做，按键**不带** `--selector` |
| 自查 | 删除前后读一次 `innerText.length`，必须真的变小到 0 |

```js
// 正确
await run(s, `(() => { const r = document.createRange(); r.selectNodeContents(ed); getSelection().addRange(r); })()`);
await combo(s, 'Backspace');          // 不带 selector
```

### 1.3 组合键无效且不报错

| 项 | 内容 |
| --- | --- |
| 症状 | `press 'Meta+a'` 返回 ok，实际什么都没按 |
| 根因 | 的修饰键是 `--modifiers Meta`，写进 key 字符串里是空操作；知乎编辑器本身也不吃 Cmd+A |
| 铁律 | 全选一律用 DOM range；确实要组合键时用 `--modifiers` |
| 自查 | 按完读一次选中长度 |

### 1.4 长轮询撞页面操作超时

| 项 | 内容 |
| --- | --- |
| 症状 | `the browser operation did not finish cancellation in time`；此时动作**已经生效** |
| 根因 | 在 `evaluate` 里 `await sleep(25s)` 等上传 |
| 铁律 | 等待放在 Node 侧轮询，每次 evaluate 只问一句状态 |
| 自查 | 报错后**先观察页面**，不要盲目重试（会贴两张图） |

### 1.5 大 base64 撞 ARG_MAX

| 项 | 内容 |
| --- | --- |
| 症状 | `E2BIG`（参数太长） |
| 根因 | 把原图（2–5 MB PNG）base64 后塞进命令行参数 |
| 铁律 | 用渲染产物里已经压好的 JPEG（30–150 KB / 张） |

---

## 二、位置 / 顺序类

### 2.1 用编辑器根节点当光标锚点

| 项 | 内容 |
| --- | --- |
| 症状 | 所有后续粘贴都插到文档最前面 |
| 根因 | `selectNodeContents(editor).collapse(false)` 被 Draft 归一化到**第一个块的 offset 0** |
| 铁律 | 锚点必须是具体的 `[data-block]`，且优先用标记定位（见铁律 3） |
| 自查 | 粘完读首块文本，必须等于正文第一段 |

### 2.2 异步挂载的 DOM 当场查不到

| 项 | 内容 |
| --- | --- |
| 症状 | 图刚粘完就找 `figcaption`，8 张里 6 张报 `no-figcaption` |
| 根因 | 图片块（`figure`/`figcaption`）异步挂载，粘贴返回时还没渲染 |
| 铁律 | 依赖后插入元素的操作，**全部做完再统一补一遍** |
| 自查 | 补完统计"还剩几张 `is-placeholder`" |

### 2.3 用"最后一张"代替"刚才那张"

| 项 | 内容 |
| --- | --- |
| 症状 | 8 张图全去填文末那张的注释，前面的图全留占位 |
| 根因 | 图是按标记**就地**插入的，DOM 顺序里"最后一张"不是"刚插的这张" |
| 铁律 | 用下标对应（`figs[i]` ↔ `imgs[i]`）或光标归属定位 |

---


---

## 六、环境 / 会话类

| 现象 | 原因 | 做法 |
| --- | --- | --- |
| 内容改完刷新就没了 | 同一草稿开了**多个编辑标签页**，旧标签页自动保存把新内容覆盖 | 开工前列出标签页；有别的标签页就请用户关掉/刷新 |
| 每建一个 session 多一排标签 | session 不自动清理 | 收工前关闭会话 |
| 写入编辑器后所有动作被拒 | `editing: true` 挂起，且不自动释放 | 关闭会话后重开；先确认站点会自动存草稿 |
| `session stopped after its idle timeout` | 会话**默认闲置 5 分钟**就被回收，标签页一起关掉 | 长任务别中途停下等人；重开会话再跑 |
| `page interaction coverage is unavailable … (about:)` | 新会话的标签页停在 `about:blank` | **先导航到目标页**再做任何同步 |
| `Previous operation is still settling` | 上一个操作（大 HTML 粘贴、图片上传）还没结束 | 等；连续失败就重载标签页 |
| `E2BIG` / 超时 / 各种瞬时错 | 见 §1.4、§1.5 | 重试封装 + Node 侧轮询 |

### 验收的两个「假坏图」陷阱

```js
// ✗ 刷新后立刻读：一定是 0，图还没下载
img.naturalWidth > 0

// ✓ 要等；而且知乎图片是懒加载，不滚进可视区就永远不下载
img.complete && img.naturalWidth > 0   // 先逐张 scrollIntoView，再轮询
```

实测：8 张图滚完要 2 轮 + 约 10 秒才全部 `complete`。
一次性快滚会让前几张还没开始下载就被滚过去，所以脚本里滚两轮。

---

## 七、每次发稿的固定顺序

```sh
# 0) 前置
（启动会话时必须让标签页在前台/聚焦）
（列出标签页）确认同一草稿没有别的编辑标签页
`document.visibilityState` 必须是 visible

# 1) 渲染
npm run render:zhihu -- --slug=<slug>       # 缺 TeX / 缺 ## 正文 会直接报错退出
npm run publish:check -- --slug=<slug>      # 含 D5/D6 平台产物自检

# 2) 灌入（脚本内部已带重试与就地替换）
（你的驱动脚本） --slug=<slug> [--reset]

# 3) 落盘验收（不可跳过）
node .claude/skills/paper-publish/scripts/zhihu-verify.mjs $S --slug=<slug>
```

`zhihu-verify.mjs` 做的事：强制 `navigate` 刷新 → 重新读状态 →
和 `dist/zhihu/<slug>.html` 的期望值逐项比对 → 任一不符退出码 1。

---

## 七之二、平台「不给」的能力：先探测，再换形态（2026-11-15）

用户反馈「公众号里这些链接都没有超链接，你加一下」时，第一反应不该是改 HTML，
而是**先确认平台到底收不收**。

### 探测方法（一次就够，别反复试）

```js
// 最小探测：提交 → 读回 → 看留下了什么
await addDraft(token, { title:'PROBE', author:'P', digest:'p', thumbMediaId,
  content:'<p><a href="https://arxiv.org/abs/2401.15077">arXiv</a></p>' });
const back = (await getDraft(token, id)).content;   // → '<p>arXiv</p>'
```

结果：**`anchors=0`，连 `<a>` 标签本身都不剩**。`data-linktype` / `data-miniprogram-appid`
同样无效；指向 `mp.weixin.qq.com` 的内链直接 `45166 invalid content`。
结论：公众号正文**没有任何可点外链**，这是平台规则，不是排版没调好。

### 换形态（已实现）

| 平台 | 不可用 | 替代 |
| --- | --- | --- |
| 公众号 | 正文外链 | ① 元信息块每条链接一枚二维码（68px，长按识别）；链接很多时用 `WECHAT_QR_PATTERN` 只给一部分出码 ② `content_source_url`「阅读原文」指向个人站本篇页 ③ 纯文本 URL 保留便于复制 |
| 小红书 | 正文外链、纯文本话题不可点 | 编号小节 + emoji 分行；话题必须在编辑器里走 `#` 联想面板 |

**回复用户时第一句就要说清「这是平台限制」**，否则他会以为是我们没做。
这次的反馈是「这些都没有超链接」，如果只回「改好了」，用户点一下发现还是不能点，信任就没了。

### 机器守卫

`publish-check` 的 **D6** 反过来查「正文不许有 `<a>`」——留着 `<a>` 说明还有没处理干净的模板分支。
**D6b** 查二维码数量，**D6c** 查问答编号（`问题N/回答N`，不是 `问：/答：`）与文末标签数。

---
