/**
 * 从已完成的正文回推大纲。
 *
 * 用在哪：手写稿（先写 article.md，再补状态机）的 `publish --stage=outlined --from-article`。
 *
 * 为什么不是「让模型重新写一份大纲」：
 * 那样得到的是「本该怎么写」，和正文实际的结构对不上，后面 generate 若拿它去拼
 * 会把两套结构混在一起。回推出来的大纲是「这篇实际怎么写成的」——每节的 claim
 * 就是该节的第一句论断，字段口径与 outline.mjs 完全一致（thesis / sections[].heading / .claim）。
 */

/** 大纲里不该出现的节：问答是附录，不是论证的一部分。 */
const SKIP = /^附[：:]\s*问答$/;

/**
 * @param {string} md      article.md 全文
 * @param {string} [title] 标题，用来兜底 thesis
 * @returns {{thesis: string, sections: {heading: string, claim: string}[]}}
 */
export function outlineFromArticle(md, title = '') {
  const body = md.replace(/^---\n[\s\S]*?\n---\n/, '');
  const parts = body.split(/^##\s+(.+)$/m);
  const sections = [];
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i].trim();
    if (SKIP.test(heading)) continue;
    sections.push({ heading, claim: firstClaim(parts[i + 1] ?? '') });
  }

  // thesis 取 TL;DR 的第一句结论；没有 TL;DR 就用第一个非 TL;DR 小节的 claim。
  const tldr = sections.find((s) => /TL;DR/i.test(s.heading))?.claim ?? '';
  const thesis = (tldr || sections[0]?.claim || title).slice(0, 120);
  return { thesis, sections };
}

/** 一节的首个论断：跳过小标题、表格、图片、公式块、列表。 */
function firstClaim(text) {
  for (const raw of text.split(/\n\s*\n/)) {
    const p = raw.trim();
    if (!p) continue;
    if (/^(#{3,6}\s|\||!\[|\$\$|[-*]\s|>)/.test(p)) continue;
    const flat = p
      .replace(/\*\*|`|_/g, '')
      .replace(/\$([^$]+)\$/g, '$1')              // 行内公式只留内容，大纲是给人读的
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接只留文字
      .replace(/\s+/g, ' ')
      .trim();
    if (!flat) continue;
    // 截到第一个句末标点，claim 是一句话不是一段
    const m = flat.match(/^[\s\S]*?[。！？]/);
    return (m ? m[0] : flat.slice(0, 120)).slice(0, 160);
  }
  return '';
}
