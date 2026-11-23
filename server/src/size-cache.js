// 壁纸文件夹大小：启动后后台算一遍写进库，界面上只在详情里读。
// 不放前端算（浏览器拿不到目录），也不在请求里现算（几百 MB 的包会卡住接口）。

import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { resolveWallpaperDir } from './library-path.js';

const MAX_DEPTH = 16;
let running = false;
let started = false;

// 递归统计。不跟符号链接 / junction（跟着走会绕圈甚至跑进别的盘），
// 深度也设上限，避免异常目录结构拖死进程。
async function walk(dir, acc, seen, depth) {
  if (depth > MAX_DEPTH) return acc;
  let real;
  try { real = await fs.promises.realpath(dir); } catch { return acc; }
  if (seen.has(real)) return acc;
  seen.add(real);

  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
  catch { return acc; }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(p, acc, seen, depth + 1);
    } else if (entry.isFile()) {
      try {
        const st = await fs.promises.stat(p);
        acc.bytes += st.size;
        acc.files += 1;
      } catch { /* 单个文件读不到就跳过，不让整条失败 */ }
    }
  }
  return acc;
}

export async function folderSize(dir) {
  if (!dir) return 0;
  try {
    const st = await fs.promises.stat(dir);
    if (!st.isDirectory()) return 0;
  } catch { return 0; }
  const acc = await walk(dir, { bytes: 0, files: 0 }, new Set(), 0);
  return acc.bytes;
}

// 单条重算：新入库的壁纸（导入 / 云端下载）不该等到下次重启才有大小
export async function updateOneSize(row) {
  if (!row || !row.id) return 0;
  const bytes = await folderSize(resolveWallpaperDir(row));
  db.prepare("UPDATE wallpapers SET size_bytes = ?, size_at = datetime('now','localtime') WHERE id = ?")
    .run(bytes, row.id);
  return bytes;
}

// 全量重算。本地库条目不多（几十到几百），后台跑几秒，不阻塞接口。
export async function refreshSizes() {
  if (running) return { skipped: true };
  running = true;
  const startedAt = Date.now();
  try {
    const rows = db.prepare('SELECT * FROM wallpapers').all();
    const upd = db.prepare(
      "UPDATE wallpapers SET size_bytes = ?, size_at = datetime('now','localtime') WHERE id = ?",
    );
    let done = 0;
    for (const row of rows) {
      const bytes = await folderSize(resolveWallpaperDir(row));
      upd.run(bytes, row.id);
      done += 1;
    }
    console.log(`[size] 已计算 ${done} 条壁纸大小，用时 ${Date.now() - startedAt}ms`);
    return { done, cost: Date.now() - startedAt };
  } catch (e) {
    console.warn('[size] 计算失败：', e.message);
    return { error: e.message };
  } finally {
    running = false;
  }
}

// 启动后延迟一会儿再算：先让窗口出来、列表能看，别跟首屏抢 IO
export function startSizeWorker(delay = 1500) {
  if (started) return;
  started = true;
  const t = setTimeout(() => { refreshSizes(); }, delay);
  if (t.unref) t.unref();
}
