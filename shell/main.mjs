// WallFlow 桌面应用主进程
// 职责：内嵌启动后端 → 主窗口（管理界面）+ 壁纸层窗口（贴桌面底层）→ 托盘常驻 → 单实例
// electron 是 CJS 包，ESM 具名导入在部分版本里拿不到，统一用 createRequire 加载
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { attachToDesktop, isAttached, detach, fit, needsRefit, toHwnd } from './attach.mjs';
import { isFullscreenApp } from './fullscreen.mjs';
import { leftButtonDown } from './cursor.mjs';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, screen, session, ipcMain, dialog, desktopCapturer } = require('electron');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.WF_PORT || 3001);
const BASE = `http://127.0.0.1:${PORT}`;
const argv = new Set(process.argv.slice(1));
// 打包成 exe 后 Chromium 会把 --xxx 当成自己的开关并直接报 "bad option" 退出，
// 所以这些调试开关同时支持环境变量写法（WF_SHOT=1 等）
const flag = (name, env) => argv.has(name) || process.env[env] === '1';
const SELFTEST = flag('--selftest', 'WF_SELFTEST');  // 自检：只测壁纸层，截图后退出
const NO_ATTACH = flag('--no-attach', 'WF_NO_ATTACH'); // 调试：不贴桌面
const NO_WINDOW = flag('--no-window', 'WF_NO_WINDOW'); // 调试：只起壁纸层，不起主窗口
const SHOT = flag('--shot', 'WF_SHOT');                // 自检：给主窗口截图后退出
const HOLD = (() => {
  const a = [...argv].find((s) => s.startsWith('--hold='));
  return a ? Math.min(120, Math.max(0, parseInt(a.split('=')[1], 10) || 0)) : 0;
})();

// 窗口贴到桌面底层后 Chromium 会判定"被完全遮挡"而降频，壁纸会卡死。
// 这三个开关是同类软件（Lively / WE）的通用做法。
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 桌面层没有用户手势，视频壁纸"打开声音"时若按默认策略会被拦成静音。
// 这是桌面壁纸场景的正常需求（壁纸引擎也这么做），只影响本应用自己的窗口。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.setName('WallFlow');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 打包后 exe 没有控制台，日志同时写进 %APPDATA%\WallFlow\wallflow.log，出问题能直接看
const LOG_DIR = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || ROOT, 'WallFlow');
const LOG_FILE = path.join(LOG_DIR, 'wallflow.log');
const log = (...a) => {
  const line = new Date().toTimeString().slice(0, 8) + '  ' +
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log('[app]', ...a);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志失败不影响主流程 */ }
};
log('启动：', { exe: process.execPath, packaged: app.isPackaged, port: PORT, selftest: SELFTEST, shot: SHOT });

let mainWin = null;
let wallpaperWin = null;
let tray = null;
let backendChild = null;
let coreChild = null;   // V1 spike：独立渲染内核进程（当前为假内核）
let coreWatch = null;   // 内核异常退出后的自动拉起定时器
let coreRestoring = false;
let bounds = null;
let hostHandle = 0;
let attachState = null;
let watchdog = null;
let backendWatch = null;
let fullWatch = null;
let renderWatch = null;    // 按当前壁纸类型切换「内核 / 浏览器」桌面渲染归属
let renderMode = null;     // 'core' | 'desktop' | null
let cursorTimer = null;
let fsPaused = false;
let quitting = false;
let lastRenderFps = 0;     // 全局渲染节拍（后端 render_fps），变了才下发内核，避免刷屏

const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');
const TRAY_PNG = path.join(__dirname, 'assets', 'tray.png');

// ---------- 数据目录 ----------
// 打包后壁纸素材与数据库放 %APPDATA%\WallFlow，不写在程序目录里：
// 这样程序放在 Program Files / 只读盘 / U 盘里也能正常跑，复制到别的电脑也不用改权限。
// 开发模式（npm run app）仍用项目内 server/，避免开发数据和打包数据分裂两处。
const DATA_HOME = path.join(process.env.APPDATA || process.env.LOCALAPPDATA || ROOT, 'WallFlow');
const USE_EXTERNAL_DATA = app.isPackaged;

// ---------- 本机设置 ----------
// 「常规设置」这几项只有主进程用得上（开机启动、窗口行为、全屏暂停），
// 所以存在主进程自己的 prefs.json 里，不经过后端 —— 后端没起来也能正常读。
const PREFS_FILE = path.join(DATA_HOME, 'prefs.json');
const DEFAULT_PREFS = {
  launchAtLogin: false,          // 登录 Windows 后自动启动
  startMinimized: false,         // 启动后不弹主窗口，从托盘打开
  closeToTray: true,             // 关窗口只是收进托盘（壁纸继续跑）
  autoPauseOnFullscreen: true,   // 检测到全屏应用时暂停壁纸
  pauseOnBattery: true,          // 用电池时暂停壁纸（省电，WE 同款策略）
  stopOnPause: true,             // 暂停时真正卸载解码器释放内存（关掉则只 pause 保留画面）
};
let prefs = { ...DEFAULT_PREFS };

function loadPrefs() {
  try {
    const j = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    prefs = { ...DEFAULT_PREFS };
    for (const k of Object.keys(DEFAULT_PREFS)) if (typeof j?.[k] === 'boolean') prefs[k] = j[k];
  } catch { prefs = { ...DEFAULT_PREFS }; }
}

function savePrefsFile() {
  try {
    fs.mkdirSync(DATA_HOME, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (e) { log('设置写入失败：', e.message); }
}

// 开机启动写进注册表 Run 项。开发模式下写了会把 electron.exe 拉进开机项，
// 那是个空壳（没有 app 参数），所以只在打包后真写；开发时只存值不落地。
function applyLoginItem() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!prefs.launchAtLogin, path: process.execPath, args: [] });
    log('开机启动：', prefs.launchAtLogin ? '已开启' : '已关闭');
  } catch (e) { log('开机启动设置失败：', e.message); }
}

// 统一入口：改设置 → 落盘 → 立刻生效 → 各窗口与托盘同步
function setPrefs(patch) {
  if (!patch || typeof patch !== 'object') return prefs;
  for (const k of Object.keys(DEFAULT_PREFS)) {
    if (typeof patch[k] === 'boolean') prefs[k] = patch[k];
  }
  savePrefsFile();
  applyLoginItem();
  // 设置项关闭时，清掉对应的暂停原因（若还有别的原因成立则继续保持暂停）
  if (!prefs.autoPauseOnFullscreen && pauseReasons.has('fullscreen')) {
    setPauseReason('fullscreen', false);
    log('全屏自动暂停已关闭 → 清除该暂停原因');
  }
  if (!prefs.pauseOnBattery && pauseReasons.has('battery')) {
    setPauseReason('battery', false);
    log('电池暂停已关闭 → 清除该暂停原因');
  }
  // 用户调整「暂停时是否释放内存」时，若当前正处于暂停且内核在画，立即按新档位重新施加
  if (pauseActive && renderMode === 'core') {
    if (prefs.stopOnPause) { notifyCoreCommand('tier', { tier: 2 }); log('切换为 Stop 档（释放内存）'); }
    else { notifyCoreCommand('pause', { paused: true }); log('切换为 Pause 档（保留解码器）'); }
  }
  if (tray) tray.setContextMenu(trayMenu());
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === mainWin && !w.isDestroyed()) w.webContents.send('wf:prefs-changed', prefs);
  }
  log('设置已更新：', JSON.stringify(prefs));
  return prefs;
}

