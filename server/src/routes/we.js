import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import db, { getLibraryDir, PROJECT_ROOT } from '../db.js';
import { TYPE_DIR, copyDirRecursive } from '../we-format.js';
import { resolveMediaPath, resolveWallpaperDir } from '../library-path.js';
import { workshopFolder } from '../naming.js';
import { ensureVideoAnim, ensureImageThumb, animAvailable } from '../preview-anim.js';
import {
  WE_APP_ID, discoverSources, setExtraDirs,
  runScan, scanState, isInsideKnownRoot, knownRoots,
  findSteamApiDll, setSteamDllPath,
} from '../steam.js';

const router = Router();

const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

// ---------- 已复制状态对账 ----------
// wallpaper_id 是指向 wallpapers 表的外键，但删除壁纸走的是通用删除接口，
// 在那里回写一次之外，还要兜住「在资源管理器里手动删文件夹」「旧版本留下的脏数据」。
// 分两级：库里的行没了 —— 每次请求都查（一条 SQL）；
//        行还在但磁盘文件没了 —— 节流 30 秒（上千次 existsSync 不能每页都跑）。
let lastDeepReconcile = 0;
function reconcileImports({ deep = false } = {}) {
  let fixed = 0;
  try {
    const dangling = db.prepare(`
      SELECT w.workshop_id FROM we_items w
      LEFT JOIN wallpapers p ON p.id = w.wallpaper_id
      WHERE w.wallpaper_id IS NOT NULL AND p.id IS NULL
    `).all();
    for (const r of dangling) {
      db.prepare("UPDATE we_items SET wallpaper_id = NULL, status = 'available' WHERE workshop_id = ?").run(r.workshop_id);
      fixed += 1;
    }
  } catch { /* 表结构异常时不阻断接口 */ }

  const now = Date.now();
  if (deep && now - lastDeepReconcile > 30000) {
    lastDeepReconcile = now;
    try {
      const libDir = path.resolve(getLibraryDir());
      // 三个类型目录一个都不在 → 库根本没挂上（外接盘没插、路径失效）。
      // 这时候"文件不存在"不代表被删了，不能把标记全清掉，否则插回硬盘也回不来。
      const typeDirs = Object.values(TYPE_DIR).map((t) => path.join(libDir, t));
      if (!typeDirs.some((d) => fs.existsSync(d))) return fixed;

      const rows = db.prepare(`
        SELECT w.workshop_id, p.dir_name, p.main_file
        FROM we_items w JOIN wallpapers p ON p.id = w.wallpaper_id
      `).all();
      const missing = [];
      for (const r of rows) {
        const abs = path.resolve(libDir, r.dir_name || '', r.main_file || '');
        const inside = abs.startsWith(libDir + path.sep);
        if (!inside || !r.main_file || !fs.existsSync(abs)) missing.push(r.workshop_id);
      }
      // 大面积对不上多半是盘/路径的问题，不是用户真删了这么多，宁可不改
      if (rows.length >= 4 && missing.length / rows.length > 0.5) return fixed;

      for (const id of missing) {
        db.prepare("UPDATE we_items SET wallpaper_id = NULL, status = 'available' WHERE workshop_id = ?").run(id);
        fixed += 1;
      }
    } catch { /* 同上 */ }
  }
  return fixed;
}

