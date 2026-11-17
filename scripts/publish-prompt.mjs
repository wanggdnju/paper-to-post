#!/usr/bin/env node
/**
 * 写稿提示词：把 publish/config.yaml + writing-spec + 论文全文拼成一份可直接喂给模型的 prompt。
 *
 *   npm run publish:prompt -- --slug=dflash --paper=paper.md [--platform=wechat] > prompt.txt
 *
 * 不调用任何 LLM——由 agent 或人拿去用，避免把论文全文发到未授权的端点。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArticle } from './lib/frontmatter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=')];
}));
if (!args.slug || !args.paper) {
  console.error('用法：node scripts/publish-prompt.mjs --slug=<slug> --paper=<论文全文.md>');
  process.exit(1);
}
const config = parseArticle(readFileSync(join(ROOT, 'publish/config.yaml'), 'utf8')).data;
const spec = readFileSync(join(ROOT, 'publish/writing-spec.md'), 'utf8');
const metaPath = join(ROOT, 'articles', args.slug, 'article.yaml');
const meta = existsSync(metaPath) ? parseArticle(readFileSync(metaPath, 'utf8')).data : {};
const paper = readFileSync(args.paper, 'utf8');
// 外部调研（research-paper.mjs 产出）：官方仓 README、issue 里的质疑、学术谱系。
// 有就带上——论文没写的部署要求、社区质疑，往往是解读里最有价值的部分。
// 写作简报（briefing.mjs 产出）：从三路调研里提炼出的「冲突点 / 差异点 / 数字陷阱」。
// 优先用它——原始调研加起来 2.8 万字，信噪比太低；简报约 4 千字，是写稿真正该读的。
const briefPath = join(ROOT, 'articles', args.slug, 'briefing.md');
const briefing = existsSync(briefPath) ? readFileSync(briefPath, 'utf8') : '';
const researchPath = join(ROOT, 'articles', args.slug, 'research.md');
const deepPath = join(ROOT, 'articles', args.slug, 'research-deep.md');
const research = existsSync(researchPath) ? readFileSync(researchPath, 'utf8') : '';
const deep = existsSync(deepPath) ? readFileSync(deepPath, 'utf8') : '';
// 缺材料要写进提示词本身：模型不知道「本来该有但没生成」，
// 只有把缺口摆到它面前，它才会在写的时候留余地（比如不敢断言对比公平）。
const missing = [];
if (!briefing) missing.push('briefing.md（三路调研简报）');
if (!deep) missing.push('research-deep.md（子智能体深度调研）');
if (!research) missing.push('research.md（官方仓/issue 调研）');
const missingNote = missing.length
  ? `\n\n# ⚠️ 调研材料不全\n本次缺少：${missing.join('、')}。\n写到「对比是否公平」「有没有第三方复现」「部署门槛」这类判断时，**只写论文原文明说的**，\n不要凭印象补全；拿不准的地方直接写「论文未说明」。\n`
  : '';

const required = (config.required_sections ?? []).join(' → ');
console.log(`# 角色
你是大模型算法方向的技术作者，为「${config.account_name}」写论文解读。
读者：${config.target_reader}。
调性：${config.tone}。

# 本篇
论文：${meta.title ?? ''}（arXiv:${meta.arxiv_id ?? ''}，${meta.venue ?? ''}）
作者：${meta.authors ?? ''}

# 结构（顺序固定，一个不能少）
${required}

# 写作规范
${spec}

# 硬性要求（会被脚本自动检查）
1. 行间公式必须写在一行内：$$ ... $$。
2. 行内公式只用 $x$，宏限定在 spec 列出的集合里。
3. 正文出现的每个 x.xx× 都必须能在文中的表格里找到。
4. 摘要另写一段，80–128 字，不能与正文首段重复。
5. 不要输出任何 HTML 标签。${briefing ? `

# 写作简报（先读这个，决定写什么、哪里要小心）
${briefing}` : ''}${deep ? `

# 深度调研（回查细节用）
${deep}

> 使用纪律：
> 1. 「论文说的」可以直接作论据；「官方仓库/issue 说的」要写明出处；
> 2. 「第三方复现的数字」**不能当论文数据引用**，只能当旁证，且必须标明来源；
> 3. 与论文不一致的地方（训练数据、预算、block size、硬件要求）**写进「局限」或「实验设置」**，
>    这正是深度解读比论文摘要多出来的价值。` : research ? `

# 外部调研
${research}` : ''}

# 论文全文
${paper}${missingNote}
`);
