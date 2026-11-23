import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import db, { getLibraryDir } from '../db.js';
import { resolveWallpaperDir } from '../library-path.js';

const router = Router();
const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif']);
const VID_EXT = new Set(['.mp4', '.webm', '.mkv', '.mov', '.m4v']);

const STYLE_LABEL = { fill: '填充', fit: '适应' };

// 只允许本机调用：这是"改你电脑桌面"的操作，不能被局域网里的别人触发
const onlyLocal = (req, res, next) => {
  const ip = String(req.socket.remoteAddress || '').replace('::ffff:', '');
  if (ip === '127.0.0.1' || ip === '::1') return next();
  // 跨源写拦截（第二道）：第三方壁纸页拿不到本应用的源，带 cookie 直接 fetch 也过不了
  const _origin = String(req.headers.origin || '');
  if (_origin && !_origin.startsWith('http://127.0.0.1:') && !_origin.startsWith('http://localhost:')) {
    return fail(res, 403, '禁止跨源写入');
  }
  return fail(res, 403, '只允许本机操作');
};

// 交给渲染内核的「真实媒体」路径。
// 视频/图片给真实文件；网页(index.html) 和场景(scene.pkg) mpv 播不了，返回 null →
// 让内核让出桌面层，由 Electron 壁纸窗口渲染。
// 注意：这里只决定"谁来画桌面"，绝不碰 Windows 系统壁纸——那是用户自己的设置，
// 壁纸软件退出后应该原样露出来（WE / Lively 都是这个行为）。
function coreMedia(w) {
  const dir = resolveWallpaperDir(w);
  const root = path.resolve(getLibraryDir()) + path.sep;
  const rel = String(w.main_file || '').replace(/\\/g, '/');
  if (!rel) return null;
  const abs = path.resolve(dir, path.basename(rel));
  if (!abs.startsWith(root) || !fs.existsSync(abs)) return null;
  const ext = path.extname(abs).toLowerCase();
  if (VID_EXT.has(ext) || IMG_EXT.has(ext)) return abs;
  return null;
}

let applying = false;