// 状态：Steam 在不在、有哪些库、有多少订阅内容、索引里各状态多少
router.get('/status', (req, res) => {
  reconcileImports({ deep: true });
  const disc = discoverSources();
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM we_items GROUP BY status
  `).all();
  const byType = db.prepare(`
    SELECT type, COUNT(*) AS n, SUM(size_bytes) AS bytes FROM we_items GROUP BY type
  `).all();
  const total = db.prepare('SELECT COUNT(*) AS n, SUM(size_bytes) AS bytes FROM we_items').get();
  success(res, {
    appId: WE_APP_ID,
    steamRoot: disc.steamRoot,
    steamFound: disc.steamFound,
    libraries: disc.libraries,
    extraDirs: disc.extraDirs,
    libraryDir: getLibraryDir(),
    indexed: {
      total: total?.n || 0,
      bytes: total?.bytes || 0,
      byStatus: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      byType: Object.fromEntries(byType.map((t) => [t.type || 'unknown', { n: t.n, bytes: t.bytes || 0 }])),
    },
    scan: scanState(),
  });
});

// 手动指定目录（自动定位失败，或者内容不在 Steam 库里时用）
router.post('/dirs', (req, res) => {
  const dirs = Array.isArray(req.body?.dirs) ? req.body.dirs : [];
  for (const d of dirs) {
    if (typeof d !== 'string' || !path.isAbsolute(d)) return fail(res, 400, '请提供绝对路径：' + d);
    if (!fs.existsSync(d)) return fail(res, 400, '目录不存在：' + d);
  }
  success(res, { extraDirs: setExtraDirs(dirs) });
});

// 扫描：立刻返回，进度靠 /scan 轮询（千级壁纸不能让请求干等）
router.post('/scan', (req, res) => {
  if (scanState().running) return success(res, scanState());
  runScan(); // 不 await：后台跑
  success(res, scanState());
});

router.get('/scan', (req, res) => success(res, scanState()));

// ---------- 无引用的库目录 ----------
// 删壁纸时旧实现只删了主文件，几百个附属文件连同文件夹留在库里；手动往里拷东西也会留下。
// 这里只负责「找出来」和「用户明确确认后删掉」，绝不自动清。
function treeSize(root) {
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

function findOrphans() {
  const libDir = path.resolve(getLibraryDir());
  // 引用判断必须走统一口径（resolveWallpaperDir / resolveMediaPath）：
  // dir_name 有两种历史写法（类型目录名 / 子目录名），旧实现按 dir_name + main_file 首段拼路径，
  // 对云端/导入类条目（dir_name=子目录名、main_file 以「网页/」开头）会拼出 <库>/W-we-xxx/网页 这样的幻影路径，
  // 真实目录在 <库>/网页/W-we-xxx —— 被误判为残留删掉。2026-11-20 事故：3 个网页壁纸因此被误删。
  const referenced = new Set();
  const rows = db.prepare('SELECT * FROM wallpapers').all();
  for (const r of rows) {
    const dir = resolveWallpaperDir(r);
    if (dir) referenced.add(path.resolve(dir));
    for (const rel of [r.main_file, r.cover]) {
      const abs = resolveMediaPath(r, rel);
      if (!abs) continue;
      // resolveMediaPath 对「rel 首段已是类型目录」的写法会多拼一层类型目录（历史语义），
      // 拼出来的路径不存在；只有真实存在的文件才收进引用集合，避免幻影路径既不保护也不误导
      if (fs.existsSync(abs)) {
        referenced.add(path.resolve(abs));
        const parent = path.dirname(abs);
        if (parent !== libDir && parent.startsWith(libDir + path.sep)) referenced.add(parent);
      }
    }
  }

  const list = [];
  let bytes = 0;
  let files = 0;
  for (const [t, typeKey] of Object.entries(TYPE_DIR)) {
    const dir = path.join(libDir, typeKey);
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name === '.cache' || e.name === '.trash' || e.name === '.upload-tmp') continue;
      const abs = path.join(dir, e.name);
      if (referenced.has(path.resolve(abs))) continue;
      // 二次核验：任何一条壁纸解析出的目录落在候选目录里 = 被引用。
      // 删文件前多一道确定性检查，不再只信集合判空（上次事故的教训）。
      const absResolved = path.resolve(abs);
      let touched = false;
      for (const r of rows) {
        const wd = resolveWallpaperDir(r);
        if (wd && (wd === absResolved || wd.startsWith(absResolved + path.sep))) { touched = true; break; }
      }
      if (touched) continue;
      const sz = treeSize(abs);
      list.push({ type: t, name: e.name, path: abs, files: sz.files, bytes: sz.bytes });
      bytes += sz.bytes;
      files += sz.files;
    }
  }
  list.sort((a, b) => b.bytes - a.bytes);
  return { list, total: list.length, bytes, files, libraryDir: libDir };
}

// .trash 里超过 7 天的条目物理删除（挂在 orphans 扫描时机执行，无独立定时器）
function purgeTrash() {
  const trashRoot = path.join(path.resolve(getLibraryDir()), '.trash');
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  let ents = [];
  try { ents = fs.readdirSync(trashRoot, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const p = path.join(trashRoot, e.name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 下次再试 */ }
  }
}

router.get('/orphans', (req, res) => {
  purgeTrash();
  success(res, findOrphans());
});

// 清理：只接受「当前确实无引用」的目录，客户端传的路径仅用于挑选，最终以服务端重扫结果为准
router.post('/orphans/clean', (req, res) => {
  if (req.body?.confirm !== true) return fail(res, 400, '清理目录需要显式确认');
  const want = Array.isArray(req.body?.paths) ? new Set(req.body.paths.map((p) => path.resolve(String(p)))) : null;
  const { list } = findOrphans();
  const targets = want ? list.filter((x) => want.has(path.resolve(x.path))) : list;

  const removed = [];
  const failed = [];
  let bytes = 0;
  // 清理不再直删：先移入库根 .trash/（7 天后由清理任务删除）。
  // 引用判断再怎么防都有漏网可能，删错了至少 7 天内能手工找回 —— 2026-11-20 误删事故的兜底。
  const trashRoot = path.join(path.resolve(getLibraryDir()), '.trash');
  fs.mkdirSync(trashRoot, { recursive: true });
  for (const t of targets) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dest = path.join(trashRoot, stamp + '-' + t.type + '-' + t.name);
      fs.renameSync(t.path, dest);
      removed.push({ ...t, trashedTo: dest });
      bytes += t.bytes;
    } catch (e) {
      failed.push({ path: t.path, message: e?.message || String(e) });
    }
  }
  success(res, { removed, failed, bytes });
});

// 列表与批量测试共用同一套筛选：避免两处条件写歪，测的东西和看到的东西不一致
function itemWhere(q = {}) {
  const type = String(q.type || '');
  const status = String(q.status || '');
  const compat = String(q.compat || '');
  const keyword = String(q.keyword || '').trim();
  // 标签多选 = 全部满足（Anime + Girls 可以收窄到 323 个，用「任一」几乎等于没筛）
  const tags = String(q.tags || '').split(',').map((s) => s.trim()).filter(Boolean);

  let where = ' WHERE 1=1';
  const params = [];
  if (type) { where += ' AND type = ?'; params.push(type); }
  if (status === 'imported') where += ' AND wallpaper_id IS NOT NULL';
  else if (status === 'available') where += ' AND wallpaper_id IS NULL AND source_exists = 1';
  else if (status === 'missing') where += ' AND source_exists = 0';
  if (compat === 'untested') where += " AND compat = ''";
  else if (compat === 'ok') where += " AND compat = 'ok'";
  else if (compat === 'broken') where += " AND compat IN ('fail','partial')";
  for (const t of tags) {
    // tags 存的是逗号分隔串，用 instr 精确匹配整段，避免 "Anime" 命中 "AnimeSomething"
    where += " AND instr(',' || tags || ',', ',' || ? || ',') > 0";
    params.push(t);
  }
  if (keyword) {
    where += ' AND (title LIKE ? OR author LIKE ? OR workshop_id LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  return { where, params };
}

// 列表：分页 + 搜索 + 类型/状态筛选，过滤下推到 SQL
router.get('/items', (req, res) => {
  reconcileImports();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 60));
  const { where, params } = itemWhere(req.query);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM we_items${where}`).get(...params).n;
  const rows = db.prepare(`
    SELECT workshop_id, source, dir_path, title, type, preview, main_file, author,
           size_bytes, file_count, source_exists, wallpaper_id, status,
           compat, compat_note, compat_at, subscribed, tags
    FROM we_items${where}
    ORDER BY title COLLATE NOCASE ASC, workshop_id ASC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  success(res, { list: rows, total, page, pageSize });
});

// 标签分布：统计口径跟列表一致（但不含标签自身），这样点一个标签后剩下的数量是可预期的
router.get('/tags', (req, res) => {
  reconcileImports();
  const q = { ...req.query };
  delete q.tags;
  const { where, params } = itemWhere(q);
  const rows = db.prepare(`SELECT tags FROM we_items${where}`).all(...params);
  const count = new Map();
  for (const r of rows) {
    for (const t of String(r.tags || '').split(',')) {
      const k = t.trim();
      if (!k) continue;
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  const list = [...count.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, n]) => ({ tag, n }));
  success(res, { list, total: rows.length });
});

// 「全部测试」要一次拿到当前筛选下的所有条目：分页拉几十轮太慢，还会跟筛选变更打架
router.get('/ids', (req, res) => {
  const { where, params } = itemWhere(req.query);
  const rows = db.prepare(`
    SELECT workshop_id, title, type, main_file, source_exists, compat
    FROM we_items${where}
    ORDER BY title COLLATE NOCASE ASC, workshop_id ASC
  `).all(...params);
  success(res, { list: rows, total: rows.length });
});

// 缩略图：只允许读"已索引条目自己目录内"的预览文件
router.get('/thumb/:id', async (req, res) => {
  const row = db.prepare('SELECT dir_path, preview, wallpaper_id FROM we_items WHERE workshop_id = ?').get(req.params.id);
  // 源目录被删了但这条已经复制到「我的壁纸」→ 用本地那份的封面顶上，
  // 不然卡片上是一张空图，看着像库坏了
  const localCover = () => {
    if (row?.wallpaper_id == null) return res.sendStatus(404);
    try {
      const w = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(row.wallpaper_id);
      const abs = w ? resolveMediaPath(w, w.cover) : '';
      if (!abs || !fs.existsSync(abs)) return res.sendStatus(404);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.sendFile(abs);
    } catch { return res.sendStatus(404); }
  };
  if (!row || !row.preview) return localCover();
  const base = path.resolve(row.dir_path);
  const abs = path.resolve(base, row.preview);
  if (!abs.startsWith(base + path.sep)) return res.sendStatus(403);
  if (!fs.existsSync(abs)) return localCover();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  // 动图（gif/webp）原样发，缩放会把它变成静态图
  const ext = path.extname(abs).toLowerCase();
  if (['.gif', '.webp'].includes(ext)) return res.sendFile(abs);
  // 大图先缩到 480 宽再发：一页 50 张原图要下几十 MB
  try {
    if (fs.statSync(abs).size > 100 * 1024) {
      const small = await ensureImageThumb(req.params.id, abs);
      if (small) {
        res.type('image/jpeg');
        return res.sendFile(small);
      }
    }
  } catch { /* 缩略图失败就走原图 */ }
  res.sendFile(abs);
});

// 动态缩略图（视频壁纸切 1.8 秒）。第一次请求时现场转码，之后直接读缓存。
router.get('/anim/:id', async (req, res) => {
  const row = db.prepare(`
    SELECT type, dir_path, main_file FROM we_items WHERE workshop_id = ?
  `).get(req.params.id);
  if (!row) return fail(res, 404, '索引里没有这条记录');
  if (row.type !== 'video') return fail(res, 404, '这类壁纸暂时没有动态缩略图');
  if (!row.main_file) return fail(res, 404, '没有主文件');
  const base = path.resolve(row.dir_path);
  const src = path.resolve(base, row.main_file);
  if (!src.startsWith(base + path.sep)) return fail(res, 403, '非法路径');
  try {
    const file = await ensureVideoAnim(req.params.id, src);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('video/mp4').sendFile(file);
  } catch (e) {
    fail(res, 500, '生成动态缩略图失败：' + (e?.message || e));
  }
});

// 预热：列表翻到哪一页，就把这页的视频壁纸排在后台慢慢转，悬停时基本已经好了
router.post('/anim/prefetch', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 60).map(String) : [];
  if (!ids.length) return success(res, { queued: 0 });
  let queued = 0;
  for (const id of ids) {
    const row = db.prepare(`
      SELECT type, dir_path, main_file FROM we_items WHERE workshop_id = ?
    `).get(id);
    if (!row || row.type !== 'video' || !row.main_file) continue;
    const base = path.resolve(row.dir_path);
    const src = path.resolve(base, row.main_file);
    if (!src.startsWith(base + path.sep)) continue;
    if (!fs.existsSync(src)) continue;
    queued += 1;
    ensureVideoAnim(id, src).catch(() => { /* 失败会在磁盘上留标记，不再重试 */ });
  }
  success(res, { queued, ffmpeg: animAvailable() });
});

// 复制入库：真复制到自己的库，源目录一个字节都不动
router.post('/import', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return fail(res, 400, '没有选择要复制的壁纸');
  reconcileImports();

  const libDir = getLibraryDir();
  const imported = [];
  const skipped = [];
  const failed = [];

  for (const id of ids) {
    const row = db.prepare('SELECT * FROM we_items WHERE workshop_id = ?').get(id);
    if (!row) { failed.push({ id, message: '索引里没有这条记录' }); continue; }
    if (!row.source_exists || !fs.existsSync(row.dir_path)) {
      failed.push({ id, message: '源目录已不存在' }); continue;
    }
    if (row.wallpaper_id) {
      const exists = db.prepare('SELECT id FROM wallpapers WHERE id = ?').get(row.wallpaper_id);
      if (exists) { skipped.push({ id, wallpaperId: row.wallpaper_id, message: '已经复制过' }); continue; }
    }
    if (!row.type) { failed.push({ id, message: '类型无法识别，无法入库' }); continue; }
    if (!row.main_file) { failed.push({ id, message: '找不到主文件' }); continue; }

    const typeDir = path.join(libDir, TYPE_DIR[row.type]);
    fs.mkdirSync(typeDir, { recursive: true });

    // 目录名统一成 <类型字母>-we-<创意工坊id>，和壁纸库里其它入口同一套规则
    let folderName = workshopFolder(row.type, id);
    let target = path.join(typeDir, folderName);
    let reused = false;

    if (fs.existsSync(target)) {
      // 目录还在，但没有任何壁纸记录指着它 → 上次删除留下的残留。
      // 内容跟源一致就直接复用，否则退到 -2，避免把「删了重下」变成一堆 we-xxx-2。
      const used = db.prepare('SELECT 1 FROM wallpapers WHERE dir_name = ? AND main_file LIKE ? LIMIT 1')
        .get(TYPE_DIR[row.type], `${folderName}/%`);
      if (!used) {
        const check = countFiles(target);
        if (check.files === row.file_count && (!row.size_bytes || check.bytes === row.size_bytes)) {
          reused = true;
        } else {
          try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 删不掉就换名字 */ }
        }
      }
      if (!reused && fs.existsSync(target)) {
        let n = 2;
        while (fs.existsSync(target)) {
          folderName = `${workshopFolder(row.type, id)}-${n}`;
          target = path.join(typeDir, folderName);
          n += 1;
        }
      }
    }

    // 本次新建的目录，只要没成功入库就必须清掉。以前复制失败只在 failed 里记一笔，
    // 半个目录会永远留在库里，界面上看不见也没有入口能删（we-3799228186 就是这么来的）。
    let createdHere = false;
    try {
      if (!reused) {
        createdHere = true;
        copyDirRecursive(row.dir_path, target);

        // 校验：文件数与总字节必须与扫描时一致，否则视为复制不完整
        const check = countFiles(target);
        if (check.files !== row.file_count || (row.size_bytes && check.bytes !== row.size_bytes)) {
          throw new Error(`复制校验失败（源 ${row.file_count} 个文件 / ${row.size_bytes} 字节，副本 ${check.files} / ${check.bytes}）`);
        }
      }

      const info = db.prepare(`
        INSERT INTO wallpapers (title, type, dir_name, cover, main_file, author, category, description, source_note, tags)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.title || '未命名壁纸',
        row.type,
        TYPE_DIR[row.type],
        row.preview ? `${folderName}/${row.preview}` : null,
        `${folderName}/${row.main_file}`,
        row.author || '',
        '壁纸引擎',
        row.description || '',
        `we:${row.workshop_id}`,
        row.tags || '',
      );
      const wallpaperId = Number(info.lastInsertRowid);

      db.prepare(`
        UPDATE we_items SET wallpaper_id = ?, status = 'imported' WHERE workshop_id = ?
      `).run(wallpaperId, id);
      imported.push({ id, wallpaperId, title: row.title, reused });
      createdHere = false;
    } catch (e) {
      if (createdHere) {
        try { fs.rmSync(target, { recursive: true, force: true }); }
        catch (ce) { console.warn('[import] 半成品目录清理失败：', target, ce?.message || ce); }
      }
      failed.push({ id, message: e?.message || String(e) });
    }
  }

  success(res, { imported, skipped, failed, libraryDir: libDir });
});

