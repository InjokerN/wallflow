// 云端壁纸下载：排队 → 下载（可续传）→ 校验 → 解压 → 入库。
//
// 三条原则：
// 1. 失败不删 .part。网络断了重试能接着下，几十上百 MB 不该从头再来。
// 2. 入库成功才删 .part。中途出错留下的是可续传的半成品，不是垃圾。
// 3. 解压前先看磁盘够不够。解压 + 复制会有两份数据同时存在，按包体 × 2.5 预留。

import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { getCacheDir, DATA_DIR } from '../db.js';
import { readCloudConfig, publicUrl, isConfigured, missingFields } from './config.js';
import { readCatalog } from './publish.js';
import { findProjectJson, parseProjectJson, pickMainFile, pickPreview, TYPE_DIR } from '../we-format.js';
import { isInside, installWallDir } from '../we-install.js';

const STATE_FILE = path.join(DATA_DIR, 'cloud-downloads.json');
const KEEP_HISTORY = 40; // 历史留最近 40 条，够翻就行

// 阶段进度：下载占大头，解压和入库很快，但要让用户看到「还没卡住」
const PHASE_PCT = { queued: 0, downloading: 0, verifying: 88, extracting: 92, importing: 97, done: 100 };

const tasks = new Map(); // id -> task
let seq = 0;
let pumping = false;

function cacheDir() {
  // 缓存根由设置决定（默认跟着壁纸库走），下载的半成品放在它的 downloads/ 下
  const dir = path.join(getCacheDir(), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const t of raw.tasks || []) {
      // 上次退出时还在跑的任务，重启后不能装作还在下载
      if (['queued', 'downloading', 'verifying', 'extracting', 'importing'].includes(t.status)) {
        t.status = 'failed';
        t.message = '上次退出时任务未完成，可以重试（已下载的部分会接着下）';
      }
      tasks.set(t.id, t);
    }
  } catch { /* 没有历史就从空开始 */ }
}

function saveState() {
  try {
    const list = [...tasks.values()].slice(-KEEP_HISTORY * 2);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ tasks: list }, null, 2), 'utf8');
  } catch { /* 状态存不下不影响下载本身 */ }
}

const publicTask = (t) => ({
  id: t.id,
  packId: t.packId,
  title: t.title,
  type: t.type,
  thumb: t.thumb,
  bytes: t.bytes,
  received: t.received || 0,
  progress: Math.max(0, Math.min(100, Math.round(t.progress || 0))),
  status: t.status,
  message: t.message || '',
  createdAt: t.createdAt,
  finishedAt: t.finishedAt || '',
});

export function listDownloads() {
  const all = [...tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const active = all.filter((t) => ['queued', 'downloading', 'verifying', 'extracting', 'importing'].includes(t.status));
  const history = all.filter((t) => !active.includes(t) && t.status !== 'removed').slice(0, KEEP_HISTORY);
  return { active: active.map(publicTask), history: history.map(publicTask) };
}

export function enqueue(packId, entry) {
  // 同一个包已经在队列里跑，就别重复排队
  for (const t of tasks.values()) {
    if (t.packId === packId && ['queued', 'downloading', 'verifying', 'extracting', 'importing'].includes(t.status)) {
      return { task: publicTask(t), duplicated: true };
    }
  }
  const id = 'd' + Date.now().toString(36) + (++seq);
  const task = {
    id,
    packId,
    title: entry.title || packId,
    type: entry.type || 'scene',
    thumb: entry.thumbUrl || '',
    bytes: Number(entry.bytes) || 0,
    received: 0,
    progress: 0,
    status: 'queued',
    message: '',
    createdAt: new Date().toISOString(),
  };
  tasks.set(id, task);
  saveState();
  pump();
  return { task: publicTask(task), duplicated: false };
}

export function retryDownload(id) {
  const t = tasks.get(id);
  if (!t) return null;
  if (['queued', 'downloading', 'verifying', 'extracting', 'importing'].includes(t.status)) return publicTask(t);
  t.status = 'queued';
  t.progress = 0;
  t.message = '';
  t.finishedAt = '';
  saveState();
  pump();
  return publicTask(t);
}

// 协作式取消：置 cancelled 标志，runTask 各阶段检查点抛 CancelledError。
// 下载流里由 Transform 抛出中断流；解压/入库阶段颗粒粗，检查点在阶段边界。
class CancelledError extends Error {
  constructor() { super('已取消'); this.cancelled = true; }
}
const cancelling = new Set(); // id -> 已请求取消

export function cancelDownload(id) {
  const t = tasks.get(id);
  if (!t) return null;
  if (!['queued', 'downloading', 'verifying', 'extracting', 'importing'].includes(t.status)) return publicTask(t);
  cancelling.add(id);
  t.cancelRequested = true;
  if (t.status === 'queued') {
    // 还没开跑的直接出队，标成 cancelled 进历史
    t.status = 'cancelled';
    t.message = '已取消（还没开始下载）';
    t.finishedAt = new Date().toISOString();
    cancelling.delete(id);
    saveState();
  }
  return publicTask(t);
}

// 检查点：任务被请求取消就抛出，让 runTask 的 catch 统一收尾
function throwIfCancelled(task) {
  if (cancelling.has(task.id)) throw new CancelledError();
}

// 清空历史（非进行中的全部移除），不动已入库的壁纸文件
export function clearHistory() {
  const working = ['queued', 'downloading', 'verifying', 'extracting', 'importing'];
  let n = 0;
  for (const t of [...tasks.values()]) {
    if (!working.includes(t.status)) { tasks.delete(t.id); n++; }
  }
  if (n) saveState();
  return n;
}

// 只从列表里移除记录，不碰已经入库的壁纸文件
export function removeDownload(id) {
  const t = tasks.get(id);
  if (!t) return false;
  if (['queued', 'downloading', 'verifying', 'extracting', 'importing'].includes(t.status)) return false;
  tasks.delete(id);
  saveState();
  return true;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = [...tasks.values()].find((t) => t.status === 'queued');
      if (!next) break;
      await runTask(next);
    }
  } finally {
    pumping = false;
  }
}

