#!/usr/bin/env node
/**
 * 论文外部调研：给「写稿」阶段补充论文本身没有的信息。
 *
 *   node scripts/research-paper.mjs --slug=dspine [--arxiv=2609.36173]
 *   → articles/<slug>/research.md
 *
 * 输出「线索」而不是「结论」：每条都带 URL，写稿时可以直接核对。
 *
 * 为什么要这一步：论文正文只回答「作者想让你知道什么」。写深度解读还需要
 *   - 同类方法的对比坐标（这篇在谱系里什么位置）
 *   - 社区质疑 / 复现情况（结论站不站得住）
 *   - 作者的其它工作（这条线是怎么演进过来的）
 *   - 后续跟进的论文（这个思路后来被怎么发展/否定）
 *
 * ⚠️ 只用 shell 出网（curl），不走 WebSearch/WebFetch——后者在某些环境下被
 *    企业网络策略拦截（实测 arxiv.org 报 "Unable to verify if domain is safe"）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseArxivId } from './lib/arxiv.mjs';

const ROOT = process.cwd();

/**
 * 从项目 .env 读键值。逐行解析，不能 `source`——某些值里带括号/引号会让 shell 报错。
 * 已经有了就不用 `node --env-file`，保持这个脚本可以裸 `node` 直接跑。
 * 环境变量优先级高于 .env（方便临时覆盖）。
 */
function readEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
const dotenv = readEnv();
const envGet = (key) => process.env[key] ?? dotenv[key] ?? '';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.slug) {
  console.error('用法：node scripts/research-paper.mjs --slug=<slug> [--arxiv=<id>]');
  process.exit(1);
}
const slug = String(args.slug);
const dir = join(ROOT, 'articles', slug);
if (!existsSync(join(dir, 'article.yaml'))) {
  console.error(`✗ 没有 articles/${slug}/article.yaml`);
  process.exit(1);
}

const yaml = readFileSync(join(dir, 'article.yaml'), 'utf8');
// article.yaml 里存的应该是裸 ID；但历史文章可能存了 URL（--stage=new 早期版本不归一化），
// 这里统一过一遍解析器，免得老文章一跑调研就整段空白。
let arxivId = '';
try {
  arxivId = parseArxivId(args.arxiv ?? yaml.match(/^arxiv_id:\s*"?([^"\n]+)"?$/m)?.[1] ?? '').id;
} catch {
  arxivId = '';
}
const title = yaml.match(/^title:\s*"?([^"\n]+)"?$/m)?.[1] ?? '';
if (!arxivId) {
  console.error('✗ 拿不到 arXiv ID（article.yaml 的 arxiv_id 字段，或 --arxiv=<id>）');
  process.exit(1);
}

/**
 * 预热缓存：把互不依赖的网络请求**并发**发出去，结果按 url 存起来。
 *
 * 原来这几个请求是一个接一个 `execFileSync('curl')` 串行跑的：arXiv 1.3s + GitHub 1s
 * + Semantic Scholar 0.7s + HN 0.5s + Reddit 最多 8s（本机常超时）+ 项目页/HF 各 0.5s，
 * 加起来 12–25 秒，而它们之间**没有任何依赖**。并发后墙钟约等于最慢的那一个。
 *
 * 只对「URL 在写代码时就能确定」的请求做预热；依赖前一步结果（README/issues、
 * 项目页正文抓取）的仍然按原顺序走同步 curl，不走缓存。
 */
const PREFETCH = new Map();
const prefetchKey = (url, headers = []) => `${url}|${headers.join(',')}`;

