#!/usr/bin/env node
// 把 electron-builder 的中间产物 release/win-unpacked 变成正式目录 release/WallFlow
// 顺序：先清理测试残留 → 再替换，保证正式目录里没有垃圾，也不会留下两个 500MB 副本
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');
const SRC = path.join(OUT, 'win-unpacked');
const DST = path.join(OUT, 'WallFlow');

if (!fs.existsSync(SRC)) {
  console.error('[publish] 找不到 release/win-unpacked，先跑 electron-builder');
  process.exit(1);
}

// 1. 清理中间产物的测试残留（业务数据不动）
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'clean-package.mjs'), path.join(SRC, 'resources', 'app', 'server')], { stdio: 'inherit' });

// 2. 替换正式目录。
//    原实现直接 rmSync(DST) 批量删 900+ 文件，既不可回滚，也会撞环境的批量删除保护。
//    改成「旧目录改名备份 → 新目录原子改名进来」：全程无删除，出任何问题都能原路改回。
//    备份目录会占用一份旧成品的磁盘，确认新版无误后可自行删除。
try {
  if (fs.existsSync(DST)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const base = path.join(OUT, `WallFlow.prev-${stamp}`);
    let backup = base, n = 1;
    while (fs.existsSync(backup)) backup = `${base}-${n++}`;
    fs.renameSync(DST, backup);
    console.log('[publish] 旧成品已改名备份（可回滚）：' + backup);
  }
  fs.renameSync(SRC, DST);
} catch (e) {
  console.error('[publish] 替换失败：' + e.message);
  console.error('[publish] 如果 WallFlow 正在运行，请先从托盘退出；若旧目录已改名，把它改回 WallFlow 即可回滚');
  process.exit(1);
}

console.log('[publish] 已更新 ' + DST);
