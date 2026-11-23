// 云端壁纸库接口。上传是长任务：POST 只负责建队列，进度靠轮询 /job/:id 拿，
// 避免一个几百 MB 的包把 HTTP 请求吊在那里。

import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import db, { DATA_DIR, getCacheDir } from '../db.js';
import { readCloudConfig, publicStatus, isConfigured, missingFields } from '../cloud/config.js';
import { getStore } from '../cloud/store.js';
import { publishOne, readCatalog, packIdOf, deletePack } from '../cloud/publish.js';
import { listDownloads, enqueue, retryDownload, removeDownload, cancelDownload, clearHistory } from '../cloud/download.js';
import { WE_TAG_SET, joinSubTags } from '../we-tags.js';

const router = Router();
const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

// 本机发布过的包 → 本地壁纸 id。
// 只存本地：老条目的 packId 是 wf-<行id>，和下载目录名对不上，
// 光靠 dir_name 判断会把自己刚传上去的东西显示成「未下载」，诱导用户下第二份。
// 不写进 index.json，避免把本地 id 暴露给别的机器（换台机器 id 对不上就会误判）。
const PUBLISHED_FILE = path.join(DATA_DIR, 'cloud-published.json');

function readPublished() {
  try {
    const j = JSON.parse(fs.readFileSync(PUBLISHED_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function recordPublished(packId, rowId) {
  try {
    const m = readPublished();
    m[String(packId)] = Number(rowId);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PUBLISHED_FILE, JSON.stringify(m, null, 2), 'utf8');
  } catch { /* 记不上不影响发布本身 */ }
}

const LABELS = {
  accountId: 'Account ID',
  bucket: '桶名称',
  accessKeyId: 'Access Key ID',
  secretAccessKey: 'Secret Access Key',
  publicBase: '公开访问地址',
  localDir: '本地桶目录',
};
const describeMissing = (cfg) =>
  '云端配置缺：' + missingFields(cfg).map((k) => LABELS[k] || k).join('、');

const jobs = new Map();
let jobSeq = 0;

// 表单里的信息要同时落到本地库：打包时的 project.json 读的是库里的主标签，
// 只改云端不改本地，会出现「云端显示动漫、下载下来是游戏」的错位。
function applyMeta(rowId, meta) {
  const sets = [];
  const vals = [];
  if (typeof meta.title === 'string' && meta.title.trim()) {
    sets.push('title=?'); vals.push(meta.title.trim().slice(0, 200));
  }
  if (typeof meta.description === 'string') {
    sets.push('description=?'); vals.push(meta.description.slice(0, 2000));
  }
  if (typeof meta.author === 'string') {
    sets.push('author=?'); vals.push(meta.author.trim().slice(0, 100));
  }
  if (typeof meta.primaryTag === 'string') {
    const tag = meta.primaryTag.trim();
    if (tag && !WE_TAG_SET.has(tag)) throw new Error(`主标签「${tag}」不是壁纸引擎支持的标签`);
    // 这一列是 NOT NULL DEFAULT ''，清空要写空串而不是 null
    sets.push('primary_tag=?'); vals.push(tag || '');
  }
  if (Array.isArray(meta.subTags)) {
    sets.push('tags=?'); vals.push(joinSubTags(meta.subTags));
  }
  if (!sets.length) return db.prepare('SELECT * FROM wallpapers WHERE id=?').get(rowId);
  sets.push("updated_at=datetime('now')");
  db.prepare(`UPDATE wallpapers SET ${sets.join(',')} WHERE id=?`).run(...vals, rowId);
  return db.prepare('SELECT * FROM wallpapers WHERE id=?').get(rowId);
}

router.get('/status', (req, res) => {
  success(res, publicStatus());
});

// 连通性自检：写一个探针对象、读回来、再删掉。
// 分三步报错，能直接看出是密钥错（401）、桶名错（404/403）还是只有读权限（PUT 失败）。
// 允许请求体覆盖字段（设置页可以「先测再存」）；密钥留空表示沿用已保存的那个。
const VERIFY_FIELDS = ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey', 'publicBase', 'localDir'];
router.post('/verify', async (req, res) => {
  const cfg = { ...readCloudConfig() };
  if (req.body?.mode === 'r2' || req.body?.mode === 'local') cfg.mode = req.body.mode;
  for (const k of VERIFY_FIELDS) {
    const v = req.body?.[k];
    if (typeof v === 'string' && v.trim()) cfg[k] = v.trim();
  }
  if (!isConfigured(cfg)) return fail(res, 400, describeMissing(cfg));
  const store = getStore(cfg);
  const key = `_probe/${Date.now()}.txt`;
  const body = Buffer.from('wallflow probe ' + new Date().toISOString(), 'utf8');
  const steps = [];
  try {
    await store.put(key, body, 'text/plain', body.length);
    steps.push('put');
    const back = await store.get(key);
    steps.push('get');
    if (!back || !back.equals(body)) throw new Error('读回的内容和写入不一致');
    await store.del(key);
    steps.push('del');
    const url = cfg.mode === 'r2' ? publicStatus(cfg).publicBase : '';
    success(res, { mode: cfg.mode, steps, bucket: cfg.bucket, publicBase: url });
  } catch (e) {
    // 已经写进去但后面失败，尽量把探针清掉，别在桶里留垃圾
    if (steps.includes('put') && !steps.includes('del')) await store.del(key).catch(() => {});
    const hint = /HTTP 401|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(e.message)
      ? '（密钥不对：Access Key ID / Secret Access Key 填错了，或者 token 已删除）'
      : /HTTP 404|NoSuchBucket/i.test(e.message)
        ? '（桶名不对，或者 token 没有这个桶的权限）'
        : /HTTP 403|AccessDenied/i.test(e.message)
          ? '（token 权限不足：需要 Object Read & Write）'
          : '';
    fail(res, 502, `连接失败于 ${steps.length ? steps[steps.length - 1] : 'put'} 这一步：${e.message}${hint}`);
  }
});

router.get('/catalog', async (req, res) => {
  const cfg = readCloudConfig();
  if (!isConfigured(cfg)) return fail(res, 400, describeMissing(cfg));
  try {
    success(res, { packs: await readCatalog(cfg), published: readPublished() });
  } catch (e) {
    fail(res, 502, '读取云端目录失败：' + e.message);
  }
});

// 连续删除的写竞争：deletePack 是「读清单→改→写回」，两个并发 DELETE 会互相覆盖
// （后写赢，先删的那个被悄悄恢复）。单进程桌面应用，进程内 promise 队列串行化即可。
let deleteQueue = Promise.resolve();
// 从云端删除一个包。破坏性操作，前端必须先确认再调。
// id 会被拼进对象 key，所以只放行安全字符：挡住 ../ 之类把删除范围扩到别的前缀。
router.delete('/packs/:id', async (req, res) => {
  const cfg = readCloudConfig();
  if (!isConfigured(cfg)) return fail(res, 400, describeMissing(cfg));
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 120 || !/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) {
    return fail(res, 400, '包 id 不合法');
  }
  try {
    // 排队执行：本请求等到前面所有删除（含上传完成后的清单写回）做完才开始
    const r = await (deleteQueue = deleteQueue.then(() => deletePack(id, cfg)));
    thumbCatalog.promise = null;             // 目录变了，封面代理的短缓存立刻失效
    // 本地缓存的封面一起删：桶里已经没有了，留着只会变成没人认领的垃圾
    try {
      const dir = path.join(getCacheDir(), 'cloud-thumbs');
      for (const ext of ['.gif', '.jpg', '.jpeg', '.png', '.webp', '.avif']) {
        fs.rmSync(path.join(dir, id + ext), { force: true });
      }
      fs.rmSync(path.join(dir, id + '.json'), { force: true });
    } catch { /* 缓存清不掉不影响云端那步的结果 */ }
    success(res, { id, removed: r.removed, title: r.entry ? r.entry.title : '' });
  } catch (e) {
    fail(res, 502, '删除失败：' + e.message);
  }
});

// ---------- 封面代理 ----------
// 浏览器直连公开域名（pub-xxx.r2.dev）实测会被掐：ERR_CONNECTION_CLOSED，
// 连得上也常传一半就断。后端走的是 S3 端点（另一个域名），稳定得多。
// 所以封面一律由后端代取，取到就在本地缓存目录里留一份 —— 断网也能看。
const THUMB_MIME = {
  '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
};

// 一次页面加载会并发要好几张封面，别让它们各自去读一遍 index.json
let thumbCatalog = { at: 0, promise: null };
function catalogForThumb(cfg) {
  if (thumbCatalog.promise && Date.now() - thumbCatalog.at < 5000) return thumbCatalog.promise;
  thumbCatalog.at = Date.now();
  thumbCatalog.promise = readCatalog(cfg).catch((e) => { thumbCatalog.promise = null; throw e; });
  return thumbCatalog.promise;
}

router.get('/thumb/:id', async (req, res) => {
  const cfg = readCloudConfig();
  if (!isConfigured(cfg)) return fail(res, 400, describeMissing(cfg));
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 120 || !/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) {
    return fail(res, 400, '包 id 不合法');
  }
  let entry;
  try {
    entry = (await catalogForThumb(cfg)).find((p) => p.id === id);
  } catch (e) {
    return fail(res, 502, '读取云端目录失败：' + e.message);
  }
  if (!entry || !entry.thumb) return fail(res, 404, '这条没有封面');

  const ext = path.extname(entry.thumb).toLowerCase();
  const dir = path.join(getCacheDir(), 'cloud-thumbs');
  const file = path.join(dir, id + ext);
  const metaFile = path.join(dir, id + '.json');

  // 云端换过封面（updatedAt 变了）就重新取；否则一直用本地那份，不再走网络
  let fresh = false;
  if (fs.existsSync(file)) {
    try { fresh = JSON.parse(fs.readFileSync(metaFile, 'utf8')).updatedAt === entry.updatedAt; }
    catch { fresh = false; }
  }
  if (!fresh) {
    try {
      const buf = await getStore(cfg).get(entry.thumb);
      if (!buf) return fail(res, 404, '云端没有这张封面');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, buf);
      fs.writeFileSync(metaFile, JSON.stringify({ updatedAt: entry.updatedAt, size: buf.length }));
    } catch (e) {
      // 取不到但本地有旧的就先用旧的：图旧一点，好过发现页开天窗
      if (!fs.existsSync(file)) return fail(res, 502, '封面下载失败：' + e.message);
    }
  }
  res.setHeader('Content-Type', THUMB_MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=600');
  fs.createReadStream(file).on('error', () => { try { res.end(); } catch { /* 已断开 */ } }).pipe(res);
});

// ---------- 下载队列 ----------
router.get('/downloads', (req, res) => success(res, listDownloads()));

router.post('/install', async (req, res) => {
  const cfg = readCloudConfig();
  if (!isConfigured(cfg)) return fail(res, 400, describeMissing(cfg));
  const ids = Array.isArray(req.body?.packIds)
    ? req.body.packIds.map(String).filter(Boolean)
    : [req.body?.packId].map(String).filter(Boolean);
  if (!ids.length) return fail(res, 400, '没有指定要下载的包');

  let packs;
  try {
    packs = await readCatalog(cfg);
  } catch (e) {
    return fail(res, 502, '读取云端目录失败：' + e.message);
  }
  const queued = [];
  const missing = [];
  for (const pid of ids) {
    const entry = packs.find((p) => p.id === pid);
    if (!entry) { missing.push(pid); continue; }
    const r = enqueue(pid, entry);
    queued.push({ packId: pid, taskId: r.task.id, duplicated: r.duplicated });
  }
  if (!queued.length) return fail(res, 404, '云端没有这些包：' + missing.join('、'));
  success(res, { queued, missing });
});

// 取消进行中的任务：协作式取消，已下载的 .part 保留（重试可续传）
router.post('/downloads/:id/cancel', (req, res) => {
  const t = cancelDownload(req.params.id);
  if (!t) return fail(res, 404, '任务不存在');
  success(res, t);
});

// 清空历史记录（done/cancelled/failed 全清，不动已入库的壁纸文件）
router.post('/downloads/clear-history', (req, res) => {
  if (req.body?.confirm !== true) return fail(res, 400, '清空历史需要显式确认');
  const n = clearHistory();
  success(res, { cleared: n });
});

router.post('/downloads/:id/retry', (req, res) => {
  const t = retryDownload(req.params.id);
  if (!t) return fail(res, 404, '任务不存在');
  success(res, t);
});

// 只删记录，不动已经入库的壁纸文件
router.delete('/downloads/:id', (req, res) => {
  if (!removeDownload(req.params.id)) return fail(res, 400, '任务不存在，或还在进行中');
  success(res, { removed: req.params.id });
});

router.post('/publish', (req, res) => {
  const cfg = readCloudConfig();
  if (!isConfigured(cfg)) return fail(res, 400, describeMissing(cfg));
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (!ids.length) return fail(res, 400, '没有选中要上传的壁纸');

  // 单条上传才吃表单信息；批量按各自的默认信息走
  const meta = ids.length === 1 && req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : null;

  const job = { id: 'j' + (++jobSeq), total: ids.length, done: 0, status: 'running', phase: 'packing', current: '', results: [], error: '' };
  jobs.set(job.id, job);

  (async () => {
    for (const wid of ids) {
      try {
        let row = db.prepare('SELECT * FROM wallpapers WHERE id=?').get(wid);
        if (!row) throw new Error('壁纸不存在');
        job.current = row.title;
        if (meta) row = applyMeta(wid, meta);
        job.phase = 'packing';
        const entry = await publishOne(row, meta || {}, cfg);
        job.phase = 'uploading';
        recordPublished(entry.id, wid);
        job.results.push({ id: wid, ok: true, packId: entry.id, title: entry.title });
      } catch (e) {
        job.results.push({ id: wid, ok: false, message: e.message || String(e) });
      }
      job.done++;
    }
    job.current = '';
    job.status = job.results.every((r) => r.ok) ? 'done' : 'partial';
    thumbCatalog.promise = null;           // 目录里多了新包，封面代理的短缓存要立刻失效
    // 结果留在内存里够前端取；超过 20 个任务清掉最老的，别无限涨
    if (jobs.size > 20) jobs.delete([...jobs.keys()][0]);
  })();

  success(res, { jobId: job.id, total: job.total });
});

router.get('/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return fail(res, 404, '任务不存在或已过期');
  success(res, job);
});

// 云端那一条的信息（目前用于诊断 packId 会不会撞）
router.get('/pack-id/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id=?').get(Number(req.params.id));
  if (!row) return fail(res, 404, '壁纸不存在');
  success(res, { packId: packIdOf(row) });
});

export default router;
