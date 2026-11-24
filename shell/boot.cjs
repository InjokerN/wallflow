// 打包后的入口：用 CJS 引导，再动态 import ESM 主进程。
// 原因：Electron 直接以 .mjs 作为 package.json 的 main 时，部分版本会在加载前就静默退出，
// 用 CJS 引导能拿到异常并写日志，排查成本低得多。
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const LOG_DIR = path.join(process.env.APPDATA || __dirname, 'WallFlow');
const LOG = path.join(LOG_DIR, 'boot.log');
const RUN_MARK = path.join(LOG_DIR, 'running.mark');
process.env.WF_RUN_MARK = RUN_MARK; // 传给 main.mjs，正常退出时清掉
const say = (m) => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG, new Date().toTimeString().slice(0, 8) + '  ' + m + '\n');
  } catch { /* 忽略 */ }
};

// 异常退出诊断：正常退出由 main.mjs 的 before-quit 清掉 running.mark。
// 若下次启动发现它还在，说明上次是被系统强杀（如 0xc0000005），记一笔方便定位。
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(RUN_MARK)) {
    const prev = fs.readFileSync(RUN_MARK, 'utf8').trim();
    say('上次未正常退出（疑似崩溃）' + (prev ? '，上次启动于 ' + prev : '') + '；本次已记录启动');
  }
  fs.writeFileSync(RUN_MARK, new Date().toISOString());
} catch { /* 忽略：诊断不影响启动 */ }

say('boot start');
import(pathToFileURL(path.join(__dirname, 'main.mjs')).href)
  .then(() => say('main.mjs loaded'))
  .catch((e) => { say('main.mjs failed: ' + (e && e.stack || e)); });
