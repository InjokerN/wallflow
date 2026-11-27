import { Router } from 'express';
import multer from 'multer';
import AdmZip from 'adm-zip';
import yazl from 'yazl';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import db, { getLibraryDir, EXPORTS_DIR } from '../db.js';
import { resolveWallpaperDir, TYPE_DIR as LIB_TYPE_DIR } from '../library-path.js';
import { projectJsonTags } from '../we-tags.js';
import {
  TYPE_DIR, findProjectJson, parseProjectJson, buildProjectJson,
  pickMainFile, pickPreview, copyDirRecursive, JUNK_NAMES, isJunkPath,
} from '../we-format.js';
import { isInside, registerWallpaper, installWallDir } from '../we-install.js';
import { workshopFolder } from '../naming.js';

const router = Router();
const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

// 认不出时要说清楚「为什么」和「那该怎么办」，只丢一句报错用户只能反复试
const NO_PROJECT_HINT = '这个包里找不到 project.json，认不出是哪种壁纸。'
  + 'Wallpaper Engine 的壁纸一定带 project.json；如果只是想导入一张图片或一个视频，请用「导入文件」。';
function noMainHint(type) {
  return type === 'video' ? '找不到视频主文件（需要 .mp4 或 .webm）'
    : type === 'web' ? '找不到网页主文件（需要 .html）'
      : '找不到场景主文件（需要 .pkg）';
}
// multer 的报错是英文常量，直接抛给用户等于没说
function uploadErrText(err) {
  const code = err?.code || '';
  if (code === 'LIMIT_FILE_COUNT') return '文件数量超出上限，请改用 ZIP 导入';
  if (code === 'LIMIT_FILE_SIZE') return '单个文件超过 2GB，无法导入';
  if (code === 'LIMIT_UNEXPECTED_FILE') return '文件数量超出上限，请改用 ZIP 导入';
  return err?.message || '上传失败';
}
// 解压/选择文件夹时顺手带进来的系统垃圾，进库前清掉
function dropJunk(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (JUNK_NAMES.has(e.name)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* 忽略 */ } }
    else if (e.isDirectory()) dropJunk(p);
  }
}

// ---------- ZIP 导入 ----------
const zipUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      const dir = path.join(os.tmpdir(), 'wallflow-import');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(req, file, cb) {
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}.zip`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() !== '.zip') return cb(new Error('只支持 .zip 文件'));
    cb(null, true);
  },
});

router.post('/import/zip', (req, res) => {
  zipUpload.single('file')(req, res, (err) => {
    if (err) return fail(res, 400, uploadErrText(err));
    if (!req.file) return fail(res, 400, '没有收到 ZIP 文件');
    const tmpRoot = path.join(os.tmpdir(), `wallflow-unzip-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    try {
      const zip = new AdmZip(req.file.path);
      // 逐条解压并校验路径，防止 zip slip
      for (const entry of zip.getEntries()) {
        const dest = path.join(tmpRoot, entry.entryName);
        if (!isInside(tmpRoot, dest)) throw new Error('ZIP 含非法路径，已拒绝：' + entry.entryName);
      }
      zip.extractAllTo(tmpRoot, true);
      dropJunk(tmpRoot);

      const found = findProjectJson(tmpRoot);
      if (!found) throw new Error(NO_PROJECT_HINT);
      const meta = parseProjectJson(found.file);
      const mainFile = pickMainFile(found.wallDir, meta.file, meta.type);
      const preview = pickPreview(found.wallDir, meta.preview);
      if (!mainFile) throw new Error(noMainHint(meta.type));

      // wanted 现在只是个提示，不再当目录名：目录统一由 naming.js 生成
      // <类型>-ms-<10位>，所以扁平包、同名包都不会互相覆盖或堆重复目录。
      const zipName = path.basename(req.file.originalname || '', path.extname(req.file.originalname || ''));
      const rootIsWall = path.resolve(found.wallDir) === path.resolve(tmpRoot);
      const wanted = rootIsWall ? (zipName || `imported-${Date.now()}`) : path.basename(found.wallDir);
      // 带 workshopid 的 WE 整包用官方序列号当目录名（S/V/W-we-<id>），同一包重复导入会判重；
      // 没有 id 就传空 opts，走 naming.js 的随机 ms 命名，行为不变。
      const installOpts = meta.workshopId
        ? { folderName: workshopFolder(meta.type, meta.workshopId) }
        : {};

      const result = installWallDir(found.wallDir, meta, mainFile, preview, wanted, installOpts);
      success(res, { ...result, title: meta.title, type: meta.type });
    } catch (e) {
      fail(res, 400, '导入失败：' + e.message);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
      try { fs.unlinkSync(req.file.path); } catch { /* 忽略清理失败 */ }
    }
  });
});

