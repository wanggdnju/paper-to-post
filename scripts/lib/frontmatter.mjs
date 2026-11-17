/**
 * publish/config.yaml 与 articles/<slug>/article.yaml 的读写。
 *
 * 只支持我们配置文件里用到的 YAML 子集，不引第三方依赖：
 *   - 顶层标量：`key: value`（可带行尾注释），值可为 ""、true/false、数字、文本
 *   - 顶层列表：`key:` 后接 `- item`
 *   - 对象：`key:` 后接 2 格缩进的子键；子键也可以是对象（如 platforms.zhihu.mode）
 *   - 单行对象：`key: { a: 1, b: 2 }`
 * 写回时保留行尾注释；顶层键的值整体重写，未识别的行原样保留。
 * 遇到简单 YAML 解析不了的结构（多行字符串、锚点、注释块中的键），改配置而不是扩展解析器。
 */

export function parseArticle(text) {
  const data = {};
  const lines = text.split('\n');
  let current = null; // 当前顶层键
  let itemKey = null; // 最近一个值为空的子键（列表项/子对象的宿主）
  const stack = []; // 子对象栈：2 格一层

  for (const line of lines) {
    if (!line || line.trimStart().startsWith('#')) continue;
    // 顶层键：不含缩进
    const top = line.match(/^([a-z_]+):\s*(.*)$/);
    if (top) {
      current = top[1];
      itemKey = null;
      stack.length = 0;
      const raw = stripComment(top[2]).trim();
      data[current] = raw === '[]' ? [] : raw === '' ? undefined : parseScalar(raw);
      if (raw === '') itemKey = current;
      continue;
    }
    if (current === null) continue;
    // 列表项
    const item = line.match(/^(\s+)-\s+(.*)$/);
    if (item) {
      const owner = itemKey === current ? (data[current] ??= []) : stack.at(-1);
      if (owner && itemKey !== current && !Array.isArray(owner[itemKey])) owner[itemKey] = [];
      const target = itemKey === current ? owner : owner?.[itemKey];
      if (Array.isArray(target)) target.push(parseScalar(stripComment(item[2]).trim()));
      continue;
    }
    if (data[current] === undefined) data[current] = {};
    // 子键：缩进层数 = 2 的倍数，深度 = 缩进 / 2
    const nested = line.match(/^( +)([a-z_]+):\s*(.*)$/);
    if (!nested) continue;
    const depth = Math.floor(nested[1].length / 2);
    while (stack.length >= depth) stack.pop();
    const parent = stack.at(-1) ?? data[current];
    const raw = stripComment(nested[3]).trim();
    if (raw === '') {
      parent[nested[2]] ??= {};
      itemKey = nested[2];
      stack.push(parent[nested[2]]);
    } else {
      parent[nested[2]] = raw === '[]' ? [] : raw.startsWith('{') ? parseInlineObject(raw) : parseScalar(raw);
      itemKey = nested[2];
    }
  }
  for (const [key, value] of Object.entries(data)) if (value === undefined) data[key] = {};
  return { data, lines };
}

/**
 * 写回：顶层键的值整体重写（包括它的子行），其余行（含注释）原样保留。
 * `rewriteComments` 里列出的顶层键，写入时去掉旧注释（注释已经过时，例如 status 的状态机说明）。
 */
export function stringifyArticle(data, original, { rewriteComments = [] } = {}) {
  const lines = original.split('\n');
  const out = [];
  const used = new Set();
  for (let i = 0; i < lines.length; i++) {
    const top = lines[i].match(/^([a-z_]+):\s*(.*)$/);
    if (!top) {
      out.push(lines[i]);
      continue;
    }
    const key = top[1];
    used.add(key);
    let comment = lines[i].slice(stripComment(lines[i]).length);
    if (rewriteComments.includes(key)) comment = '';
    const trailingComments = [];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      const next = lines[++i];
      const match = next.match(/^\s+(#.*)$/);
      if (match) trailingComments.push(match[1]);
    }
    const block = renderKey(key, data[key], '');
    out.push(block[0] + comment, ...block.slice(1));
    for (const c of trailingComments) out.push(`  ${c}`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (!used.has(key)) out.push(...renderKey(key, value, ''));
  }
  return out.join('\n');
}

function renderKey(key, value, indent) {
  if (Array.isArray(value)) {
    if (!value.length) return [`${indent}${key}: []`];
    return [`${indent}${key}:`, ...value.map((item) => `${indent}  - ${renderValue(item)}`)];
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return [`${indent}${key}: {}`];
    return [`${indent}${key}:`, ...entries.flatMap(([k, v]) => renderKey(k, v, `${indent}  `))];
  }
  return [`${indent}${key}: ${renderValue(value)}`];
}

function stripComment(value) {
  // 只剥「空白 + #」，字符串里的 # 不动
  return value.replace(/\s+#.*$/, '');
}

function parseScalar(raw) {
  if (raw === '""' || raw === "''") return '';
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { return raw.slice(1, -1); }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '~') return null;
  return raw;
}

function parseInlineObject(raw) {
  const obj = {};
  for (const part of raw.replace(/^\{|\}$/g, '').split(',')) {
    const [k, ...rest] = part.split(':');
    if (!k?.trim()) continue;
    obj[k.trim()] = parseScalar(rest.join(':').trim());
  }
  return obj;
}

function inlineObject(obj) {
  return `{ ${Object.entries(obj).map(([k, v]) => `${k}: ${renderValue(v)}`).join(', ')} }`;
}

function renderValue(value) {
  if (value === '' || value === undefined || value === null) return '""';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') return inlineObject(value);
  const text = String(value);
  const plain = /^[\w一-龥][\w一-龥 .×–\-_/()（）:%·→]*$/.test(text) && !/^(true|false|\d+(\.\d+)?)$/.test(text);
  return plain && !text.startsWith('{') && !text.startsWith('[') ? text : JSON.stringify(text);
}