async function prefetch(urls) {
  const { execFile: execFileCb } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFileCb);
  await Promise.all(urls.map(async ({ url, headers = [], timeout = 25 }) => {
    try {
      const { stdout } = await run('curl', [
        '-sL', '--max-time', String(timeout),
        '-A', 'paper-to-post/1.0 (+https://github.com/)',
        ...headers.flatMap((h) => ['-H', h]),
        url,
      ], { encoding: 'utf8', maxBuffer: 1e8 });
      if (stdout) PREFETCH.set(prefetchKey(url, headers), stdout);
      else PREFETCH.set(prefetchKey(url, headers), null);   // 空响应也算「查过了」
    } catch {
      // **失败也要记下来**，否则下面同步 curl 会把同一个超时再等一遍
      // （Reddit 8s、HF 6s，实测因此白等了 14 秒）。
      PREFETCH.set(prefetchKey(url, headers), null);
    }
  }));
}

/** curl 取文本，失败返回 null（调研是尽力而为，单点失败不该中断）。
 *  arXiv / GitHub 偶发 5xx 或超时，重试 2 次再放弃。
 *  但**限流不重试**——403 重试只会把额度烧得更久，直接返回给上层处理。 */
function curl(url, { timeout = 25, json = false, headers = [], tries = 3 } = {}) {
  const key = prefetchKey(url, headers);
  const text = PREFETCH.has(key) ? PREFETCH.get(key) : (() => {
    let lastErr = null;
    for (let i = 0; i < tries; i++) {
      try {
        const out = execFileSync('curl', [
          '-sL', '--max-time', String(timeout),
          '-A', 'paper-to-post/1.0 (+https://github.com/)',
          ...headers.flatMap((h) => ['-H', h]),
          url,
        ], { encoding: 'utf8', maxBuffer: 1e8 });
        if (!out) { lastErr = 'empty'; continue; }
        return out;
      } catch (e) {
        lastErr = e.message?.slice(0, 60);
        if (i < tries - 1) execFileSync('sleep', ['1']);
      }
    }
    if (process.env.RESEARCH_DEBUG) console.error(`  curl 失败 ${lastErr} <- ${url.slice(0, 90)}`);
    return null;
  })();
  if (!text) return null;
  if (json) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { return null; }
    // GitHub 未认证限流：60 次/小时。返回的是对象而非数组，且带 message。
    // 必须显式报出来——静默跳过会让调研结果「看起来查过了」。
    if (parsed && !Array.isArray(parsed) && /rate limit|secondary rate/i.test(parsed.message ?? '')) {
      return { __rateLimited: true, message: parsed.message };
    }
    return parsed;
  }
  return text;
}

// 从论文标题里提取检索用的关键词。
// 注意：取第一个词往往就是方法名（DSpine），单靠它搜出来的结果会混进无关项目
// （DSpine 撞上 Esoteric Software Spine 游戏引擎、Unix 历史仓）。所以：
//   1. 方法名 + 领域词一起搜；
//   2. 优先用论文的分类（cs.LG）和「speculative decoding」这类任务词补全。
const titleHead = title.split(/[：:]/)[0];
const methodWord = titleHead.split(/\s+/).find((w) => /^[A-Z][a-zA-Z0-9-]{2,}$/.test(w) && !/^(Draft|Parallel|Towards?|Fast|Efficient)$/i.test(w)) ?? '';

/**
 * 论文里**自己写明**的代码仓。这是判「官方仓」最可靠的信号，优先级高于任何搜索启发式。
 *
 * 为什么必须有这一步：按关键词搜 GitHub 会撞上大量同名项目，而「仓库名含方法名 +
 * star > 50」这个判据认得出来却辨不了真伪——EAGLE 这篇就命中了
 * `ThoughtfulDev/EagleEye`（一个社交账号追踪工具，5275 star），README 抓下来是 404，
 * 整节调研全废，而真正的 `SafeAILab/EAGLE` 明明就印在论文首页的脚注里。
 *
 * 来源优先级：PDF 全文 > LaTeX 源码。PDF 里的 `https://github.com/...` 是作者
 * 排版时写死在正文/脚注的，可信度最高。
 */
