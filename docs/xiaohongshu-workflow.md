# 小红书发布：步骤与坑

> 本文件是**人工发布**的操作指南，也是自己实现驱动的规格说明。
> 本仓库不内置小红书自动化（见 [drivers.md](drivers.md)）。

> 2026-11-10 DSpine 实战后重写。**核心结论：正文写入是整个流程唯一的硬骨头**，
> 图片和标题都很顺。先读「正文怎么写进去」再动手。

## 前置

- 登录态在 `creator.xiaohongshu.com`，**过期非常频繁**（一天内就能掉），先打开发布页看一眼是不是被重定向到 `/login`。
- 被重定向 = 需要用户扫码，**停下来告诉用户，不要自己尝试登录**。

## 发布之后：取笔记链接写回状态机

用户点完「发布」后，`article.yaml` 里要补 `urls.xiaohongshu`，否则 `publish:check` 的
**D4** 会报「标为 published 但没有 url」。

**不要试图从发布页或卡片链接里找**（卡片 `<a>` 的 href 是空的，Vue 里也没挂 noteId）。
已验证的取法是读卡片上的埋点属性：

```js
// 在 https://creator.xiaohongshu.com/new/note-manager?source= 页面执行
[...document.querySelectorAll('.note-card')].map(c => {
  const t = (c.querySelector('.note-card__title') || {}).innerText || '';
  const j = JSON.parse(c.getAttribute('data-impression') || '{}');
  return { title: t.trim(), noteId: j.noteTarget?.value?.noteId };
});
```

拿到 `noteId` 后拼 `https://www.xiaohongshu.com/explore/<noteId>`。
（直接 curl 这个地址会 302，属正常——游客态会跳登录，链接本身是对的。）

写回用 `--platform=<名>=published`，**不要用 `--stage=published`**：
后者会把 `platforms` 里**所有**平台都改成 published，而当时通常只发了小红书。

```sh
npm run publish -- --slug=<slug> --platform=xiaohongshu=published
# 然后手工补 article.yaml 的 urls.xiaohongshu，或按上面 take 到的 id 写入
```

## 步骤

1. 打开 `https://creator.xiaohongshu.com/publish/publish`
2. 进「上传图文」：页面上有两个同名按钮，**第一个（`@e27`）点不动**（`element not visible`），
   要点**第二个 `@e28`**。判断方法：点完页面出现「上传图片，或写文字生成图片」。
3. 上传图片：**一次全传**，`--file` 可以重复
   ```sh
   上传这些文件：dist/xhs/<slug>-00-cover.png --file ...-01.png ... --file ...-09.png
   ```
   - 封面在首张、顺序必须 `00 → 01 → …`；
   - 3:4 手机比例（780×1040），小红书要求 3:4 至 2:1 之间；
   - 传完核对：`document.body.innerText.match(/(\d+)\/18/)` 应为 `10/18`。
   - **不要逐个传**：每传一次文件输入框的 ref 就失效，后续 `upload` 会被静默忽略，
     现象是「传了 10 次，计数还是 1/18」。
4. 标题：填入 `...`（≤ 20 字），这个很顺。
5. 正文 —— 见下一节。
6. **发布前必须让用户确认**。小红书「发布」同样是直接公开。

## 正文怎么写进去（踩了很多坑，照这个做）

> **先看这条**：正文 + 话题已经固化成脚本，不要每次手拼 JS：
>
> ```sh
> node .claude/skills/paper-publish/scripts/xhs-fill.mjs <session> --slug=<slug> --save
> # 等价：npm run xhs:fill -- <session> --slug=<slug> --save
> ```
>
> 它做三件事：按空行切 `xhs.md`（去掉文件名行和末尾纯文本话题）→ 一次性写入正文 +
> 用联想面板把 `xhs_tags` 逐个点成真话题实体 → 可选点「暂存离开」存草稿并把
> `platforms.xiaohongshu.status` 写成 `draft`。加 `--dry` 只打印将要执行的 JS。
> **前提**：图片已上传、标题已填（脚本不碰这两样）。下面保留原理与踩坑记录，改脚本前先读。

**编辑器是 tiptap / ProseMirror**，不是 textarea。已知的失败路径：

| 尝试 | 结果 |
| --- | --- |
| 直接给编辑器设值 | `cdp_failed: fill target changed or lost focus while positioning the caret`——填充时编辑器重绘，焦点丢了 |
| 点击编辑器 + Cmd+V 粘贴 | 不生效。CDP 按键不触发系统剪贴板，`pbcopy` 的内容到不了页面 |
| `document.execCommand('insertText')` 逐段写入 | **内容确实写进去了**，但扩展把这次注入记成「真人编辑」，按设计把控制权交还给人并进入 `editing` 挂起，之后所有动作被拒 |

