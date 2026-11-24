import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WE_TAG_SET } from './we-tags.js';

// 所有路径基于数据根目录计算，不硬编码绝对路径
const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '../..');

// 数据根目录：
//   开发时（直接 node server/src/app.js）→ 项目内的 server/，行为与以前一致
//   桌面版（主进程 spawn 时注入 WF_DATA_DIR）→ %APPDATA%\WallFlow，程序目录可只读
// 这样把整个 release 目录复制到别的电脑、或放进 Program Files / 只读盘，都不影响写入
const dataRoot = process.env.WF_DATA_DIR
  ? path.resolve(process.env.WF_DATA_DIR)
  : path.join(projectRoot, 'server');

export const PROJECT_ROOT = projectRoot;
export const DATA_ROOT = dataRoot;
export const DATA_DIR = path.join(dataRoot, 'data');
export const EXPORTS_DIR = path.join(dataRoot, 'exports');
// 壁纸库默认落在程序数据目录下的 library/，但允许用户改到任意位置（几十 GB 不该塞 C 盘）
export const DEFAULT_LIBRARY_DIR = path.join(dataRoot, 'uploads');
for (const d of [DATA_DIR, DEFAULT_LIBRARY_DIR, EXPORTS_DIR]) fs.mkdirSync(d, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'wallflow.db'));

// 建表：壁纸元数据。类型用英文枚举 scene/video/web，对应中文目录 场景/视频/网页
db.exec(`
  CREATE TABLE IF NOT EXISTS wallpapers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('scene','video','web')),
    dir_name TEXT NOT NULL,
    cover TEXT,
    main_file TEXT,
    author TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '未分类',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const TYPE_DIR = { scene: '场景', video: '视频', web: '网页' };

// 老库补列：CREATE TABLE IF NOT EXISTS 不会给已有表加字段，这里做一次轻量迁移
const wallpaperCols = new Set(db.prepare('PRAGMA table_info(wallpapers)').all().map((c) => c.name));
if (!wallpaperCols.has('source_note')) {
  db.exec("ALTER TABLE wallpapers ADD COLUMN source_note TEXT NOT NULL DEFAULT ''");
}
// 标签：从壁纸引擎复制进来的条目会把 project.json 的 tags 带过来（逗号分隔）
if (!wallpaperCols.has('tags')) {
  db.exec("ALTER TABLE wallpapers ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
}

// 标签分层：主标签必须是 WE 枚举（导出时只写它），副标签自由文本、只在本地用。
// 新建列的那一次顺手把老的 tags 迁过去：枚举值提为主标签，其余留在副标签。
if (!wallpaperCols.has('primary_tag')) {
  db.exec("ALTER TABLE wallpapers ADD COLUMN primary_tag TEXT NOT NULL DEFAULT ''");
  const rows = db.prepare("SELECT id, tags FROM wallpapers WHERE tags <> ''").all();
  const upd = db.prepare('UPDATE wallpapers SET primary_tag = ?, tags = ? WHERE id = ?');
  for (const r of rows) {
    const all = String(r.tags).split(',').map((s) => s.trim()).filter(Boolean);
    // Unspecified 等同于「没指定」，留空即可，卡片上照样显示「未分类」
    const primary = all.find((t) => WE_TAG_SET.has(t) && t !== 'Unspecified') || '';
    const subs = all.filter((t) => t !== primary && !WE_TAG_SET.has(t));
    upd.run(primary, subs.join(','), r.id);
  }
}

// 文件夹大小：启动后由 size-cache 后台写入，界面上只在详情里显示
if (!wallpaperCols.has('size_bytes')) {
  db.exec('ALTER TABLE wallpapers ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0');
}
// 计算时目录的 mtime，用来判断「没变就别重算」
if (!wallpaperCols.has('size_at')) {
  db.exec("ALTER TABLE wallpapers ADD COLUMN size_at TEXT NOT NULL DEFAULT ''");
}
// 收藏：原来存在浏览器 localStorage 里、按 SQLite 行 id 做键 ——
// 换机器 / 清用户数据 / 删掉再导入（行 id 会变）都会静默丢失，出问题也查不到痕迹。
// 现在跟着壁纸行一起存，删壁纸时收藏自然跟着消失，不会再残留一条指向不存在壁纸的记录。
if (!wallpaperCols.has('favorite')) {
  db.exec('ALTER TABLE wallpapers ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0');
}

// 文件夹（逻辑分组）：只是壁纸的归属标签，绝不动磁盘上的物理目录。
// parent_id 支持嵌套（NULL = 根）；wallpapers.folder_id 指向文件夹，NULL = 未分组（"全部"）。
// 物理目录是 类型/目录名/ 结构，被导出/删除/内核播放路径强依赖，移动物理文件会串断整条链路。
if (!wallpaperCols.has('folder_id')) {
  db.exec('ALTER TABLE wallpapers ADD COLUMN folder_id INTEGER');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE
  );
`);