// ---- V1 spike：把已应用的壁纸命令转发给本机渲染内核 ----
// 内核地址可配（默认 127.0.0.1:3002），内核没起来就静默跳过，不影响壁纸记录。
const CORE_BASE = process.env.WF_CORE_URL || 'http://127.0.0.1:3002';
async function notifyCore(payload) {
  try {
    const r = await fetch(`${CORE_BASE}/api/core/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    const j = await r.json().catch(() => ({}));
    console.log('[apply->core] 转发结果', JSON.stringify({ ok: r.ok, code: j.code }));
    return r.ok;
  } catch (e) {
    // 内核未启动 / 不可达：不算失败，壁纸记录照常写入
    console.log('[apply->core] 内核不可达，跳过转发:', e.message);
    return false;
  }
}

// 开机恢复：把数据库里记住的当前壁纸重新下发给渲染层。
// 必须定义在 /:id 之前，否则会被通配路由抢先匹配，把 "restore" 当成壁纸 id 查库报 404。
// 只恢复动态画面与渲染归属，从不重新写系统壁纸——用户设置过什么，就一直是什么。
// 找不到素材时如实返回，不伪造路径——素材是用户自己的库文件。
router.post('/restore', onlyLocal, async (req, res) => {
  const id = Number(db.prepare("SELECT value FROM app_state WHERE key = 'current_wallpaper'").get()?.value) || null;
  if (!id) return success(res, { id: null, renderBy: null, restored: false });
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(id);
  if (!row) return success(res, { id, renderBy: null, restored: false, reason: '壁纸记录已删除' });
  const media = coreMedia(row);
  const renderBy = media ? 'core' : 'desktop';
  const ok = await notifyCore({
    cmd: media ? 'play' : 'hide', id, type: row.type, path: media, renderBy,
    style: db.prepare("SELECT value FROM app_state WHERE key = 'wallpaper_style'").get()?.value || 'fill',
    ts: Date.now(),
  });
  success(res, {
    id, type: row.type, media: media || null, renderBy, restored: ok,
    reason: media ? undefined
      : (row.type === 'web' || row.type === 'scene'
          ? '网页/场景壁纸由浏览器壁纸窗口渲染'
          : '素材文件已缺失，需重新导入'),
  });
});

// POST /api/v1/apply/:id    body: { style: 'fill' | 'fit' }
//
// 这里只做两件事：
//   1. 告诉渲染层（C++ 内核 / Electron 壁纸窗口）画哪张壁纸
//   2. 记下当前壁纸，供开机恢复
//
// 刻意【不生成静态图、不调用 SystemParametersInfo、不改 HKCU\Control Panel\Desktop】。
// 旧版本会把壁纸缩略图生成 JPG 设成系统壁纸，用它当"渲染层没起来时的兜底"。
// 副作用是：退出软件、壁纸窗口销毁后，那张缩略图就露出来变成桌面——
// 这正是"退出后桌面变成糊缩略图"的根源。WE / Lively 从不改系统壁纸，
// 桌面内容完全由贴在 WorkerW 上的窗口负责，退出即原样恢复。
router.post('/:id', onlyLocal, async (req, res) => {
  if (applying) return fail(res, 429, '上一次设置还没完成，请稍候');
  const style = STYLE_LABEL[req.body?.style] ? req.body.style : 'fill';
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');

  // 视频/图片发真实媒体；网页/场景 mpv 播不了，让内核让出桌面层，交浏览器窗口渲染。
  // fire-and-forget：内核不可达不影响壁纸记录，开机恢复会再试。
  const media = coreMedia(row);
  const renderBy = media ? 'core' : 'desktop';
  console.log('[apply->core] 渲染归属', JSON.stringify({ id: row.id, type: row.type, renderBy, media: media || null }));
  notifyCore({
    cmd: media ? 'play' : 'hide',
    id: Number(row.id),
    type: row.type || null,
    path: media,
    renderBy,
    style,
    ts: Date.now(),
  }).catch(() => {});

  applying = true;
  try {
    db.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES ('current_wallpaper', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(row.id));
    db.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES ('wallpaper_style', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(style);

    // B 修复：把这次「填充/适应」预设真正写进该壁纸的 frame.mode。
    // 之前只写 wallpaper_style，而 play.js 的 frameOf() 一旦看到 wp_frame 里有值
    // （用户在「正在播放」里调过一次就会写），就永远以 wp_frame 为准、忽略 fill/fit，
    // 导致库里的填充/适应按钮点了没反应。这里只改 mode，保留用户调过的 x/y/scale。
    // 桌面端有 1.5s 轮询兜底会自动拿到新 frame，无需额外广播。
    try {
      const raw = db.prepare("SELECT value FROM app_state WHERE key = 'wp_frame'").get()?.value || '{}';
      const map = JSON.parse(raw);
      const idKey = String(row.id);
      const base = { mode: 'cover', x: 0, y: 0, scale: 100, ...(map[idKey] || {}) };
      base.mode = style === 'fit' ? 'contain' : 'cover';
      map[idKey] = base;
      db.prepare(`
        INSERT INTO app_state (key, value, updated_at) VALUES ('wp_frame', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(JSON.stringify(map));
    } catch (e) {
      console.log('[apply] 同步 frame.mode 失败（不影响应用壁纸）:', e.message);
    }

    success(res, { id: Number(row.id), style, styleLabel: STYLE_LABEL[style], renderBy });
  } catch (e) {
    fail(res, 500, '设置壁纸失败：' + e.message);
  } finally {
    applying = false;
  }
});

// 查询当前壁纸（给「正在播放」页和套壳后开机恢复用）
// 带上 type / renderBy：主进程据此决定该由 C++ 内核还是 Electron 壁纸窗口贴在桌面层。
router.get('/current', (req, res) => {
  const get = (k) => db.prepare('SELECT value FROM app_state WHERE key = ?').get(k)?.value ?? null;
  const id = Number(get('current_wallpaper')) || null;
  const row = id ? db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(id) : null;
  const media = row ? coreMedia(row) : null;
  success(res, {
    id, style: get('wallpaper_style'),
    type: row?.type || null,
    media: media || null,
    renderBy: media ? 'core' : (row ? 'desktop' : null),
  });
});

export default router;
