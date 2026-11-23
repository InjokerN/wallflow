// 壁纸目录定位：全后端只有这一处知道「一条壁纸的真实文件夹在哪」。
//
// 历史上有两种写法并存，不能靠 dir_name 单独判断：
//   1. 壁纸引擎复制（routes/we.js）  dir_name='场景'   main_file='we-123/scene.pkg'
//   2. ZIP/文件夹导入（compat.js）   dir_name='we-123' main_file='场景/we-123/scene.pkg'
//   3. 场景转视频（bake.js）         dir_name='视频'   main_file='bake-123/video.mp4'
//   4. 最早的三条示例                dir_name='场景'   main_file='scene.pkg'（直接躺在类型目录根下）
//
// 之前导出只拼 dir_name，结果导出任意一条场景都会打包整个「场景」目录（含别人的壁纸），
// 这就是「导出的包内容不对」的根因。统一走这里之后，导出 / 算大小 / 删除 / 烘焙口径一致。

import fs from 'node:fs';
import path from 'node:path';
import { getLibraryDir } from './db.js';

export const TYPE_DIR = { scene: '场景', video: '视频', web: '网页' };
const TYPE_DIR_SET = new Set(Object.values(TYPE_DIR));

const norm = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');

// 从相对路径里取出「文件夹」部分，并统一成相对库根的写法
function folderOf(rel, typeDir) {
  const segs = norm(rel).split('/').filter(Boolean);
  if (segs.length < 2) return '';
  // 首段已经是类型目录（写法 2），说明整串本来就相对库根
  if (TYPE_DIR_SET.has(segs[0])) return segs.slice(0, -1).join('/');
  return typeDir ? `${typeDir}/${segs.slice(0, -1).join('/')}` : '';
}

// 返回绝对路径。拿不到更精确的信息时退回类型目录（老条目就躺在那里）
export function resolveWallpaperDir(row) {
  if (!row) return '';
  const lib = getLibraryDir();
  const typeDir = TYPE_DIR[row.type] || '';
  const byMain = folderOf(row.main_file, typeDir);
  if (byMain) return path.resolve(lib, byMain);
  const byCover = folderOf(row.cover, typeDir);
  if (byCover) return path.resolve(lib, byCover);
  // dir_name 本身是子目录名（主文件/封面都为空时才会走到）
  const dirName = norm(row.dir_name);
  if (dirName && !TYPE_DIR_SET.has(dirName)) {
    return path.resolve(lib, typeDir, dirName);
  }
  return path.resolve(lib, typeDir);
}

// 相对库根的目录（存库、做比较时用）
export function relativeWallpaperDir(row) {
  const abs = resolveWallpaperDir(row);
  const rel = path.relative(path.resolve(getLibraryDir()), abs);
  return rel.split(path.sep).join('/');
}

// 「相对路径」是相对哪儿？同样是两种写法（见文件头注释），归一成绝对路径。
// 例：cover='网页/xxx/preview.gif' → <库>/网页/xxx/preview.gif
//     cover='xxx/preview.gif' + type=web → <库>/网页/xxx/preview.gif
export function resolveMediaPath(row, rel) {
  const p = norm(rel);
  if (!p) return '';
  const segs = p.split('/').filter(Boolean);
  const lib = path.resolve(getLibraryDir());
  const typeDir = TYPE_DIR[row?.type] || '';
  // 首段已经是类型目录 → 整串相对库根（'网页/xxx/index.html'）；
  // 否则相对类型目录（'xxx/scene.pkg' + type=scene）。
  // 以前无条件拼 typeDir，导致前者拼出 <库>/网页/网页/xxx 的幻影路径：
  // 文件明明在，导出/缩略图/孤儿清理却当成不存在，正是「显示正常但功能报缺失」的根因。
  const abs = (typeDir && TYPE_DIR_SET.has(segs[0]))
    ? path.resolve(lib, p)
    : path.resolve(lib, typeDir, p);
  // 纵深防御：rel 来自数据库字段，正常导入链路写不进 ..，但一旦混入就越出库目录。
  // 删除/读取/烘焙都走这里，解析结果必须锁死在库根以内；越界返回空让调用方走 404。
  if (abs !== lib && !abs.startsWith(lib + path.sep)) return '';
  return abs;
}

// 一条壁纸的文件健康状态。列表/详情/批量检查共用这一个口径，避免「各处说法不一」。
// 只读 fs.existsSync，不改动任何文件。
// 注意：主文件缺失才是「壁纸坏了」；封面缺失只是显示问题，单独列出来，
// 这样界面不会把一张能播但没封面的壁纸整条标成文件缺失。
export function wallpaperHealth(row) {
  const mainAbs = resolveMediaPath(row, row?.main_file);
  const coverAbs = resolveMediaPath(row, row?.cover);
  const dir = resolveWallpaperDir(row);
  const missing = !mainAbs || !fs.existsSync(mainAbs);
  const issues = [];
  if (!row?.main_file) issues.push('未登记主文件');
  else if (!mainAbs) issues.push('主文件路径越出库目录');
  else if (missing) issues.push('主文件丢失');
  if (row?.cover) {
    if (!coverAbs) issues.push('封面路径越出库目录');
    else if (!fs.existsSync(coverAbs)) issues.push('封面丢失');
  }
  if (!dir || !fs.existsSync(dir)) issues.push('壁纸文件夹丢失');
  return { ok: issues.length === 0, missing, issues, mainAbs, coverAbs, dir };
}
