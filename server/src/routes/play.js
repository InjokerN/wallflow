// 「正在播放」相关：当前壁纸状态、调节项、画面变换、手动暂停
//
// 桌面层（desktop.html）和主界面（index.html）是两个独立页面，都只认 HTTP。
// 所以这里除了常规读写接口，还开一条 SSE：拖滑块时后端立即把新值广播出去，
// 桌面层收到就推给壁纸页面，不用等 1.5 秒轮询 —— 慢一步就会觉得"滑块是滑了，画面没跟上"。
//
// 存储全部走 app_state，因为都是「一条记录、整体读写」的形态：
//   wp_props    { "<壁纸id>": { "zoom": 120, ... } }   只存和 project.json 默认值不同的项
//   wp_frame    { "<壁纸id>": { "mode":"cover", "x":0, "y":0, "scale":100 } }
//   play_paused "0" / "1"
//   play_mouse_click  "0" / "1"   桌面点击是否转发给壁纸（壁纸层收不到真实事件，只能旁听全局左键）
//   play_video_sound  "0" / "1"   视频壁纸在桌面上要不要出声（默认静音）
//   render_fps  "30"/"60"/"72"/"144"  全局渲染节拍（默认30），不随壁纸记录，切换保持

import { Router } from 'express';
import db from '../db.js';
import { readWallpaperProps, mergeProps, validatePropValue } from '../we-props.js';

const router = Router();
const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

// ---------- app_state 小工具 ----------

const getState = (key) => db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value ?? null;

function setState(key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value));
}

function readMap(key) {
  try {
    const j = JSON.parse(getState(key) || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeMapEntry(key, id, value) {
  const map = readMap(key);
  if (value === null) delete map[String(id)];
  else map[String(id)] = value;
  setState(key, JSON.stringify(map));
}

// ---------- 当前壁纸 ----------

const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;

function currentRow() {
  const id = Number(getState('current_wallpaper')) || null;
  if (!id) return { id: null, style: null, appliedAt: null, row: null };
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(id) || null;
  // datetime('now') 存的是 UTC，直接给前端会被当成本地时间，用 strftime 换成秒级时间戳
  const ts = db.prepare(`
    SELECT CAST(strftime('%s', updated_at) AS INTEGER) AS s FROM app_state WHERE key = 'current_wallpaper'
  `).get()?.s;
  return { id: row ? Number(row.id) : null, style: getState('wallpaper_style') || 'fill', appliedAt: ts ? ts * 1000 : null, row };
}

const DEFAULT_FRAME = { mode: 'cover', x: 0, y: 0, scale: 100 };

function coerceFrame(raw) {
  const f = { ...DEFAULT_FRAME, ...(raw && typeof raw === 'object' ? raw : {}) };
  const mode = String(f.mode || 'cover');
  const out = {
    mode: ['cover', 'contain', 'stretch'].includes(mode) ? mode : 'cover',
    x: Math.max(-50, Math.min(50, Number(f.x) || 0)),
    y: Math.max(-50, Math.min(50, Number(f.y) || 0)),
    scale: Math.max(50, Math.min(200, Number(f.scale) || 100)),
  };
  return {
    mode: out.mode,
    x: Number(out.x.toFixed(1)),
    y: Number(out.y.toFixed(1)),
    scale: Number(out.scale.toFixed(0)),
  };
}

function frameOf(id, style) {
  const saved = id == null ? null : readMap('wp_frame')[String(id)];
  // 没单独调过就跟随「填充/适应」这两个预设，用户改过一次之后以他自己的为准
  if (!saved) return { ...DEFAULT_FRAME, mode: style === 'fit' ? 'contain' : 'cover' };
  return coerceFrame(saved);
}

// ---------- SSE 广播 ----------

const clients = new Set();

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // 万一以后前面加了反向代理，别让它攒着不发
  });
  res.write('retry: 2000\n\n');
  clients.add(res);

  // 连上先给一份完整状态：桌面层重连（比如换了壁纸层窗口）时能立刻对齐，不用等下一次轮询
  const cur = currentRow();
  if (cur.id) {
    const declared = readWallpaperProps(cur.row);
    const merged = mergeProps(declared, readMap('wp_props')[String(cur.id)]);
    res.write(`data: ${JSON.stringify({
      type: 'init', id: cur.id, style: cur.style, paused: getState('play_paused') === '1', sceneFps: Number(getState('scene_fps')) || 72, videoCap: getState('video_cap') === '1', videoFps: Number(getState('video_fps')) || null, renderFps: renderFpsState(),
      props: merged.all, frame: frameOf(cur.id, cur.style), mouse: mouseState(), sound: soundState(),
    })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ type: 'init', id: null, paused: getState('play_paused') === '1', mouse: mouseState(), sound: soundState(), renderFps: renderFpsState() })}\n\n`);
  }

  // 心跳：本地直连其实不需要，但浏览器对长时间无数据的连接有回收策略
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 下面 close 会清掉 */ } }, 25000);
  const bye = () => { clearInterval(ping); clients.delete(res); };
  req.on('close', bye);
  req.on('error', bye);
  res.on('error', bye);
});

