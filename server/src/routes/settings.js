import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import db, {
  getLibraryDir, setLibraryDir, getCacheDir, setCacheDir, getDefaultCacheDir,
  DEFAULT_LIBRARY_DIR, DATA_ROOT,
} from '../db.js';
import { copyDirRecursive } from '../we-format.js';
import { resolveWallpaperDir } from '../library-path.js';
import { readCloudConfig, writeCloudConfig, publicStatus, CLOUD_CONFIG_FILE } from '../cloud/config.js';

const router = Router();
const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

function dirStats(root) {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { files += 1; try { bytes += fs.statSync(p).size; } catch { /* 忽略 */ } }
    }
  }
  return { files, bytes };
}

router.get('/', (req, res) => {
  const libDir = getLibraryDir();
  const stats = dirStats(libDir);
  // .cache 也算在库目录里，但单独报一下，否则用户会觉得"文件对不上"
  const cacheDir = getCacheDir();
  const cache = dirStats(cacheDir);
  const count = db.prepare('SELECT COUNT(*) AS n FROM wallpapers').get().n;
  const defaultCacheDir = getDefaultCacheDir();
  success(res, {
    libraryDir: libDir,
    defaultLibraryDir: DEFAULT_LIBRARY_DIR,
    dataRoot: DATA_ROOT,
    isCustom: path.resolve(libDir) !== path.resolve(DEFAULT_LIBRARY_DIR),
    wallpaperCount: count,
    files: stats.files,
    bytes: stats.bytes,
    cacheDir,
    defaultCacheDir,
    cacheIsCustom: path.resolve(cacheDir) !== path.resolve(defaultCacheDir),
    cacheBytes: cache.bytes,
    cacheFiles: cache.files,
  });
});

// 通用目录校验：绝对路径、不是盘根、不落在壁纸库的类型目录里
function checkDir(raw, label) {
  if (!path.isAbsolute(raw)) return `${label}请填写绝对路径（例如 D:\\WallFlow\\cache）`;
  const target = path.resolve(raw);
  if (path.dirname(target) === target) return `不能把${label}设为盘符根目录`;
  return '';
}

// 改壁纸库位置。mode=move 时把已有文件一起搬过去（推荐），mode=switch 只切换指针。
router.post('/library', (req, res) => {
  const raw = String(req.body?.dir || '').trim();
  const mode = req.body?.mode === 'move' ? 'move' : 'switch';
  if (!raw) return fail(res, 400, '请提供目录路径');
  if (!path.isAbsolute(raw)) return fail(res, 400, '请填写绝对路径（例如 D:\\WallFlowLibrary）');

  const target = path.resolve(raw);
  const current = path.resolve(getLibraryDir());
  if (target === current) return success(res, { libraryDir: current, moved: false, unchanged: true });

  // 目标不能在当前库内部（会边搬边套娃），也不能是盘根目录
  if (target.startsWith(current + path.sep)) return fail(res, 400, '新目录不能放在当前壁纸库内部');
  if (path.dirname(target) === target) return fail(res, 400, '不能把壁纸库设为盘符根目录');

  try {
    fs.mkdirSync(target, { recursive: true });
    for (const t of ['场景', '视频', '网页']) fs.mkdirSync(path.join(target, t), { recursive: true });
  } catch (e) {
    return fail(res, 400, '目录不可用：' + (e?.message || e));
  }

  let moved = false;
  let leftover = '';
  if (mode === 'move') {
    // 只搬三个壁纸目录。.cache 是可以随时重建的缩略图/动图缓存，跟着搬只会拖慢迁移。
    //
    // 校验必须「逐目录、比文件数 + 字节数」：
    // 以前是把整个旧库的文件数（含 .cache）和目标文件数加缓存一起比，
    // 只要缓存够多，少搬几百个壁纸文件也能凑够数通过 —— 旧库随后被删，那部分就永久没了。
    const types = ['场景', '视频', '网页'];
    const src = {};
    for (const t of types) {
      const from = path.join(current, t);
      if (fs.existsSync(from)) src[t] = dirStats(from);
    }
    try {
      for (const t of types) {
        const from = path.join(current, t);
        if (fs.existsSync(from)) copyDirRecursive(from, path.join(target, t));
      }
      const short = [];
      for (const t of types) {
        if (!src[t]) continue;
        const got = dirStats(path.join(target, t));
        if (got.files < src[t].files || got.bytes < src[t].bytes) {
          short.push(`${t}（源 ${src[t].files} 文件 / ${src[t].bytes} 字节，副本 ${got.files} / ${got.bytes}）`);
        }
      }
      if (short.length) {
        return fail(res, 500, '迁移不完整，已保留原目录：' + short.join('；'));
      }
    } catch (e) {
      return fail(res, 500, '迁移失败，已保留原目录：' + (e?.message || e));
    }
    moved = true;

    // 第二道保险：按每条壁纸自己的目录重新解析一遍。
    // 逐目录比文件数只保证「三个类型目录搬全了」，但某条壁纸算出来的目录可能不在这三个里
    // （老写法的子目录名、手工放进来的目录）。迁移前在旧库找得到的，迁移后必须也找得到，
    // 否则就是把它丢了 —— 宁可迁失败、保留旧库，也不能删了源再报"迁移成功"。
    const rows = db.prepare('SELECT * FROM wallpapers').all();
    const hadBefore = new Set();
    for (const r of rows) {
      try { if (fs.existsSync(resolveWallpaperDir(r))) hadBefore.add(r.id); } catch { /* 解析不了就跳过 */ }
    }
    setLibraryDir(target);
    const lost = [];
    for (const r of rows) {
      if (!hadBefore.has(r.id)) continue;
      let ok = false;
      try { ok = fs.existsSync(resolveWallpaperDir(r)); } catch { ok = false; }
      if (!ok) lost.push(`#${r.id} ${r.title}`);
    }
    if (lost.length) {
      setLibraryDir(current);
      return fail(res, 500, `迁移不完整，已保留原目录（这些壁纸在新位置找不到：${lost.slice(0, 3).join('、')}${lost.length > 3 ? ` 等 ${lost.length} 个` : ''}）`);
    }
    // 只有搬的是默认目录（在数据目录里）才自动清掉旧的，避免误删用户自己指定的盘
    if (current === path.resolve(DEFAULT_LIBRARY_DIR)) {
      try { fs.rmSync(current, { recursive: true, force: true }); } catch { leftover = current; }
    } else {
      leftover = current;
    }
  }

  setLibraryDir(target);
  success(res, { libraryDir: getLibraryDir(), moved, leftover });
});