loadPrefs();

// ---------- 应用规则：指定 exe 运行期间暂停壁纸（方案 A：进程一在就暂停）----------
// 独立存一个数组文件：prefs.json 只收 boolean，规则是 exe 名数组，不能混进去。
// 只认精确的 exe 文件名（大小写不敏感，Windows 进程名本身就不分大小写），不看路径 —— 与 WE 一致。
const APP_RULES_FILE = path.join(DATA_HOME, 'app-rules.json');
const SELF_PROCESSES = new Set(['wallflow.exe', 'wallcore.exe', 'electron.exe']); // 绝不能让规则停掉自己
let appRules = [];
let appRuleActive = false;   // 上一次命中状态，避免每 2 秒重复刷日志
let appChecking = false;     // 防止上一轮 tasklist 没回来下一轮又发

function normalizeExeName(raw) {
  let s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^["']|["']$/g, '').replace(/^.*[\\/]/, '');  // 允许粘贴完整路径/带引号，只取文件名
  if (!s.endsWith('.exe')) s += '.exe';
  return s;
}

function loadAppRules() {
  try {
    const j = JSON.parse(fs.readFileSync(APP_RULES_FILE, 'utf8'));
    appRules = Array.isArray(j)
      ? [...new Set(j.map(normalizeExeName).filter((s) => s && !SELF_PROCESSES.has(s)))]
      : [];
  } catch { appRules = []; }
}

function saveAppRules() {
  try {
    fs.mkdirSync(DATA_HOME, { recursive: true });
    fs.writeFileSync(APP_RULES_FILE, JSON.stringify(appRules, null, 2));
  } catch (e) { log('应用规则写入失败：', e.message); }
}

function getAppRules() { return [...appRules]; }

function setAppRules(list) {
  if (!Array.isArray(list)) return getAppRules();
  appRules = [...new Set(list.map(normalizeExeName).filter((s) => s && !SELF_PROCESSES.has(s)))];
  saveAppRules();
  log('应用规则已更新：', JSON.stringify(appRules));
  checkAppRules();   // 立即按新规则判一次，不等下个轮询周期
  return getAppRules();
}

// 递归看目录里到底有没有真文件：只认"有内容"，不认"有空壳目录"
// （迁到一半失败会留下空目录，这种要能重试，不能当成已完成）
function hasAnyFile(dir) {
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile()) return true;
      if (e.isDirectory() && hasAnyFile(p)) return true;
    }
  } catch { /* 读不了就当没有 */ }
  return false;
}

// 从只读介质（U 盘只读开关、光盘、只读共享盘）复制过来的文件会带着"只读"属性，
// 迁移到数据目录后数据库就变成不可写，后端会崩在第一次写入上。迁完统一清掉属性。
function clearReadonly(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) clearReadonly(p);
    else { try { fs.chmodSync(p, 0o666); } catch { /* 个别失败不影响整体 */ } }
  }
}

// 首次运行（或换了台电脑）把包内自带的初始素材搬到数据目录，只搬一次
function prepareDataHome() {
  if (!USE_EXTERNAL_DATA) return;
  const seedRoot = path.join(ROOT, 'server');
  for (const name of ['uploads', 'data']) {
    const src = path.join(seedRoot, name);
    const dst = path.join(DATA_HOME, name);
    // data 目录以数据库文件为准：有库才算迁完
    const done = name === 'data'
      ? fs.existsSync(path.join(dst, 'wallflow.db'))
      : hasAnyFile(dst);
    if (done) continue;
    try {
      if (fs.existsSync(src)) {
        fs.cpSync(src, dst, { recursive: true });
        clearReadonly(dst);
        log(`已把初始素材迁移到数据目录：${dst}`);
      } else {
        fs.mkdirSync(dst, { recursive: true });
      }
    } catch (e) {
      log(`迁移 ${name} 失败：`, e.message);
      // 迁不动也不能让应用起不来：后端会自己建库，先跑起来再说
      try { fs.mkdirSync(dst, { recursive: true }); } catch { /* 连建目录都不行就只能报错 */ }
    }
  }
}

// ---------- 后端 ----------

async function healthy() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

// 用 Electron 自带的 Node 跑后端（ELECTRON_RUN_AS_NODE），用户机器不需要装 Node
function spawnBackend() {
  const script = path.join(ROOT, 'server', 'src', 'app.js');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) };
  // 内核地址只有一个来源：WF_CORE_PORT（默认 3002）。后端原本只看 WF_CORE_URL，
  // 两个变量不一致会导致改端口后 apply 命令转发不到内核 —— 这里统一算好传下去。
  const corePort = Number(process.env.WF_CORE_PORT || 3002);
  env.WF_CORE_URL = process.env.WF_CORE_URL || `http://127.0.0.1:${corePort}`;
  // 告诉后端数据写哪儿；不传则后端退回项目内 server/（开发模式）
  if (USE_EXTERNAL_DATA) env.WF_DATA_DIR = DATA_HOME;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  // 打包后没有控制台，后端崩了必须能事后查到原因，所以输出落盘
  let out = 'ignore';
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const f = path.join(LOG_DIR, 'backend.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, '');
    out = fs.openSync(f, 'a');
  } catch { /* 打不开就维持忽略 */ }
  const child = spawn(process.execPath, [script], {
    cwd: ROOT, env, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.on('error', (e) => log('后端启动出错：', e.message));
  child.on('exit', (c) => { log('后端进程退出 code=', c); if (backendChild === child) backendChild = null; });
  return child;
}

// 优雅关闭：向后端要一次性令牌（/api/health 随健康检查下发），发 /__shutdown 让它自己收尾，
// 超时才 kill —— 直接 TerminateProcess 会让 SQLite 写入与导出临时文件来不及清理
async function gracefulBackendStop(child, timeoutMs = 3000) {
  if (!child) return;
  try {
    const r = await fetch(`${BASE}/api/health`);
    const j = await r.json();
    const token = j?.data?.shutdownToken;
    if (token) {
      await fetch(`${BASE}/__shutdown`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: token,
      }).catch(() => {});
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        await sleep(100);
        if (child.exitCode !== null || child.signalCode) return;
      }
    }
  } catch { /* 健康检查拿不到令牌就走强杀兜底 */ }
  try { child.kill(); } catch { /* 已经退出 */ }
}

async function ensureBackend() {
  if (await healthy()) { log('后端已在运行，复用现有实例'); return; }
  log('后端未运行，正在启动…');
  backendChild = spawnBackend();
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    if (await healthy()) { log('后端已就绪'); return; }
  }
  throw new Error('后端 20 秒内没有启动成功');
}