// 删除壁纸引擎源目录：需显式传 ids，且必须落在已识别的库/手动目录内
// 源目录真的没了（用户删的、Steam 清理的）之后，这条索引怎么处理：
// · 已经复制进「我的壁纸」的 → 留着那条记录，卡片显示「已复制」，让人知道这张是从哪来的
// · 没复制过的 → 文件没了、内容也没了，记录本身没有任何价值。留着只会在界面上多一张
//   永远打不开的空卡片（用户会觉得"我明明删了，怎么还在"），所以直接清掉。
function afterSourceGone(row) {
  if (row.wallpaper_id == null) {
    db.prepare('DELETE FROM we_items WHERE workshop_id = ?').run(row.workshop_id);
    return 'purged';
  }
  db.prepare("UPDATE we_items SET source_exists = 0, status = 'imported' WHERE workshop_id = ?")
    .run(row.workshop_id);
  return 'kept';
}

router.post('/delete-source', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return fail(res, 400, '没有选择要删除的壁纸');
  if (req.body?.confirm !== true) return fail(res, 400, '删除源文件需要显式确认');

  const removed = [];
  const failed = [];

  for (const id of ids) {
    const row = db.prepare('SELECT * FROM we_items WHERE workshop_id = ?').get(id);
    if (!row) { failed.push({ id, message: '索引里没有这条记录' }); continue; }

    const target = path.resolve(row.dir_path);
    if (!fs.existsSync(target)) {
      removed.push({ id, action: afterSourceGone(row), message: '目录本来就不存在' });
      continue;
    }
    // 三重保险：必须在已知根目录内、不能是根目录本身、目录名必须与该条目记录一致
    if (!isInsideKnownRoot(target) || knownRoots().includes(target)) {
      failed.push({ id, message: '路径不在已识别的壁纸引擎目录内，已拒绝' });
      continue;
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed.push({ id, action: afterSourceGone(row) });
    } catch (e) {
      failed.push({ id, message: e?.message || String(e) });
    }
  }

  success(res, { removed, failed });
});

