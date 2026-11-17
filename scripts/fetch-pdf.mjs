#!/usr/bin/env node
/**
 * 用系统自带 Chromium（Playwright 驱动）下载论文 PDF，并抽取正文文本。
 *
 *   node scripts/fetch-pdf.mjs https://arxiv.org/pdf/2602.06036 [--out=/tmp/paper.pdf] [--text=/tmp/paper.txt]
 *
 * 为什么不用 curl：arXiv 的 PDF 链接会校验浏览器会话，裸 curl 拿到的是
 * HTML 跳转页或 403；浏览器上下文里有 cookie，请求才会返回真正的 application/pdf。
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseArxivId } from './lib/arxiv.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const url = args._ ?? process.argv.slice(2).find((arg) => !arg.startsWith('--'));
if (!url) {
  console.error('Usage: node scripts/fetch-pdf.mjs <pdf-url> [--out=paper.pdf] [--text=paper.txt]');
  process.exit(1);
}
const out = args.out ?? '/tmp/paper.pdf';
const textOut = args.text ?? out.replace(/\.pdf$/, '.txt');

const executablePath = findChromium();
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const host = new URL(url).host;
// 先打开论文页拿到会话 cookie，再在同一个浏览器上下文里请求 PDF
await page.goto(`https://${host}/abs/${extractId(url)}`, { waitUntil: 'load', timeout: 120_000 });
const response = await context.request.get(url, { timeout: 180_000 });
if (response.status() !== 200) throw new Error(`PDF request failed: HTTP ${response.status()}`);
const bytes = await response.body();
if (!bytes.subarray(0, 5).toString('latin1').startsWith('%PDF')) throw new Error('Response is not a PDF (session check failed)');
writeFileSync(out, bytes);
await browser.close();
console.log(JSON.stringify({ pdf: out, bytes: bytes.length, contentLength: bytes.length }));

// 文本抽取：用 pypdf（无需额外系统依赖）
const { spawnSync } = await import('node:child_process');
const extractor = `
import sys, json
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
text = "\\n".join((page.extract_text() or "") for page in reader.pages)
open(sys.argv[2], "w").write(text)
print(json.dumps({"pages": len(reader.pages), "chars": len(text), "text": sys.argv[2]}))
`;
const result = spawnSync('python3', ['-c', extractor, out, textOut], { encoding: 'utf8' });
if (result.status === 0) console.log(result.stdout.trim());
else console.error(`text extraction skipped: ${result.stderr.split('\n').filter(Boolean).slice(-1)[0] ?? 'pypdf not available'}`);

function extractId(value) {
  return parseArxivId(value).id;   // 与另外几个脚本共用一套规则，URL 也能吃
}

function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((name) => name.startsWith('chromium-')).sort().reverse();
  for (const dir of dirs) {
    const base = join(cache, dir, 'chrome-mac-arm64');
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const mac = join(base, entry, 'Contents', 'MacOS');
      if (existsSync(mac)) {
        const binary = readdirSync(mac)[0];
        if (binary) return join(mac, binary);
      }
    }
  }
  return undefined;
}