function startBackendWatch() {
  clearInterval(backendWatch);
  backendWatch = setInterval(async () => {
    if (backendChild) return;
    if (await healthy()) return;
    log('后端已不在，尝试重新启动');
    try { await ensureBackend(); } catch (e) { log('重启后端失败：', e.message); }
  }, 10000);
}

// ---------- 独立渲染内核（V2：真 C++ 内核，假内核仅作回退）----------
// 方案3 的核心：壁纸不再由 Electron 画，交给独立内核进程。
// 默认拉 wallcore.exe（D3D11 硬解贴桌面）；内核 exe 缺失时自动回退假内核（只打印）。
// WF_CORE_FAKE=1 可强制假内核（调试用）；NO_ATTACH 自检时给内核传 WF_CORE_NO_ATTACH=1 不碰桌面。
const CORE_EXE = path.join(ROOT, 'core', 'wallcore', 'build', 'bin', 'Release', 'wallcore.exe');
const USE_NATIVE_CORE = fs.existsSync(CORE_EXE) && process.env.WF_CORE_FAKE !== '1';
log('内核模式：', USE_NATIVE_CORE ? '真 C++ 内核 (wallcore.exe)' : '假内核 (回退/调试)');

async function healthyCore() {
  try {
    const corePort = Number(process.env.WF_CORE_PORT || 3002);
    const r = await fetch(`http://127.0.0.1:${corePort}/api/core/health`, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch { return false; }
}

function spawnCore() {
  let out = 'ignore';
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const f = path.join(LOG_DIR, 'core.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, '');
    out = fs.openSync(f, 'a');
  } catch { /* 打不开就忽略 */ }

  let child;
  if (USE_NATIVE_CORE) {
    // 真内核是 WIN32 GUI 程序，不依赖控制台；自检时传 NO_ATTACH 不碰真实桌面
    const env = { ...process.env };
    if (NO_ATTACH) env.WF_CORE_NO_ATTACH = '1';
    child = spawn(CORE_EXE, [], {
      cwd: path.dirname(CORE_EXE), env, stdio: ['ignore', out, out], windowsHide: true,
    });
    log('启动真内核：', CORE_EXE);
  } else {
    const script = path.join(ROOT, 'core', 'fake-core.mjs');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    child = spawn(process.execPath, [script], {
      cwd: ROOT, env, stdio: ['ignore', out, out], windowsHide: true,
    });
    log('启动假内核：', script);
  }
  child.on('error', (e) => log('内核启动出错：', e.message));
  child.on('exit', (c) => {
    log('内核进程退出 code=', c);
    if (coreChild !== child) return;
    coreChild = null;
    // 0xC0000005 / 意外退出会让视频壁纸永久消失。真内核自己修完竞态后，
    // 这里只做兜底：异常退出就重启并重新下发当前壁纸，用户无感。
    if (!quitting && USE_NATIVE_CORE) scheduleCoreRestart(c);
  });
  return child;
}

async function ensureCore() {
  if (await healthyCore()) { log('内核已在运行，复用现有实例'); return; }
  log('内核未运行，正在启动…');
  coreChild = spawnCore();
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    if (await healthyCore()) { log('内核已就绪'); return; }
  }
  log('内核 4 秒内未就绪（spike 阶段不影响启动）');
}

// 内核异常退出自愈：重启 -> 健康确认 -> 重新下发当前壁纸 -> 恢复归属轮询。
// 这是兜底，不是掩盖 bug；真正的线程竞态已在 wallcore.cpp 侧加锁修掉。
function scheduleCoreRestart(code) {
  if (coreRestoring || quitting || !USE_NATIVE_CORE) return;
  coreRestoring = true;
  log('内核异常退出，准备自动拉起：', code);
  clearTimeout(coreWatch);
  coreWatch = setTimeout(async () => {
    try {
      if (quitting) return;
      await ensureCore();
      if (!(await healthyCore())) { log('内核自动拉起失败：健康探测未通过'); return; }
      log('内核已自动拉起，恢复当前壁纸');
      await restoreWallpaper();
      if (!SELFTEST && !NO_ATTACH) startRenderModeWatch();
    } catch (e) {
      log('内核自动恢复失败：', e.message);
    } finally {
      coreRestoring = false;
    }
  }, 800);
}

function statePath() { return path.join(app.getPath('userData'), 'window.json'); }

function loadWinState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (typeof s.width === 'number' && s.width > 400) return s;
  } catch { /* 首次运行没有状态文件 */ }
  return { width: 1320, height: 860 };
}

function saveWinState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  try {
    const b = mainWin.getNormalBounds ? mainWin.getNormalBounds() : mainWin.getBounds();
    fs.writeFileSync(statePath(), JSON.stringify({ ...b, maximized: mainWin.isMaximized() }));
  } catch { /* 忽略 */ }
}

function createMainWindow() {
  const st = loadWinState();
  // 上次存的尺寸可能小于现在的最小值（窗口缩得很小时存的），进来先夹一次，
  // 否则会先按旧尺寸创建再被系统拉回，闪一下
  const MIN_W = 960, MIN_H = 700;
  const win = new BrowserWindow({
    width: Math.max(MIN_W, st.width || MIN_W), height: Math.max(MIN_H, st.height || MIN_H), x: st.x, y: st.y,
    minWidth: MIN_W, minHeight: MIN_H,
    frame: false, backgroundColor: '#0b0c0d', show: false,
    title: 'WallFlow', icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`${BASE}/index.html?app=1`);

  win.once('ready-to-show', () => {
    if (st.maximized) win.maximize();
    // 「启动时最小化到托盘」：启动后不弹窗，用户从托盘图标打开（壁纸已经在跑）
    if (prefs.startMinimized) { log('设置为启动时最小化，主窗口先不显示'); return; }
    win.show();
  });

  // V8：关窗默认真正销毁界面进程（释放 renderer 的 ~200MB），壁纸由独立内核继续画，不受影响。
  // 旧实现 win.hide() 只是隐藏，renderer 完整常驻，是常驻内存高的主因之一。
  // 用户关掉这一项则按普通软件处理 —— 关窗即退出。
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    saveWinState();
    if (prefs.closeToTray) {
      log('关闭窗口 = 销毁界面（壁纸由内核继续渲染），托盘保留');
      win.destroy();          // 彻底销毁 renderer，释放内存
      mainWin = null;         // showMain() 下次会重新 createMainWindow()
      return;
    }
    log('关闭窗口 = 退出（未开启驻留托盘）');
    quitApp();
  });
  win.on('resize', saveWinState);
  win.on('move', saveWinState);

  // 页面里的 target=_blank / window.open 一律走系统浏览器，不在应用内开新窗
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // 加载失败要能自愈：后端没起来时 loadURL 会失败，之前只写日志，
  // 之后后端被 backendWatch 拉起来了页面也永远不会重试（frameless 无菜单，连 Ctrl+R 都没有）
  let loadRetries = 0;
  win.webContents.on('did-finish-load', () => { loadRetries = 0; });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('主界面加载失败', code, desc);
    if (quitting || loadRetries >= 8) return;
    loadRetries++;
    setTimeout(() => {
      try { if (!win.isDestroyed()) win.loadURL(`${BASE}/index.html?app=1`); } catch { /* 窗口已销毁 */ }
    }, Math.min(1500 * loadRetries, 6000));
  });
  return win;
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) { mainWin = createMainWindow(); return; }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

