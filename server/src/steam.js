import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import db from './db.js';
import { parseProjectJson, findProjectJson, pickMainFile, pickPreview } from './we-format.js';

// Wallpaper Engine 在 Steam 上的固定 appid
export const WE_APP_ID = '431960';

// ---------- 定位 Steam 与库 ----------

// 读注册表拿 Steam 安装位置。失败返回空串，由调用方走手动指定。
function readRegistrySteamPath() {
  if (process.platform !== 'win32') return '';
  const probes = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ];
  for (const [key, name] of probes) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', name], {
        encoding: 'utf8', windowsHide: true, timeout: 5000,
      });
      const m = out.match(new RegExp(name + '\\s+REG_SZ\\s+(.+)', 'i'));
      if (m && m[1].trim()) return m[1].trim();
    } catch { /* 换下一个探测点 */ }
  }
  return '';
}

// 解析 libraryfolders.vdf：只要 "path" 后面那串，兼容 v1/v2 两种结构
export function parseLibraryFolders(text) {
  const out = [];
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[1].replace(/\\\\/g, '\\').trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

function readLibraryFolders(steamRoot) {
  const vdf = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    return parseLibraryFolders(fs.readFileSync(vdf, 'utf8'));
  } catch { return []; }
}

// 手动添加的目录（存在 app_state 里，纯用户选择，不做任何自动决定）
export function getExtraDirs() {
  try {
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'we_extra_dirs'").get();
    const arr = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string' && p) : [];
  } catch { return []; }
}

export function setExtraDirs(dirs) {
  const clean = [];
  for (const d of Array.isArray(dirs) ? dirs : []) {
    if (typeof d !== 'string' || !d.trim()) continue;
    const abs = path.resolve(d.trim());
    if (!clean.includes(abs)) clean.push(abs);
  }
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES ('we_extra_dirs', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(JSON.stringify(clean));
  return clean;
}

// 候选 Steam 安装位置：注册表优先，其次是常见安装路径
// 之所以不只读注册表：某些环境（受限账户、被安全软件拦、绿色版 Steam）读不到 reg.exe
function candidateSteamRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (out.some((x) => x.toLowerCase() === abs.toLowerCase())) return;
    // 只认真正装着 Steam 的目录（有 steamapps 才算）
    if (fs.existsSync(path.join(abs, 'steamapps'))) out.push(abs);
  };

  // 测试/调试用：显式指定后只认这一个根，不扩散到其他盘
  const fromEnv = process.env.WF_STEAM_DIR;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    return fs.existsSync(abs) ? [abs] : [];
  }
  add(readRegistrySteamPath());

  for (const key of ['ProgramFiles(x86)', 'ProgramFiles']) {
    const base = process.env[key];
    if (base) add(path.join(base, 'Steam'));
  }
  // 常见自选安装位置：各盘根目录下的 Steam / STEAM / SteamLibrary
  for (let c = 67; c <= 90; c += 1) {
    const drive = String.fromCharCode(c) + ':\\';
    for (const name of ['Steam', 'STEAM', 'SteamLibrary', 'SteamLibrary2']) {
      add(path.join(drive, name));
    }
  }
  return out;
}

// 汇总所有"可能装着壁纸引擎内容"的位置
export function discoverSources() {
  const candidates = candidateSteamRoots();
  const roots = [];
  const seenRoot = new Set();
  const pushRoot = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) return;
    const k = abs.toLowerCase();
    if (seenRoot.has(k)) return;
    seenRoot.add(k);
    roots.push(abs);
  };

  pushRoot(candidates[0] || process.env.WF_STEAM_DIR || '');
  for (const cand of candidates) {
    pushRoot(cand);
    for (const lib of readLibraryFolders(cand)) {
      if (fs.existsSync(lib)) pushRoot(lib);
    }
  }
  const steamRoot = candidates[0] || '';

  const libraries = roots.map((root) => {
    const workshopDir = path.join(root, 'steamapps', 'workshop', 'content', WE_APP_ID);
    let itemCount = 0;
    try {
      itemCount = fs.readdirSync(workshopDir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).length;
    } catch { /* 库存在但没有订阅内容 */ }
    return { root, workshopDir, exists: fs.existsSync(workshopDir), itemCount };
  });

  return {
    steamRoot: steamRoot || '',
    steamFound: !!steamRoot && fs.existsSync(steamRoot),
    libraries,
    extraDirs: getExtraDirs(),
  };
}

