#!/usr/bin/env node
/**
 * 从 arXiv e-print 取论文原图，并把 PDF/EPS 矢量图转成高清 PNG。
 *
 *   npm run fetch:figures -- --arxiv=2602.06036 --slug=dflash
 *   npm run fetch:figures -- --arxiv=2602.06036 --slug=dflash --dpi=200
 *
 * 为什么不用 PDF 里抽图：论文图绝大多数是矢量（Form XObject 或内嵌 PDF），
 * 从 PDF 里抽出来只是空白或碎块。e-print 里的原始 figures/*.pdf 才是干净的源。
 *
 * 产物：
 *   articles/<slug>/assets/fig-<原名>.png      图
 *   articles/<slug>/assets/figures.json               每张图的上下文（所在章节、caption、引用宽度），写稿时按它插图
 *   articles/<slug>/assets/src/*.tex           各 chapter 的 tex（供人工核对 caption）
 */
import { execFileSync } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { parseArxivId } from './lib/arxiv.mjs';
import { mapPool, resolveJobs } from './lib/pool.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.join('=') || true];
}));
if (!args.arxiv || !args.slug) {
  console.error('用法：node scripts/fetch-figures.mjs --arxiv=<id 或 URL> --slug=<slug> [--dpi=200]');
  process.exit(1);
}
const ROOT = process.cwd();
const slug = String(args.slug);
let arxivId;
try {
  arxivId = parseArxivId(args.arxiv).id;   // 也接受 https://arxiv.org/abs/xxxx
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}
const dpi = Number(args.dpi ?? 200);
const assetDir = join(ROOT, 'articles', slug, 'assets');
fs.mkdirSync(join(assetDir, 'src'), { recursive: true });

// ---- 1. 下载 e-print ----
const tarPath = join('/tmp', `eprint-${arxivId}.tar.gz`);
const url = `https://export.arxiv.org/e-print/${arxivId}`;
const localCopy = join('/tmp', `eprint-${arxivId}.tar.gz`);
let downloaded = false;
try {
  execFileSync('curl', ['-sL', '--fail', '-m', '600', '-A', 'Mozilla/5.0 paper-to-post', '-o', tarPath, url], { stdio: 'pipe' });
  downloaded = fs.existsSync(tarPath) && fs.statSync(tarPath).size > 1024;
} catch {
  downloaded = false;
}
if (!downloaded && existsSync(localCopy)) {
  fs.copyFileSync(localCopy, tarPath);
  console.warn('⚠️ 下载失败，使用本地已有的源码包：', localCopy);
}
if (!downloaded && !existsSync(localCopy)) {
  console.error('下载 e-print 失败，且本地没有缓存。检查网络或手动下载后放到', localCopy);
  process.exit(1);
}
const raw = fs.readFileSync(tarPath);
if (raw[0] !== 0x1f || raw[1] !== 0x8b) {
  console.error('下载结果不是 gzip，arXiv 可能返回了错误页');
  process.exit(1);
}
const tarBuf = gunzipSync(raw);
const isTar = tarBuf.length > 262 && tarBuf.subarray(257, 262).toString('latin1') === 'ustar';
const work = join('/tmp', `eprint-${arxivId}`);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
if (isTar) {
  try { execFileSync('tar', ['xzf', tarPath, '-C', work], { stdio: 'pipe' }); }
  catch { console.warn('⚠️ tar 解压有错误（常见于包内字体文件），已抽取到的文件继续使用'); }
} else {
  fs.writeFileSync(join(work, 'main.tex'), tarBuf);
}

// 保存原始 e-print，便于以后重新抽取（论文素材进版本库）
fs.mkdirSync(join(ROOT, 'articles', slug, 'source', 'latex'), { recursive: true });
fs.copyFileSync(tarPath, join(ROOT, 'articles', slug, 'source', 'latex', 'eprint.tar.gz'));

// ---- 2. 收集 tex 与图 ----
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const files = walk(work);
const texFiles = files.filter((f) => f.endsWith('.tex'));
const candidates = files.filter((f) => /\.(pdf|eps|png|jpe?g|svg)$/i.test(f) && !/\.tex$/i.test(f));

// caption + 所在章节：扫所有 tex，按 \begin{figure}...\end{figure} 取块
const figureMeta = new Map();
for (const tex of texFiles) {
  const text = fs.readFileSync(tex, 'utf8');
  fs.writeFileSync(join(assetDir, 'src', tex.slice(work.length + 1).replace(/[\\/]/g, '_')), text);
  // 最近的 section 标题作为章节名
  const blocks = [...text.matchAll(/\\begin\{figure\*?\}([\s\S]*?)\\end\{figure\*?\}/g)];
  for (const b of blocks) {
    const body = b[1];
    const inc = body.match(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/);
    if (!inc) continue;
    const before = text.slice(0, b.index);
    const secMatches = [...before.matchAll(/\\(?:sub)?section\*?\{([^}]*)\}/g)];
    const section = secMatches.at(-1)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    const caption = (body.match(/\\caption\{([\s\S]*?)\}\s*(?:\\label|\\end)/)?.[1] ?? '')
      .replace(/\\[a-zA-Z]+\{?|\}/g, ' ').replace(/\s+/g, ' ').trim();
    const label = body.match(/\\label\{([^}]+)\}/)?.[1] ?? '';
    const width = inc[0].match(/width=([\d.]+)\\(?:line)?width/)?.[1] ?? '1';
    figureMeta.set(inc[1].replace(/^\.\//, ''), { section, caption, label, width: Number(width) });
  }
}