// ---------- 文件夹导入（浏览器选文件夹，多文件带相对路径） ----------
// 以前用 memoryStorage：整个文件夹先在内存里堆一份，几百 MB 的壁纸直接把进程顶到 OOM。
// 现在边收边落盘到临时目录，再按 relativePaths 摆好结构，内存占用与体积无关。
const folderUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      if (!req._tmpRoot) {
        req._tmpRoot = path.join(os.tmpdir(), `wallflow-folder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
        fs.mkdirSync(req._tmpRoot, { recursive: true });
      }
      cb(null, req._tmpRoot);
    },
    filename(req, file, cb) {
      req._seq = (req._seq || 0) + 1;
      cb(null, `f${String(req._seq).padStart(5, '0')}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 5000 },
});

router.post('/import/folder', (req, res) => {
  folderUpload.array('files', 5000)(req, res, (err) => {
    if (err) {
      const tmp = req._tmpRoot;
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ } }
      return fail(res, 400, uploadErrText(err));
    }
    const files = req.files || [];
    if (!files.length) return fail(res, 400, '没有收到文件');
    // 浏览器提交的 relativePath 字段给出每个文件在文件夹内的相对路径
    let relPaths;
    try { relPaths = JSON.parse(req.body.relativePaths || '[]'); }
    catch { return fail(res, 400, 'relativePaths 格式错误'); }
    if (relPaths.length !== files.length) return fail(res, 400, '文件与路径数量不匹配');

    const tmpRoot = req._tmpRoot || files[0].destination;
    try {
      for (let i = 0; i < files.length; i++) {
        const rel = relPaths[i];
        if (typeof rel !== 'string' || rel.includes('..') || path.isAbsolute(rel)) {
          throw new Error('非法文件路径：' + rel);
        }
        if (isJunkPath(rel)) { try { fs.unlinkSync(files[i].path); } catch { /* 忽略 */ } continue; }
        const dest = path.join(tmpRoot, rel);
        if (!isInside(tmpRoot, dest)) throw new Error('路径越界：' + rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(files[i].path, dest);
      }
      dropJunk(tmpRoot);

      const found = findProjectJson(tmpRoot);
      if (!found) throw new Error(NO_PROJECT_HINT);
      const meta = parseProjectJson(found.file);
      const mainFile = pickMainFile(found.wallDir, meta.file, meta.type);
      const preview = pickPreview(found.wallDir, meta.preview);
      if (!mainFile) throw new Error(noMainHint(meta.type));

      const rootIsWall = path.resolve(found.wallDir) === path.resolve(tmpRoot);
      const wanted = rootIsWall
        ? (req.body.folderName || `imported-${Date.now()}`)
        : path.basename(found.wallDir);
      // 同 ZIP 路径：有 workshopid 就用官方序列号命名，没有就照旧随机 ms。
      const installOpts = meta.workshopId
        ? { folderName: workshopFolder(meta.type, meta.workshopId) }
        : {};

      const result = installWallDir(found.wallDir, meta, mainFile, preview, wanted, installOpts);
      success(res, { ...result, title: meta.title, type: meta.type });
    } catch (e) {
      fail(res, 400, '导入失败：' + e.message);
    } finally {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
    }
  });
});

// 取壁纸文件夹的绝对路径（供导出共用）
// 一条壁纸的真实文件夹。dir_name 有两种历史写法（类型目录名 / 子目录名），
// 统一由 library-path 解，别再各处自己拼。
function wallpaperFolder(row) {
  return resolveWallpaperDir(row);
}

// 老条目（examples）直接躺在类型目录根下，自己没有独立文件夹。
// 导出这种条目时只能带走它自己的几个文件，否则会把整个类型目录里别人的壁纸一起打包。
function ownsTypeRoot(row, dir) {
  const typeDir = path.resolve(getLibraryDir(), LIB_TYPE_DIR[row.type] || '');
  return path.resolve(dir) === typeDir;
}