function paperDeclaredRepos() {
  const sources = [];
  const pdfPath = args.pdf ? String(args.pdf) : `/tmp/${slug}.pdf`;
  if (existsSync(pdfPath)) {
    const r = spawnSync('python3', ['-c', `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
print("\\n".join((p.extract_text() or "") for p in r.pages))
`, pdfPath], { encoding: 'utf8', maxBuffer: 1e8 });
    if (r.status === 0 && r.stdout) sources.push(r.stdout);
  }
  const treeDir = join(dir, 'source', 'latex', 'tree');
  if (existsSync(treeDir)) {
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name);
      return e.isDirectory() ? walk(p) : (e.name.endsWith('.tex') ? [readFileSync(p, 'utf8')] : []);
    });
    sources.push(...walk(treeDir));
  }
  const found = new Map();
  for (const text of sources) {
    // 去掉行尾标点和闭合括号：PDF 抽出来的文本常把 `)` 或 `,` 粘在 URL 后面
    for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
      const full = `${m[1]}/${m[2]}`.replace(/\.git$/, '');
      // 过滤「其它仓库」引用：链接末尾常见 `/issues`、`/blob`，上面那段已经把它们切掉，
      // 但 `owner/repo.git` 之类还要再清一遍。这里只保留形如 owner/repo 的。
      if (!/^[\w.-]+\/[\w.-]+$/.test(full)) continue;
      if (!found.has(full.toLowerCase())) found.set(full.toLowerCase(), full);
    }
  }
  return [...found.values()];
}
const declaredRepos = paperDeclaredRepos();

const domainWords = [];
const domainMap = [
  [/speculat|draft/i, 'speculative decoding'],
  [/attend|attention|transformer/i, 'transformer attention'],
  [/quant/i, 'quantization'],
  [/moe|expert/i, 'mixture of experts'],
  [/rlhf|reward|preference/i, 'rlhf alignment'],
  [/diffusion/i, 'diffusion model'],
  [/agent/i, 'llm agent'],
];
for (const [re, phrase] of domainMap) if (re.test(title)) domainWords.push(phrase);

const keywords = [methodWord, ...domainWords].filter(Boolean);
const searchQuery = keywords.join(' ') || titleHead;

/** 项目页常见形式：<方法名>-project.github.io。取不到就退化成 arXiv 摘要页。 */
function officialPage(id) {
  const guess = `https://${(methodWord || '').toLowerCase()}-project.github.io`;
  return methodWord ? guess : `https://arxiv.org/abs/${id}`;
}

// 并发预热：下面五处请求的 URL 此刻都已确定，先把它们同时发出去。
// （README / issues / 项目页正文依赖上一步结果，仍在原位同步抓。）
const ghHeaders = ['Accept: application/vnd.github+json'];
const ghTokenPrefetch = envGet('GITHUB_TOKEN');
if (ghTokenPrefetch) ghHeaders.push(`Authorization: Bearer ${ghTokenPrefetch}`);
await prefetch([
  { url: `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}` },
  { url: `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&per_page=5`, headers: ghHeaders },
  { url: `https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=title,year,citationCount,referenceCount,references.title,references.year,references.externalIds` },
  { url: `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(searchQuery)}&tags=story&hitsPerPage=8` },
  { url: `https://www.reddit.com/search.json?q=${encodeURIComponent(searchQuery)}&limit=8&sort=relevance`, timeout: 8 },
  { url: officialPage(arxivId), timeout: 6 },
  { url: `https://huggingface.co/${(methodWord || 'tencent').toLowerCase()}`, timeout: 6 },
]);

const sections = [];

