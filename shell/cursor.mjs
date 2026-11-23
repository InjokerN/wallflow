// 全局鼠标状态读取
//
// 壁纸窗口贴在桌面图标层下面，真实鼠标事件被图标层截走，窗口一个都收不到。
// 所以只能"旁听"：光标位置用 Electron 的 screen.getCursorScreenPoint()，
// 左键状态只能问系统要 —— GetAsyncKeyState 读的是全局按键状态，不需要焦点，
// 也不需要装钩子（装 WH_MOUSE_LL 会被杀软当成键盘记录器，这里只读一个键，轻得多）。
//
// 只取最高位（0x8000，此刻是否按着）。最低位那个"自上次读取以来按下过"的标志
// 看着能补捉极快点击，实测对合成输入不生效，而且微软文档明说它受抢占式多任务影响
// 并不可靠 —— 拿它当判据会凭空冒出假点击，比漏掉一次极快点更烦人，所以不用。
// 16ms 轮询对真人手速（按下通常持续 40ms 以上）够用。
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const GetAsyncKeyState = user32.func('int16_t GetAsyncKeyState(int vKey)');

const VK_LBUTTON = 0x01;

export function leftButtonDown() {
  try {
    return (Number(GetAsyncKeyState(VK_LBUTTON)) & 0x8000) !== 0;
  } catch {
    return false;
  }
}
