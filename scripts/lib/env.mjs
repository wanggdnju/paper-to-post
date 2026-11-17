/**
 * 从项目 .env 读键值。逐行解析，不能 `source`——某些值里带括号/引号会让 shell 报错。
 *
 * 为什么单独拎出来：research-paper.mjs 里原来有一份，写稿链路还需要，
 * 复制三份一定会漂移（比如有人给其中一份加了引号处理）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function readEnv(root = ROOT) {
  const path = join(root, '.env');
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/** 环境变量优先于 .env（方便临时覆盖，例如换模型试一次）。 */
export function envGet(key, root = ROOT) {
  if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
  return readEnv(root)[key] ?? '';
}
