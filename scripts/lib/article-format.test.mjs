/**
 * 正文结构排版的回归测试。
 *
 * 这三条规则踩过的坑都是「看起来对、机器查不出来」，所以每条测试都写清楚
 * 失败时**读者会看到什么**，不只是断言一个字符串。
 *
 *   node --test scripts/lib/article-format.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMetaBlock, buildMetaLines, checkFigureRefs, formatArticle,
  numberCaptions, numberHeadings, repairGluedTables,
} from './article-format.mjs';

const meta = {
  arxiv_id: '2401.15077',
  title: 'EAGLE：投机采样要在特征层做自回归',
  authors: 'Yuhui Li、Fangyun Wei',
  venue: '',
};
const research = '- 标题：EAGLE: Speculative Sampling Requires Rethinking Feature Uncertainty\n';

test('元信息块：缺的时候补在 H1 之后', () => {
  const out = applyMetaBlock('# 标题\n\n## TL;DR\n\n正文', ['**论文**　X', '**作者**　Y']);
  const lines = out.split('\n');
  assert.equal(lines[0], '# 标题');
  assert.equal(lines[2], '> **论文**　X\\');
  assert.equal(lines[3], '> **作者**　Y');
  // 续行反斜杠不能少：少了 marked 的 breaks:true 会把整个块渲染成一行
  assert.ok(lines[2].endsWith('\\'));
});

test('元信息块：已有的不能覆盖', () => {
  // dflash 的块是手写的，带英文原题和机构；自动生成只能给中文标题，
  // 覆盖等于把更好的内容换成更差的。
  const md = '# 标题\n\n> **论文**　手写的英文原题\n> **作者**　A、B\n\n## TL;DR\n';
  assert.equal(applyMetaBlock(md, ['**论文**　自动生成的']), md);
});

test('元信息块：venue 是 arXiv 占位时不重复编号', () => {
  const lines = buildMetaLines({ meta: { ...meta, venue: 'arXiv 2401.15077' }, research, links: null });
  const paper = lines.find((l) => l.startsWith('**论文**'));
  // 之前会输出「（2401.15077，arXiv:2401.15077）」——同一个编号印两遍
  assert.equal((paper.match(/2401\.15077/g) ?? []).length, 1);
  assert.match(paper, /arXiv:2401\.15077/);
});

test('元信息块：/blog/ 链接不算项目页', () => {
  // eagle 的 PDF 引了 lmsys.org/blog/2023-11-21-lookahead-decoding/，
  // 那是竞品的介绍文章。按 host 后缀收进「项目页」，读者点进去会以为走错了。
  const links = { project: [
    { url: 'https://lmsys.org/blog/2023-11-21-lookahead-decoding/', host: 'lmsys.org' },
    { url: 'https://dspine-project.github.io', host: 'dspine-project.github.io' },
  ] };
  const lines = buildMetaLines({ meta, research, links });
  const linkLine = lines.find((l) => l.startsWith('**链接**'));
  assert.ok(linkLine.includes('dspine-project.github.io'));
  assert.ok(!linkLine.includes('lmsys.org'));
});

test('图表编号：图和表各自计数，旧编号被剥掉', () => {
  const md = [
    '![旧图注](assets/fig-a.png)',
    '![表 1：旧标题](assets/tab-main.png)',
    '![图 7 · 另一张](assets/fig-b.png)',
    '表 3 · 手写的切片表标题',
  ].join('\n');
  const out = numberCaptions(md);
  assert.match(out, /^!\[图 1 · 旧图注\]/m);
  assert.match(out, /^!\[表 1 · 旧标题\]/m);
  assert.match(out, /^!\[图 2 · 另一张\]/m);
  // Markdown 表格继续用同一个表计数器，不能重新从 1 开始
  assert.match(out, /^表 2 · 手写的切片表标题$/m);
});

test('图表编号：幂等', () => {
  const once = numberCaptions('![图 1 · a](assets/fig-x.png)\n![表 1 · b](assets/tab-x.png)');
  assert.equal(numberCaptions(once), once);
});

test('标题编号：h2 从 1 开始，h3 跟着父节', () => {
  const md = ['## 引言', '### 4.1 旧编号的子节', '## TL;DR', '### 摘要下的子节', '## 附：附录', '## 方法'].join('\n');
  const out = numberHeadings(md);
  assert.match(out, /^## 1\. 引言$/m);
  assert.match(out, /^### 1\.1 旧编号的子节$/m);
  // TL;DR / 附： 不参与编号，也不让子节的编号凭空出现
  assert.match(out, /^## TL;DR$/m);
  assert.match(out, /^### 摘要下的子节$/m);
  assert.match(out, /^## 附：附录$/m);
  assert.match(out, /^## 2\. 方法$/m);
});

test('标题编号：幂等', () => {
  const once = numberHeadings('## 引言\n### 子节\n## 方法\n### 子节二');
  assert.equal(numberHeadings(once), once);
});

test('粘连表格：段落和表头挤在一行时拆开', () => {
  // 这是生成的正文里最隐蔽的一类错误：`|` 行数没变、数字没变，
  // 但 marked 把整行当段落文字，页面上印出一长串 `| 0.79 | 0.74 |`。
  const line = '这说明误差被压住了。| 模型（T=0） | 0-α | 1-α |';
  const out = repairGluedTables(line);
  assert.equal(out, '这说明误差被压住了。\n\n| 模型（T=0） | 0-α | 1-α |');
});

test('粘连表格：正常表头不能被切坏', () => {
  // `（T=0）` 也以 `）` 结尾。用贪婪正则找「最后一句末」会把表头第一格切进正文，
  // 剩下的表头变成 `| 0-α | 1-α |` —— 列名整列消失，比不修更糟。
  const line = '| 模型（T=0） | 0-α | 1-α | 2-α |';
  assert.equal(repairGluedTables(line), line);
});

test('引用校验：引用不存在的编号要报出来', () => {
  const md = [
    '![图 1 · a](assets/fig-a.png)',
    '![表 1 · b](assets/tab-a.png)',
    '正文说「见表 2」和「见图 9」，但这两张都不存在。',
    '论文原文的 Figure 1 不算错——它明确指向论文。',
  ].join('\n');
  const { available, bad } = checkFigureRefs(md);
  assert.deepEqual(available, ['图 1', '表 1']);
  assert.deepEqual(bad.map((b) => b.ref), ['表 2', '图 9']);
});

test('formatArticle：四件事一起做，再跑一次不变', () => {
  const md = [
    '# 标题',
    '',
    '## TL;DR',
    '',
    '正文段。| 模型 | τ |',
    '',
    '## 方法',
    '',
    '![旧图注](assets/fig-a.png)',
  ].join('\n');
  const once = formatArticle(md, { meta, research, links: null });
  assert.match(once, /^> \*\*论文\*\*/m);
  // TL;DR 是摘要，不占节号；正文节从 1 开始
  assert.match(once, /^## TL;DR$/m);
  assert.match(once, /^## 1\. 方法$/m);
  assert.match(once, /^!\[图 1 · 旧图注\]/m);
  assert.match(once, /\n\n\| 模型 \| τ \|\n/);
  assert.equal(formatArticle(once, { meta, research, links: null }), once);
});

test('formatArticle：不传 meta 时不动元信息', () => {
  const md = '# 标题\n\n## TL;DR\n\n正文';
  const out = formatArticle(md);
  assert.ok(!out.includes('**论文**'));
  assert.match(out, /^## TL;DR$/m);
});
