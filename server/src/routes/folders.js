// 文件夹（逻辑分组）API —— 只改数据库的 folder_id，绝不移动磁盘上的物理壁纸目录。
// 物理目录 类型/<dir_name>/ 被导出/删除/内核播放/缩略图强依赖，动它会串断整条链路。

import { Router } from 'express';
import db from '../db.js';

const router = Router();
const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

// 目录名清洗：去首尾空白、挡空名、限长（和 wallpapers.title 的 100 字口径一致）
function cleanName(raw) {
  const name = String(raw ?? '').trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!name) return '';
  return name.slice(0, 100);
}

// 查某文件夹是否 descendants 包含 target（防把父文件夹移到自己子孙下造成环）
// 本期不提供"移动文件夹"操作，保留此函数供将来扩展与删除时的递归收集。
function collectDescendantIds(rootId) {
  const all = db.prepare('SELECT id, parent_id FROM folders').all();
  const out = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const cur = queue.shift();
    for (const f of all) if (f.parent_id === cur && !out.includes(f.id)) { out.push(f.id); queue.push(f.id); }
  }
  return out;
}

// 列表：平铺返回（含 parent_id），前端自己组装树。每个文件夹带 count（直属+子孙内的壁纸总数），
// 这样 UI 上能直接显示每个文件夹里有多少张。
router.get('/', (req, res) => {
  try {
    const folders = db.prepare('SELECT id, name, parent_id, created_at FROM folders ORDER BY parent_id, id').all();
    const counts = db.prepare(`
      SELECT f.id, COUNT(w.id) AS n FROM folders f
      LEFT JOIN wallpapers w ON w.folder_id = f.id
      GROUP BY f.id
    `).all();
    const byId = new Map(counts.map(c => [c.id, c.n]));
    // 把子孙的壁纸数累加到祖先：父文件夹显示整棵子树的壁纸总数
    for (const f of folders) {
      const ids = collectDescendantIds(f.id);
      f.count = ids.reduce((n, id) => n + (byId.get(id) || 0), 0);
    }
    success(res, { folders });
  } catch (e) { fail(res, 500, '读取文件夹失败：' + (e?.message || e)); }
});

// 新建：parent_id 省略/0/null = 根。同一父下不许重名。
router.post('/', (req, res) => {
  const name = cleanName(req.body?.name);
  if (!name) return fail(res, 400, '文件夹名不能为空');
  let parentId = Number(req.body?.parent_id) || null;
  try {
    if (parentId && !db.prepare('SELECT id FROM folders WHERE id = ?').get(parentId)) {
      return fail(res, 400, '父文件夹不存在');
    }
    const dup = db.prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS ?').get(name, parentId);
    if (dup) return fail(res, 400, '同一层级下已有同名文件夹');
    const info = db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId);
    success(res, { id: Number(info.lastInsertRowid), name, parent_id: parentId });
  } catch (e) { fail(res, 500, '创建文件夹失败：' + (e?.message || e)); }
});

// 重命名
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const name = cleanName(req.body?.name);
  if (!name) return fail(res, 400, '文件夹名不能为空');
  try {
    const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!row) return fail(res, 404, '文件夹不存在');
    const dup = db.prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS ? AND id <> ?').get(name, row.parent_id, id);
    if (dup) return fail(res, 400, '同一层级下已有同名文件夹');
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
    success(res, { id, name });
  } catch (e) { fail(res, 500, '重命名失败：' + (e?.message || e)); }
});

// 删除：连同所有子文件夹一起删；这些文件夹里的壁纸 folder_id 置 NULL（回到"全部"），
// 壁纸本身和磁盘文件绝不动。用事务保证"删文件夹"与"壁纸回根"要么全成要么全不成。
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  try {
    const row = db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(id);
    if (!row) return fail(res, 404, '文件夹不存在');
    // 删文件夹时，里面的壁纸回到「上层文件夹」（parent_id）；根文件夹则回 NULL（首页）。
    // 子孙文件夹一并删除，其壁纸同样上移到这个 parent_id，而不是全部甩回首页。
    const parentId = row.parent_id == null ? null : row.parent_id;
    const ids = collectDescendantIds(id);
    const ph = ids.map(() => '?').join(',');
    const moved = db.prepare(`SELECT COUNT(*) n FROM wallpapers WHERE folder_id IN (${ph})`).get(...ids).n;
    // node:sqlite 没有 db.transaction()，用显式 BEGIN/COMMIT，失败 ROLLBACK。
    db.exec('BEGIN');
    try {
      db.prepare(`UPDATE wallpapers SET folder_id = ? WHERE folder_id IN (${ph})`).run(parentId, ...ids);
      db.prepare(`DELETE FROM folders WHERE id IN (${ph})`).run(...ids);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败也不掩盖原错误 */ }
      throw e;
    }
    success(res, { deleted: ids.length, wallpapersMovedTo: parentId, movedCount: moved, wallpapersMovedToRoot: parentId == null ? moved : 0 });
  } catch (e) { fail(res, 500, '删除文件夹失败：' + (e?.message || e)); }
});

// 批量移动壁纸到文件夹：body = { ids:[...], folderId: number|null }
// null = 移到"全部"（取消分组）。事务 + 逐条校验，一条无效就整体失败，不留半吊子状态。
router.post('/move', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
  const rawFolder = req.body?.folderId;
  const folderId = rawFolder == null || rawFolder === 0 ? null : Number(rawFolder);
  if (!ids.length) return fail(res, 400, '没有要移动的壁纸');
  try {
    if (folderId && !db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId)) {
      return fail(res, 400, '目标文件夹不存在');
    }
    const found = db.prepare(`SELECT id FROM wallpapers WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (found.length !== new Set(ids).size) return fail(res, 400, '部分壁纸不存在，已取消移动');
    const uniq = [...new Set(ids)];
    db.exec('BEGIN');
    try {
      const upd = db.prepare('UPDATE wallpapers SET folder_id = ? WHERE id = ?');
      for (const id of uniq) upd.run(folderId, id);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 回滚失败也不掩盖原错误 */ }
      throw e;
    }
    success(res, { moved: uniq.length, folderId });
  } catch (e) { fail(res, 500, '移动失败：' + (e?.message || e)); }
});

export default router;