// ---------- 只读媒体源：让壁纸引擎里的内容可以被直接预览/试渲染 ----------
// 只读、只允许落在已识别库内、只按条目自己目录做根（express.static 自带 .. 穿越防护）。
// 支持 Range，视频才能拖动进度。
const staticCache = new Map();
router.use('/media/:id', (req, res, next) => {
  const row = db.prepare('SELECT dir_path FROM we_items WHERE workshop_id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const base = path.resolve(row.dir_path);
  if (!fs.existsSync(base)) return res.status(404).end();
  if (!isInsideKnownRoot(base)) return res.status(403).end();
  let fn = staticCache.get(base);
  if (!fn) {
    fn = express.static(base, {
      index: ['index.html'],
      fallthrough: true,
      setHeaders: (r) => { if (!r.getHeader('Cache-Control')) r.setHeader('Cache-Control', 'no-cache'); },
    });
    staticCache.set(base, fn);
  }
  fn(req, res, (e) => {
    if (e) return res.status(e.status || 404).end();
    res.status(404).end();
  });
});

// ---------- 兼容性探测结果（由渲染端实测后回报，服务端只负责记账） ----------
router.post('/compat', (req, res) => {
  const id = String(req.body?.id || '');
  const result = String(req.body?.result || '');
  const note = String(req.body?.note || '').slice(0, 400);
  if (!id) return fail(res, 400, '缺少条目 id');
  if (!['', 'ok', 'partial', 'fail'].includes(result)) return fail(res, 400, 'result 只能是 ok / partial / fail / 空');
  const row = db.prepare('SELECT workshop_id FROM we_items WHERE workshop_id = ?').get(id);
  if (!row) return fail(res, 404, '索引里没有这条记录');
  db.prepare(`
    UPDATE we_items SET compat = ?, compat_note = ?, compat_at = datetime('now') WHERE workshop_id = ?
  `).run(result, note, id);
  success(res, { id, result, note });
});

// 批量测试一次跑几百上千条，逐条 POST 太碎；按批（前端攒 20 条）提交
router.post('/compat/batch', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return fail(res, 400, '没有要记录的结果');
  const stmt = db.prepare(`
    UPDATE we_items SET compat = ?, compat_note = ?, compat_at = datetime('now') WHERE workshop_id = ?
  `);
  let saved = 0;
  const missing = [];
  for (const it of items) {
    const id = String(it?.id || '');
    const result = String(it?.result || '');
    const note = String(it?.note || '').slice(0, 400);
    if (!id || !['', 'ok', 'partial', 'fail'].includes(result)) { missing.push(id || '(空 id)'); continue; }
    try {
      const r = stmt.run(result, note, id);
      if (r.changes) saved += 1; else missing.push(id);
    } catch (e) {
      missing.push(id);
    }
  }
  success(res, { saved, missing });
});