真正可行的组合（2026-11-10 验证）：

1. **先做完全部不涉及编辑器的动作**：传图、填标题、关掉引导浮层。
   ```js
   // 这个浮层会挡住编辑区、抢焦点，必须先隐藏
   const g = document.querySelector('.feature-guide');
   if (g) (g.closest('.d-popover') || g).style.display = 'none';
   ```
2. **最后一次 `evaluate` 里一次性写完正文 + 话题**（写标题也可以并进来）。
   **这是一条硬规则，不是建议**：`execCommand` 一落进 ProseMirror，扩展就把这次输入
   记成真人编辑、交还控制权，此后任何自动化动作都被拒。所以**一个会话只有一次写入机会**。
   边写边核对 = 每核对一次就要重启会话 + 重进草稿箱 + 重新点编辑，一轮 30–60 秒。
   2026-11-15 在 EAGLE-2 上因此反复了 8 轮，多花 20 多分钟，最后还是一次写成的。
   段落数组 `P` 按 `xhs.md` 的**空行切分**，每块之间要插**两个** `insertParagraph`：
   一个换段、一个留空行。小红书详情页会把相邻段落压成一片，
   只有空行才看得出分段（2026-11-14 用户截图反馈「段落间都连在一起，看不清」）。
   ```js
   const e = document.querySelector('.ProseMirror');
   e.focus();
   document.execCommand('selectAll', false, null);
   document.execCommand('delete', false, null);
   for (let i = 0; i < P.length; i++) {
     if (i > 0) {
       document.execCommand('insertParagraph', false, null);  // 换段
       document.execCommand('insertParagraph', false, null);  // 空行
     }
     document.execCommand('insertText', false, P[i]);
   }
   document.execCommand('insertParagraph', false, null);
   document.execCommand('insertParagraph', false, null);
   document.execCommand('insertText', false, '#大模型 #推理加速 #投机解码 #LLM #论文解读');
   document.activeElement.blur();   // blur 能减少挂起概率
   ```
3. **写完立刻核对**（内容是真的写进去了，别被 `permission_denied` 吓到）：
   ```js
   (() => {
     const e = document.querySelector('.ProseMirror');
     const t = [...document.querySelectorAll('input')].find(i => /标题/.test(i.placeholder || ''));
     return JSON.stringify({ title: t?.value, bodyLen: e.innerText.length, tail: e.innerText.slice(-50) });
   })()
   ```
   成功的样子：`bodyLen` ≈ 730、`tail` 是话题标签。

### 话题标签：必须选联想词，打出来的 `#xxx` 不可点

正文末尾直接 `insertText('#大模型 #推理加速')` 写出来的只是**纯文本**，详情页里不可点
（2026-11-14 用户截图反馈）。真正的话题是编辑器里的话题实体，必须走联想。

**全部话题必须在同一次 `evaluate` 里做完。** 见下一节「一次写完」——注入会立刻触发
editing hold，分次做就要每轮重启一次会话（2026-11-15 因此在 EAGLE-2 上多花 20+ 分钟）。

已验证可用的操作序列（2026-11-15，v0.5.0）：

```js
const TAGS = ['大语言模型','推理加速','投机采样','EAGLE2','论文解读','LLM'];
const e = document.querySelector('.ProseMirror');
e.focus();
// 1) 先清掉末尾所有空段和以 # 开头的纯文本段（上一步残留）
const ps = [...e.querySelectorAll('p')];
for (let i = ps.length - 1; i >= 0; i--) {
  const t = ps[i].innerText.trim();
  if (t === '' || t.startsWith('#')) {
    const r = document.createRange(); r.selectNodeContents(ps[i]);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('delete', false, null);
  } else break;
}
// 2) 归位到末尾，留一个空行
const rr = document.createRange(); rr.selectNodeContents(e); rr.collapse(false);
const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rr);
document.execCommand('insertParagraph', false, null);
document.execCommand('insertParagraph', false, null);
// 3) 逐个：打 #词 → 等联想 → 点选
for (const tag of TAGS) {
  document.execCommand('insertText', false, '#' + tag);
  await new Promise(r => setTimeout(r, 1500));
  const items = [...document.querySelectorAll('.item')]
    .filter(x => (x.innerText || '').trim().startsWith('#' + tag) && x.offsetHeight > 0);
  const exact = items.find(x => (x.innerText || '').trim().split(/\s|\|/)[0] === '#' + tag);
  const pick = exact || items[0];
  if (pick) {
    pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    pick.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    pick.click();
    await new Promise(r => setTimeout(r, 700));
  }
}
```

关键几点：