// ---------- 壁纸层 ----------

function createWallpaperWindow() {
  const d = screen.getPrimaryDisplay();
  const b = d.bounds;
  bounds = b;
  log('屏幕：', JSON.stringify({ bounds: b, workArea: d.workArea, scaleFactor: d.scaleFactor }));
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, focusable: false, skipTaskbar: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false, show: false,
    backgroundColor: '#000000', title: 'WallFlow Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload-desktop.cjs'),
      backgroundThrottling: false,
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`${BASE}/desktop.html`);
  // 同主窗口：加载失败退避重试，后端恢复后页面能自己跟上
  let loadRetries = 0;
  win.webContents.on('did-finish-load', () => { loadRetries = 0; });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log('渲染页加载失败', code, desc);
    if (quitting || loadRetries >= 8) return;
    loadRetries++;
    setTimeout(() => {
      try { if (!win.isDestroyed()) win.loadURL(`${BASE}/desktop.html`); } catch { /* 窗口已销毁 */ }
    }, Math.min(1500 * loadRetries, 6000));
  });
  return win;
}

function tryAttach() {
  if (!wallpaperWin || wallpaperWin.isDestroyed()) return;
  try {
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const phys = {
      x: Math.round(bounds.x * sf), y: Math.round(bounds.y * sf),
      width: Math.round(bounds.width * sf), height: Math.round(bounds.height * sf),
    };
    const r = attachToDesktop(wallpaperWin.getNativeWindowHandle(), phys);
    attachState = r;
    hostHandle = r.host || 0;
    log('贴桌面：', r.ok ? '成功' : '失败', JSON.stringify({
      via: r.via, hostClass: r.hostClass, parentClass: r.parentClass, reason: r.reason,
      hostSize: r.hostSize, winRect: r.winRect,
    }));
    if (r.ok) {
      const h = wallpaperWin.getNativeWindowHandle();
      [400, 1500].forEach((ms) => setTimeout(() => {
        try {
          if (!wallpaperWin || wallpaperWin.isDestroyed()) return;
          const f = fit(h, r.host);
          if (f) log('铺满校验：', JSON.stringify(f));
        } catch { /* 忽略 */ }
      }, ms));
    }
  } catch (e) {
    attachState = { ok: false, reason: '异常：' + (e && e.message) };
    log('贴桌面异常：', e && e.message, '\n', e && e.stack);
  }
}

function startWatchdog() {
  clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (!wallpaperWin || wallpaperWin.isDestroyed() || NO_ATTACH) return;
    if (!isAttached(wallpaperWin.getNativeWindowHandle(), hostHandle)) {
      log('检测到壁纸层丢失，重新贴一次');
      tryAttach();
      return;
    }
    // 还挂着但没盖满（被系统按工作区夹小、或被别的壁纸窗口挤动）→ 原地重铺
    try {
      if (needsRefit(wallpaperWin.getNativeWindowHandle(), hostHandle)) {
        const f = fit(wallpaperWin.getNativeWindowHandle(), hostHandle);
        log('检测到未铺满，重新铺一次：', JSON.stringify(f));
      }
    } catch { /* 忽略 */ }
  }, 5000);
}

// ---------- 桌面渲染归属：内核 / 浏览器按壁纸类型互斥 ----------
// 网页(index.html) 和场景(scene.pkg) mpv 播不了，只能由 Electron 壁纸窗口
// （WebWallGL + sandbox iframe）渲染；视频/图片则交给 C++ 内核硬解贴桌面。
// 两个窗口绝不能同时挂在 WorkerW 上：会互相挤 Z 序，用户看到的就是「壁纸被 WE 顶掉」。
function destroyWallpaperWindow() {
  clearInterval(watchdog); watchdog = null;
  stopCursorFeed();
  if (wallpaperWin && !wallpaperWin.isDestroyed()) {
    try { detach(wallpaperWin.getNativeWindowHandle()); } catch { /* 忽略 */ }
    try { wallpaperWin.destroy(); } catch { /* 忽略 */ }
  }
  wallpaperWin = null;
  hostHandle = 0;
  attachState = null;
}

async function ensureWallpaperWindow() {
  if (wallpaperWin && !wallpaperWin.isDestroyed()) return;
  wallpaperWin = createWallpaperWindow();
  wallpaperWin.once('ready-to-show', () => {
    if (!wallpaperWin || wallpaperWin.isDestroyed()) return;
    wallpaperWin.showInactive();
    startCursorFeed();
    if (!NO_ATTACH) { tryAttach(); startWatchdog(); }
  });
  wallpaperWin.on('closed', () => {
    if (quitting || NO_ATTACH || renderMode !== 'desktop') return;
    log('壁纸窗口被系统销毁，2 秒后重建');
    wallpaperWin = null;
    stopCursorFeed();
    clearInterval(watchdog); watchdog = null;
    setTimeout(() => {
      if (quitting || wallpaperWin || renderMode !== 'desktop') return;
      ensureWallpaperWindow();
    }, 2000);
  });
  wallpaperWin.webContents.on('render-process-gone', (_e, details) => {
    if (quitting) return;
    log('壁纸渲染进程崩溃，1.5 秒后重载：', JSON.stringify(details));
    setTimeout(() => {
      try { if (wallpaperWin && !wallpaperWin.isDestroyed()) wallpaperWin.webContents.reload(); } catch { /* closed 会走重建 */ }
    }, 1500);
  });
}

async function applyRenderMode(mode) {
  if (quitting || NO_ATTACH || !USE_NATIVE_CORE) return;
  if (!mode || mode === renderMode) return;
  log('桌面渲染归属切换：', renderMode || '(none)', '→', mode);
  renderMode = mode;
  // 媒体命令（hide/play）由后端 apply / restore 统一下发，内核 play 成功后
  // 会自己 setVisible(true)。这里只管桌面层的“谁来画”，不再重复发命令，
  // 避免切换时两套路径交错（也是之前黑屏/抖动的帮凶）。
  if (mode === 'desktop') {
    await ensureWallpaperWindow();
  } else {
    destroyWallpaperWindow();
  }
}