// 把来源目录展开成"待扫描的壁纸目录列表"
// 支持三种输入：创意工坊 content/431960（子目录=壁纸）、单个壁纸目录（含 project.json）、任意上层目录
function expandSourceDirs(src) {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(src, { withFileTypes: true }); } catch { return out; }
  if (ents.some((e) => e.isFile() && e.name.toLowerCase() === 'project.json')) {
    out.push({ dir: src, source: 'local' });
    return out;
  }
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = path.join(src, e.name);
    // 只看一层：WE 的目录结构就是 <content>/<id>/project.json
    try {
      if (fs.existsSync(path.join(dir, 'project.json'))) {
        out.push({ dir, source: /^\d+$/.test(e.name) ? 'workshop' : 'local', key: e.name });
      }
    } catch { /* 跳过不可读目录 */ }
  }
  return out;
}

// ---------- 统计与扫描 ----------

// 递归统计目录：目录读取与文件 stat 都分批并发，千级壁纸也能在几十秒内跑完
async function dirStats(root) {
  let bytes = 0;
  let files = 0;
  const queue = [root];
  while (queue.length) {
    const batch = queue.splice(0, 24);
    const listed = await Promise.all(batch.map(async (d) => {
      try { return { d, ents: await fsp.readdir(d, { withFileTypes: true }) }; } catch { return { d, ents: [] }; }
    }));
    const nextDirs = [];
    const filePaths = [];
    for (const { d, ents } of listed) {
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) nextDirs.push(p);
        else if (e.isFile()) filePaths.push(p);
      }
    }
    queue.push(...nextDirs);
    for (let i = 0; i < filePaths.length; i += 64) {
      const chunk = filePaths.slice(i, i + 64);
      const stats = await Promise.all(chunk.map((p) => fsp.stat(p).catch(() => null)));
      for (const s of stats) {
        if (s && s.isFile()) { bytes += s.size; files += 1; }
      }
    }
  }
  return { bytes, files };
}

function idFor(entry) {
  if (entry.source === 'workshop' && entry.key) return String(entry.key);
  return 'local-' + crypto.createHash('sha1').update(entry.dir).digest('hex').slice(0, 12);
}

const upsert = () => db.prepare(`
  INSERT INTO we_items
    (workshop_id, source, lib_root, dir_path, title, type, preview, main_file, author, description, tags,
     size_bytes, file_count, source_exists, status, scanned_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))
  ON CONFLICT(workshop_id) DO UPDATE SET
    source = excluded.source, lib_root = excluded.lib_root, dir_path = excluded.dir_path,
    title = excluded.title, type = excluded.type, preview = excluded.preview,
    main_file = excluded.main_file, author = excluded.author,
    description = excluded.description, tags = excluded.tags,
    size_bytes = excluded.size_bytes, file_count = excluded.file_count,
    source_exists = 1,
    status = CASE WHEN we_items.wallpaper_id IS NOT NULL THEN 'imported' ELSE excluded.status END,
    scanned_at = datetime('now')
`);

// 扫描任务：一次只跑一个，进度存在内存里给前端轮询
const job = {
  running: false, phase: '', total: 0, done: 0,
  found: 0, removed: 0, purged: 0, errors: 0,
  unique: 0, duplicates: 0, skipped: [],
  startedAt: 0, finishedAt: 0, message: '',
};

export function scanState() {
  return { ...job };
}

