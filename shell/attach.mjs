// 把任意窗口"过继"给 Windows 桌面壁纸层（WorkerW），让它跑到桌面图标后面
// 全部调用 user32.dll 原生接口。
// 注意：Win32 的 BOOL 是 4 字节 int，不能用 koffi 的 bool（1 字节），否则调用约定错位会直接段错误。
// HWND 统一按 uintptr_t 传递（数值），比 void* 更省心，也不涉及 BigInt 转换。
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');

const FindWindowA = user32.func('uintptr_t FindWindowA(const char *cls, const char *win)');
const FindWindowExA = user32.func('uintptr_t FindWindowExA(uintptr_t parent, uintptr_t child, const char *cls, const char *win)');
// 7 个参数，缺一不可：uTimeout(uint32) 是第 6 个，lpdwResult 是第 7 个。
// 真实类型是 PDWORD_PTR（x64=8字节），必须用 uintptr_t* + 8 字节缓冲；
// 漏 uTimeout 会让 lpdwResult 落到栈垃圾值上，函数写入时直接 0xc0000005 崩溃（换机必现）。
const SendMessageTimeoutA = user32.func('intptr_t SendMessageTimeoutA(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)');
const SetParent = user32.func('uintptr_t SetParent(uintptr_t child, uintptr_t parent)');
const GetParent = user32.func('uintptr_t GetParent(uintptr_t hwnd)');
// 顶层窗口的 GetParent 返回的是 owner（通常为 0），GetAncestor(GA_PARENT) 才是真正的父窗口
const GetAncestor = user32.func('uintptr_t GetAncestor(uintptr_t hwnd, uint32_t flags)');
const GA_PARENT = 1;
const SetWindowPos = user32.func('int SetWindowPos(uintptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)');
const GetWindowRect = user32.func('int GetWindowRect(uintptr_t hwnd, _Out_ int *r)');
const GetClientRect = user32.func('int GetClientRect(uintptr_t hwnd, _Out_ int *r)');
const ClientToScreen = user32.func('int ClientToScreen(uintptr_t hwnd, _Out_ int *pt)');
const GetClassNameA = user32.func('int GetClassNameA(uintptr_t hwnd, _Out_ char *buf, int n)');
const IsWindow = user32.func('int IsWindow(uintptr_t hwnd)');
const GetWindowLongA = user32.func('int32_t GetWindowLongA(uintptr_t hwnd, int idx)');
const SetWindowLongA = user32.func('int32_t SetWindowLongA(uintptr_t hwnd, int idx, int32_t val)');

const EnumWindowsProc = koffi.proto('int EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)');
const EnumWindows = user32.func('int EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');

const WM_SPAWN_WORKER = 0x052C;
const HWND_TOP = 0;
const SWP_NOACTIVATE = 0x0010;
const SWP_SHOWWINDOW = 0x0040;
// 铺满时四周各外扩 1px：WorkerW 里可能同时挂着别的壁纸软件（Wallpaper Engine 等），
// DWM 的圆角/1px 非客户区常常让最外一圈留出一条能看穿的缝。多盖 1px 没有视觉代价。
const OVERSCAN = 1;

// Electron 的 frame:false 窗口在 Windows 上仍保留不可见的缩放边框（WS_THICKFRAME）。
// 实测外层窗口 1936×1040 时，内层渲染区是 1920×1032 且从 x=7 开始 ——
// 贴到桌面后左边就露出 7px 的底图，这就是「桌面左侧有一条缝」的真正原因。
// 贴桌面时把这几类装饰样式去掉，让客户区等于窗口区。
const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CAPTION = 0x00C00000;
const WS_THICKFRAME = 0x00040000;
const WS_DLGFRAME = 0x00400000;
const WS_BORDER = 0x00800000;
const WS_CHILD = 0x40000000;
const WS_POPUP = 0x80000000;
const WS_EX_CLIENTEDGE = 0x00000200;
const WS_EX_STATICEDGE = 0x00020000;
const SWP_FRAMECHANGED = 0x0020;