function startRenderModeWatch() {
  clearInterval(renderWatch);
  renderWatch = setInterval(async () => {
    if (quitting || NO_ATTACH || SELFTEST || !USE_NATIVE_CORE) return;
    try {
      const r = await fetch(`${BASE}/api/v1/apply/current`, { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      const mode = j.code === 0 && j.data?.id
        ? (j.data.renderBy === 'desktop' ? 'desktop' : 'core')
        : null;
      await applyRenderMode(mode);
    } catch { /* 后端短暂不可用，下轮再试 */ }

    // 全局渲染节拍（WE 同款）：后端 render_fps 是唯一源，变了就下发内核，
    // 让视频/图片按目标节拍 Present。场景/网页由桌面页经 SSE 自行应用。
    try {
      const sr = await fetch(`${BASE}/api/v1/play/state`, { signal: AbortSignal.timeout(1500) });
      const sj = await sr.json();
      const fps = Number(sj.data?.renderFps);
      if ([30, 60, 72, 144].includes(fps) && fps !== lastRenderFps) {
        lastRenderFps = fps;
        notifyCoreCommand('fps', { fps });
        log('全局渲染节拍下发内核：', fps, 'fps');
      }
    } catch { /* 后端短暂不可用，下轮再试 */ }
  }, 1200);
}

// 开机恢复：内核启动后把数据库里记住的当前壁纸重新下发一次。
// 不重建静态系统壁纸（Windows 自己记得），只恢复动态画面与渲染归属。
async function restoreWallpaper() {
  try {
    const r = await fetch(`${BASE}/api/v1/apply/restore`, {
      method: 'POST', signal: AbortSignal.timeout(4000),
    });
    const j = await r.json();
    log('开机恢复壁纸：', JSON.stringify(j.data || j.message));
    if (j.code === 0 && j.data?.renderBy) await applyRenderMode(j.data.renderBy);
  } catch (e) { log('开机恢复失败：', e.message); }
}

// ---------- 光标旁听 ----------
// 壁纸窗口挂在桌面图标层下面，真实鼠标事件全被图标层截走，窗口一个都收不到。
// 所以主进程自己读光标位置送给渲染层，渲染层再合成事件塞进壁纸页面。
//
// 按键只读左键，而且是"按需开"：只有当前壁纸是网页壁纸、且用户打开了点击开关时才读。
// 一旦打开就意味着整个桌面的左键都会被旁听（点图标、拖文件都算），
// 副作用是壁纸会跟着一起响应 —— 这是这条路绕不开的，所以默认关。

const CURSOR_TICK = 16;    // 60Hz，一帧一次，再快渲染层也用不上
let clickWanted = false;   // 渲染层告诉我当前壁纸要不要点击
let lastCursor = null;     // 上一帧位置，没动就不发
let lastDown = false;      // 上一帧左键状态，用来做边沿检测

function startCursorFeed() {
  clearInterval(cursorTimer);
  cursorTimer = setInterval(() => {
    if (!wallpaperWin || wallpaperWin.isDestroyed()) return;
    let p;
    try { p = screen.getCursorScreenPoint(); } catch { return; }
    // 窗口被 SetParent 成宿主的子窗口后 screenX/screenY 不可靠，
    // 用建窗口时记下的屏幕 bounds 换算，渲染层直接拿到的就是窗口内 CSS 坐标。
    const x = p.x - bounds.x, y = p.y - bounds.y;
    if (!lastCursor || lastCursor.x !== x || lastCursor.y !== y) {
      lastCursor = { x, y };
      wallpaperWin.webContents.send('wf:cursor', { type: 'move', x, y });
    }
    if (!clickWanted) return;
    const down = leftButtonDown();
    if (down === lastDown) return;
    lastDown = down;
    wallpaperWin.webContents.send('wf:cursor', { type: down ? 'down' : 'up', x, y });
  }, CURSOR_TICK);
}

function stopCursorFeed() {
  clearInterval(cursorTimer);
  cursorTimer = null;
  lastCursor = null;
  lastDown = false;
  clickWanted = false;
}

// ---------- 全屏应用自动暂停 ----------
// 全屏游戏/视频时壁纸被完全遮住，继续渲染只是白烧显卡。检测到就暂停，退出就恢复。

// 给独立内核发命令（V1 信号链复用）。fire-and-forget，内核不可达不影响主流程。
async function notifyCoreCommand(cmd, extra = {}) {
  try {
    const corePort = Number(process.env.WF_CORE_PORT || 3002);
    const r = await fetch(`http://127.0.0.1:${corePort}/api/core/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, ...extra, ts: Date.now() }),
      signal: AbortSignal.timeout(3000),
    });
    log(`内核命令 ${cmd}：`, r.ok ? '已送达' : '失败 ' + r.status);
  } catch (e) {
    log(`内核命令 ${cmd} 不可达：`, e.message);
  }
}

// V9 暂停统一入口。三种原因（全屏 / 电池 / 手动）聚合成一个状态：
// 任何一个原因成立 → 暂停；全部解除 → 恢复。避免"退出全屏但还在电池上"误恢复。
// 暂停分两档（prefs.stopOnPause）：
//   · Stop（默认）：给内核发 tier=2 真正卸载解码器释放 RAM/VRAM，保留最后一帧画面；
//                   恢复时发 reload 用记住的路径重建并上屏。≈ WE 的 Stop 语义。
//   · Pause（关闭 stopOnPause 时）：只发 pause，保留解码器，恢复更快但不省内存。
// 关键纪律：全程不碰壁纸窗口的创建/销毁/父子关系（T28–T30 的黑屏教训）。
const pauseReasons = new Set();
let pauseActive = false;

function notifyWallpaperPagePaused(paused) {
  if (!wallpaperWin || wallpaperWin.isDestroyed()) return;
  const js = `(function(){
    var d = window.WF_DESKTOP;
    if (!d) return 'no-page';
    d.setPaused(${paused});
    var v = document.querySelector('video');
    return JSON.stringify({ layers: d.layerCount, paused: d.paused, videoPaused: v ? v.paused : null });
  })()`;
  wallpaperWin.webContents.executeJavaScript(js)
    .then((s) => log(`壁纸页已${paused ? '暂停' : '恢复'}：`, s))
    .catch((e) => log('通知壁纸页失败：', e.message));
}

function setPauseReason(reason, active) {
  if (active) pauseReasons.add(reason); else pauseReasons.delete(reason);
  const shouldPause = pauseReasons.size > 0;
  if (shouldPause === pauseActive) return;
  pauseActive = shouldPause;
  fsPaused = shouldPause;   // 兼容既有自检/托盘读取
  const coreActive = renderMode === 'core';
  if (shouldPause) {
    log(`壁纸进入暂停（原因：${[...pauseReasons].join('+')}，归属=${renderMode || 'none'}）`);
    // 只操作真正负责画面的那一层，避免误伤：
    //  · 内核归属 → 对内核 Stop/Pause；
    //  · 桌面归属（html/scene）→ 只暂停壁纸页，内核此刻本就 standby 隐藏，不碰它。
    if (coreActive) {
      if (prefs.stopOnPause) {
        notifyCoreCommand('tier', { tier: 2 });
        log('已请求内核 Stop（tier=2，卸载解码器释放内存）');
      } else {
        notifyCoreCommand('pause', { paused: true });
      }
    }
    notifyWallpaperPagePaused(true);
  } else {
    log('壁纸恢复（暂停原因已全部解除，归属=' + (renderMode || 'none') + '）');
    if (coreActive) {
      if (prefs.stopOnPause) {
        // 用记住的路径重建解码器并上屏（play 自包含 show，不碰窗口生命周期）
        notifyCoreCommand('reload');
      } else {
        notifyCoreCommand('pause', { paused: false });
      }
    }
    notifyWallpaperPagePaused(false);
  }
}

// 保留旧的 notifyPaused 名字供少量兼容调用；语义改为走统一原因聚合器的「手动」原因
function notifyPaused(paused) { setPauseReason('manual', paused); }

// 仅自检用：强制交替"全屏/非全屏"，用于验证 暂停 → 恢复 的整条链路
// （真实判据已在 shell/fullscreen.mjs 单独验证过，这里只测 IPC 与渲染层响应）
const FS_FORCE = process.env.WF_FS_FORCE === '1';

function startFullscreenWatch() {
  clearInterval(fullWatch);
  fullWatch = setInterval(() => {
    // V2 前置修复：全屏检测不能依赖壁纸窗口存在。V2 摘掉 Electron 壁纸窗口后
    // wallpaperWin 为 null，若在此 return，暂停信号根本不会产生。
    // 检测本身(isFullscreenApp)与通知内核(notifyPaused 内部先发内核命令)都不依赖壁纸窗口；
    // 仅「通知壁纸页 JS」那一步在 notifyPaused 内部有独立守卫，安全。
    if (!prefs.autoPauseOnFullscreen) {
      if (pauseReasons.has('fullscreen')) setPauseReason('fullscreen', false);
      return;
    }
    let r;
    if (FS_FORCE) {
      r = { fullscreen: !pauseReasons.has('fullscreen'), cls: 'ForceTest', reason: 'forced', rect: { l: 0, t: 0, r: 0, b: 0 } };
    } else {
      try { r = isFullscreenApp(); } catch (e) { return; }
      // 自家窗口（比如主窗口被拖成整屏）不算全屏应用，否则会自己把自己暂停
      if (r.fullscreen) {
        const own = BrowserWindow.getAllWindows().some((w) => {
          try { return toHwnd(w.getNativeWindowHandle()) === r.hwnd; } catch { return false; }
        });
        if (own) r = { fullscreen: false, reason: 'own-window' };
      }
    }
    if (r.fullscreen === pauseReasons.has('fullscreen')) return;
    log(r.fullscreen
      ? `检测到全屏应用（${r.cls} ${r.rect.l},${r.rect.t},${r.rect.r},${r.rect.b}）→ 暂停壁纸`
      : `全屏应用已退出（${r.reason}）→ 恢复壁纸`);
    setPauseReason('fullscreen', r.fullscreen);
  }, 1200);
}

// 电池暂停：用电池供电时暂停壁纸省电，插回电源恢复。WE 官方同款策略。
function startPowerWatch() {
  try {
    const pm = require('electron').powerMonitor;
    if (typeof pm.isOnBatteryPower === 'function') {
      const apply = () => {
        if (!prefs.pauseOnBattery) { if (pauseReasons.has('battery')) setPauseReason('battery', false); return; }
        const onBattery = !!pm.isOnBatteryPower();
        log('电源状态：', onBattery ? '电池供电' : '外接电源');
        setPauseReason('battery', onBattery);
      };
      pm.on('on-battery', apply);
      pm.on('on-ac', apply);
      apply();   // 启动时先按当前电源状态判一次
      log('电池暂停监听已启动');
    } else {
      log('当前 Electron 不支持 isOnBatteryPower，电池暂停跳过');
    }
  } catch (e) { log('电池暂停监听启动失败：', e.message); }
}

// 应用规则检测：方案 A —— 规则里的 exe 只要有一个在运行就暂停壁纸，全都退出才恢复。
// 用系统自带 tasklist 按镜像名匹配（零外部依赖，绿色包零安装铁律不受影响），约 2 秒一次。
// 只调用现成的 setPauseReason('appRule')，复用 T33 已验证的暂停链路，全程不碰窗口生命周期。
let appWatch = null;

function checkAppRules() {
  if (quitting || appChecking) return;
  if (!appRules.length) {
    if (pauseReasons.has('appRule')) setPauseReason('appRule', false);
    if (appRuleActive) { log('应用规则已清空 → 恢复壁纸'); appRuleActive = false; }
    return;
  }
  appChecking = true;
  execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
    appChecking = false;
    if (err || quitting) { if (err) log('应用规则检测：tasklist 失败 ' + err.message); return; }
    // CSV 每行形如 "notepad.exe","1234","Console","1","4,024 K"，第一列是镜像名（进程名本身不分大小写）
    const running = new Set();
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\s*"([^"]+\.exe)"/i);
      if (m) running.add(m[1].toLowerCase());
    }
    const hit = appRules.find((exe) => running.has(exe)) || null;
    if (!!hit !== appRuleActive) {
      appRuleActive = !!hit;
      log(hit ? `应用规则命中（${hit} 正在运行）→ 暂停壁纸` : '应用规则中的程序已全部退出 → 恢复壁纸');
    }
    setPauseReason('appRule', !!hit);
  });
}

function startAppRuleWatch() {
  clearInterval(appWatch);
  loadAppRules();
  checkAppRules();
  appWatch = setInterval(checkAppRules, 2000);
  log('应用规则检测已启动（规则数：' + appRules.length + '）');
}

// ---------- 托盘 / 退出 ----------

// 托盘菜单每次都按当前设置重建：设置页改了「全屏暂停」，这里要跟着变，
// 两处共用一个 prefs，不会出现"设置页关了、托盘还开着"的矛盾
function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开 WallFlow', click: () => showMain() },
    { label: '重新载入壁纸', click: () => {
      if (USE_NATIVE_CORE && renderMode !== 'desktop') {
        notifyCoreCommand('reload');   // 视频/图片：让内核重播它记住的最后一个媒体
      } else {
        try { wallpaperWin?.webContents.reload(); } catch { /* 窗口已销毁 */ }
      }
    } },
    {
      label: '全屏时自动暂停', type: 'checkbox', checked: !!prefs.autoPauseOnFullscreen,
      click: (item) => { setPrefs({ autoPauseOnFullscreen: item.checked }); },
    },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '退出 WallFlow', click: () => quitApp() },
  ]);
}

function createTray() {
  const img = fs.existsSync(TRAY_PNG) ? nativeImage.createFromPath(TRAY_PNG) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('WallFlow 桌面壁纸');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => showMain());
  tray.on('double-click', () => showMain());
}

function quitApp() {
  quitting = true;
  clearInterval(watchdog);
  clearInterval(backendWatch);
  clearInterval(fullWatch);
  clearInterval(renderWatch);
  clearInterval(appWatch);
  clearTimeout(coreWatch);
  stopCursorFeed();
  try { if (wallpaperWin && !wallpaperWin.isDestroyed()) detach(wallpaperWin.getNativeWindowHandle()); } catch { /* 忽略 */ }
  if (coreChild) {
    try { coreChild.kill(); } catch { /* 忽略 */ }
    coreChild = null;
  }
  if (backendChild) {
    gracefulBackendStop(backendChild).catch(() => {});
    setTimeout(() => { try { if (backendChild) backendChild.kill(); } catch { /* 忽略 */ } }, 3500);
  }
  app.quit();
}

// ---------- 启动 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 第二次双击图标：把已经开着的窗口拿出来
  app.on('second-instance', () => showMain());

  // 导出 ZIP 时弹系统「另存为」，而不是静默下载到某个目录
  app.whenReady().then(() => {
    session.defaultSession.on('will-download', (e, item) => {
      try { item.setSaveDialogOptions({ title: '导出壁纸', defaultPath: item.getFilename() }); } catch { /* 忽略 */ }
    });

    ipcMain.on('wf:win', (e, action) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w) return;
      if (action === 'minimize') w.minimize();
      else if (action === 'maximize') { w.isMaximized() ? w.unmaximize() : w.maximize(); }
      else if (action === 'close') w.close();
    });
    ipcMain.handle('wf:win', (e, action) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      return action === 'isMaximized' ? !!w?.isMaximized() : false;
    });
    ipcMain.handle('wf:app', (e, what) => {
      if (what === 'version') return app.getVersion();
      if (what === 'nativeCore') return !!USE_NATIVE_CORE;
      // 正在播放页的网页壁纸要显示“跟随显示器刷新率”。浏览器没有读刷新率的标准 API，
      // 只能从主进程的 screen 取；拿不到就返回 null，界面按“没有就不显示”处理。
      if (what === 'displayRefreshRate') {
        try {
          const hz = Number(screen.getPrimaryDisplay().refreshRate);
          return Number.isFinite(hz) && hz > 0 ? Math.round(hz) : null;
        } catch { return null; }
      }
      return null;
    });
    // 资源管理器打开壁纸所在文件夹并选中文件：路径必须真实存在才放行，
    // 防止渲染层被注入后拿任意路径乱开窗口
    ipcMain.handle('wf:reveal', (_e, p) => {
      try {
        const target = String(p || '');
        if (!target || !fs.existsSync(target)) return 'missing';
        shell.showItemInFolder(target);
        return 'ok';
      } catch { return 'error'; }
    });
    ipcMain.on('wf:app', (e, what) => {
      if (what === 'openDataDir') shell.openPath(app.getPath('userData'));
    });
    // 应用壁纸成功后前端立刻通知：不等 1.2 秒轮询，立即切换桌面渲染归属。
    // 轮询仍保留作兜底（比如托盘操作、命令行改库等非界面路径）。
    ipcMain.on('wf:applied', (_e, renderBy) => {
      if (quitting || NO_ATTACH || !USE_NATIVE_CORE) return;
      const mode = renderBy === 'desktop' || renderBy === 'core' ? renderBy : null;
      if (mode) applyRenderMode(mode).catch((err) => log('即时切换渲染归属失败：', err?.message));
    });
    // 设置页的「常规设置」：读 / 写都走这里。写的时候主进程立刻生效（开机项、托盘菜单等），
    // 不等下次启动 —— 用户点了开关就该马上看到结果。
    ipcMain.handle('wf:prefs', (e, patch) => {
      if (patch && typeof patch === 'object') return setPrefs(patch);
      return prefs;
    });
    // 应用规则（exe 名数组）：不带参数是读，带数组是改（立即生效并落盘）
    ipcMain.handle('wf:appRules', (e, list) => {
      if (Array.isArray(list)) return setAppRules(list);
      return getAppRules();
    });
    // 壁纸层要不要旁听左键：由渲染层按「当前壁纸是不是网页 + 用户开关」决定。
    // 只接受壁纸窗口自己发来的，别的地方改了不算数。
    ipcMain.on('wf:cursor-click', (e, on) => {
      if (!wallpaperWin || e.sender !== wallpaperWin.webContents) return;
      clickWanted = !!on;
      if (!on) lastDown = false;
    });
    // 壁纸层整体静音开关：网页壁纸里的音轨不受 <video muted> 控制，只能整窗静音。
    // 只接受壁纸窗口自己发来的，别的地方改了不算数。
    ipcMain.on('wf:audio', (e, muted) => {
      if (!wallpaperWin || wallpaperWin.isDestroyed() || e.sender !== wallpaperWin.webContents) return;
      try { wallpaperWin.webContents.setAudioMuted(!!muted); } catch { /* 窗口正在销毁就算了 */ }
      log('壁纸层声音：', muted ? '静音' : '放开');
    });
    // 导出定位：ZIP 用系统「另存为」，文件夹用「选择文件夹」。
    // 取消返回空串，前端据此直接中止，不会写出半截文件。
    ipcMain.handle('wf:dialog', async (e, kind, defaultName) => {
      const win = BrowserWindow.fromWebContents(e.sender) || mainWin;
      try {
        if (kind === 'save') {
          const r = await dialog.showSaveDialog(win, {
            title: '导出壁纸',
            defaultPath: String(defaultName || 'wallpaper.zip'),
            filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
          });
          return r.canceled ? '' : r.filePath;
        }
        if (kind === 'dir') {
          const r = await dialog.showOpenDialog(win, {
            title: '选择导出位置',
            properties: ['openDirectory', 'createDirectory'],
          });
          return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
        }
        // 设置页挑目录：和导出分开，标题写清楚，别让用户以为是导出
        if (kind === 'folder') {
          const r = await dialog.showOpenDialog(win, {
            title: '选择文件夹',
            buttonLabel: '用这个文件夹',
            properties: ['openDirectory', 'createDirectory'],
          });
          return r.canceled || !r.filePaths.length ? '' : r.filePaths[0];
        }
      } catch { /* 对话框被系统打断就当取消 */ }
      return '';
    });
  });

  app.whenReady().then(async () => {
    log('数据目录：', USE_EXTERNAL_DATA ? DATA_HOME : path.join(ROOT, 'server'));
    log('本机设置：', JSON.stringify(prefs));
    applyLoginItem();   // 程序可能被挪到别的路径，每次启动把开机项对齐一次
    prepareDataHome();
    try {
      await ensureBackend();
    } catch (e) {
      log('无法启动后端：', e.message);
      // 不能弹模态框：打包后没人点会一直卡住，改成写日志 + 界面自己会显示错误
    }
    await ensureCore();   // V1 spike：拉起独立内核，验证信号链

    // V2：真内核模式下壁纸由 C++ 画在 WorkerW，Electron 不再创建壁纸窗口
    // （否则两个窗口抢桌面层，还构成跨进程父子窗口链）。假内核模式保留旧链路供回退/对照。
    if (!USE_NATIVE_CORE) {
      wallpaperWin = createWallpaperWindow();
      wallpaperWin.once('ready-to-show', () => {
        wallpaperWin.showInactive();
        startCursorFeed();
        if (!NO_ATTACH) { tryAttach(); startWatchdog(); }
      });

      // 生命周期自愈：壁纸窗口被系统销毁（explorer 重启 / 改分辨率级联销毁子窗口）、
      // 渲染进程崩溃（WebGL 是 OOM 高发区）时，之前没有任何恢复路径，桌面会永久黑屏。
      wallpaperWin.on('closed', () => {
        if (quitting || NO_ATTACH) return;
        log('壁纸窗口被系统销毁，2 秒后重建');
        wallpaperWin = null;
        stopCursorFeed();
        setTimeout(() => {
          if (quitting || wallpaperWin) return;
          wallpaperWin = createWallpaperWindow();
          wallpaperWin.once('ready-to-show', () => {
            wallpaperWin.showInactive();
            startCursorFeed();
            if (!NO_ATTACH) tryAttach();
          });
        }, 2000);
      });
      wallpaperWin.webContents.on('render-process-gone', (_e, details) => {
        if (quitting) return;
        log('壁纸渲染进程崩溃，1.5 秒后重载：', JSON.stringify(details));
        setTimeout(() => {
          try { if (wallpaperWin && !wallpaperWin.isDestroyed()) wallpaperWin.webContents.reload(); } catch { /* 窗口已销毁，closed 会走重建 */ }
        }, 1500);
      });
    } else {
      log('真内核模式：按壁纸类型分配桌面渲染归属（视频/图片→内核，网页/场景→浏览器）');
      if (!SELFTEST && !NO_ATTACH) {
        await restoreWallpaper();
        startRenderModeWatch();
      }
    }

    // 全局服务不依赖壁纸窗口：放在外层，真内核模式下也会启动
    // （旧代码把它们挂在壁纸窗口 ready-to-show 里，壁纸窗口出问题会导致全屏暂停失效）
    startBackendWatch();
    startFullscreenWatch();
    startPowerWatch();
    if (!SELFTEST) startAppRuleWatch();   // 应用规则暂停（方案A）：与全屏/电池并列，不依赖壁纸窗口
    if (!SELFTEST) createTray();

    if (!SELFTEST && !NO_WINDOW) mainWin = createMainWindow();

    if (SHOT) {
      await sleep(5000);
      try {
        const info = await mainWin.webContents.executeJavaScript(`JSON.stringify({
          bodyClass: document.body.className,
          hasShell: !!window.WF_SHELL,
          winbar: !!document.getElementById('wfWinbar'),
          cards: document.querySelectorAll('.wall-card').length,
          title: document.title,
          size: [innerWidth, innerHeight],
        })`);
        log('主窗口状态：', info);
        // 程序化点一下最大化：验证 preload → IPC → 主进程这条链路（真鼠标另测）
        await mainWin.webContents.executeJavaScript(`document.querySelector('#wfWinbar [data-wf="max"]').click(); 1`);
        await sleep(700);
        log('点击最大化后 isMaximized =', mainWin.isMaximized());
        const img = await mainWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '_main.png'), img.toPNG());
        log('主窗口截图 shell/_main.png', img.getSize());

        // V8 自检：程序化关窗，验证 renderer 真正销毁（而不是 hide 常驻）
        // V2 真内核模式下额外核对：关窗后 C++ 内核仍存活（壁纸不受界面关窗影响）
        const wallpaperAliveBefore = wallpaperWin && !wallpaperWin.isDestroyed();
        const coreAliveBefore = !!coreChild && coreChild.exitCode === null;
        mainWin.close();
        await sleep(400);
        log('V8 关窗自检：', JSON.stringify({
          mainWinDestroyed: mainWin === null,
          nativeCore: USE_NATIVE_CORE,
          coreAliveBefore,
          coreStillAlive: !!coreChild && coreChild.exitCode === null,
          wallpaperStillAlive: wallpaperWin && !wallpaperWin.isDestroyed(),
          wallpaperAliveBefore,
        }));
      } catch (e) { log('主窗口截图失败：', e.message); }
      quitting = true;
      app.exit(0);
    }

    if (SELFTEST) {
      await sleep(6000);
      // 真内核模式没有壁纸窗口，自检改为验证内核健康 + 让用户发 play 命令观察渲染日志
      if (USE_NATIVE_CORE) {
        const coreOk = await healthyCore();
        log('真内核自检：', JSON.stringify({ healthy: coreOk, nativeCore: true, pid: coreChild?.pid || null }));
        if (HOLD > 0) await sleep(HOLD * 1000);
        quitting = true;
        app.exit(0);
      }
      try {
        const info = await wallpaperWin.webContents.executeJavaScript(`(function(){
          const s=document.getElementById('stage');
          return JSON.stringify({
            href: location.href,
            stageChildren: s?s.children.length:-1,
            stageHtml: s? s.innerHTML.slice(0,140):'',
            hint: (document.getElementById('hint')||{}).style && document.getElementById('hint').style.display,
            dbg: (document.getElementById('dbg')||{}).textContent,
            vid: (function(){const v=document.querySelector('video');return v?{w:v.videoWidth,h:v.videoHeight,rs:v.readyState,paused:v.paused}:null})(),
          });
        })()`);
        log('页面状态：', info);
      } catch (e) { log('读取页面状态失败：', e.message); }
      try {
        const img = await wallpaperWin.webContents.capturePage();
        fs.writeFileSync(path.join(__dirname, '_selftest.png'), img.toPNG());
        const a = img.toBitmap();
        await sleep(1000);
        const b = (await wallpaperWin.webContents.capturePage()).toBitmap();
        let diff = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i += 4) if (Math.abs(a[i] - b[i]) > 8) diff++;
        log('动态性：像素变化率 ' + (diff / (a.length / 4) * 100).toFixed(2) + '%');
      } catch (e) { log('截图失败：', e.message); }
      log('自检结果：', JSON.stringify({ attach: attachState && { ok: attachState.ok, via: attachState.via, reason: attachState.reason } }));
      if (HOLD > 0) await sleep(HOLD * 1000);
      quitting = true;
      app.exit(0);
    }
  });

  // 分辨率/DPI 变化：刷新 bounds 快照并重铺。bounds 只在创建窗口时记录过一次，
  // 改分辨率后光标映射会用旧宽高持续错位，必须跟着 screen 事件走。
  // screen 模块必须在 app ready 之后才能用，所以监听也放到 ready 之后再挂。
  app.whenReady().then(() => {
    screen.on('display-metrics-changed', (_e, _d, changed) => {
      if (quitting || NO_ATTACH) return;
      if (!changed.includes('bounds') && !changed.includes('scaleFactor')) return;
      const w = wallpaperWin;
      if (!w || w.isDestroyed()) return;
      bounds = screen.getPrimaryDisplay().bounds;
      log('显示器指标变化，更新 bounds 并重铺：', JSON.stringify(bounds));
      try { fit(w.getNativeWindowHandle(), hostHandle); } catch { /* 下个看门狗周期会再试 */ }
    });
  });

  app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
  app.on('before-quit', () => {
    quitting = true;
    clearInterval(watchdog);
    clearInterval(backendWatch);
  clearInterval(fullWatch);
  stopCursorFeed();
  if (coreChild) {
    try { coreChild.kill(); } catch { /* 忽略 */ }
    coreChild = null;
  }
  if (backendChild) {
    gracefulBackendStop(backendChild).catch(() => {});
    setTimeout(() => { try { if (backendChild) backendChild.kill(); } catch { /* 忽略 */ } }, 3500);
  }
});
}
