// 壁纸层窗口的桥接：只做一件事 —— 把主进程旁听到的光标位置和左键状态送进页面。
//
// 为什么不用 HTTP/SSE：鼠标位置一秒几十次，走网络栈纯属浪费；
// 而且这条链路只在桌面层窗口内部有意义，走 IPC 最直接。
//
// 按键轮询是"按需开"的：页面告诉主进程当前壁纸要不要点击，不要就完全不去读全局按键。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('WF_CURSOR', {
  on: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, d) => { try { cb(d); } catch { /* 页面自己的异常不能影响通道 */ } };
    ipcRenderer.on('wf:cursor', h);
    return () => ipcRenderer.removeListener('wf:cursor', h);
  },
  setClickCapture: (on) => ipcRenderer.send('wf:cursor-click', !!on),
});

// 声音开关：视频元素的 muted 管不了网页壁纸里的音轨，所以整窗一起静音/放开。
// 只在用户打开「壁纸声音」时才让它出声，默认仍然是静音。
contextBridge.exposeInMainWorld('WF_AUDIO', {
  setMuted: (muted) => ipcRenderer.send('wf:audio', !!muted),
});