async function runTask(task) {
  const cfg = readCloudConfig();
  if (!isConfigured(cfg)) {
    task.status = 'failed';
    task.message = '云端未配置：' + missingFields(cfg).join('、');
    task.finishedAt = new Date().toISOString();
    saveState();
    return;
  }

  const dir = cacheDir();
  const part = path.join(dir, `${task.packId}.zip.part`);
  const extractDir = path.join(dir, `${task.packId}-extract`);

  try {
    // 从清单里重新拿一次条目：内存里的 entry 可能已经过时（标题被人改过之类）
    const packs = await readCatalog(cfg);
    const entry = packs.find((p) => p.id === task.packId);
    if (!entry) throw new Error('云端已没有这个包（可能被删除了）');
    task.title = entry.title || task.title;
    task.type = entry.type || task.type;
    task.thumb = entry.thumbUrl || task.thumb;
    task.bytes = Number(entry.bytes) || task.bytes;

    throwIfCancelled(task);
    await downloadTo(cfg, entry, part, task);
    throwIfCancelled(task);
    task.status = 'verifying';
    task.progress = PHASE_PCT.verifying;
    saveState();

    const size = fs.statSync(part).size;
    if (!size) throw new Error('下载到的文件是空的');
    if (entry.bytes && size !== Number(entry.bytes)) {
      throw new Error(`包大小对不上：云端记录 ${entry.bytes} 字节，实际拿到 ${size} 字节`);
    }
    ensureSpace(part);

    throwIfCancelled(task);
    task.status = 'extracting';
    task.progress = PHASE_PCT.extracting;
    saveState();
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    const fileCount = await unzipTo(part, extractDir);

    throwIfCancelled(task);
    task.status = 'importing';
    task.progress = PHASE_PCT.importing;
    saveState();

    const found = findProjectJson(extractDir);
    if (!found) throw new Error('包里的结构认不出来（没有 project.json）');
    const meta = parseProjectJson(found.file);
    // 云端 info.json 是发布者最后确认过的信息，比包里那份更权威
    if (entry.title) meta.title = entry.title;
    if (entry.author) meta.author = entry.author;
    if (entry.primaryTag) meta.primaryTag = entry.primaryTag;
    // 云端存的是「主标签 + 副标签」两栏，副标签直接覆盖包内可能过时的 tags
    if (Array.isArray(entry.subTags) && entry.subTags.length) meta.tags = entry.subTags.slice();
    const mainFile = pickMainFile(found.wallDir, meta.file, meta.type);
    if (!mainFile) throw new Error('包里找不到壁纸主文件');
    const preview = pickPreview(found.wallDir, meta.preview);

    // 云端下载沿用云端包的 packId 当目录名：上传端已经是 <类型>-<来源>-<编号>，
    // 直接用既不会撞名，也保住「dir_name === packId」的已下载判定。
    const result = installWallDir(found.wallDir, meta, mainFile, preview, task.packId,
      { folderName: task.packId });
    task.status = 'done';
    task.progress = 100;
    task.message = result.duplicated ? '库里已经有这一条了' : `已保存到 ${TYPE_DIR[meta.type]}/${result.folder}`;
    task.wallpaperId = result.id;
    task.fileCount = fileCount;
    task.finishedAt = new Date().toISOString();

    // 入库成功才清掉临时文件
    fs.rmSync(part, { force: true });
    fs.rmSync(extractDir, { recursive: true, force: true });
  } catch (e) {
    if (e && e.cancelled) {
    task.status = 'cancelled';
    task.message = '已取消（已下载的部分保留，重试可接着下）';
    } else {
    task.status = 'failed';
    task.message = e.message || String(e);
    }
    cancelling.delete(task.id);
    task.finishedAt = new Date().toISOString();
    // .part 故意留着：重试时能按 Range 接着下
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  saveState();
}

// 流式下载到 .part，已存在就带 Range 接着下
async function downloadTo(cfg, entry, part, task) {
  const url = publicUrl(cfg, entry.pack);
  if (!url) throw new Error('没有配置公开访问地址，无法下载');

  let start = 0;
  try { start = fs.statSync(part).size; } catch { start = 0; }

  task.status = 'downloading';
  task.received = start;
  task.progress = PHASE_PCT.downloading;
  saveState();

  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(url, { headers });

  let append = false;
  if (start > 0 && res.status === 206) {
    append = true;
  } else if (res.status === 200) {
    // 服务器不支持续传就从头来，别把新内容接在旧内容后面
    append = false;
    start = 0;
  } else if (res.status === 416) {
    // 请求范围超出文件长度：说明 .part 已经比云端文件还大，只能重下
    fs.rmSync(part, { force: true });
    return downloadTo(cfg, entry, part, task);
  } else {
    throw new Error(`下载失败：HTTP ${res.status}`);
  }

  const total = Number(res.headers.get('content-length') || 0) + start;
  if (entry.bytes) task.bytes = Number(entry.bytes);

  const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  let received = start;
  let lastTick = 0;
  // 用 pipeline 而不是手动 pause/resume 挂 data 事件：实测同一份 18MB 文件，
  // 手写背压只有 668 KB/s，pipeline 是 2090 KB/s（差 3 倍）。进度靠一个透传 Transform 计。
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      if (cancelling.has(task.id)) { cb(new CancelledError()); return; }
      received += chunk.length;
      task.received = received;
      if (task.bytes) {
        // 下载阶段只占 0-88%，剩下的留给校验和解压
        task.progress = Math.min(87, (received / task.bytes) * 88);
      }
      const now = Date.now();
      if (now - lastTick > 400) { lastTick = now; saveState(); }
      cb(null, chunk);
    },
  });
  // fetch 的 body 是 WHATWG 流，转成 Node 流才能进 pipeline
  await pipeline(Readable.fromWeb(res.body), counter, out);

  if (total && received !== total) {
    throw new Error(`下载中断：期望 ${total} 字节，实际 ${received} 字节（重试会接着下）`);
  }
  task.received = received;
}