// 贴到桌面层时必须真的变成「子窗口」。
// 只 SetParent 不改样式的话，Electron 仍按顶层窗口处理：会给自己留一圈不可见的
// 缩放边框（实测内层渲染区从 x=6 开始），并且把高度夹到工作区（1032 而不是 1080）。
// 两者叠加就是「桌面左侧一条缝 + 底部被任务栏吃掉」。
function asChild(hwnd) {
  try {
    const style = GetWindowLongA(hwnd, GWL_STYLE);
    const want = (style | WS_CHILD) & ~WS_POPUP;
    if (want !== style) SetWindowLongA(hwnd, GWL_STYLE, want);
  } catch { /* 改样式失败不影响贴桌面，只是可能留一条边 */ }
}

function stripFrame(hwnd) {
  try {
    const style = GetWindowLongA(hwnd, GWL_STYLE);
    const want = style & ~(WS_THICKFRAME | WS_CAPTION | WS_DLGFRAME | WS_BORDER);
    if (want !== style) SetWindowLongA(hwnd, GWL_STYLE, want);
    const ex = GetWindowLongA(hwnd, GWL_EXSTYLE);
    const wantEx = ex & ~(WS_EX_CLIENTEDGE | WS_EX_STATICEDGE);
    if (wantEx !== ex) SetWindowLongA(hwnd, GWL_EXSTYLE, wantEx);
  } catch { /* 改样式失败不影响贴桌面，只是可能留一条边 */ }
}

// 宿主客户区（相对宿主 0,0 的宽高）——贴桌面后子窗口坐标就是相对宿主的，
// 用屏幕 bounds 去猜会在「宿主不铺满屏幕」或 DPI 缩放时留下边缘缝。
function clientSize(hwnd) {
  const r = Buffer.alloc(16);
  try {
    if (!GetClientRect(hwnd, r)) return null;
    const w = r.readInt32LE(8) - r.readInt32LE(0);
    const h = r.readInt32LE(12) - r.readInt32LE(4);
    return w > 0 && h > 0 ? { w, h } : null;
  } catch { return null; }
}

// 客户区左上角在屏幕上的坐标（子窗口也适用）
function clientOrigin(hwnd) {
  const p = Buffer.alloc(8);
  try {
    if (!ClientToScreen(hwnd, p)) return null;
    return { x: p.readInt32LE(0), y: p.readInt32LE(4) };
  } catch { return null; }
}

export function windowRect(hwnd) {
  const r = Buffer.alloc(16);
  try {
    if (!GetWindowRect(hwnd, r)) return null;
    return { x: r.readInt32LE(0), y: r.readInt32LE(4), w: r.readInt32LE(8) - r.readInt32LE(0), h: r.readInt32LE(12) - r.readInt32LE(4) };
  } catch { return null; }
}

export function className(hwnd) {
  if (!hwnd) return '';
  const buf = Buffer.alloc(256);
  try {
    const n = GetClassNameA(hwnd, buf, 256);
    if (n <= 0) return '';
    return buf.subarray(0, n).toString('ascii');
  } catch { return ''; }
}

// Electron 的 getNativeWindowHandle() 在 Windows 返回「装着 HWND 的 Buffer」，
// 必须按小端读出指针值，不能 BigInt(buffer)（那会按字符串解析抛错）
export function toHwnd(h) {
  if (typeof h === 'number') return h;
  if (typeof h === 'bigint') return Number(h);
  if (Buffer.isBuffer(h)) {
    if (h.length >= 8) return Number(h.readBigUInt64LE(0));
    if (h.length >= 4) return h.readUInt32LE(0);
    return 0;
  }
  return 0;
}