export async function runScan() {
  if (job.running) return scanState();
  Object.assign(job, {
    running: true, phase: '定位库', total: 0, done: 0,
    found: 0, removed: 0, purged: 0, errors: 0,
    unique: 0, duplicates: 0, skipped: [],
    startedAt: Date.now(), finishedAt: 0, message: '',
  });

  const run = (async () => {
    const disc = discoverSources();
    const roots = disc.libraries.filter((l) => l.exists).map((l) => l.workshopDir);
    const allRoots = [...roots, ...disc.extraDirs];

    const entries = [];
    for (const src of allRoots) entries.push(...expandSourceDirs(src));
    // 同一目录被多个来源重复列出时去重
    const seen = new Set();
    const uniq = entries.filter((e) => (seen.has(e.dir) ? false : (seen.add(e.dir), true)));

    job.phase = '扫描壁纸';

    // 同一个 workshop id 可能在多个 Steam 库里各有一份（库迁移会留下重复目录）。
    // 以前直接 upsert 会互相覆盖：扫到 1077 个目录，表里只剩 1050 行，看着像丢数据。
    // 现在先按 id 挑内容最全的那一份（一级条目多者优先），其余计入「合并重复」。
    const dirWeight = (d) => { try { return fs.readdirSync(d).length; } catch { return -1; } };
    const bestById = new Map();
    for (const entry of uniq) {
      const id = idFor(entry);
      const prev = bestById.get(id);
      if (!prev || dirWeight(entry.dir) > dirWeight(prev.dir)) bestById.set(id, entry);
    }

    job.total = uniq.length;
    job.unique = bestById.size;
    job.duplicates = uniq.length - bestById.size;
    job.skipped = [];

    const stmt = upsert();
    const kept = new Set();
    for (const [id, entry] of bestById) {
      kept.add(id);
      try {
        const pj = findProjectJson(entry.dir);
        if (!pj) throw new Error('目录里没有 project.json');
        const meta = parseProjectJson(pj.file);
        const main = pickMainFile(pj.wallDir, meta.file, meta.type);
        const cover = pickPreview(pj.wallDir, meta.preview);
        const { bytes, files } = await dirStats(entry.dir);
        stmt.run(
          id, entry.source, entry.dir, pj.wallDir,
          meta.title, meta.type, cover, main, meta.author,
          meta.description.slice(0, 2000), meta.tags.join(','),
          bytes, files, 'available',
        );
        job.found += 1;
      } catch (e) {
        job.errors += 1;
        // 记明细：以前只加个计数器，用户看到「跳过 1 个」但永远不知道是哪个
        if (job.skipped.length < 50) {
          job.skipped.push({
            id, dir: entry.dir,
            title: (() => { try { return path.basename(entry.dir); } catch { return id; } })(),
            reason: String(e?.message || e).slice(0, 200),
          });
        }
      }
      job.done += 1;
    }

    // 这次没扫到的历史条目 → 分两种情况处理（不能让界面上留一批点不开的空卡）
    //   · 目录没了，但它所在的那个库目录还在 → 是真的被删/被 Steam 清了：
    //       已经复制进「我的壁纸」的留记录（卡片显示已复制），没复制过的直接清掉
    //   · 整个库目录都不在 → 大概率是移动硬盘没插、Steam 库被暂时移走：
    //       只标记源缺失，**绝不删记录**，否则插回来一次扫描就把数据全丢了
    job.phase = '核对失效项';
    const rows = db.prepare('SELECT workshop_id, dir_path, wallpaper_id, source_exists FROM we_items').all();
    const markGone = db.prepare(`
      UPDATE we_items SET source_exists = 0,
        status = CASE WHEN wallpaper_id IS NOT NULL THEN 'imported' ELSE 'missing' END
      WHERE workshop_id = ?
    `);
    const purge = db.prepare('DELETE FROM we_items WHERE workshop_id = ?');
    const rootAlive = (dirPath) => {
      try { return fs.existsSync(path.dirname(dirPath)); } catch { return false; }
    };
    for (const r of rows) {
      if (kept.has(r.workshop_id)) continue;
      if (fs.existsSync(r.dir_path)) continue;
      if (r.wallpaper_id == null && rootAlive(r.dir_path)) {
        purge.run(r.workshop_id);
        job.purged += 1;
        continue;
      }
      if (r.source_exists) { markGone.run(r.workshop_id); job.removed += 1; }
    }
    job.phase = '完成';
    // 口径必须自己说清楚：目录数、合并的重复、跳过的失败、真正入库的，是四个不同的数
    job.message = `扫描 ${job.total} 个目录 · 合并重复 ${job.duplicates} 个 · 跳过 ${job.errors} 个 · 入库 ${job.found} 个`
      + (job.purged ? ` · 清理失效 ${job.purged} 个` : '');
  })();

  try {
    await run;
  } catch (e) {
    job.message = '扫描失败：' + (e?.message || e);
    job.phase = '失败';
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
  return scanState();
}

// 路径守卫：只允许访问已知来源目录内部（防目录穿越 / 任意文件读取）
// 带 5 秒缓存：媒体请求会连续来很多次（网页壁纸一个页面十几个资源），不能每次都全盘探测
let rootsCache = null;

export function knownRoots() {
  if (rootsCache && Date.now() - rootsCache.at < 5000) return rootsCache.roots;
  const roots = [
    ...discoverSources().libraries.map((l) => l.workshopDir),
    ...getExtraDirs(),
  ].filter(Boolean).map((r) => path.resolve(r));
  rootsCache = { at: Date.now(), roots };
  return roots;
}

export function isInsideKnownRoot(target) {
  const abs = path.resolve(target);
  // Windows 路径不区分大小写，但盘符探测出来的根目录是小写（e:\steam），
  // 而 libraryfolders.vdf 里可能写成 E:\Steam。严格比较会把同一目录判成"不在库内"，
  // 表现为预览 403。这里统一按平台规则比较。
  const norm = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const a = norm(abs);
  return knownRoots().some((root) => a === norm(root) || a.startsWith(norm(root) + path.sep));
}

// ---------- Steamworks 客户端库（取消订阅用） ----------
// 需要 steam_api64.dll：这是个随游戏分发的客户端库，本机通常能在壁纸引擎自己的 bin 目录里找到。
// 优先用用户自己安装里的这份，不去额外下载/分发任何 SDK 文件。
function readDllSetting() {
  try {
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'steam_api_dll'").get();
    return row?.value || '';
  } catch { return ''; }
}

export function setSteamDllPath(p) {
  const value = p ? path.resolve(p) : '';
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES ('steam_api_dll', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(value);
  dllCache = null;
  return value;
}

let dllCache = null; // { at, result }

export function findSteamApiDll() {
  if (dllCache && Date.now() - dllCache.at < 30000) return dllCache.result;

  const cands = [];
  const add = (p, origin) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (cands.some((c) => c.path.toLowerCase() === abs.toLowerCase())) return;
    cands.push({ path: abs, origin });
  };

  add(readDllSetting(), '手动指定');
  add(process.env.WF_STEAM_DLL, '环境变量');

  const disc = discoverSources();
  for (const lib of disc.libraries) {
    // 壁纸引擎本体自带的
    add(path.join(lib.root, 'steamapps', 'common', 'wallpaper_engine', 'bin', 'steam_api64.dll'), '壁纸引擎');
  }
  // 其他游戏自带的（只扫两级，控制在几十个目录内，不做全盘搜）
  let budget = 60;
  for (const lib of disc.libraries) {
    const common = path.join(lib.root, 'steamapps', 'common');
    let dirs = [];
    try { dirs = fs.readdirSync(common, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      if (budget-- <= 0) break;
      add(path.join(common, d.name, 'steam_api64.dll'), '其他游戏');
      add(path.join(common, d.name, 'bin', 'steam_api64.dll'), '其他游戏');
    }
  }

  const hit = cands.find((c) => { try { return fs.statSync(c.path).isFile(); } catch { return false; } });
  const result = hit || null;
  dllCache = { at: Date.now(), result };
  return result;
}