// 导出目录守卫：绝对路径、真实存在、不在壁纸库内部、不是盘根或系统目录
function safeTargetDir(input) {
  const raw = String(input || '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error('需要绝对路径');
  const abs = path.resolve(raw);
  const lib = path.resolve(getLibraryDir());
  if (abs === lib || abs.startsWith(lib + path.sep)) throw new Error('不能导出到壁纸库内部');
  if (abs === path.parse(abs).root) throw new Error('不能导出到磁盘根目录');
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('目标文件夹不存在'); }
  if (!st.isDirectory()) throw new Error('目标不是文件夹');
  const blocked = [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'], process.env.ProgramData]
    .filter(Boolean).map((p) => path.resolve(p));
  if (blocked.some((b) => abs === b || abs.startsWith(b + path.sep))) {
    throw new Error('不能导出到系统目录');
  }
  return abs;
}

// 同名就加序号，绝不覆盖用户已有的文件夹
function uniqueDir(parent, base) {
  const clean = String(base || 'wallpaper').replace(/[\\/:*?"<>|]/g, '_').trim() || 'wallpaper';
  let dest = path.join(parent, clean);
  if (!fs.existsSync(dest)) return dest;
  for (let i = 2; i < 1000; i += 1) {
    const alt = path.join(parent, `${clean}-${i}`);
    if (!fs.existsSync(alt)) return alt;
  }
  throw new Error('同名文件夹太多，换个位置导出');
}

// project.json 的 tags 只写主标签：副标签是本地私有的，WE 不认。
// 已有文件就只替换 tags，保留作者写的其他字段；解析不了才整体重建。
function projectJsonFor(row) {
  return {
    title: row.title,
    type: row.type,
    file: row.main_file ? path.basename(row.main_file) : '',
    preview: row.cover ? path.basename(row.cover) : '',
    description: row.description,
    author: row.author || '',
    tags: projectJsonTags(row.primary_tag),
  };
}

function mergeTagsIntoProjectJson(text, row) {
  try {
    const json = JSON.parse(text);
    json.tags = projectJsonTags(row.primary_tag);
    // 标题和描述也跟库里的记录对齐：只在库里改过标题、包内文件没改，
    // 会出现「云端显示 A、下载下来叫 B」的错位。
    if (row.title) json.title = row.title;
    if (row.description) json.description = row.description;
    // 作者跟库里对齐：导出包里带着用户改过的名字，再导入能读回（WE 忽略这个键）。
    // 空作者删行，跟「清除作者」语义一致。
    if (row.author) json.author = row.author;
    else delete json.author;
    return JSON.stringify(json, null, '\t');
  } catch {
    return JSON.stringify(buildProjectJson(projectJsonFor(row)), null, '\t');
  }
}

function writeProjectJson(dir, row) {
  const pj = path.join(dir, 'project.json');
  const old = fs.existsSync(pj) ? fs.readFileSync(pj, 'utf8') : '';
  fs.writeFileSync(pj, mergeTagsIntoProjectJson(old, row), 'utf8');
}

// 递归往 zip 里加文件；project.json 走内存改写，不动源目录里的那份
function walkAdd(zip, dir, zipPath, row) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    const rel = `${zipPath}/${entry.name}`;
    if (entry.isDirectory()) {
      walkAdd(zip, abs, rel, row);
    } else if (entry.name.toLowerCase() === 'project.json') {
      try {
        const text = fs.readFileSync(abs, 'utf8');
        zip.addBuffer(Buffer.from(mergeTagsIntoProjectJson(text, row), 'utf8'), rel);
      } catch {
        zip.addFile(abs, rel);
      }
    } else {
      zip.addFile(abs, rel);
    }
  }
}

// 顶层文件夹名：普通条目用自己的目录名（we-<id>，WE 里能看出是哪个包），
// 老条目没有独立目录，就用标题，否则包里会顶着「场景」这种名字。
function safeRootName(row, fallback) {
  const clean = String(row.title || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 40);
  return clean || fallback || 'wallpaper';
}

// 把一条壁纸登记进 zip（老条目只带自己的文件，普通条目整目录）
function addRowToZip(zip, row) {
  const src = wallpaperFolder(row);
  const legacy = ownsTypeRoot(row, src);
  const rootName = legacy
    ? safeRootName(row, LIB_TYPE_DIR[row.type] || 'wallpaper')
    : (path.basename(src) || 'wallpaper').replace(/[\\/:*?"<>|]/g, '_');
  if (legacy) {
    for (const rel of [row.main_file, row.cover]) {
      if (!rel) continue;
      const abs = path.join(src, path.basename(rel));
      if (fs.existsSync(abs)) zip.addFile(abs, `${rootName}/${path.basename(rel)}`);
    }
    const pj = path.join(src, 'project.json');
    const old = fs.existsSync(pj) ? fs.readFileSync(pj, 'utf8') : '';
    zip.addBuffer(Buffer.from(mergeTagsIntoProjectJson(old, row), 'utf8'), `${rootName}/project.json`);
    return rootName;
  }
  const hasProjectJson = fs.existsSync(path.join(src, 'project.json'));
  walkAdd(zip, src, rootName, row);
  // 转视频（bake）这类条目源目录里本来就没有 project.json，WE 认不出包。
  // 导出 / 上传云端时补一份，和「导出文件夹」的行为对齐。
  if (!hasProjectJson) {
    zip.addBuffer(
      Buffer.from(mergeTagsIntoProjectJson('', row), 'utf8'),
      `${rootName}/project.json`,
    );
  }
  return rootName;
}

// ---------- ZIP 导出（流式，支持指定落点） ----------
// 不带 dest：直接流回浏览器；带 dest：写到用户选的路径，并回报实际落点。
// 用 yazl 边读边写，不再像 adm-zip 那样把整个包读进内存（几百 MB 的包会直接 OOM）。
router.post('/export/zip', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?')
    .get(req.body?.id ?? req.query.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const src = wallpaperFolder(row);
  if (!fs.existsSync(src)) return fail(res, 404, '壁纸文件夹不存在');

  let dest = '';
  try {
    if (req.body?.dest) {
      const raw = String(req.body.dest).trim();
      if (!path.isAbsolute(raw)) throw new Error('导出路径必须是绝对路径');
      const dir = safeTargetDir(path.dirname(raw));
      dest = path.join(dir, path.basename(raw));
      if (!/\.zip$/i.test(dest)) dest += '.zip';
    }
  } catch (e) {
    return fail(res, 400, e.message);
  }

  const zip = new yazl.ZipFile();
  let rootName = '';
  try {
    rootName = addRowToZip(zip, row);
    zip.end();
  } catch (e) {
    return fail(res, 500, '导出失败：' + e.message);
  }

  if (dest) {
    const ws = fs.createWriteStream(dest);
    zip.outputStream.on('error', (e) => { try { ws.destroy(); } catch { /* 忽略 */ } fail(res, 500, '打包失败：' + e.message); });
    ws.on('error', (e) => fail(res, 500, '写入失败：' + e.message));
    ws.on('close', () => success(res, { path: dest, folder: rootName, bytes: ws.bytesWritten }));
    zip.outputStream.pipe(ws);
    return;
  }

  const safeName = String(row.title || rootName).slice(0, 60)
    .replace(/[^\w\u4e00-\u9fa5-]/g, '_') || rootName;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}.zip`);
  zip.outputStream.on('error', () => { try { res.destroy(); } catch { /* 忽略 */ } });
  zip.outputStream.pipe(res);
});

// ---------- 文件夹导出 ----------
// 不传 targetDir 就落在数据目录的 exports/（老行为）；传了就落到用户选的位置。
// 目标位置同名文件夹绝不覆盖，自动加 -2、-3。
router.post('/export/folder', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?')
    .get(req.body?.id ?? req.query.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const src = wallpaperFolder(row);
  if (!fs.existsSync(src)) return fail(res, 404, '壁纸文件夹不存在');

  let parent;
  try {
    parent = req.body?.targetDir ? safeTargetDir(req.body.targetDir) : EXPORTS_DIR;
    fs.mkdirSync(parent, { recursive: true });
  } catch (e) {
    return fail(res, 400, e.message);
  }

  try {
    const legacy = ownsTypeRoot(row, src);
    const base = legacy
      ? safeRootName(row, LIB_TYPE_DIR[row.type] || 'wallpaper')
      : (path.basename(src) || 'wallpaper');
    const dest = uniqueDir(parent, base);
    if (legacy) {
      // 老条目没有自己的文件夹：新建一个，只放它自己的文件
      fs.mkdirSync(dest, { recursive: true });
      for (const rel of [row.main_file, row.cover]) {
        if (!rel) continue;
        const from = path.join(src, path.basename(rel));
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dest, path.basename(rel)));
      }
    } else {
      copyDirRecursive(src, dest);
    }
    writeProjectJson(dest, row);
    success(res, {
      path: dest,
      folder: path.basename(dest),
      renamed: path.basename(dest) !== base,
      message: '已导出 WE 文件夹：' + dest,
    });
  } catch (e) {
    fail(res, 500, '导出失败：' + e.message);
  }
});

// 预览某个壁纸的 project.json（诊断用，让前端显示会给 WE 写什么）
router.get('/project/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const pj = path.join(wallpaperFolder(row), 'project.json');
  if (fs.existsSync(pj)) {
    try { return success(res, JSON.parse(fs.readFileSync(pj, 'utf8'))); }
    catch { /* 落到下面生成规范版 */ }
  }
  success(res, buildProjectJson({
    title: row.title, type: row.type,
    file: row.main_file ? path.basename(row.main_file) : '',
    preview: row.cover ? path.basename(row.cover) : '',
    description: row.description, author: row.author || '',
    tags: projectJsonTags(row.primary_tag),
  }));
});

export default router;
// 云端发布要复用同一套打包口径，避免「本地导出」和「上传云端」打出来的包内容不一致
export { addRowToZip, wallpaperFolder, ownsTypeRoot };