// 枚举所有顶层窗口，找出"装着桌面图标（SHELLDLL_DefView）"的那个，它后面的 WorkerW 才是壁纸层
function findWorkerWByEnum() {
  let found = 0;
  try {
    const cb = koffi.register((hwnd) => {
      try {
        const defView = FindWindowExA(hwnd, 0, 'SHELLDLL_DefView', null);
        if (defView) {
          const w = FindWindowExA(0, hwnd, 'WorkerW', null);
          if (w) { found = w; return 0; }   // 找到就停
        }
      } catch { /* 单个窗口出错不影响整体 */ }
      return 1;
    }, koffi.pointer(EnumWindowsProc));
    try { EnumWindows(cb, 0); } finally { koffi.unregister(cb); }
  } catch { /* 忽略 */ }
  return found;
}

// 找壁纸层句柄。本机实测结构有三种，按可靠性依次尝试：
//   ① WorkerW 是 Progman 的子窗口（Win10/11 常见，壁纸就画在它上面）
//   ② WorkerW 是 Progman 的兄弟顶层窗口（老系统的经典结构）
//   ③ 都没有，就直接认领给 Progman（保底，仍能显示在图标后面）
export function findWallpaperHost() {
  const progman = FindWindowA('Progman', null);
  if (!progman) return { host: 0, className: '', via: 'no-progman' };

  // ① 先看 Progman 内部有没有 WorkerW
  let worker = FindWindowExA(progman, 0, 'WorkerW', null);
  if (worker) return { host: worker, className: className(worker), via: 'workerw-child' };

  // ② 经典结构：戳一下让 explorer 生成壁纸层，再找 Progman 后面的顶层 WorkerW
  const out = Buffer.alloc(8); // PDWORD_PTR = 指针宽度，x64 为 8 字节
  try { SendMessageTimeoutA(progman, WM_SPAWN_WORKER, 0xD, 0x1, 0, 1000, out); } catch { /* 忽略 */ }

  worker = FindWindowExA(0, progman, 'WorkerW', null);
  if (worker) return { host: worker, className: className(worker), via: 'workerw-sibling' };

  worker = findWorkerWByEnum();
  if (worker) return { host: worker, className: className(worker), via: 'workerw-enum' };

  // ③ 保底
  return { host: progman, className: className(progman), via: 'progman-fallback' };
}

const WIN_FLAGS = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED;

// 把「客户区」精确铺到宿主客户区（四周外扩 OVERSCAN）。
// 不能直接给 SetWindowPos 传目标尺寸：Electron 的窗口即使把边框样式全去掉了，
// 客户区仍比窗口小一圈（实测 1922×1082 的窗口，客户区只有 1908×1075、原点偏右 7px ——
// 这正是「桌面左侧一条缝」的来源）。所以按客户区实测值做闭环收敛，差多少补多少。
function fillClient(hwnd, hostOrigin, tw, th) {
  const want = {
    x: hostOrigin.x - OVERSCAN, y: hostOrigin.y - OVERSCAN,
    w: tw + OVERSCAN * 2, h: th + OVERSCAN * 2,
  };
  SetWindowPos(hwnd, HWND_TOP, -OVERSCAN, -OVERSCAN, want.w, want.h, WIN_FLAGS);
  for (let i = 0; i < 3; i++) {
    const wr = windowRect(hwnd);
    const cr = clientSize(hwnd);
    const org = clientOrigin(hwnd);
    if (!wr || !cr || !org) break;
    const dx = want.x - org.x, dy = want.y - org.y;
    const dw = want.w - cr.w, dh = want.h - cr.h;
    if (!dx && !dy && !dw && !dh) break;
    // 客户区原点随窗口平移、尺寸随窗口尺寸线性变化，一轮就能收敛
    SetWindowPos(hwnd, HWND_TOP, wr.x + dx, wr.y + dy, wr.w + dw, wr.h + dh, WIN_FLAGS);
  }
  return { client: clientSize(hwnd), origin: clientOrigin(hwnd), win: windowRect(hwnd) };
}

