/**
 * 「这个数字是什么单位」的判定，verify-numbers 和测试共用。
 *
 * 为什么需要一个单位维度：同一篇文章里 `4.22` 常常既是接受长度（表格原值）
 * 又是加速比（同名字段的 `4.22×`）。只按数值建索引，两个含义会互相顶替，
 * 于是「这个数在表里」这条信号既可能误放行也可能误报。
 *
 * 但单位维度不能太严——表里抽出来的事实值天生不带单位（单元格里就是 `23.3`），
 * 正文却会写「吞吐高 23.3%」。所以查找规则是不对称的：
 *
 *   - 引用**带**单位：先找同类，找不到再认领无单位的那一格（`23.3%` ← `23.3`）
 *   - 引用**不带**单位：只找无单位的格子，不去认领 `4.22x`
 *
 * 反方向放宽会让「正文写了 4.22，其实表里是 4.22×」静默通过，那正是要防的。
 */

/** 单位类别：`×` / `x` / `倍` 同属加速比；`%` 单独一类；其余无单位。 */
export function unitClass(raw) {
  const s = String(raw);
  if (/[×x倍]$/.test(s)) return 'x';
  if (/%$/.test(s)) return '%';
  return '';
}

/** 索引键：`数值|单位类别`。数值取前导数字，跳过正负号和千分位。 */
export function valueKey(raw) {
  const s = String(raw).replace(/^[+−-]/, '');
  const num = s.match(/\d+(?:\.\d+)?/)?.[0];
  if (num === undefined) return s;
  return `${num}|${unitClass(s)}`;
}

/** 引用里的数字部分（`23.3%` → `23.3`），取不到返回 undefined。 */
export function numberCore(raw) {
  return String(raw).match(/\d+(?:\.\d+)?/)?.[0];
}

/**
 * 一个引用（数值 + 文中的单位）允许匹配哪些索引键。
 * 返回数组而不是单个键，顺序即优先级。
 */
export function candidateKeys(value, unit = '') {
  const num = numberCore(value);
  if (num === undefined) return [];
  const cls = unitClass(`${value}${unit}`);
  return cls ? [`${num}|${cls}`, `${num}|`] : [`${num}|`];
}

/** 两边的单位类别是否算「同一类」，用于舍入比对。 */
export function classesCompatible(quoteUnit, factUnit) {
  const q = unitClass(`${quoteUnit}`);
  const f = unitClass(`${factUnit}`);
  if (q === f) return true;
  // 只有「引用带单位、事实格不带」这一种放宽。
  return Boolean(q) && f === '';
}