// ---------- Steam 订阅接口（真实调用 Steamworks） ----------
// 所有原生调用都在独立子进程里跑：万一崩了也不影响后端；结果用 ##WF## 前缀的 JSON 回传。
let steamLastCheck = null;

function runWorkshop(cmd, extra = {}, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const dllHit = findSteamApiDll();
    if (!dllHit) return resolve({ ok: false, reason: 'no-dll', message: '没找到 steam_api64.dll' });
    const script = path.join(PROJECT_ROOT, 'server', 'src', 'steam-workshop.js');
    const child = spawn(process.execPath, [script, JSON.stringify({ ...cmd, dll: dllHit.path, ...extra })], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已经退出 */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('##WF##'));
      if (!line) {
        return resolve({ ok: false, reason: 'no-output', message: (err || out).slice(0, 300) || 'Steam 接口没有返回结果' });
      }
      try { resolve(JSON.parse(line.slice(6))); }
      catch { resolve({ ok: false, reason: 'bad-json', message: '结果解析失败' }); }
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: 'spawn-failed', message: String(e.message) }); });
  });
}

router.get('/steam/status', (req, res) => {
  const hit = findSteamApiDll();
  success(res, {
    available: !!hit,
    dllPath: hit?.path || '',
    dllOrigin: hit?.origin || '',
    lastCheck: steamLastCheck,
  });
});