// 应用状态：当前桌面壁纸是哪条、用的什么样式（后期「正在播放」页与套壳开机恢复都要读它）
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 壁纸库根目录：用户可在设置里改。空值 = 用默认目录（数据目录下 uploads/）
let cachedLibraryDir = null;
export function getLibraryDir() {
  if (cachedLibraryDir) return cachedLibraryDir;
  try {
    const row = db.prepare("SELECT value FROM app_state WHERE key = 'library_dir'").get();
    if (row?.value) cachedLibraryDir = row.value;
  } catch { /* 读不到就用默认 */ }
  return cachedLibraryDir || DEFAULT_LIBRARY_DIR;
}
export function setLibraryDir(dir) {
  setAppState('library_dir', dir ? path.resolve(dir) : '');
  cachedLibraryDir = null;
  // 缓存默认跟着库走，库一变缓存位置也跟着变，旧的缓存指针必须作废
  cachedCacheDir = '';
  const actual = getLibraryDir();
  fs.mkdirSync(actual, { recursive: true });
  return actual;
}

function setAppState(key, value) {
  db.prepare(`
    INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

function getAppState(key) {
  try {
    return db.prepare('SELECT value FROM app_state WHERE key = ?').get(key)?.value || '';
  } catch {
    return '';
  }
}

// 缓存目录：默认跟着壁纸库走（<库目录>/.cache），用户可在设置里单独指定。
// 之前放在数据目录里，等于壁纸在 D 盘、缓存留在 C 盘吃系统盘空间；跟着库走还能一起搬。
// 单独指定时（比如库在机械盘、想把缓存丢到 SSD）就不跟随库迁移。
let cacheDirSetting = null; // null = 还没从库里读过，'' = 用默认（跟随库）
let cachedCacheDir = '';

function cacheDirOverride() {
  if (cacheDirSetting === null) {
    const v = getAppState('cache_dir');
    cacheDirSetting = v ? path.resolve(v) : '';
  }
  return cacheDirSetting;
}

export function getDefaultCacheDir() {
  return path.join(getLibraryDir(), '.cache');
}

export function getCacheDir() {
  const wanted = cacheDirOverride() || getDefaultCacheDir();
  if (cachedCacheDir !== wanted) {
    try {
      fs.mkdirSync(wanted, { recursive: true });
      cachedCacheDir = wanted;
    } catch {
      // 自定义目录所在盘拔了 / 没权限：退回默认目录，别让缩略图接口整个 500。
      // 设置值保留不动，盘接回来下次调用就能自动回到原处。
      const fallback = getDefaultCacheDir();
      try { fs.mkdirSync(fallback, { recursive: true }); } catch { /* 默认也不可用就交给调用方处理 */ }
      cachedCacheDir = fallback;
    }
  }
  return cachedCacheDir;
}

// dir 传空 = 恢复成「跟随壁纸库」
export function setCacheDir(dir) {
  const value = dir ? path.resolve(dir) : '';
  setAppState('cache_dir', value);
  cacheDirSetting = value;
  cachedCacheDir = '';
  const actual = getCacheDir();
  fs.mkdirSync(actual, { recursive: true });
  return actual;
}

// 壁纸引擎库索引：只记录"扫描到的内容"，不代表已经复制进来
// status: available=源在 / imported=已复制入库 / missing=源已消失
db.exec(`
  CREATE TABLE IF NOT EXISTS we_items (
    workshop_id TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'workshop',
    lib_root TEXT NOT NULL DEFAULT '',
    dir_path TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    type TEXT,
    preview TEXT NOT NULL DEFAULT '',
    main_file TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    source_exists INTEGER NOT NULL DEFAULT 1,
    wallpaper_id INTEGER,
    status TEXT NOT NULL DEFAULT 'available',
    scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_we_status ON we_items(status);
  CREATE INDEX IF NOT EXISTS idx_we_type ON we_items(type);
`);

// we_items 轻量迁移：兼容性探测结果、Steam 订阅状态
// compat: '' 未测 / ok 能渲染 / partial 能开但可能不对劲 / fail 打不开
const weCols = new Set(db.prepare('PRAGMA table_info(we_items)').all().map((c) => c.name));
for (const [col, ddl] of [
  ['compat', "ALTER TABLE we_items ADD COLUMN compat TEXT NOT NULL DEFAULT ''"],
  ['compat_note', "ALTER TABLE we_items ADD COLUMN compat_note TEXT NOT NULL DEFAULT ''"],
  ['compat_at', 'ALTER TABLE we_items ADD COLUMN compat_at TEXT'],
  ['subscribed', 'ALTER TABLE we_items ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1'],
]) {
  if (!weCols.has(col)) db.exec(ddl);
}

// 老数据补主标签：从壁纸引擎复制进来的条目，source_note 里存着 we:<workshop_id>，
// 索引表里本来就有原作者的 tags，一次补齐，不用重新复制一遍。
// 注意：只补 primary_tag。以前这里回填的是 tags，现在 tags 是副标签池，
// 再往里写枚举值会让「主标签」和「副标签」出现重复项。
try {
  const need = db.prepare(`
    SELECT w.id AS id, i.tags AS tags
    FROM wallpapers w JOIN we_items i ON 'we:' || i.workshop_id = w.source_note
    WHERE w.primary_tag = ''
  `).all();
  if (need.length) {
    const upd = db.prepare('UPDATE wallpapers SET primary_tag = ? WHERE id = ?');
    for (const row of need) {
      const all = String(row.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
      // Unspecified 等同于没指定，留空即可
      const primary = all.find((t) => WE_TAG_SET.has(t) && t !== 'Unspecified') || '';
      if (primary) upd.run(primary, row.id);
    }
  }
} catch { /* 索引表为空或结构异常都不影响启动 */ }


// 三条初始数据，字段来自用户批准读取的 project.json（2026-11-17）
// 场景主文件实际是 scene.pkg（引擎打包格式），浏览器无法渲染，故网页阶段只用 preview.jpg
const seed = [
  { title: '【交错战线】皮肤鉴赏：绯色巧手 荷鲁斯', type: 'scene', dir: TYPE_DIR.scene, cover: 'preview.jpg', main: 'scene.pkg', category: '动漫', description: '' },
  { title: '雀魂麻将Mahjong Soul雀魂-じゃんたま-', type: 'video', dir: TYPE_DIR.video, cover: 'preview.gif', main: 'ffmpeg_251010215844_9ad809_60.mp4', category: '动漫', description: '' },
  { title: '【完整互动】交错战线/CrossCore · 刺蝽-本心欲望 | 语音/文本', type: 'web', dir: TYPE_DIR.web, cover: 'preview.gif', main: 'index.html', category: '动漫', description: '左上角蜡烛互动提示' },
];
const insert = db.prepare(`
  INSERT INTO wallpapers (title, type, dir_name, cover, main_file, category, description)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
// 只把旧的占位标题升级为真实数据，不覆盖用户之后手动改过的内容
const upgrade = db.prepare(`
  UPDATE wallpapers SET title = ?, cover = ?, main_file = ?, category = ?, description = ?, updated_at = datetime('now')
  WHERE dir_name = ? AND type = ? AND title IN ('场景壁纸','视频壁纸','网页壁纸')
`);
for (const w of seed) {
  // 已经存在的条目只管升级标题，不再看文件（用户自己搬过的壁纸不该被跳过）
  const exists = db.prepare('SELECT id FROM wallpapers WHERE dir_name = ? AND type = ?').get(w.dir, w.type);
  if (exists) {
    upgrade.run(w.title, w.cover, w.main, w.category, w.description, w.dir, w.type);
    continue;
  }
  // 新建之前先确认素材真的在库里。以前无条件插入：用户删掉这条之后，
  // 每次重启又会冒出一条指向不存在文件的「损坏壁纸」，库里永远清不干净。
  const mainAbs = path.join(getLibraryDir(), w.dir, String(w.main).replace(/\//g, path.sep));
  if (!fs.existsSync(mainAbs)) continue;
  insert.run(w.title, w.type, w.dir, w.cover, w.main, w.category, w.description);
}

export default db;