// 解压前检查剩余空间：解压出来一份 + 搬进库再一份，按 2.5 倍预留
function ensureSpace(part) {
  let st;
  try {
    st = fs.statfsSync(getLibraryDir());
  } catch {
    // 某些文件系统查不到可用空间，不能因为查不到就把正常下载挡下来
    return;
  }
  const free = st.bavail * st.bsize;
  const need = fs.statSync(part).size * 2.5;
  if (free < need) {
    throw new Error(`磁盘空间不够：还需要约 ${(need / 1073741824).toFixed(1)} GB，当前只剩 ${(free / 1073741824).toFixed(1)} GB`);
  }
}

// 流式解压，逐条校验路径，防 zip slip
function unzipTo(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(new Error('ZIP 打不开：' + err.message));
      let count = 0;
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        // 目录条目本身不写盘，靠文件自动建父目录
        if (/\/$/.test(name)) return zip.readEntry();
        if (name.includes('\\') || path.isAbsolute(name) || name.split('/').includes('..')) {
          return reject(new Error('包内含非法路径，已拒绝：' + name));
        }
        const target = path.join(destDir, name);
        if (!isInside(destDir, target)) return reject(new Error('包内路径越界，已拒绝：' + name));
        zip.openReadStream(entry, (err2, rs) => {
          if (err2) return reject(new Error('解压失败：' + err2.message));
          fs.mkdirSync(path.dirname(target), { recursive: true });
          pipeline(rs, fs.createWriteStream(target))
            .then(() => {
              count++;
              zip.readEntry();
            })
            .catch(reject);
        });
      });
      zip.on('end', () => resolve(count));
      zip.on('error', (e) => reject(new Error('解压失败：' + e.message)));
      zip.readEntry();
    });
  });
}

loadState();
