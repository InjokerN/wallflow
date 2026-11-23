// 壁纸自带的调节项（Wallpaper Engine 的「属性面板」）
//
// WE 壁纸把可调项声明在 project.json 的 general.properties 里，运行时靠
// window.wallpaperPropertyListener.applyUserProperties(properties) 把值推进页面。
// WallFlow 桌面层只是一个普通浏览器页面，拿不到 WE 的注入，所以这里做两件事：
//   1. 把 project.json 的声明读成前端能直接渲染的清单
//   2. 把用户改过的值存下来，切壁纸回来重新推一次
//
// 只认能真正生效的类型。file / directory / scenetexture 要弹系统选择框、
// usershortcut 要抓全局快捷键，这些在桌面层做不到，直接跳过 —— 界面上宁可不显示，
// 也不放一个点了没反应的控件。

import fs from 'node:fs';
import path from 'node:path';
import { resolveWallpaperDir } from './library-path.js';

// WE 内部文案键（属性面板里显示成「主题色」之类）不该原样露给用户
const I18N_KEY = /^ui_browse_/i;

// 这个开关不给用户看：它管的是「壁纸自己要不要响应互动」。
// 真正该由用户决定的是 WallFlow 那层的「接收桌面点击」，而壁纸这层永远开着就行。
// 两个都摆出来，用户会以为是重复的开关。值固定 true，靠 all 推给页面。
const AUTO_ON_KEY = /^(interactive|enable_?interactive)$/i;

// 能渲染也能生效的类型；不在这个表里的一律不返回给前端
const RENDERABLE = new Set(['slider', 'bool', 'color', 'combo', 'textinput']);

const asNum = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// 颜色在 WE 里是 "r g b"（0~255，空格分隔），不是 #rrggbb
function normalizeColor(v, fallback) {
  const parts = String(v ?? '').trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return parts.map((n) => Math.max(0, Math.min(255, Math.round(n)))).join(' ');
}

// 按声明把任意输入夹回合法值：滑块要对齐 step，下拉必须是已声明的选项
function coerce(item, raw) {
  switch (item.type) {
    case 'bool':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'slider': {
      let n = asNum(raw, item.value);
      n = Math.max(item.min, Math.min(item.max, n));
      if (item.step > 0) n = Math.round(n / item.step) * item.step;
      // 步长累加会出现 99.99999，按精度收一下
      const p = Math.max(0, Math.min(6, item.precision));
      return Number(n.toFixed(p));
    }
    case 'color':
      return normalizeColor(raw, item.value);
    case 'combo': {
      const s = String(raw ?? '');
      return item.options.some((o) => o.value === s) ? s : item.value;
    }
    default:
      return String(raw ?? '').slice(0, 200);
  }
}

// 找到壁纸目录下真正的 project.json（和导入时同一套规则：根目录优先，再往下一层）
function findProjectFile(dir) {
  try {
    const direct = path.join(dir, 'project.json');
    if (fs.existsSync(direct)) return direct;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const nested = path.join(dir, e.name, 'project.json');
      if (fs.existsSync(nested)) return nested;
    }
  } catch { /* 目录不在（盘没挂上）就当没有 */ }
  return null;
}

// 读一条壁纸的属性声明。
// 返回 { list, values, all }：
//   list   只含可渲染项（给界面画控件）
//   values 每项的当前默认值（已按声明夹过）
//   all    完整键值（推给页面时必须是全量，见 routes/play.js 的说明）
export function readWallpaperProps(row) {
  const empty = { list: [], values: {}, all: {} };
  if (!row) return empty;
  const dir = resolveWallpaperDir(row);
  const file = findProjectFile(dir);
  if (!file) return empty;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return empty; // project.json 坏了不影响壁纸本身能不能播
  }

  const props = raw?.general?.properties || raw?.properties || {};
  const all = {};
  const items = [];

  for (const [key, def] of Object.entries(props)) {
    if (!def || typeof def !== 'object') continue;
    const type = String(def.type || '').toLowerCase();
    const text = String(def.text || '');

    // 默认值先按类型粗规范一次，全量推送用
    let value;
    if (type === 'bool') value = def.value !== false;
    else if (type === 'color') value = normalizeColor(def.value, '0 0 0');
    else if (type === 'slider') value = asNum(def.value, asNum(def.min, 0));
    else value = String(def.value ?? '');
    all[key] = value;

    // 强制常开的项：值钉死 true，也不进界面（见 AUTO_ON_KEY 的说明）
    if (type === 'bool' && AUTO_ON_KEY.test(key)) {
      all[key] = true;
      continue;
    }

    if (!RENDERABLE.has(type)) continue;
    if (I18N_KEY.test(text)) continue;      // 「主题色」这类 WE 内部项，不展示

    const item = { key, type, text: text || key };
    if (type === 'slider') {
      item.min = asNum(def.min, 0);
      item.max = asNum(def.max, 100);
      if (item.max <= item.min) continue;   // 声明坏了，画出来也没法拖
      item.step = Math.max(0, asNum(def.step, 1));
      item.precision = Math.max(0, asNum(def.precision, 0));
      item.value = coerce(item, value);
      all[key] = item.value;
    } else if (type === 'combo') {
      const opts = Array.isArray(def.options) ? def.options : [];
      item.options = opts
        .filter((o) => o && o.value !== undefined)
        .map((o) => ({ label: String(o.label ?? o.value), value: String(o.value) }));
      if (item.options.length < 2) continue; // 只有一个选项等于没得选
      item.value = item.options.some((o) => o.value === value) ? value : item.options[0].value;
      all[key] = item.value;
    } else if (type === 'bool') {
      item.value = value;
    } else if (type === 'color') {
      item.value = value;
    } else {
      item.value = String(value).slice(0, 200);
      all[key] = item.value;
    }

    // WE 用 order 排面板顺序，缺省时按 index，都没有就排最后
    item._order = asNum(def.order, asNum(def.index, 999));
    items.push(item);
  }

  items.sort((a, b) => a._order - b._order || a.key.localeCompare(b.key));
  const list = items.map(({ _order, ...rest }) => rest);
  return { list, values: Object.fromEntries(list.map((i) => [i.key, i.value])), all };
}

// 用户改过的值合并到声明默认值上。存的是稀疏表（只存和默认不同的），
// 这样壁纸作者以后改了默认值，我们不会用旧值把它盖住。
export function mergeProps(declared, saved) {
  const values = { ...declared.values };
  const all = { ...declared.all };
  for (const item of declared.list) {
    if (!saved || !(item.key in saved)) continue;
    const v = coerce(item, saved[item.key]);
    values[item.key] = v;
    all[item.key] = v;
  }
  return { list: declared.list, values, all };
}

// 校验外部传进来的单值；不认识的键直接拒绝，避免往页面里灌任意字段
export function validatePropValue(declared, key, raw) {
  const item = declared.list.find((i) => i.key === key);
  if (!item) return { ok: false, reason: `壁纸没有声明「${key}」这个调节项` };
  return { ok: true, item, value: coerce(item, raw) };
}
