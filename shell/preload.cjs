// 主窗口与主进程之间的最小桥接：只暴露窗口控制，不开任何 Node 能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('WF_SHELL', {
  minimize: () => ipcRenderer.send('wf:win', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('wf:win', 'maximize'),
  close: () => ipcRenderer.send('wf:win', 'close'),
  isMaximized: () => ipcRenderer.invoke('wf:win', 'isMaximized'),
  version: () => ipcRenderer.invoke('wf:app', 'version'),
  // 是否真 C++ 内核模式（决定视频帧率面板是否显示无效的锁30开关）
  nativeCore: () => ipcRenderer.invoke('wf:app', 'nativeCore'),
  // 主显示器刷新率（Hz），浏览器里没有 WF_SHELL 时前端自行降级为不显示
  displayRefreshRate: () => ipcRenderer.invoke('wf:app', 'displayRefreshRate'),
  openDataDir: () => ipcRenderer.send('wf:app', 'openDataDir'),
  // 资源管理器打开所在文件夹并选中该文件（路径必须存在，主进程会校验）
  revealPath: (p) => ipcRenderer.invoke('wf:reveal', String(p || '')),
  // 导出用：原生「另存为」/「选择文件夹」，返回用户选的路径，取消时返回空串
  pickSavePath: (defaultName) => ipcRenderer.invoke('wf:dialog', 'save', String(defaultName || '')),
  pickDir: () => ipcRenderer.invoke('wf:dialog', 'dir'),
  // 设置页用：弹系统「选择文件夹」，给壁纸库 / 缓存目录这种路径挑位置
  pickFolder: () => ipcRenderer.invoke('wf:dialog', 'folder'),
  // 应用壁纸成功后立即通知主进程切换桌面渲染归属，避免等轮询的 1.2 秒空窗
  applied: (renderBy) => ipcRenderer.send('wf:applied', String(renderBy || '')),
  // 手动暂停：前端写完 /play/pause 后通知主进程，由主进程按渲染归属暂停真正的画面层
  // （core→内核 pause/stop，desktop→壁纸页）。以前只写库+SSE，视频走内核根本收不到，暂停无效。
  setPaused: (paused) => ipcRenderer.send('wf:paused', !!paused),
  // 「常规设置」：不带参数是读，带对象是改（返回改完之后的整份设置）
  prefs: (patch) => ipcRenderer.invoke('wf:prefs', patch || null),
  // 应用规则：指定 exe 运行期间暂停壁纸。不带参数是读，带数组是改
  appRules: (list) => ipcRenderer.invoke('wf:appRules', Array.isArray(list) ? list : null),
  // 别处改了设置（比如托盘里切了全屏暂停），界面要跟着刷新
  onPrefs: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, p) => cb(p);
    ipcRenderer.on('wf:prefs-changed', h);
    return () => ipcRenderer.removeListener('wf:prefs-changed', h);
  },
});