// ---------- 桌面鼠标互动 ----------
// 桌面壁纸窗口挂在图标层下面，真实鼠标事件进不来（详见 shell/main.mjs 的光标旁听）。
// 位置是默认转发的，只有"点击"需要一个开关：它靠旁听全局左键实现，
// 打开后点桌面图标、拖文件时壁纸也会跟着响应，这个副作用消除不掉，只能让用户自己选。
const mouseState = () => ({ click: getState('play_mouse_click') === '1' });

router.get('/mouse', (req, res) => success(res, mouseState()));

router.post('/mouse', (req, res) => {
  const click = !!req.body?.click;
  setState('play_mouse_click', click ? '1' : '0');
  broadcast({ type: 'mouse', click });
  success(res, { click });
});

// ---------- 声音 ----------
// 视频壁纸默认静音（和「应用即静音」的老行为一致）。这是一项全局设置，
// 不按壁纸分别记：它管的是"要不要出声"这件事本身，换壁纸不该悄悄把声音打开。
const soundState = () => ({ sound: getState('play_video_sound') === '1' });

router.get('/sound', (req, res) => success(res, soundState()));

router.post('/sound', (req, res) => {
  const sound = !!req.body?.sound;
  setState('play_video_sound', sound ? '1' : '0');
  broadcast({ type: 'sound', sound });
  success(res, { sound });
});

// ---------- 状态 ----------

router.get('/state', (req, res) => {
  const cur = currentRow();
  if (!cur.id) {
    return success(res, {
      id: null, style: null, appliedAt: null, paused: getState('play_paused') === '1',
      sceneFps: Number(getState('scene_fps')) || 72, videoCap: getState('video_cap') === '1', videoFps: Number(getState('video_fps')) || null, renderFps: renderFpsState(),
      wall: null, props: { list: [], values: {} }, frame: null, mouse: mouseState(), sound: soundState(),
    });
  }
  const declared = readWallpaperProps(cur.row);
  const merged = mergeProps(declared, readMap('wp_props')[String(cur.id)]);
  success(res, {
    id: cur.id,
    style: cur.style,
    appliedAt: cur.appliedAt,
    paused: getState('play_paused') === '1',
    sceneFps: Number(getState('scene_fps')) || 72, videoCap: getState('video_cap') === '1', videoFps: Number(getState('video_fps')) || null, renderFps: renderFpsState(),
    wall: cur.row,
    // all 是完整属性表：界面用 list 画控件，往壁纸里推值时必须用 all（少一个键就会被当成"没设置"）
    props: { list: merged.list, values: merged.values, all: merged.all },
    frame: frameOf(cur.id, cur.style),
    mouse: mouseState(),
    sound: soundState(),
  });
});

// ---------- 帧率 ----------
// 全局渲染节拍（WE 同款）：一个值管所有壁纸，不按类型/壁纸分别记，切换壁纸保持。
// 三条链路各自执行：内核视频 Present 节流、场景 WebWallGL、网页经桥下发 fps。
// 30 为默认（桌面壁纸 30 帧即流畅、省近半 GPU，WE 官方口径）。
const RENDER_FPS_CHOICES = [30, 60, 72, 144];
const renderFpsState = () => {
  const n = Number(getState('render_fps'));
  return RENDER_FPS_CHOICES.includes(n) ? n : 30;
};
router.get('/render-fps', (req, res) => success(res, { fps: renderFpsState() }));
router.post('/render-fps', (req, res) => {
  const fps = Number(req.body?.fps);
  if (!RENDER_FPS_CHOICES.includes(fps)) return fail(res, 400, '不支持的帧率');
  setState('render_fps', String(fps));
  broadcast({ type: 'render-fps', fps });
  success(res, { fps });
});