// 把窗口贴到桌面壁纸层，并铺满整个宿主客户区
export function attachToDesktop(nativeHandle, bounds) {
  const hwnd = toHwnd(nativeHandle);
  if (!hwnd) return { ok: false, reason: '窗口句柄为空，无法解析' };
  if (!IsWindow(hwnd)) return { ok: false, reason: '窗口句柄无效' };

  const { host, className: hostClass, via } = findWallpaperHost();
  if (!host) return { ok: false, reason: '找不到桌面壁纸层（Progman 不存在）' };

  const prev = SetParent(hwnd, host);
  asChild(hwnd);
  stripFrame(hwnd);
  // 铺满宿主的客户区，并放到该层最上面：同一层里可能还挂着别的壁纸软件，
  // 用户当前选中的是 WallFlow 的壁纸，就该完整盖住别人，而不是被压在下面。
  const size = clientSize(host) || { w: bounds.width, h: bounds.height };
  const hostOrigin = clientOrigin(host) || { x: 0, y: 0 };
  const filled = fillClient(hwnd, hostOrigin, size.w, size.h);

  const parent = GetAncestor(hwnd, GA_PARENT);
  const owner = GetParent(hwnd);
  const ok = parent === host;
  return {
    ok,
    hwnd,
    host,
    via,
    hostClass,
    hostSize: size,
    clientSize: filled.client,
    clientOrigin: filled.origin,
    winRect: windowRect(hwnd),
    parentClass: className(parent),
    ownerClass: className(owner),
    prevParentClass: className(prev),
    reason: ok ? '' : 'SetParent 后父窗口不匹配',
  };
}

// 只调整位置尺寸（窗口已挂到桌面层后，个别情况下会被系统按工作区高度夹一下，
// 过一会儿再推一次就能铺到整屏，包括任务栏下面那条）
export function fit(nativeHandle, host) {
  const hwnd = toHwnd(nativeHandle);
  if (!hwnd || !IsWindow(hwnd)) return null;
  const hostHwnd = Number(host) || 0;
  const size = clientSize(hostHwnd);
  if (!size) return null;
  const origin = clientOrigin(hostHwnd) || { x: 0, y: 0 };
  asChild(hwnd);
  stripFrame(hwnd);   // Electron 偶尔会把样式加回去，每次铺满前再保险一次
  const filled = fillClient(hwnd, origin, size.w, size.h);
  return { hostSize: size, clientSize: filled.client, clientOrigin: filled.origin };
}

// 看门狗用：窗口的客户区没盖满宿主客户区（被系统夹小 / 被别的窗口挤动）就重铺
export function needsRefit(nativeHandle, expectedHost) {
  const hwnd = toHwnd(nativeHandle);
  if (!hwnd || !IsWindow(hwnd)) return false;
  const hostHwnd = Number(expectedHost) || 0;
  const size = clientSize(hostHwnd);
  const origin = clientOrigin(hostHwnd);
  if (!size || !origin) return false;
  const cr = clientSize(hwnd);
  const org = clientOrigin(hwnd);
  if (!cr || !org) return false;
  const wantX = origin.x - OVERSCAN, wantY = origin.y - OVERSCAN;
  return Math.abs(org.x - wantX) > 1 || Math.abs(org.y - wantY) > 1
    || cr.w < size.w + OVERSCAN * 2 - 2 || cr.h < size.h + OVERSCAN * 2 - 2;
}

// 看门狗用：父窗口还在且仍是同一层，就认为没掉
export function isAttached(nativeHandle, expectedHost) {
  const hwnd = toHwnd(nativeHandle);
  if (!hwnd || !IsWindow(hwnd)) return false;
  const p = GetAncestor(hwnd, GA_PARENT);
  if (!p) return false;
  if (expectedHost && p !== Number(expectedHost)) return false;
  const c = className(p);
  return c === 'WorkerW' || c === 'Progman';
}

export function detach(nativeHandle) {
  const hwnd = toHwnd(nativeHandle);
  try { if (hwnd && IsWindow(hwnd)) SetParent(hwnd, 0); } catch { /* 忽略 */ }
}