// 只转「被 \includegraphics 引用」或放在 figures/ 目录下的文件。
//
// e-print 里常带一份**编译好的整篇 PDF**（文件名是一串随机字符）。以前它会被当成图，
// 整页渲染成 4.9 MB 的 PNG 塞进 assets/（2026-11-16 DFlare 的
// fig-zfyyytvwykkrccfjfzhcczcqmyhbnpx.png 就是论文第 1 页）。
// 判据用 LaTeX 自己引用的路径，比按文件名猜可靠；一个都没引用时才退回全收。
const referenced = new Set([...figureMeta.keys()].map((k) => k.replace(/^\.\//, '')));
const figures = candidates.filter((f) => {
  if (!referenced.size) return true;
  const rel = f.slice(work.length + 1).replace(/[\\/]/g, '/');
  return referenced.has(rel) || /(^|\/)figures?\//i.test(rel);
});
const dropped = candidates.length - figures.length;
if (dropped > 0) console.log(`⏭ 跳过 ${dropped} 个未被 \\includegraphics 引用的文件（多半是编译好的整篇 PDF）`);

// ---- 3. 转换：PDF/EPS → PNG（Chromium 的 PDF 查看器渲染单页，带透明通道）----
// 每张图一个独立 page，并发渲染。
// 串行时每张要「导航 1.8s + 截图 + 像素扫描」，十几张图就是 30–40 秒；并发后是它的 1/4。
// **不能共用一个 page**：renderPdfPage 会在里面改视口高度、goto 新 URL，
// 多个任务共享同一 page 会互相打断（视口被改回去 → 渲染出来是被裁的图）。
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true, ...(findChromium() ? { executablePath: findChromium() } : {}) });
const jobs = resolveJobs(args.jobs, 4);
if (figures.length > 1) console.log(`并发 ${Math.min(jobs, figures.length)} 张（--jobs 可调）`);
const manifest = [];
const rendered = await mapPool(figures, jobs, async (fig) => {
  const rel = fig.slice(work.length + 1).replace(/[\\/]/g, '/');
  const meta = figureMeta.get(rel) ?? {};
  const base = rel.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '-');
  const outPng = join(assetDir, `fig-${base}.png`);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1400 }, deviceScaleFactor: dpi / 96 });
  try {
    if (/\.(pdf|eps)$/i.test(fig)) {
      // Chromium 只认 PDF：EPS 先交给 sips 试试，失败就记下来
      if (/\.eps$/i.test(fig)) {
        execFileSync('sips', ['-s', 'format', 'png', fig, '--out', outPng], { stdio: 'ignore' });
      } else {
        await renderPdfPage(page, fig, outPng);
      }
    } else {
      fs.copyFileSync(fig, outPng);
    }
    const size = fs.statSync(outPng).size;
    if (size < 2048) throw new Error('输出小于 2KB，可能是空白页');
    console.log(`✓ ${rel} → fig-${base}.png (${Math.round(size / 1024)}KB)`);
    return { file: rel, png: `articles/${slug}/assets/fig-${base}.png`, bytes: size, ...meta };
  } catch (error) {
    console.warn(`✗ ${rel}: ${error instanceof Error ? error.message : error}`);
    return { file: rel, error: String(error instanceof Error ? error.message : error), ...meta };
  } finally {
    await page.close().catch(() => {});
  }
});
manifest.push(...rendered);
await browser.close();

fs.writeFileSync(join(ROOT, 'articles', slug, 'assets', 'figures.json'), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.filter((m) => m.png).length}/${figures.length} 张已转换，清单：articles/${slug}/assets/figures.json`);

/**
 * 用 Chromium 内置 PDF 查看器渲染单页 PDF。
 * 思路：打开 PDF → 等待查看器渲染 → 对查看器插件区域截图 → 在页面内用 canvas 扫像素裁掉白边。
 * 不依赖 PIL / sharp 这类图像库。
 */
/**
 * 用 Chromium 的 PDF 查看器渲染单页 PDF，只保留「文档画布」区域。
 *
 * 查看器自带缩略图侧栏（深灰）和顶部工具栏，不能直接对整页截图裁白边——
 * 之前就是这么把深灰侧栏裁进图里的（黑框框）。
 * 做法：截图后找出「白色纸张」的列区间和行区间，据此确定画布边界，再按纸张裁剪。
 */
/**
 * 用 Chromium 的 PDF 查看器渲染单页 PDF。
 *
 * 关键：用 URL 参数 `#toolbar=0&navpanes=0&view=FitH` 关掉查看器自带的工具栏和缩略图侧栏。
 * 之前没关，截到的是「深灰侧栏 + 工具栏 + 白纸」，按白色像素裁切就把深灰侧栏留在了图里（黑框）。
 * 关掉 UI 后整页只有白纸是白的，按白色外接框裁一刀即可。
 */
