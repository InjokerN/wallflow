// Steamworks 独立子进程：只做两件事——读订阅列表、取消订阅。
// 之所以单独起进程：steam_api64.dll 是第三方原生库，初始化姿态、崩溃、句柄泄漏都不该影响后端主进程。
// 调用方式：node steam-workshop.js '{"cmd":"list"}'
// 结果以 ##WF## 前缀的 JSON 打到 stdout，父进程按行解析。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WE_APP_ID = '431960';
const emit = (o) => {
  process.stdout.write('##WF##' + JSON.stringify(o) + '\n');
};

let payload;
try {
  payload = JSON.parse(process.argv[2] || '{}');
} catch {
  emit({ ok: false, reason: 'bad-args' });
  process.exit(2);
}

const DLL = payload.dll;
const cmd = payload.cmd || 'list';

if (!DLL || !fs.existsSync(DLL)) {
  emit({ ok: false, reason: 'no-dll', message: '找不到 steam_api64.dll' });
  process.exit(0);
}

let koffi;
try {
  koffi = (await import('koffi')).default;
} catch (e) {
  emit({ ok: false, reason: 'no-koffi', message: '原生模块 koffi 不可用：' + (e?.message || e) });
  process.exit(0);
}

// 独立工作目录：steam_api64.dll 只认当前目录下的 steam_appid.txt
const work = path.join(os.tmpdir(), 'wf-steamwork-' + process.pid);
let lib = null;
let inited = false;

const cleanup = () => {
  try { if (inited) lib?.func('void SteamAPI_Shutdown()')(); } catch { /* 已退出就算了 */ }
  try { process.chdir(os.tmpdir()); } catch { /* ignore */ }
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* dll 可能仍被占用，留给系统清理 */ }
};
process.on('exit', cleanup);

try {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const localDll = path.join(work, 'steam_api64.dll');
  fs.copyFileSync(DLL, localDll);
  fs.writeFileSync(path.join(work, 'steam_appid.txt'), WE_APP_ID);
  process.chdir(work);
  lib = koffi.load(localDll);
} catch (e) {
  emit({ ok: false, reason: 'dll-load-failed', message: String(e?.message || e).slice(0, 300) });
  process.exit(0);
}

// Steam 没开着时 Init 会自己拉起 Steam 或直接失败，先问一句更友好
try {
  const running = lib.func('bool SteamAPI_IsSteamRunning()')();
  if (!running) {
    emit({ ok: false, reason: 'steam-not-running', message: 'Steam 客户端没有运行，请先启动并登录 Steam' });
    process.exit(0);
  }
} catch { /* 老版本没有这个符号，继续往下试 */ }

try {
  inited = lib.func('bool SteamAPI_InitSafe()')();
} catch { inited = false; }
if (!inited) {
  try {
    const buf = Buffer.alloc(1024);
    inited = lib.func('int SteamAPI_InitFlat(char* out)')(buf) === 0;
  } catch { inited = false; }
}
if (!inited) {
  emit({ ok: false, reason: 'init-failed', message: 'SteamAPI 初始化失败（可能是当前账号未登录或没有壁纸引擎）' });
  process.exit(0);
}

let ugc = null;
try {
  for (const v of ['v021', 'v020', 'v019', 'v018', 'v017']) {
    try {
      ugc = lib.func('void* SteamAPI_SteamUGC_' + v + '()')();
      if (ugc) break;
    } catch { /* 换下一个版本号 */ }
  }
} catch { ugc = null; }
if (!ugc) {
  emit({ ok: false, reason: 'no-ugc', message: '这个 steam_api64.dll 没有暴露创意工坊接口' });
  process.exit(0);
}

const numSub = lib.func('uint32 SteamAPI_ISteamUGC_GetNumSubscribedItems(void*)');
const listSub = lib.func('uint32 SteamAPI_ISteamUGC_GetSubscribedItems(void*, uint64*, uint32)');
const getState = lib.func('uint32 SteamAPI_ISteamUGC_GetItemState(void*, uint64)');
const unsubscribe = lib.func('bool SteamAPI_ISteamUGC_UnsubscribeItem(void*, uint64)');

function readSubscribed() {
  const n = numSub(ugc);
  if (!n) return [];
  const buf = Buffer.alloc(8 * n);
  const got = listSub(ugc, buf, n);
  const out = [];
  for (let i = 0; i < got; i += 1) {
    const id = buf.readBigUInt64LE(i * 8).toString();
    out.push({ id, state: getState(ugc, BigInt(id)) });
  }
  return out;
}

try {
  const items = readSubscribed();
  if (cmd === 'list') {
    emit({
      ok: true,
      cmd: 'list',
      total: items.length,
      // 只回前若干条，父进程按需取；避免一次吐几千行
      sample: items.slice(0, 10),
      ids: payload.withIds ? items.map((i) => i.id) : undefined,
    });
  } else if (cmd === 'unsubscribe') {
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String) : [];
    if (!ids.length) { emit({ ok: false, reason: 'no-ids' }); process.exit(0); }
    const before = new Set(items.map((i) => i.id));
    const results = [];
    for (const id of ids) {
      if (!before.has(id)) { results.push({ id, ok: false, message: '不在当前订阅列表里' }); continue; }
      let called = false;
      try { called = unsubscribe(ugc, BigInt(id)); } catch (e) { results.push({ id, ok: false, message: String(e?.message || e).slice(0, 120) }); continue; }
      results.push({ id, ok: !!called });
    }
    // 给 Steam 客户端一点时间处理，再核对一遍真实状态
    const pending = new Set(results.filter((r) => r.ok).map((r) => r.id));
    const deadline = Date.now() + 6000;
    while (pending.size && Date.now() < deadline) {
      const now = new Set(readSubscribed().map((i) => i.id));
      for (const id of [...pending]) if (!now.has(id)) pending.delete(id);
      if (pending.size) await new Promise((r) => setTimeout(r, 400));
    }
    emit({
      ok: true,
      cmd: 'unsubscribe',
      results: results.map((r) => ({ ...r, confirmed: r.ok ? !pending.has(r.id) : false })),
      remaining: readSubscribed().length,
    });
  } else {
    emit({ ok: false, reason: 'unknown-cmd' });
  }
} catch (e) {
  emit({ ok: false, reason: 'runtime-error', message: String(e?.message || e).slice(0, 300) });
}
process.exit(0);
