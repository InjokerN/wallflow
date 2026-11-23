import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import wallpapersRouter from './routes/wallpapers.js';
import compatRouter from './routes/compat.js';
import bakeRouter from './routes/bake.js';
import applyRouter from './routes/apply.js';
import weRouter from './routes/we.js';
import settingsRouter from './routes/settings.js';
import cloudRouter from './routes/cloud.js';
import playRouter from './routes/play.js';
import { getLibraryDir } from './db.js';
import { readCloudConfig } from './cloud/config.js';
import { startSizeWorker } from './size-cache.js';
import { bridgeMiddleware } from './middleware/bridge.js';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '../..');

const app = express();
app.use(express.json());

// CORS：GET 保持放开（列表/媒体对局域网调试保持原行为）；
// 写操作（POST/PATCH/DELETE）只接受本应用页面的来源 —— 否则沙箱里的
// 第三方网页壁纸仍能用 fetch 直接打写接口（no-cors 请求拦不住效果）。
// OPTIONS 预检同理只放行本应用来源。
const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${process.env.PORT || 3001}`,
  `http://localhost:${process.env.PORT || 3001}`,
]);
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');
  if (req.method === 'OPTIONS') {
    if (SELF_ORIGINS.has(origin)) return res.sendStatus(204);
    return res.sendStatus(403);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && origin && !SELF_ORIGINS.has(origin)) {
    return res.status(403).json({ code: 403, message: '禁止跨源写入', data: null });
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// 网页壁纸的属性/光标桥：往壁纸 HTML 里注入 postMessage 适配层，
// 沙箱里的第三方壁纸页因此还能收到调节项与鼠标事件（见 middleware/bridge.js）
app.use(bridgeMiddleware());

// 主进程唯一持有的优雅关闭令牌：退出时先 POST 这里让后端自己收尾，超时才 kill
// 启动即生成一次性令牌，健康检查随行下发；主进程退出时拿它调 /__shutdown 优雅收尾。
// 本机进程本来就能拿到（health 无鉴权、服务只绑回环），令牌的作用是防止前端代码
// 或误触发的 POST 直接关停后端，不是安全边界。
let shutdownToken = randomUUID();
app.post('/__shutdown', express.text({ type: '*/*' }), (req, res) => {
  const token = typeof req.body === 'string' ? req.body : String(req.body || '');
  if (!shutdownToken || token !== shutdownToken) {
    return res.status(403).json({ code: 403, message: 'token 不合法', data: null });
  }
  shutdownToken = null;
  res.json({ code: 0, message: 'ok', data: null });
  setTimeout(() => process.exit(0), 150);
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ code: 0, message: 'ok', data: { uptime: process.uptime(), shutdownToken: shutdownToken || null } }));

// 壁纸接口
app.use('/api/v1/wallpapers', wallpapersRouter);

// Wallpaper Engine 双向兼容接口（整包导入/导出）
app.use('/api/v1/compat', compatRouter);

// 场景转视频（逐帧抓图 → FFmpeg 合成）
app.use('/api/v1/bake', bakeRouter);

// 应用壁纸：真正把壁纸设成 Windows 桌面壁纸（路由内部已限制只允许本机调用）
app.use('/api/v1/apply', applyRouter);

// 正在播放：当前壁纸状态、壁纸自带调节项、画面变换、手动暂停（含 SSE 实时下发）
app.use('/api/v1/play', playRouter);

// 壁纸引擎库：扫描、列表、按需复制、按需删除源（每个动作独立，互不绑定）
app.use('/api/v1/we', weRouter);

// 设置：壁纸库位置等
app.use('/api/v1/settings', settingsRouter);

// 云端壁纸库：发布到桶 / 读云端目录（桶私写公开读，软件不需要自己的服务器）
app.use('/api/v1/cloud', cloudRouter);

// 静态资源：/media/场景/preview.jpg 指向壁纸库下的 场景/preview.jpg
// 用中间件包一层，用户改库目录后立即生效（不能在启动时把路径写死）
app.use('/media', (req, res, next) => express.static(getLibraryDir())(req, res, next));

// 本地模拟桶（mode=local 时当云端用）：/cloud-mock/packs/x/thumb.jpg
app.use('/cloud-mock', (req, res, next) =>
  express.static(readCloudConfig().localDir)(req, res, next));

// 前端页面（后续迁移进来后生效）
app.use(express.static(path.join(projectRoot, 'web')));

const PORT = process.env.PORT || 3001;
// 只监听本机回环地址：这套东西能改系统桌面壁纸，不该让同一局域网的其他设备访问到
app.listen(PORT, '127.0.0.1', () => {
  console.log(`WallFlow server running at http://localhost:${PORT}`);
  // 启动后后台算一遍各壁纸文件夹大小（只在详情里显示，别跟首屏抢 IO）
  startSizeWorker();
});