// 只读：连上 Steam 看看订阅了多少个（不取消任何东西）。
// 顺手做一次「订阅状态对账」：把库里每条到底还在不在订阅列表里写实。
// 不然界面上的「未订阅」只能来自上次退订时的返回值，用户没法自己验证到底退掉没有。
router.post('/steam/check', async (req, res) => {
  const t = Date.now();
  const r = await runWorkshop({ cmd: 'list', withIds: true }, {}, 45000);
  steamLastCheck = {
    at: new Date().toISOString(),
    ok: !!r.ok,
    total: r.total || 0,
    message: r.ok ? '' : (r.message || r.reason || '连接失败'),
    ms: Date.now() - t,
  };
  if (!r.ok) return res.json({ code: 0, message: 'ok', data: { ...steamLastCheck, reason: r.reason } });

  const reconciled = { subscribed: 0, unsubscribed: 0 };
  try {
    const subs = new Set((Array.isArray(r.ids) ? r.ids : []).map(String));
    const rows = db.prepare('SELECT workshop_id, subscribed FROM we_items').all();
    const yes = db.prepare('UPDATE we_items SET subscribed = 1 WHERE workshop_id = ?');
    const no = db.prepare('UPDATE we_items SET subscribed = 0 WHERE workshop_id = ?');
    for (const row of rows) {
      // 手动添加的目录（不是 Steam 订的）也会被记为未订阅，这是对的
      const want = subs.has(String(row.workshop_id)) ? 1 : 0;
      if ((Number(row.subscribed) === 1 ? 1 : 0) === want) continue;
      (want ? yes : no).run(row.workshop_id);
      if (want) reconciled.subscribed += 1; else reconciled.unsubscribed += 1;
    }
  } catch { /* 对账失败不影响连接结果 */ }

  success(res, { ...steamLastCheck, sample: r.sample || [], reconciled });
});

