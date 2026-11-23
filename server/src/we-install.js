// 把「已经躺在磁盘上的壁纸文件夹」登记进库。导入 ZIP、导入文件夹、云端下载共用这一份，
// 保证三条路进来的条目字段完全一致（dir_name / cover / main_file 的拼法一旦不一致，
// 预览就会串到别的壁纸上，这个坑之前踩过）。

import fs from 'node:fs';
import path from 'node:path';
import db, { getLibraryDir } from './db.js';
import { TYPE_DIR, copyDirRecursive } from './we-format.js';
import { WE_TAG_SET } from './we-tags.js';
import { updateOneSize } from './size-cache.js';
import { newLocalFolder } from './naming.js';

// 目标路径必须仍在 base 目录内（防 zip slip / 路径穿越）
export function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 从 tags 里分离主标签与副标签：主标签必须是 WE 枚举，其余留作副标签
export function splitTags(list, declared) {
  const all = (Array.isArray(list) ? list : []).map((s) => String(s).trim()).filter(Boolean);
  const declaredOk = declared && WE_TAG_SET.has(declared) && declared !== 'Unspecified' ? declared : '';
  const primary = declaredOk || all.find((t) => WE_TAG_SET.has(t) && t !== 'Unspecified') || '';
  const subs = all.filter((t) => t !== primary && !WE_TAG_SET.has(t));
  return { primary, subs };
}

// 登记一条已经复制到位、文件齐全的壁纸
export function registerWallpaper(folderName, type, meta, mainFile, preview) {
  const relDir = `${TYPE_DIR[type]}/${folderName}`;
  const mainRel = `${relDir}/${mainFile}`;
  const coverRel = preview ? `${relDir}/${preview}` : '';
  const exists = db.prepare('SELECT id FROM wallpapers WHERE dir_name = ? AND main_file = ?')
    .get(folderName, mainRel);
  if (exists) return { id: exists.id, duplicated: true };

  const { primary, subs } = splitTags(meta.tags, meta.primaryTag);
  const info = db.prepare(`
    INSERT INTO wallpapers (title, type, dir_name, cover, main_file, author, category, description, tags, primary_tag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(meta.title || '未命名壁纸').slice(0, 200), type, folderName,
    coverRel, mainRel,
    String(meta.author || 'WE 导入').slice(0, 100),
    (subs[0] || primary || '未分类').slice(0, 50),
    String(meta.description || '').slice(0, 500),
    subs.join(','),
    primary
  );
  const id = Number(info.lastInsertRowid);
  // 新入库的条目立刻算一次大小，不然要等下次启动才有（详情里会缺这一项）
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(id);
  if (row) updateOneSize(row).catch(() => {});
  return { id, duplicated: false, primary, subs };
}

// 把解压/临时目录里的壁纸目录搬进库。返回入库结果。
// opts.folderName：云端下载传 packId（保住「dir_name === packId」的已下载判定）；
// 不传就是自己导入，按统一规则生成 <类型>-ms-<10位>。
// wantedName（ZIP 原名 / 文件夹名）只作提示，不再当目录名——目录名要全局唯一、可预期。
export function installWallDir(wallDir, meta, mainFile, preview, wantedName, opts = {}) {
  const typeDir = path.join(getLibraryDir(), TYPE_DIR[meta.type]);
  fs.mkdirSync(typeDir, { recursive: true });

  const baseName = String(opts.folderName || newLocalFolder(meta.type))
    .replace(/[\\/:*?"<>|]/g, '-').trim();
  if (!baseName) throw new Error('目录名为空');
  let folderName = baseName;

  // 云端下载按 packId 判重：同一个包再下一次不该生成 -2 副本。
  // 自己导入的目录名是随机的，按「类型 + 标题 + 主文件名」判重。
  const title = String(meta.title || '未命名壁纸').slice(0, 200);
  if (opts.folderName) {
    const already = db.prepare('SELECT id FROM wallpapers WHERE dir_name = ?').get(folderName);
    if (already) return { id: already.id, duplicated: true, folder: folderName };
  } else {
    const sameTitle = db.prepare('SELECT id, main_file FROM wallpapers WHERE type = ? AND title = ?')
      .all(meta.type, title);
    const hit = sameTitle.find((r) => String(r.main_file || '').endsWith('/' + mainFile));
    if (hit) return { id: hit.id, duplicated: true };
  }

  let target = path.join(typeDir, folderName);
  if (!isInside(typeDir, target)) throw new Error('目标目录越界：' + folderName);
  let n = 2;
  while (fs.existsSync(target)) {
    folderName = `${baseName}-${n++}`;
    target = path.join(typeDir, folderName);
  }

  copyDirRecursive(wallDir, target);
  return { ...registerWallpaper(folderName, meta.type, meta, mainFile, preview), folder: folderName };
}
