/**
 * 微信公众平台草图接口的最小封装。凭据从项目 .env 读取：
 *   WECHAT_APPID=...
 *   WECHAT_APPSECRET=...
 *
 * 只做「建草稿」，不调用群发。群发不可撤回，必须由人在后台点击。
 * 注意：接口要求服务器出口 IP 在「基本配置 → IP 白名单」里，否则报 40164。
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.weixin.qq.com/cgi-bin';

/** .env 里可能有带括号/引号的值，不能 source，这里逐行解析 */
function readEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) throw new Error('找不到 .env');
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

let cached = null; // { token, expiresAt }

export async function getToken({ force = false } = {}) {
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const env = { ...readEnv(), ...process.env };
  const appid = env.WECHAT_APPID;
  const secret = env.WECHAT_APPSECRET;
  if (!appid || !secret) throw new Error('.env 里缺少 WECHAT_APPID / WECHAT_APPSECRET');
  const res = await fetch(`${API}/token?grant_type=client_credential&appid=${appid}&secret=${secret}`);
  const data = await res.json();
  if (!data.access_token) {
    const hint = data.errcode === 40164 ? '（出口 IP 不在白名单：开发 → 基本配置 → IP 白名单）' : '';
    throw new Error(`获取 access_token 失败：${data.errcode} ${data.errmsg}${hint}`);
  }
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return cached.token;
}

/**
 * 上传一张图片，返回微信域名 URL。
 * 走永久素材（material/add_material），因为草稿正文里的图片必须是微信自己的地址。
 */
export async function uploadImage(token, buffer, filename, type = 'png') {
  const form = new FormData();
  form.append('media', new Blob([buffer], { type: `image/${type}` }), filename);
  const res = await fetch(`${API}/material/add_material?access_token=${token}&type=image`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.url) throw new Error(`上传图片失败（${filename}）：${data.errcode} ${data.errmsg}`);
  return data.url;
}

export async function uploadThumb(token, buffer, filename, type = 'jpg') {
  const form = new FormData();
  form.append('media', new Blob([buffer], { type: `image/${type}` }), filename);
  const res = await fetch(`${API}/material/add_material?access_token=${token}&type=thumb`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.media_id) throw new Error(`上传封面失败：${data.errcode} ${data.errmsg}`);
  return data.media_id;
}

/**
 * 建草稿。content 必须是「已经上传好图片」的 HTML。
 * 返回 media_id。作者/来源署名由调用方传。
 */
export async function addDraft(token, { title, author, digest, content, thumbMediaId, sourceUrl = '' }) {
  const body = {
    articles: [{
      title: title.slice(0, 64),
      // 微信按 UTF-8 字节截断作者名（限制 8 字节），中文会被截成半个字；这里按字节安全截断
      author: bytesSlice(author ?? 'Paper', 8),
      digest: (digest ?? '').slice(0, 120),
      content,
      content_source_url: sourceUrl,
      thumb_media_id: thumbMediaId,
      need_open_comment: 1,
      only_fans_can_comment: 0,
    }],
  };
  const res = await fetch(`${API}/draft/add?access_token=${token}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const data = await res.json();
  if (!data.media_id) throw new Error(`建草稿失败：${data.errcode} ${data.errmsg}`);
  return data.media_id;
}

/**
 * 更新已有草稿（原地替换，media_id 不变）。
 * 用它而不是反复 draft/add：否则每次改版都在草稿箱里多一份，
 * 用户在列表里根本分不清哪份是最新的。
 */
export async function updateDraft(token, mediaId, { title, author, digest, content, thumbMediaId, sourceUrl = '' }) {
  const body = {
    media_id: mediaId,
    index: 0,
    articles: {
      title: String(title).slice(0, 64),
      author: bytesSlice(author ?? 'Paper', 8),
      digest: (digest ?? '').slice(0, 120),
      content,
      content_source_url: sourceUrl,
      thumb_media_id: thumbMediaId,
      need_open_comment: 1,
      only_fans_can_comment: 0,
    },
  };
  const res = await fetch(`${API}/draft/update?access_token=${token}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const data = await res.json();
  if (data.errcode) throw new Error(`更新草稿失败：${data.errcode} ${data.errmsg}`);
  return mediaId;
}

/** 读回已建草稿（用来验证「服务器上那份」和本地渲染的一致） */
export async function getDraft(token, mediaId) {
  const res = await fetch(`${API}/draft/get?access_token=${token}`, {
    method: 'POST',
    body: JSON.stringify({ media_id: mediaId }),
    headers: { 'content-type': 'application/json' },
  });
  const data = await res.json();
  if (data.errcode) throw new Error(`读草稿失败：${data.errcode} ${data.errmsg}`);
  return data.news_item?.[0] ?? null;
}

function bytesSlice(text, maxBytes) {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out || 'Paper';
}

export { createReadStream };
