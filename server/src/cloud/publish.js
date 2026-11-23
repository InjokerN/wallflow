// 把一条本地壁纸打成 WE 包并上传到桶里。
//
// 桶内布局（和 index.json 的字段一一对应）：
//   index.json                     ← 唯一清单，列表页只读它
//   packs/<packId>/info.json       ← 单条元信息
//   packs/<packId>/thumb.<ext>     ← 列表缩略图
//   packs/<packId>/pack.zip        ← 真正被下载的那一个
//
// packId 优先用 dir_name（we-2188974570 这种 WE 包 id，重装软件也不会变）；
// 老条目 dir_name 是「场景/视频/网页」这种类型目录名，不唯一，退回 wf-<id>。

import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { DATA_DIR } from '../db.js';
import { addRowToZip } from '../routes/compat.js';
import { resolveWallpaperDir, TYPE_DIR } from '../library-path.js';
import { getStore, fileStream } from './store.js';
import { publicUrl } from './config.js';

const TMP_DIR = path.join(DATA_DIR, 'cloud-tmp');
const TYPE_DIR_SET = new Set(Object.values(TYPE_DIR));

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
};

export function packIdOf(row) {
  const dirName = String(row.dir_name || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (dirName && !TYPE_DIR_SET.has(dirName)) return dirName;
  return `wf-${row.id}`;
}

// 缩略图沿用封面原格式，不改名成 .jpg 去骗浏览器（Content-Type 会跟着一起错）
function thumbName(row) {
  const ext = path.extname(String(row.cover || '')).toLowerCase();
  return MIME[ext] ? `thumb${ext === '.jpeg' ? '.jpg' : ext}` : 'thumb.jpg';
}

function packToFile(row, outFile) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const zip = new yazl.ZipFile();
    let rootName = '';
    try {
      rootName = addRowToZip(zip, row);
      zip.end();
    } catch (e) {
      try { zip.outputStream.destroy(); } catch { /* 忽略 */ }
      return reject(e);
    }
    const ws = fs.createWriteStream(outFile);
    zip.outputStream.on('error', reject);
    ws.on('error', reject);
    ws.on('close', () => resolve({ rootName, bytes: ws.bytesWritten }));
    zip.outputStream.pipe(ws);
  });
}

export async function readIndex(store) {
  const buf = await store.get('index.json');
  if (buf) {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      if (Array.isArray(j.packs)) return j;
    } catch { /* 坏清单当作空，下面重建 */ }
  }
  return { version: 1, updatedAt: '', packs: [] };
}

async function writeIndex(store, idx) {
  idx.updatedAt = new Date().toISOString();
  await store.put('index.json', Buffer.from(JSON.stringify(idx, null, 2), 'utf8'), 'application/json');
  return idx;
}

// row: 数据库行；meta: 用户在发布表单里填的信息（批量上传时为空，用 row 自己的值）
export async function publishOne(row, meta = {}, cfg) {
  const store = getStore(cfg);
  const id = packIdOf(row);
  const base = `packs/${id}`;
  const tmpZip = path.join(TMP_DIR, `${id}.zip`);

  let packed;
  try {
    packed = await packToFile(row, tmpZip);
  } catch (e) {
    throw new Error('打包失败：' + e.message);
  }

  const dir = resolveWallpaperDir(row);
  let thumbKey = '';
  if (row.cover) {
    const abs = path.join(dir, path.basename(row.cover));
    if (fs.existsSync(abs)) {
      const name = thumbName(row);
      thumbKey = `${base}/${name}`;
      await store.put(thumbKey, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'image/jpeg');
    }
  }

  const now = new Date().toISOString();
  const entry = {
    id,
    title: String(meta.title ?? row.title ?? '').slice(0, 200),
    author: String(meta.author ?? row.author ?? '').slice(0, 100),
    type: row.type,
    category: String(meta.category ?? row.category ?? '').slice(0, 60),
    description: String(meta.description ?? row.description ?? '').slice(0, 2000),
    primaryTag: meta.primaryTag !== undefined ? meta.primaryTag : (row.primary_tag || ''),
    subTags: Array.isArray(meta.subTags) ? meta.subTags : String(row.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    thumb: thumbKey,
    pack: `${base}/pack.zip`,
    bytes: packed.bytes,
    updatedAt: now,
  };

  const info = { ...entry, root: packed.rootName, version: 1 };
  await store.put(`${base}/info.json`, Buffer.from(JSON.stringify(info, null, 2), 'utf8'), 'application/json');
  await store.put(`${base}/pack.zip`, fileStream(tmpZip), 'application/zip', packed.bytes);

  const idx = await readIndex(store);
  const at = idx.packs.findIndex(p => p.id === id);
  if (at >= 0) idx.packs[at] = { ...idx.packs[at], ...entry };
  else idx.packs.unshift(entry);
  await writeIndex(store, idx);

  try { fs.rmSync(tmpZip, { force: true }); } catch { /* 忽略 */ }

  return { ...entry, thumbUrl: publicUrl(cfg, thumbKey), packUrl: publicUrl(cfg, entry.pack) };
}

// 前端拿到的目录：补上公开 URL，按更新时间倒序
//
// 封面不直接给 pub-xxx.r2.dev 的地址：浏览器直连那个域名实测会被掐断
// （ERR_CONNECTION_CLOSED，连得不稳时整张图都加载不出来），而后端走 S3 端点
// 是通的。所以封面统一交给后端代取（routes/cloud.js 的 /thumb/:id），
// 取到之后在本地留一份，之后断网也能显示。
export async function readCatalog(cfg) {
  const store = getStore(cfg);
  const idx = await readIndex(store);
  return idx.packs
    .map(p => ({
      ...p,
      thumbUrl: p.thumb ? `/api/v1/cloud/thumb/${encodeURIComponent(p.id)}` : '',
      packUrl: p.pack ? publicUrl(cfg, p.pack) : '',
    }))
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

// 删除一个云端包：目录里三个对象 + 清单里那一条。
//
// 缩略图的扩展名跟着原封面走（gif/jpg/png 都可能），清单里有就用清单里的 key；
// 清单缺这一条（比如上次上传到一半）就挨个常见扩展名试一遍 —— r2Store.del 对 404
// 是容错的，多试几个没有副作用，但能避免留下一张还能被公开域名访问到的孤儿图。
const THUMB_EXTS = ['.gif', '.jpg', '.png', '.webp', '.jpeg', '.avif'];

export async function deletePack(id, cfg) {
  const store = getStore(cfg);
  const base = `packs/${id}`;
  const idx = await readIndex(store);
  const at = idx.packs.findIndex(p => p.id === id);
  const entry = at >= 0 ? idx.packs[at] : null;

  const keys = [`${base}/info.json`, `${base}/pack.zip`];
  if (entry && entry.thumb) keys.push(entry.thumb);
  else for (const ext of THUMB_EXTS) keys.push(`${base}/thumb${ext}`);

  const failed = [];
  for (const k of keys) {
    try { await store.del(k); } catch (e) { failed.push(`${k}（${e.message}）`); }
  }
  // 只要有对象没删掉就不动清单：否则云端少一条，桶里却还留着文件，
  // 界面上再也看不到、也删不掉了，只能去控制台手挖。
  if (failed.length) throw new Error('有文件没能删掉：' + failed.join('；'));

  if (at >= 0) {
    idx.packs.splice(at, 1);
    await writeIndex(store, idx);
  }
  return { id, entry, removed: at >= 0 };
}