// ---- 1. arXiv 元信息 + 版本历史（判断这篇新不新、有没有被大改） ----
sections.push('## 1. arXiv 元信息', '');
const apiXml = curl(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`);
if (apiXml) {
  const entry = apiXml.split('<entry>')[1] ?? '';
  const pick = (tag) => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/\s+/g, ' ').trim();
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
  const cats = [...entry.matchAll(/term="([^"]+)"/g)].map((m) => m[1]);
  const comment = pick('arxiv:comment');
  sections.push(
    `- 标题：${pick('title') ?? '—'}`,
    `- 提交 / 更新：${pick('published') ?? '—'} → ${pick('updated') ?? '—'}`,
    `- 分类：${cats.slice(0, 4).join(', ') || '—'}`,
    `- 作者：${authors.join('、') || '—'}`,
    comment ? `- 作者备注：${comment}` : '',
    `- 链接：https://arxiv.org/abs/${arxivId}`,
    '',
  );
} else {
  sections.push('- ⚠️ arXiv API 取不到（可能 ID 有误或网络受限）', '');
}

// ---- 2. 官方代码仓（有没有人真跑起来） ----
sections.push('## 2. 代码与实现', '');
const ghSearch = curl(
  `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}&sort=stars&per_page=5`,
  { json: true, headers: ghHeaders },
);
if (ghSearch?.items?.length) {
  sections.push('| 仓库 | Stars | 说明 |', '| --- | --- | --- |');
  for (const r of ghSearch.items) {
    const desc = (r.description ?? '').replace(/\|/g, '\\|').slice(0, 60);
    sections.push(`| [${r.full_name}](${r.html_url}) | ${r.stargazers_count} | ${desc} |`);
  }
  sections.push('');
  sections.push('> 只按关键词搜到的高星仓，**未必是这篇的官方实现**，写稿时要人工确认归属。', '');

  // 官方仓的 README 和 open issue 往往有论文没写的东西：
  // 换了训练数据、更新了权重、用户踩到的部署坑、对论文数据的质疑。
  //
  // 认「官方」的判据，按可信度从高到低：
  //   1. 论文自己写明的仓库（脚注 / 正文里的 URL）——最可靠，**不用等搜索排序**
  //   2. 搜索结果的描述 / homepage 指向 arXiv
  //   3. 兜底：仓库名含方法名 + star > 50
  // 第 3 条不能单独用：EAGLE 靠它在 `ThoughtfulDev/EagleEye`（社交账号追踪工具，
  // 5275 star）上认错过一次，README 抓下来是 404，整节调研全废。而真正的
  // `SafeAILab/EAGLE` 就在论文首页脚注里，star 不到 top5 排不上来——
  // 所以第 1 条必须**独立于搜索结果**成立。
  const declaredSet = new Set(declaredRepos.map((r) => r.toLowerCase()));
  let official = ghSearch.items.find((r) => declaredSet.has(r.full_name.toLowerCase()));
  let officialSource = 'paper';
  if (!official && declaredRepos.length) {
    // 论文写了但没进搜索结果：自己搓一条，不依赖搜索接口
    const full = declaredRepos[0];
    const [owner, repo] = full.split('/');
    official = { full_name: full, name: repo, description: '', homepage: '', html_url: `https://github.com/${full}`, stargazers_count: null, __owner: owner };
    officialSource = 'paper';
  }
  if (!official) {
    official = ghSearch.items.find((r) => {
      const hay = `${r.description ?? ''} ${r.homepage ?? ''}`;
      return hay.includes(arxivId) || /arxiv/i.test(hay);
    });
    if (official) officialSource = 'arxiv-link';
  }
  if (!official) {
    official = ghSearch.items.find((r) => {
      const hay = `${r.name} ${r.description ?? ''} ${r.homepage ?? ''} ${r.full_name}`;
      const named = methodWord && hay.toLowerCase().includes(methodWord.toLowerCase());
      return named && r.stargazers_count > 50;
    });
    if (official) officialSource = 'guessed';
  }
  if (official) {
    if (officialSource === 'paper') {
      sections.push(`> 官方仓取自**论文正文里写明的地址** \`${official.full_name}\`，`
        + `不依赖关键词搜索的结果排序（这类仓库 star 往往排不到前面，但它是唯一可信的那个）。`, '');
    } else if (officialSource === 'guessed') {
      sections.push(`> ⚠️ 这个仓是**按仓库名 + star 猜的**，论文正文里没写。`
        + `写稿前先确认它是不是官方实现——猜错的话整节调研讲的都是别人的项目。`, '');
    }
  }

  // 论文写明、但搜索没排上的其它仓库也列出来，别静默丢掉。
  for (const full of declaredRepos) {
    if (official && full.toLowerCase() === official.full_name.toLowerCase()) continue;
    if (ghSearch.items.some((r) => r.full_name.toLowerCase() === full.toLowerCase())) continue;
    sections.push(`- 论文里写明的另一处仓库：\`${full}\`（https://github.com/${full}）`);
  }
  if (official) {
    sections.push(`### ${officialSource === 'guessed' ? '疑似官方仓' : '官方仓'}：${official.full_name}`, '');
    const [owner, repo] = (official.__owner ? [official.__owner, official.name] : official.full_name.split('/'));
    // 未认证额度只有 60 次/小时，抓 README+issues+comments 很容易打满。
    // 有 GITHUB_TOKEN 就带上（额度 5000/小时），没有也能跑，只是可能撞限流。
    const ghH = ['Accept: application/vnd.github+json'];
    const ghToken = envGet('GITHUB_TOKEN');
    if (ghToken) ghH.push(`Authorization: Bearer ${ghToken}`);

    // README 与 issues **并发**取（确定官方仓之后立刻发，两者互不依赖）
    await prefetch([
      { url: `https://raw.githubusercontent.com/${owner}/${repo}/main/README.md`, timeout: 20 },
      { url: `https://raw.githubusercontent.com/${owner}/${repo}/master/README.md`, timeout: 20 },
      { url: `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=10`, headers: ghH },
    ]);

    // README：先试 main 再试 master
    for (const branch of ['main', 'master']) {
      const readme = curl(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`, { timeout: 20 });
      if (!readme) continue;
      sections.push(`<details><summary>README（${branch}，前 60 行）</summary>`, '', '```markdown', ...readme.split('\n').slice(0, 60), '```', '', '</details>', '');
      break;
    }

    // open issues：质疑、复现问题、部署坑
    const issues = curl(`https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=10`, { json: true, headers: ghH });
    if (issues?.__rateLimited) {
      sections.push('', `> ⚠️ GitHub API 限流（未认证 60 次/小时），**issue 没抓到**。`,
        '> 修法：把 GitHub token 填进项目 `.env` 的 `GITHUB_TOKEN=`（额度 5000/小时），重跑即可。',
        '> 手工看：' + `https://github.com/${owner}/${repo}/issues`, '');
    } else if (Array.isArray(issues) && issues.length) {
      sections.push('**Issues（质疑与复现问题，写稿时逐条看）**：', '');
      const discussion = issues.filter((x) => !x.pull_request);
      // 每条 issue 的评论也并发取：串行时 5–10 条 issue 就是 3–5 秒纯等待
      await prefetch(discussion.map((it) => ({
        url: `https://api.github.com/repos/${owner}/${repo}/issues/${it.number}/comments`, headers: ghH,
      })));
      for (const it of discussion) {
        sections.push(`- [#${it.number} ${it.state}] ${it.title}`, '');
        if (it.body) {
          const brief = it.body.replace(/\s+/g, ' ').slice(0, 400);
          sections.push(`  > ${brief}`, '');
        }
        // 评论要区分「作者回复」和「路人补充」——两者的可信度不同，写稿引用时要标清楚
        const comments = curl(`https://api.github.com/repos/${owner}/${repo}/issues/${it.number}/comments`, { json: true, headers: ghH });
        for (const c of (Array.isArray(comments) ? comments : []).slice(0, 3)) {
          const ce = c.body?.replace(/\s+/g, ' ').slice(0, 500);
          if (!ce) continue;
          const isAuthor = /^(owner|member|collaborator)$/i.test(c.author_association ?? '');
          const who = `${c.user?.login ?? '?'}${isAuthor ? '（项目成员）' : '（他人）'}`;
          sections.push(`  > **${who}**：${ce}`, '');
        }
      }
    }
  }
} else {
  sections.push('- 没搜到相关仓库（可能太新，或关键词取得不好）', '');
}

// ---- 3. 引用 / 被引用：这篇站在谁肩上，谁在跟进 ----
sections.push('## 3. 学术谱系', '');
const semantics = curl(`https://api.semanticscholar.org/graph/v1/paper/arXiv:${arxivId}?fields=title,year,citationCount,referenceCount,references.title,references.year,references.externalIds`, { json: true });
if (semantics) {
  sections.push(`- 被引 ${semantics.citationCount ?? 0} 次，参考文献 ${semantics.referenceCount ?? 0} 篇`);
  const refs = (semantics.references ?? []).filter((r) => r.title).slice(0, 12);
  if (refs.length) {
    sections.push('', '**它引用了（写「领域演进」时按这个排谱系）**：', '');
    for (const r of refs) {
      const id = r.externalIds?.ArXiv ? `https://arxiv.org/abs/${r.externalIds.ArXiv}` : '';
      sections.push(`- ${r.title}${r.year ? ` (${r.year})` : ''}${id ? ` — ${id}` : ''}`);
    }
  }
} else {
  sections.push('- ⚠️ Semantic Scholar 取不到（新论文常见，索引需要时间）', '');
}
sections.push('');

// ---- 4. 社区讨论：质疑和复现比论文更有信息量 ----
// 单靠方法名搜会大量误命中（DSpine 撞上 Spine 游戏引擎、dspinellis 的 Unix 仓）。
// 所以搜索结果必须再过滤一道：标题里要同时出现方法名和领域词，或至少不撞无关同名词。
sections.push('## 4. 社区讨论（人工筛）', '');
const domainTokens = domainWords.flatMap((p) => p.split(' ')).concat(['llm', 'decoding', 'draft', 'inference', 'arxiv']);
const relevant = (text) => {
  const low = text.toLowerCase();
  if (!low.includes(methodWord.toLowerCase())) return false;
  return domainTokens.some((t) => low.includes(t.toLowerCase()));
};
const queries = [
  `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(searchQuery)}&tags=story&hitsPerPage=8`,
  // Reddit 在本机网络下经常整段超时（实测 20s 无响应），单次短超时，不通就跳过
  { url: `https://www.reddit.com/search.json?q=${encodeURIComponent(searchQuery)}&limit=8&sort=relevance`, opts: { timeout: 8, tries: 1 } },
];
const seen = new Set();
for (const q of queries) {
  const d = typeof q === 'string' ? curl(q, { json: true }) : curl(q.url, { json: true, ...q.opts });
  const hits = d?.hits ?? d?.data?.children?.map((c) => c.data) ?? [];
  for (const h of hits) {
    const url = h.url ?? (h.permalink ? `https://www.reddit.com${h.permalink}` : '');
    const label = (h.title ?? h.story_title ?? '').slice(0, 80);
    if (!url || !label || seen.has(url)) continue;
    if (!relevant(`${label} ${url}`)) continue;   // 过滤无关同名词
    seen.add(url);
    const meta = [h.points ?? h.score, h.num_comments, h.created_at ?? h.created_utc].filter(Boolean);
    sections.push(`- [${label}](${url})${meta.length ? ` — ${meta.join(' / ')}` : ''}`);
  }
}
if (!seen.size) sections.push('- 没搜到相关公开讨论（新论文多半如此，属正常）', '');
sections.push('');

// 论文项目页 / HF 模型卡：作者自己放的补充材料，常含论文没有的实测数字
sections.push('## 4b. 项目页与模型卡', '');

/**
 * 用 Scrapling 抓正文（比 curl 干净：能渲染、能剥标签）。
 * 走项目内的 .venv-scrapling；没有这个环境就静默跳过，不影响主流程。
 * 注意：**只对公开免登录页面有效**。知乎等需要登录态的站点会 403，
 * 那种场景要用 research-platform.mjs（走用户已登录的浏览器）。
 */
function scrapeText(url, maxWords = 2500) {
  const py = join(ROOT, '.venv-scrapling/bin/python3');
  const script = join(ROOT, 'scripts/research-scrape.py');
  if (!existsSync(py) || !existsSync(script)) return null;
  try {
    return execFileSync(py, [script, `--url=${url}`, `--max-words=${maxWords}`],
      { encoding: 'utf8', maxBuffer: 1e8, timeout: 90000 });
  } catch {
    return null;
  }
}

for (const [label, url] of [
  ['项目页', officialPage(arxivId)],
  ['HuggingFace 模型卡', `https://huggingface.co/${(methodWord || 'tencent').toLowerCase()}`],
]) {
  const head = curl(url, { timeout: 6, tries: 1 });
  if (!head) {
    sections.push(`- ${label}：${url}（取不到——可能被墙、未发布，或需要 JS 渲染）`, '');
    continue;
  }
  const text = scrapeText(url);
  sections.push(`- ${label}：${url}`);
  if (text && text.length > 300) {
    sections.push('', `<details><summary>正文（Scrapling 抓取，前 1200 字）</summary>`, '',
      text.replace(/^#.*$/gm, '').trim().slice(0, 1200), '', '</details>', '');
  } else {
    sections.push('- （能连通但正文抓不出来，可能要 JS 渲染）', '');
  }
}
sections.push('');

// ---- 5. 作者线索 ----
sections.push('## 5. 作者其它工作', '');
sections.push('人工查作者近期 arXiv 列表，判断这条线是不是系列工作（有没有前作可以直接对比）：', '');
const authorQuery = title.split(/[：:]/)[0].split(/\s+/).slice(0, 3).join(' ');
sections.push(`- arXiv 作者检索：https://arxiv.org/a/ 或 https://arxiv.org/search/?query=${encodeURIComponent(authorQuery)}&searchtype=all`);
sections.push('');

const outPath = join(dir, 'research.md');
mkdirSync(dir, { recursive: true });
writeFileSync(outPath, [
  `# 外部调研：${title || slug}`,
  '',
  `> arXiv:${arxivId}　生成于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
  `> 由 \`node scripts/research-paper.mjs --slug=${slug}\` 自动生成。**这是线索清单，不是结论**——`,
  '> 写稿时要逐条核对，尤其是「是不是这篇的官方实现」「社区质疑是否成立」。',
  '',
  ...sections.filter((s) => s !== undefined),
  '',
  '## 怎么用',
  '',
  '- **§1 版本历史**：`published` 和 `updated` 差很久说明改过稿，重点看最新版；',
  '- **§2 代码仓**：有官方实现就去看 README 和 issue——issue 里常有论文没写的坑；',
  '- **§3 谱系**：引言分三层（领域演进 → 失效模式 → 本文切口）直接照着 references 排；',
  '- **§4 讨论**：社区质疑如果成立，写进「局限」；如果不成立，写清为什么不成立；',
  '- **§5 作者线**：同一作者的前作是可以直接对比的基线资料。',
].join('\n'), 'utf8');

console.log(JSON.stringify({
  out: `articles/${slug}/research.md`,
  arxiv: arxivId,
  keywords,
  githubRepos: ghSearch?.items?.length ?? 0,
  citations: semantics?.citationCount ?? null,
  discussions: seen.size,
}, null, 1));
