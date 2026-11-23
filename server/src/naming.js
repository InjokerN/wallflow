// 壁纸目录命名：全软件只有这一处决定「新目录叫什么」。
//
//   <类型字母>-<来源>-<编号>
//   S / V / W = 场景 / 视频 / 网页
//   we        = 从壁纸引擎复制（编号沿用创意工坊 id，9~10 位不等，不能补齐）
//   ms        = 自己导入 / 场景转视频（编号是新生成的 10 位数字）
//
// 云端下载沿用云端包的 packId：上传端已经按这套规则生成了目录名，
// 所以直接拿来当目录名既不会重复，也保住了「dir_name === packId」的已下载判定。
//
// 历史上有过三种写法（无子目录、`we-<id>`、`<id>`），老条目由 resolveWallpaperDir 兼容，
// 不需要再改；这里只管「以后新建的目录」。

import fs from 'node:fs';
import path from 'node:path';
import db, { getLibraryDir } from './db.js';
import { TYPE_DIR } from './library-path.js';

export const TYPE_LETTER = { scene: 'S', video: 'V', web: 'W' };

export function workshopFolder(type, workshopId) {
  const id = String(workshopId || '').replace(/[^0-9A-Za-z_-]/g, '');
  if (!id) throw new Error('缺少创意工坊 id，无法生成目录名');
  return `${TYPE_LETTER[type] || 'X'}-we-${id}`;
}

const random10 = () => String(Math.floor(1000000000 + Math.random() * 9000000000));

// 10 位本地编号。数据库里出现过的、磁盘上已经存在的目录，都算占用。
export function newLocalFolder(type) {
  const used = new Set();
  for (const r of db.prepare('SELECT dir_name, main_file, cover FROM wallpapers').all()) {
    for (const v of [r.dir_name, r.main_file, r.cover]) {
      for (const seg of String(v || '').split(/[\\/]/)) if (/ms-[0-9]{10}/.test(seg)) used.add(seg);
    }
  }
  for (const t of Object.values(TYPE_DIR)) {
    const dir = path.join(getLibraryDir(), t);
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) used.add(e.name);
    } catch { /* 类型目录还没建，正常 */ }
  }
  for (let i = 0; i < 100; i += 1) {
    const name = `${TYPE_LETTER[type] || 'X'}-ms-${random10()}`;
    if (!used.has(name)) return name;
  }
  throw new Error('生成唯一目录名失败');
}