async function renderPdfPage(page, pdfPath, outPng) {
  // 视口高度必须**动态够高**，不能固定 2400。
  // 2026-11-12 事故：EAGLE-2/3 有四张方法图的比例是 1.36（竖长），
  // FitH 铺满 1800 宽之后需要 2445px，固定 2400 的视口正好切掉最后 45px——
  // 底部「Attention mask」那半行就没了，而裁白边只能裁不能补。
  // 做法：先按 2400 试一次；如果裁出来的底边贴着截图下沿（说明被视口切了），
  // 换成更高的视口重试。宁可多截一段白纸，也不能少一行内容。
  const heights = [2400, 3600, 5200];
  for (let attempt = 0; attempt < heights.length; attempt++) {
    await page.setViewportSize({ width: 1800, height: heights[attempt] });
    // `#page=1`：只要第一页。多页 PDF（LaTeX 偶尔会带一张 Figure 5 的残页）
    // 在查看器里是纵向排列的，视口一高就会把第二页也截进来——
    // 2026-11-12 EAGLE-3 的 train.pdf 就这么被拼成了「同一张图出现两遍」。
    await page.goto('file://' + pdfPath + '#page=1&toolbar=0&navpanes=0&view=FitH', { waitUntil: 'load' });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: outPng, fullPage: false, scale: 'device' });
    const shotUrl = 'data:image/png;base64,' + fs.readFileSync(outPng).toString('base64');
    const result = await page.evaluate(async (src) => {
      const img = await createImageBitmap(await (await fetch(src)).blob());
      const canvas = new OffscreenCanvas(img.width, img.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
      const px = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
      const paper = (x, y) => { const [r, g, b] = px(x, y); return r > 242 && g > 242 && b > 242; };

      let x0 = width, y0 = height, x1 = -1, y1 = -1;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          if (!paper(x, y)) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0 || y1 < 0) return null;

      // 页与页之间是查看器的背景色（深灰 40,40,40），**不是白色**。
      // 只裁到第一页：从第一行白纸往下找，遇到「整行同色且不是白」的连续 ≥8px 就停。
      // 没有这一步，两页 PDF 会被拼成一张「同一张图出现两遍」的怪图。
      const uniformNonWhite = (y) => {
        const first = px(4, y);
        if (first[0] > 242 && first[1] > 242 && first[2] > 242) return false;
        for (let x = 40; x < width - 40; x += 40) {
          const c = px(x, y);
          if (Math.abs(c[0] - first[0]) > 6 || Math.abs(c[1] - first[1]) > 6 || Math.abs(c[2] - first[2]) > 6) return false;
        }
        return true;
      };
      let pageEnd = -1;
      for (let y = y0 + 4; y < height - 8; y += 2) {
        if (!uniformNonWhite(y) || !uniformNonWhite(y + 4) || !uniformNonWhite(y + 8)) continue;
        pageEnd = y;
        break;
      }
      const pageTrimmed = pageEnd > 0 && pageEnd < y1;
      if (pageTrimmed) y1 = pageEnd - 2;

      // 纸面一直顶到截图下沿 = 页面比视口高，底部被切了（多页时 pageEnd 会先命中，不算）
      const clippedBottom = !pageTrimmed && y1 >= height - 2;
      const pad = 8;
      const bx0 = Math.max(0, x0 - pad), by0 = Math.max(0, y0 - pad);
      const bx1 = Math.min(width, x1 + pad), by1 = Math.min(height, y1 + pad);
      const out = new OffscreenCanvas(bx1 - bx0, by1 - by0);
      out.getContext('2d').drawImage(canvas, bx0, by0, bx1 - bx0, by1 - by0, 0, 0, bx1 - bx0, by1 - by0);
      const blob = await out.convertToBlob({ type: 'image/png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { dataUrl: 'data:image/png;base64,' + btoa(bin), clippedBottom, pageTrimmed, height };
    }, shotUrl).catch((e) => { console.warn('  crop failed:', String(e).split('\n')[0]); return null; });

    if (!result) { console.warn('  ⚠️ 没找到白色纸面，保留整页截图（可能是深色背景的 PDF）'); return; }
    fs.writeFileSync(outPng, Buffer.from(String(result.dataUrl).split(',')[1], 'base64'));
    if (!result.clippedBottom) return;
    if (attempt < heights.length - 1) {
      console.warn(`  ⚠️ 视口 ${heights[attempt]}px 装不下整页，改用更高视口重试`);
    }
  }
  console.error(`  ✗ 视口加到最高仍然不够，${outPng} 底部可能被截断——请手动检查`);
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  for (const dir of fs.readdirSync(cache).filter((n) => n.startsWith('chromium-')).sort().reverse()) {
    const base = join(cache, dir, 'chrome-mac-arm64');
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const mac = join(base, entry, 'Contents', 'MacOS');
      if (fs.existsSync(mac)) return join(mac, fs.readdirSync(mac)[0]);
    }
  }
  return undefined;
}
void dirname;