- **联想下拉的选择器是 `.item`**，不是 `.recommend-topic-wrapper .tag`。
  后者是编辑器右下角那条常驻「推荐话题」横条（`#howto入门codex` 之类，与正文无关），
  2026-11-15 把它误当联想面板探了三轮。真正的下拉在输入 `#` 后出现，条目形如
  `<div class="item is-selected">#大语言模型|9687.9万浏览</div>`，可直接搜到冷门词。
- 点选要 `mousedown` + `mouseup` + `click` 三个都派发，只 `click()` 不生效。
- 每选一个词后等 ~700ms，再打下一个 `#`，否则联想面板还停在上一个词上。
- 联想词一般都能搜到（`#投机采样` 11.8 万浏览、`#EAGLE2` 171 浏览都有），
  搜不到才换近义词，**不要用纯文本凑数**。

核对方式（刷新后仍成立）：`[...document.querySelectorAll('a.tiptap-topic')]`
→ 每个的 `data-topic` JSON 里取 `name`，数量与内容都要对上。
纯文本的 `#xxx` 只是文字节点，不会有这个 `a` 标签。

### 外链：小红书正文本身不支持可点链接

正文里的 `https://…` 永远是纯文本，点不动，这是平台限制，不是排版问题。
写法固定为两行：

```
🔗 架构图（复制到浏览器打开）
https://example.com/arch/p/eagle.html
```

不要写「点这里」或「链接在下方」。想让链接可点，只能放到**个人简介**或**群聊/私信自动回复**里，
正文没有别的出口。

### 控制权挂起（editing hold）怎么处理

注入后自动化工具可能一直报告「控制权在人工手里」，
此时**任何动作都会被拒**（`User activity revoked this action`）。已知：

- 它**不会自己超时恢复**（等 60s+ 也没用）；
- `自动化 cooperate wait` 也是 `ready:false`；
- 用户点一下页面空白处**不一定**能解除（试过，无效）；
- **`- 小红书有**本地草稿自动保存**，写进去的正文通常已经存成草稿

#### 所以：一次写完，只核对一次

2026-11-15 EAGLE-2 的实测代价（一定要记住）：

| 做法 | 代价 |
| --- | --- |
| 写一段 → 核对 → 再写 | 每次核对后都要 `stop`+`start`+导航+草稿箱+编辑，**30–60 秒/轮**，实际做了 8 轮 |
| 一次 evaluate 写完正文 + 6 个话题 → 重启后核对一次 | **1 轮**，30 秒 |

挂起是**确定会发生的**，不是偶发失败。所以把它当成「写入即消耗一次会话」，写入前把
所有要写的东西（标题、正文分段、空行、全部话题）准备好，**一次灌进去**。

配套的两个坑：

- **`cooperate sync` 返回的 observation 是一次性的**，用掉即失效。被挂起后连 sync 都会失败，
  所以「动作失败 → 重试」在编辑器里是无效的，只能重启会话。
- 重启后**不要**直接读 DOM 就以为拿到了内容：先 `navigate` 到发布页 → 点「草稿箱(n)」→
  切到「图文笔记」标签 → 点该草稿的「编辑」。草稿箱面板有渲染 bug，
  计数正常但列表显示「暂无草稿」，点一下「图文笔记」标签才正常渲染。
  写进去的正文通常已经自动存成草稿（「草稿箱(n)」会 +1），**优先去草稿箱接着做**，
  比重新传图快得多。

## 草稿是怎么被存下来的（2026-11-15 实测，改草稿前必读）

草稿不在服务器,在**浏览器本地的 IndexedDB**：`draft-database-v1` → store `image-draft`,
一条记录 = 一个草稿,字段在 `record.content.draftStore`。搞清这层之后,
「草稿丢了 / 空行没了 / 话题变文字」都能自己诊断,不用反复重建。

| 字段 | 作用 |
| --- | --- |
| `title` | 标题（≤20 字,列表里显示这个） |
| `desc` | **纯文本正文,编辑器重开时读的是它**,不是 `descInnerHTML` |
| `descInnerHTML` | 富文本镜像。**只写它没用**——重新打开草稿时会被 `desc` 覆盖 |
| `descLength` | 字数计数（平台的 1000 字上限按它判） |
| `imgList` / `cover` | 图和封面。**复制这两个字段就能把草稿搬到新记录,不用重传图** |

三条硬规则：

1. **换行编码是 `\n\t\n`,不是 `\n\n`。** `desc` 里一个 tab 顶一个空 `<p>`。
   写 `\n\n` 会被平台在加载时当成软换行吃掉,详情页就变成「段落连成一片」。
   实测：`'AAA\n\t\nBBB\n\t\nCCC'` 读回是 5 段、2 个空行,正确。
2. **话题没法通过草稿持久化。** `a.tiptap-topic` 存进 `descInnerHTML` 看起来很对,
   但重开草稿时平台按 `desc` 重建,`[话题]#` 标记会原样当成文字显示。
   草稿阶段就写纯文本 `#标签`,**话题等发布前在编辑器里手动点 `#` 联想补**,
   或者接受纯文本（用户已知悉正文外链与纯文本 tag 都不可点）。