// 旧接口保留但前端已不再使用（帧率统一走 render-fps），仅为兼容老版本桌面页。
const SCENE_FPS_CHOICES = [72, 144];
router.get('/scene-fps', (req, res) => success(res, { fps: Number(getState('scene_fps')) || 72 }));
router.post('/scene-fps', (req, res) => {
  const fps = Number(req.body?.fps);
  if (!SCENE_FPS_CHOICES.includes(fps)) return fail(res, 400, '不支持的帧率');
  setState('scene_fps', String(fps));
  broadcast({ type: 'scene-fps', fps });
  success(res, { fps });
});

// 视频锁 30 开关（app_state video_cap）：开着时桌面层对 ≥45fps 片源做 canvas 丢帧呈现
router.get('/video-cap', (req, res) => success(res, { on: getState('video_cap') === '1' }));
router.post('/video-cap', (req, res) => {
  const on = req.body?.on === true;
  setState('video_cap', on ? '1' : '0');
  broadcast({ type: 'video-cap', on });
  success(res, { on });
});

// 视频片源实测帧率（桌面层用 requestVideoFrameCallback 采样后上报，只读展示）
router.get('/video-fps', (req, res) => success(res, { fps: Number(getState('video_fps')) || null }));
router.post('/video-fps', (req, res) => {
  const fps = Number(req.body?.fps);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) return fail(res, 400, '帧率不合法');
  setState('video_fps', String(Math.round(fps)));
  success(res, { fps: Math.round(fps) });
});

// 单独取某条壁纸的调节项（预览里想提前看有什么可调时也能用）
router.get('/props/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const declared = readWallpaperProps(row);
  const merged = mergeProps(declared, readMap('wp_props')[String(row.id)]);
  success(res, { id: Number(row.id), list: merged.list, values: merged.values, all: merged.all });
});

// 改一个调节项：立刻存盘并广播。
// 只推改动项看着省事，但壁纸那边的监听器会把最后一次收到的对象当作"完整面板值"缓存下来，
// 只推一项会让其它项在它内部重新初始化时丢失，所以广播里永远带全量。
router.patch('/props/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const key = String(req.body?.key || '');
  if (!key) return fail(res, 400, '缺少 key');

  const declared = readWallpaperProps(row);
  if (!declared.list.length) return fail(res, 400, '这条壁纸没有声明任何可调节项');
  const check = validatePropValue(declared, key, req.body?.value);
  if (!check.ok) return fail(res, 400, check.reason);

  // 和默认值相同就不存了，保持稀疏表干净（壁纸作者改默认值也能跟着变）
  const isDefault = String(check.value) === String(declared.values[key]);
  const saved = readMap('wp_props');
  const mine = saved[String(row.id)] || {};
  if (isDefault) delete mine[key]; else mine[key] = check.value;
  writeMapEntry('wp_props', row.id, Object.keys(mine).length ? mine : null);

  const merged = mergeProps(declared, mine);
  broadcast({ type: 'props', id: Number(row.id), all: merged.all, values: merged.values });
  success(res, { id: Number(row.id), key, value: check.value, values: merged.values });
});

// 恢复默认：只清这条壁纸自己的记录
router.post('/props/:id/reset', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  writeMapEntry('wp_props', row.id, null);
  const declared = readWallpaperProps(row);
  const merged = mergeProps(declared, null);
  broadcast({ type: 'props', id: Number(row.id), all: merged.all, values: merged.values });
  success(res, { id: Number(row.id), values: merged.values });
});

// ---------- 画面变换（所有类型通用，作用在最外层容器上） ----------

router.patch('/frame/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  const frame = coerceFrame({ ...frameOf(row.id, getState('wallpaper_style') || 'fill'), ...(req.body || {}) });
  writeMapEntry('wp_frame', row.id, frame);
  broadcast({ type: 'frame', id: Number(row.id), frame });
  success(res, frame);
});

router.post('/frame/:id/reset', (req, res) => {
  const row = db.prepare('SELECT * FROM wallpapers WHERE id = ?').get(req.params.id);
  if (!row) return fail(res, 404, '壁纸不存在');
  writeMapEntry('wp_frame', row.id, null);
  const frame = frameOf(row.id, getState('wallpaper_style') || 'fill');
  broadcast({ type: 'frame', id: Number(row.id), frame });
  success(res, frame);
});

// ---------- 手动暂停 ----------
// 全屏检测那套是自动的（shell/fullscreen.mjs），这里是用户主动按的暂停。
// 两者互不覆盖：自动暂停只在桌面层内部生效，不改这个开关。

router.post('/pause', (req, res) => {
  const paused = !!req.body?.paused;
  setState('play_paused', paused ? '1' : '0');
  broadcast({ type: 'paused', paused });
  success(res, { paused });
});

export default router;