// 手动指定 DLL（自动找不到时）
router.post('/steam/dll', (req, res) => {
  const p = String(req.body?.path || '').trim();
  if (!p || !path.isAbsolute(p)) return fail(res, 400, '请提供 steam_api64.dll 的绝对路径');
  if (!fs.existsSync(p)) return fail(res, 400, '文件不存在：' + p);
  setSteamDllPath(p);
  const hit = findSteamApiDll();
  success(res, { dllPath: hit?.path || '', dllOrigin: hit?.origin || '' });
});

// 取消订阅：真实的 Steamworks 调用，必须显式确认
router.post('/steam/unsubscribe', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  if (!ids.length) return fail(res, 400, '没有选择要取消订阅的壁纸');
  if (req.body?.confirm !== true) return fail(res, 400, '取消订阅需要显式确认');

  const r = await runWorkshop({ cmd: 'unsubscribe', ids }, {}, 120000);
  if (!r.ok) {
    return fail(res, 502, r.message || ('取消订阅失败：' + (r.reason || '未知原因')));
  }

  const done = [];
  const pending = [];
  for (const x of r.results || []) {
    if (x.ok && x.confirmed) {
      db.prepare('UPDATE we_items SET subscribed = 0 WHERE workshop_id = ?').run(x.id);
      done.push(x.id);
    } else {
      pending.push({ id: x.id, message: x.message || (x.ok ? 'Steam 还没处理完' : '调用失败') });
    }
  }
  success(res, { unsubscribed: done, pending, remaining: r.remaining ?? null });
});

function countFiles(root) {
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

export default router;