// 改缓存目录：缩略图动图 + 云端下载的半成品都落在这里。
// 缓存是可以随时重建的派生文件，所以只切指针、不搬旧文件；旧目录不再被写入，用户想省空间可以自己删。
router.post('/cache', (req, res) => {
  const raw = String(req.body?.dir || '').trim();
  if (!raw) {
    // 空值 = 恢复成「跟随壁纸库」
    const dir = setCacheDir('');
    return success(res, { cacheDir: dir, isCustom: false, restored: true });
  }
  const err = checkDir(raw, '缓存目录');
  if (err) return fail(res, 400, err);

  const target = path.resolve(raw);
  const lib = path.resolve(getLibraryDir());
  if (target === lib) return fail(res, 400, '缓存目录不能直接设为壁纸库根目录');
  // 放进类型目录会被当成壁纸内容扫进库里
  for (const t of ['场景', '视频', '网页']) {
    const td = path.join(lib, t);
    if (target === td || target.startsWith(td + path.sep)) {
      return fail(res, 400, `缓存目录不能放在壁纸库的「${t}」目录里`);
    }
  }

  const previous = getCacheDir();
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
  } catch (e) {
    return fail(res, 400, '目录不可写：' + (e?.message || e));
  }

  const dir = setCacheDir(target);
  success(res, { cacheDir: dir, isCustom: true, previous });
});

// ================= 云端存储配置 =================
// 前端拿不到 secretAccessKey，只拿到「填过没有」。保存时该字段留空表示沿用旧值。
function cloudView() {
  const cfg = readCloudConfig();
  const base = String(cfg.publicBase || '').replace(/\/+$/, '');
  return {
    ...publicStatus(cfg),
    accessKeyId: cfg.accessKeyId,
    hasSecret: Boolean(cfg.secretAccessKey),
    localDir: cfg.localDir,
    configFile: CLOUD_CONFIG_FILE,
    sampleUrl: base ? `${base}/index.json` : '',
  };
}

router.get('/cloud', (req, res) => success(res, cloudView()));

router.post('/cloud', (req, res) => {
  const body = req.body || {};
  const cur = readCloudConfig();
  const mode = body.mode === 'r2' || body.mode === 'local' ? body.mode : cur.mode;
  const next = { ...cur, mode };
  for (const k of ['accountId', 'bucket', 'accessKeyId', 'publicBase', 'localDir']) {
    if (typeof body[k] === 'string') next[k] = body[k].trim();
  }
  // 密钥只写不读：留空 = 沿用已保存的；显式 clearSecret 才会清掉
  const secret = typeof body.secretAccessKey === 'string' ? body.secretAccessKey.trim() : '';
  if (secret) next.secretAccessKey = secret;
  if (body.clearSecret === true) next.secretAccessKey = '';

  const problems = [];
  if (mode === 'r2') {
    if (!/^[0-9a-f]{32}$/i.test(next.accountId)) problems.push('Account ID 应为 32 位十六进制，不是邮箱或账号名');
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(next.bucket)) problems.push('桶名只能用小写字母、数字和连字符，3–63 位');
    if (!next.accessKeyId) problems.push('Access Key ID 不能为空');
    if (!next.secretAccessKey) problems.push('Secret Access Key 还没填过（存过一次之后留空即可沿用）');
    if (!/^https?:\/\//i.test(next.publicBase)) problems.push('公开访问地址要以 http:// 或 https:// 开头');
  } else {
    const err = checkDir(next.localDir, '本地桶目录');
    if (err) problems.push(err);
  }
  if (problems.length) return fail(res, 400, problems.join('；'));

  next.publicBase = String(next.publicBase || '').replace(/\/+$/, '');
  try {
    writeCloudConfig(next);
  } catch (e) {
    return fail(res, 500, '配置写入失败：' + (e?.message || e));
  }
  success(res, cloudView());
});

export default router;
