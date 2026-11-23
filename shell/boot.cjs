// 打包后的入口：用 CJS 引导，再动态 import ESM 主进程。
// 原因：Electron 直接以 .mjs 作为 package.json 的 main 时，部分版本会在加载前就静默退出，
// 用 CJS 引导能拿到异常并写日志，排查成本低得多。
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const LOG_DIR = path.join(process.env.APPDATA || __dirname, 'WallFlow');
const LOG = path.join(LOG_DIR, 'boot.log');
const say = (m) => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG, new Date().toTimeString().slice(0, 8) + '  ' + m + '\n');
  } catch { /* 忽略 */ }
};

say('boot start');
import(pathToFileURL(path.join(__dirname, 'main.mjs')).href)
  .then(() => say('main.mjs loaded'))
  .catch((e) => { say('main.mjs failed: ' + (e && e.stack || e)); });
