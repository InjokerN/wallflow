// V1 spike 假内核：只监听本地 HTTP、打印收到的命令，不做任何渲染。
// 用途：验证「UI -> 后端 -> 内核」信号链是否打通。V2 时替换为真正的 C++ 渲染内核。
// 启动：由 Electron 主进程以 ELECTRON_RUN_AS_NODE 拉起，也可 node core/fake-core.mjs 单独跑。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.WF_CORE_PORT || 3002);
const LOG_DIR = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd(), 'WallFlow');
const LOG_FILE = path.join(LOG_DIR, 'core-fake.log');

function log(line) {
  const text = new Date().toTimeString().slice(0, 8) + '  ' + line;
  console.log('[core]', text);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, text + '\n');
  } catch { /* 日志失败不影响主流程 */ }
}

// 与真内核协议保持一致：hide/show 用于网页/场景壁纸时让出桌面层，reload 用于托盘重载。
const COMMAND_KEYS = new Set(['play', 'pause', 'tier', 'quit', 'reload', 'hide', 'show']);

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/core/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, message: 'fake-core ok', data: { uptime: process.uptime() } }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/core/command') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on('end', () => {
      let j = null;
      try { j = JSON.parse(body); } catch { /* 无效 JSON */ }
      const cmd = j && j.cmd;
      if (!COMMAND_KEYS.has(cmd)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 400, message: 'unknown cmd', data: null }));
        log('收到非法命令: ' + body.slice(0, 120));
        return;
      }
      // spike 阶段只打印，不执行。记录关键字段便于核对信号链。
      const summary = {
        cmd,
        id: j.id ?? null,
        type: j.type ?? null,
        path: j.path ?? null,
        style: j.style ?? null,
        paused: j.paused ?? null,
        tier: j.tier ?? null,
        ts: j.ts ?? null,
      };
      log('收到命令: ' + JSON.stringify(summary));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, message: 'ok', data: { received: cmd } }));
      if (cmd === 'quit') setTimeout(() => server.close(() => process.exit(0)), 200);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 404, message: 'not found', data: null }));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`假内核已启动 http://127.0.0.1:${PORT}（V1 spike，只打印不渲染）`);
});
server.on('error', (e) => log('监听失败: ' + e.message));
