import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import db, { getLibraryDir } from '../db.js';
import { resolveWallpaperDir, resolveMediaPath, wallpaperHealth } from '../library-path.js';
import { newLocalFolder } from '../naming.js';
import { normalizePrimaryTag, splitSubTags } from '../we-tags.js';

const router = Router();
const TYPE_DIR = { scene: '场景', video: '视频', web: '网页' };
const DIR_TYPE = { 场景: 'scene', 视频: 'video', 网页: 'web' };
const MAX_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.html']);

const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

// 健康状态统一由 library-path.wallpaperHealth 判定：
// 旧版这里自己拼 resolveWallpaperDir + basename，和导出/缩略图的解析口径不一致，
// 遇到 main_file 带子目录的历史写法会误判。现在列表/详情/体检共用一个答案。
function withHealth(row) {
  const h = wallpaperHealth(row);
  // 只把「有没有问题、问题是什么」交给前端，不暴露本机绝对路径
  return { ...row, missing: h.missing, issues: h.issues, health: h.ok ? 'ok' : 'broken' };
}

// 列表：分页 + 按类型/分类筛选，过滤下推到 SQL
router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
  const type = String(req.query.type || '');
  const category = String(req.query.category || '');
  const keyword = String(req.query.keyword || '');

  let where = ' WHERE 1=1';
  const params = [];
  if (type) { where += ' AND type = ?'; params.push(type); }
  if (category) { where += ' AND category = ?'; params.push(category); }
  if (keyword) { where += ' AND (title LIKE ? OR author LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }

  const total = db.prepare(`SELECT COUNT(*) AS n FROM wallpapers${where}`).get(...params).n;
  const rows = db.prepare(`SELECT * FROM wallpapers${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  success(res, { list: rows.map(withHealth), total, page, pageSize });
});

// 全库素材体检：主动扫一遍磁盘，给「检查素材」按钮用。
// 必须注册在 GET /:id 之前，否则 'health/check' 会被当成壁纸 id 直接 404。
router.get('/health/check', (req, res) => {
  const rows = db.prepare('SELECT * FROM wallpapers ORDER BY id').all();
  const bad = [];
  for (const row of rows) {
    const h = wallpaperHealth(row);
    if (!h.ok) bad.push({ id: row.id, title: row.title, type: row.type, issues: h.issues });
  }
  success(res, { total: rows.length, healthy: rows.length - bad.length, broken: bad.length, bad });
});

// 详情
// 全库作者汇总（详情编辑的下拉数据源）：去重 + 计数，按名字排序。
// 注意：必须注册在 GET /:id 之前，否则 authors/list 会被 :id 参数捕获。
router.get('/authors/list', (req, res) => {
  const rows = db.prepare("SELECT author, COUNT(*) AS n FROM wallpapers WHERE author <> '' GROUP BY author ORDER BY author").all();
  success(res, rows);
});
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  success(res, withHealth(row));
});

// 上传：先落到库内的临时目录，等表单字段（type/title）解析完再搬进类型目录。
// 以前在 destination 回调里就读 req.body.type —— 那时 multer 还没解析字段（file 通常排在前面），
// 拿到的是 undefined，于是所有单文件都掉进「场景」目录；顺带 main_file 还把文件名拼了两遍。
const UPLOAD_TMP = () => path.join(getLibraryDir(), '.upload-tmp');
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = UPLOAD_TMP();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter(req, file, cb) {
    if (!ALLOWED_EXT.has(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error('不支持的文件类型'));
    }
    cb(null, true);
  },
});

// 前端没给类型时按扩展名兜底，别一律当场景壁纸
function guessType(ext) {
  if (ext === '.mp4' || ext === '.webm') return 'video';
  if (ext === '.html') return 'web';
  return 'scene';
}

router.post('/', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return fail(res, 400, err.message || '上传失败');
    if (!req.file) return fail(res, 400, '没有收到文件');

    const ext = path.extname(req.file.originalname).toLowerCase();
    const type = TYPE_DIR[req.body.type] ? req.body.type : guessType(ext);
    // 每条壁纸独占一个目录。以前单文件是摊在类型目录根下，
    // 于是「场景/」里躺着若干条壁纸的文件，谁也分不清，删也删不干净。
    const folder = newLocalFolder(type);
    const destDir = path.join(getLibraryDir(), TYPE_DIR[type], folder);
    const fileName = path.basename(req.file.path);
    const finalPath = path.join(destDir, fileName);
    const cleanup = () => { try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* 忽略 */ } };
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.renameSync(req.file.path, finalPath);
    } catch {
      // 临时目录和类型目录理论上同盘，rename 失败就退回复制
      try {
        fs.copyFileSync(req.file.path, finalPath);
        fs.unlinkSync(req.file.path);
      } catch (e) {
        cleanup();
        return fail(res, 500, '保存文件失败：' + (e?.message || e));
      }
    }

    // 相对库根的路径，写一次就够；以前 relDir 已含文件名又拼了一遍 basename
    const relFile = `${TYPE_DIR[type]}/${folder}/${fileName}`;
    const originalName = path.basename(req.file.originalname, ext);
    try {
      const info = db.prepare(`
        INSERT INTO wallpapers (title, type, dir_name, cover, main_file, category)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        String(req.body.title || originalName).slice(0, 100),
        type,
        folder,
        relFile,
        relFile,
        String(req.body.category || '未分类').slice(0, 50)
      );
      success(res, { id: Number(info.lastInsertRowid), type, main_file: relFile });
    } catch (e) {
      cleanup();
      fail(res, 500, '入库失败：' + (e?.message || e));
    }
  });
});


