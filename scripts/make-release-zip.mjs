#!/usr/bin/env node
// 把 release/WallFlow 绿色目录压成 zip，作为 GitHub Release 附件。
// 用项目已有依赖 yazl，避免依赖系统 zip 命令。
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'release', 'WallFlow');
const OUT = path.join(ROOT, 'release', 'WallFlow-v0.4.0-win-x64.zip');

if (!fs.existsSync(SRC)) { console.error('找不到成品目录：' + SRC); process.exit(1); }

const zip = new yazl.ZipFile();
let count = 0;
function addDir(dir, prefix) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = prefix + e.name;
    if (e.isDirectory()) addDir(full, rel + '/');
    else { zip.addFile(full, rel); count++; }
  }
}
addDir(SRC, 'WallFlow/');

const out = fs.createWriteStream(OUT);
zip.outputStream.pipe(out);
zip.end();
out.on('finish', () => {
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`[zip] ${OUT}`);
  console.log(`[zip] ${count} 个文件，${mb} MB`);
});
out.on('error', (e) => { console.error('[zip] 失败：' + e.message); process.exit(1); });
