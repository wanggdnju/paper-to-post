import fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本机 Playwright 只装了完整版 chromium（headless_shell 没下载），统一用这个找可执行文件。 */
export function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { existsSync, readdirSync } = fs;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
    const base = join(cache, dir, 'chrome-mac-arm64');
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const mac = join(base, entry, 'Contents', 'MacOS');
      if (existsSync(mac)) return join(mac, readdirSync(mac)[0]);
    }
  }
  return undefined;
}

export function launchOptions(extra = {}) {
  const exe = findChromium();
  return { headless: true, ...(exe ? { executablePath: exe } : {}), ...extra };
}