3. **1000 字是硬上限,`desc` 含换行符一起算。** 超了平台在加载时静默截断/剥空行,
   表现就是「保存完再打开少了尾巴」。留 30 字余量,正文控制在 950 以内。

### 最容易踩：多标签页互相覆盖

小红书 publish 页签**一多,草稿就会被反复回写**。2026-11-15 一次事故里
`自动化 tab list` 有 **25 个** `creator.xiaohongshu.com/publish` 页签（历次会话遗留的孤儿窗口,
每次 `写进去的正文几分钟后就被别人的旧快照盖掉,现象是「明明验证通过了,过一会儿又变回 `#`」。

处置顺序：

1. 动手前先 `自动化 tab list` **数 publish 页签**;多于 2 个就先清理（见下条）,再写。
2. 写数据要在**同源的非 SPA 页**（`https://creator.xiaohongshu.com/ai_tool`）上做,
   不要在 publish 页里写——publish 页自身的内存状态会盖回去。
3. 真要绕开争抢：**复制一条记录到新 draftId**（带上 `imgList`/`cover`）,新 id 没有页签绑定,
   没人会覆盖它。实测新记录稳定存活。写完 `reload` 一次确认列表里有它。
4. 用户自己开着同一个草稿的页签也会覆盖,开工前提醒一句。

> 列表面板有渲染 bug：计数更新了但列表显示「暂无草稿」,再点一下「图文笔记」标签才渲染。

## 参考笔记的形态（2026-11 观察）

高赞的论文解读图文普遍是：浅色纸底、大留白、大字 + 数据卡片、每屏一个结论。
**现在不用卡片模式**——`render-article.mjs` 不加 `--cards` 时走 H5 切图（见 SKILL.md），
它会把整篇手机网页按屏截成 780×1040。`--cards` 是老路径，会产出 1080×1440，
`publish-check` 的 C1b 会拦住这种混入。

## 标题 20 字上限 + 「保存成功」也可能被回写覆盖（2026-11-12）

**标题硬限制 20 个字符**（ASCII 也算一个），超了输入框旁会显示红色的 `21 / 20`：

```
"EAGLE：草稿模型该猜特征，不是猜 token"     → 23 字，超限
"EAGLE-2：草稿树该长什么样，让上下文说了算"  → 21 字，超限
```

写正文前就要把标题压到 ≤20；**不要发出去之后再改**。原因是两次踩到的：

1. **原地改标题会被回写覆盖。** 打开草稿 → 改标题 → `暂存离开` → 列表里确实显示新标题，
   但随后 `自动化 navigate` 去别的页面时，编辑器里那份「打开草稿时的旧快照」又被保存了一次，
   列表里换成旧标题、时间戳刷新。整个序列看起来全绿，实际标题回退了。
2. **新建时标题写对就不会回退**，因为没有「旧快照」可回写。

所以修标题的正确做法是**重建**：新建笔记 → 一次传完图 → 一次写入标题+正文 → `暂存离开` →
确认列表标题正确 → 回草稿箱删掉旧的那条。删草稿要二次确认：
`删除` 按钮点开后出现 `.d-popconfirm-footer`，里面再点一次「删除」才真正删掉，
只点第一次只是弹出确认框（`草稿删除后不可找回`）。

> 另外：`暂存离开` 之前编辑器写的正文会被 XHS 自动存成草稿，所以**注入后即使控制权被挂起
> （`editing: true`）也不用重传图**——重启 session 后去草稿箱「编辑」那条草稿继续即可。

## 事故记录（2026-11-10，DSpine）

- 逐个 `自动化 upload` 9 次全部被静默忽略（计数停在 1/18）。→ **必须一次全传**。
- 一个文件被误挂到「关联文件」组件上（页面上有三个 `input[type=file]`，
  第三个是 `accept=.pdf,.doc,.docx` 的附件输入）。→ 用可见的「上传图片」按钮 ref，
  或选 `input[type=file][multiple]` 里的第一个。
- 反复重建 session 导致用户窗口里堆了 6 个 publish 标签页。
  → 每次失败后先 `自动化 tab list` 看看，**只关自己建的**（`scope: agent`），用户的是 `scope: user`。