// 壁纸所在目录的绝对路径（右键「打开所在位置」用）。目录不存在返回 404。
router.get('/:id/folder', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  try {
    const dir = resolveWallpaperDir(row);
    if (!dir || !fs.existsSync(dir)) return fail(res, 404, '目录不存在');
    // resolveMediaPath 对「首段已是类型目录」的旧写法会多拼一层（历史语义），
    // 拼出来的路径不存在；只回真实存在的主文件路径，否则前端退化到打开目录
    const mf = resolveMediaPath(row, row.main_file);
    success(res, { dir, mainFile: mf && fs.existsSync(mf) ? mf : '' });
  } catch (e) {
    fail(res, 500, '解析目录失败：' + (e?.message || e));
  }
});

// 改标题 / 标签。主标签只接受 WE 枚举，副标签自由文本（4 个字符以内、不含逗号）。
router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const body = req.body || {};
  const sets = [];
  const params = [];

  if ('author' in body) {
    const author = String(body.author || '').trim().slice(0, 100);
    sets.push('author = ?');
    params.push(author);   // 空串 = 清除作者
  }
  if ('description' in body) {
    sets.push('description = ?');
    params.push(String(body.description || '').trim().slice(0, 500));
  }
  if ('title' in body) {
    const title = String(body.title || '').trim().slice(0, 100);
    if (!title) return fail(res, 400, '标题不能为空');
    sets.push('title = ?');
    params.push(title);
  }
  if ('primary_tag' in body) {
    const primary = String(body.primary_tag || '').trim();
    // 传了值但不是枚举 → 明确报错，别悄悄清空用户的选择
    if (primary && !normalizePrimaryTag(primary)) {
      return fail(res, 400, '主标签必须是壁纸引擎支持的分类');
    }
    sets.push('primary_tag = ?');
    params.push(normalizePrimaryTag(primary));
  }
  if ('tags' in body) {
    sets.push('tags = ?');
    params.push(splitSubTags(body.tags).join(','));
  }
  if (!sets.length) return fail(res, 400, '没有要修改的字段');

  sets.push("updated_at = datetime('now','localtime')");
  params.push(req.params.id);
  db.prepare(`UPDATE wallpapers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  success(res, db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id));
});

// 收藏开着 / 关掉。跟着壁纸行存，不另建表：删壁纸即等于取消收藏。
router.post('/:id/favorite', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT id FROM wallpapers WHERE id = ?').get(id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const on = !!req.body?.favorite;
  db.prepare("UPDATE wallpapers SET favorite = ?, updated_at = datetime('now','localtime') WHERE id = ?")
    .run(on ? 1 : 0, id);
  success(res, { id, favorite: on });
});

// 老版本把收藏存在浏览器 localStorage 里，这里一次性搬进数据库。
// 幂等：只把列置 1，重复调用没有副作用；不存在的 id 直接跳过。
router.post('/favorites/import', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const upd = db.prepare('UPDATE wallpapers SET favorite = 1 WHERE id = ?');
  let updated = 0;
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) continue;
    try { updated += upd.run(id).changes; } catch { /* 跳过坏值 */ }
  }
  success(res, { updated, skipped: ids.length - updated });
});

// 删除：先删数据库记录，再尝试删文件（文件删失败不影响记录删除）
router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');

  // 从壁纸引擎复制进来的壁纸，索引表里有一个指向本行的外部引用。
  // 不在这里一起清掉，那条记录会永远显示「已复制」，而实际文件早没了。
  try {
    db.prepare("UPDATE we_items SET wallpaper_id = NULL, status = 'available' WHERE wallpaper_id = ?")
      .run(req.params.id);
  } catch { /* 老库没有这张表也不影响删除本身 */ }

  db.prepare('DELETE FROM wallpapers WHERE id = ?').run(req.params.id);

  // 目录定位统一走 resolveWallpaperDir：dir_name 有两种历史写法，不能只拼类型目录，
  // 否则会删到别人的壁纸（之前导出就是踩了同一个坑）。
  const lib = path.resolve(getLibraryDir());
  const absDir = resolveWallpaperDir(row);
  const typeDir = path.resolve(lib, TYPE_DIR[row.type] || '');
  const insideLib = absDir === lib ? false : absDir.startsWith(lib + path.sep);

  // 独占一个子目录的条目（壁纸引擎复制来的 we-xxx、导入的、云端下载的），
  // 连目录一起删；只删主文件会把几百个附属文件留在库里，越攒越多。
  // 老条目（dir_name 直接是类型目录名、文件躺在类型目录根下）走下面的单文件删除。
  const ownsFolder = insideLib && absDir !== typeDir && absDir.startsWith(typeDir + path.sep);
  let warning = '';
  if (ownsFolder) {
    // 按「重新解析出来的真实目录」判断，不能按 dir_name 猜：
    // 老条目 dir_name 存类型目录名（视频），新条目存子目录名，按前者会把同类型所有条目
    // 都算成同目录 → 独占目录不敢整目录删，只删主文件和封面，留下一堆附属文件。
    const others = db.prepare('SELECT * FROM wallpapers WHERE id <> ?').all(row.id)
      .filter((r) => {
        try { return path.resolve(resolveWallpaperDir(r)) === absDir; }
        catch { return false; }
      }).length;
    if (!others) {
      try {
        fs.rmSync(absDir, { recursive: true, force: true });
        return success(res, { id: Number(row.id), removedDir: path.basename(absDir) });
      } catch (e) {
        // 删不掉就明说，别一边报成功一边把文件留在盘上
        console.warn('[delete] 目录删除失败，退回单文件删除：', absDir, e?.message || e);
        warning = '目录没能完全删除：' + (e?.message || e);
      }
    }
  }

  // 其余条目：只删自己的主文件和封面，不碰同目录里的其他东西
  for (const rel of [row.main_file, row.cover]) {
    if (!rel) continue;
    const abs = path.resolve(absDir, path.basename(String(rel)));
    if (!abs.startsWith(absDir + path.sep)) continue;   // 防目录穿越
    try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* 忽略文件删除失败 */ }
  }
  // 顺手清掉因此变空的子目录（如烘焙生成的 bake-xxx），顶层类型目录不动
  try {
    if (absDir !== typeDir && absDir.startsWith(typeDir + path.sep)
      && fs.readdirSync(absDir).length === 0) fs.rmdirSync(absDir);
  } catch { /* 忽略 */ }

  success(res, { id: Number(row.id), ...(warning ? { warning } : {}) });
});

export default router;
