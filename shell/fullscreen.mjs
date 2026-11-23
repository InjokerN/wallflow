// 判断"当前前台窗口是不是全屏应用"（全屏游戏 / 全屏视频 / 全屏课件）
// 判据：前台窗口矩形完全覆盖整块屏幕（含任务栏所在区域）。
//   · 普通最大化的窗口底边会停在任务栏上方，永远盖不到整屏 → 不会误判
//   · 全屏独占游戏 / 浏览器全屏播放 / 全屏网页，矩形都等于整块屏幕
// 注：不能靠"没有标题栏"判断 —— Electron 自己的 frameless 窗口也保留 WS_CAPTION 样式。
// Win32 类型陷阱：BOOL/LONG 都是 4 字节，不能用 koffi 的 bool（1 字节），否则段错误。
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');

const RECT = koffi.struct('WF_RECT', {
  left: 'int', top: 'int', right: 'int', bottom: 'int',
});

const GetForegroundWindow = user32.func('uintptr_t GetForegroundWindow()');
const GetWindowRect = user32.func('int GetWindowRect(uintptr_t hwnd, _Out_ WF_RECT *rect)');
const GetClassNameA = user32.func('int GetClassNameA(uintptr_t hwnd, _Out_ char *buf, int n)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int index)');
const IsWindowVisible = user32.func('int IsWindowVisible(uintptr_t hwnd)');
const IsIconic = user32.func('int IsIconic(uintptr_t hwnd)');

// 系统自身的窗口，永远不算"全屏应用"
const IGNORE_CLASS = new Set([
  'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow', 'SysShadow', '',
]);

function className(hwnd) {
  const buf = Buffer.alloc(256);
  try {
    const n = GetClassNameA(hwnd, buf, 256);
    if (n <= 0) return '';
    return buf.subarray(0, n).toString('ascii');
  } catch { return ''; }
}

/**
 * 对指定窗口句柄做判决（导出以便自检，不依赖"此刻前台是谁"）
 * @returns {{ fullscreen: boolean, hwnd?: number, cls?: string, reason?: string, rect?: object, screen?: number[] }}
 */
export function judgeHwnd(hwnd) {
  const h = Number(hwnd) || 0;
  if (!h) return { fullscreen: false, reason: 'no-window' };

  const cls = className(h);
  if (IGNORE_CLASS.has(cls)) return { fullscreen: false, hwnd: h, cls, reason: 'system-window' };

  try {
    if (!IsWindowVisible(h)) return { fullscreen: false, hwnd: h, cls, reason: 'not-visible' };
    if (IsIconic(h)) return { fullscreen: false, hwnd: h, cls, reason: 'minimized' };
  } catch { /* 忽略，继续按矩形判断 */ }

  // koffi 的 _Out_ struct* 需要显式传一个接收对象
  let rect;
  try {
    const holder = {};
    const ok = GetWindowRect(h, holder);
    if (ok) rect = holder;
  } catch (e) { return { fullscreen: false, hwnd: h, cls, reason: 'rect-failed:' + e.message }; }
  if (!rect) return { fullscreen: false, hwnd: h, cls, reason: 'no-rect' };

  const sw = GetSystemMetrics(0); // SM_CXSCREEN
  const sh = GetSystemMetrics(1); // SM_CYSCREEN
  if (!sw || !sh) return { fullscreen: false, hwnd: h, cls, reason: 'no-screen' };

  // 留 8px 容差：个别全屏窗口会被 DWM 阴影撑出负坐标
  const TOL = 8;
  const covers = rect.left <= TOL && rect.top <= TOL
    && rect.right >= sw - TOL && rect.bottom >= sh - TOL;

  return {
    fullscreen: covers,
    hwnd: h,
    cls,
    reason: covers ? 'covers-screen' : 'smaller',
    rect: { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom },
    screen: [sw, sh],
  };
}

// 当前前台窗口是不是全屏应用
export function isFullscreenApp() {
  let fg = 0;
  try { fg = GetForegroundWindow(); } catch (e) { return { fullscreen: false, reason: 'call-failed:' + e.message }; }
  if (!fg) return { fullscreen: false, reason: 'no-foreground' };
  return judgeHwnd(fg);
}
