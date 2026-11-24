import fs from 'node:fs';
import path from 'node:path';

// 逐文件递归复制：比 fs.cpSync 更可控，逐个小文件写入，避免一次性批量操作
export function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
    // 跳过符号链接等特殊文件，避免安全隐患
  }
}

// Wallpaper Engine 格式约定：一个壁纸 = 一个文件夹 + project.json + 资源
// 本模块集中处理 project.json 的识别与规范化，导入导出共用，保证两侧一致

// 打包/系统顺手塞进来的垃圾目录，导入时一律丢掉：
// 复制进库既占空间，又会让「文件数校验」和源对不上。
export const JUNK_NAMES = new Set([
  '__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.workbuddy', 'node_modules', '.git',
]);
export function isJunkPath(rel) {
  return String(rel || '').split(/[\\/]/).filter(Boolean).some((s) => JUNK_NAMES.has(s));
}

// WE 里 type 有多种写法（Scene/scene/video/web），统一映射到我们的枚举
const TYPE_MAP = {
  scene: 'scene', Scene: 'scene', SCENE: 'scene',
  video: 'video', Video: 'video', VIDEO: 'video',
  web: 'web', Web: 'web', WEB: 'web', HTML: 'web', html: 'web',
};

// 我们的类型 → WE project.json 里写回的 type 值（沿用素材中的官方写法）
const TYPE_TO_WE = { scene: 'Scene', video: 'video', web: 'web' };
// 我们的类型 → 中文目录名
export const TYPE_DIR = { scene: '场景', video: '视频', web: '网页' };

export function normalizeType(raw) {
  return TYPE_MAP[String(raw || '')] || null;
}

// 在给定目录下找 project.json：先根目录，再逐层往下找（默认最多 3 层）。
// 用户自己打的包经常套着「作品名 / 版本 / 内容」这种多层目录，只认一层会直接报认不出。
export function findProjectJson(dir, maxDepth = 3) {
  const direct = path.join(dir, 'project.json');
  if (fs.existsSync(direct)) return { file: direct, wallDir: dir };

  let level = [dir];
  for (let depth = 0; depth < maxDepth && level.length; depth += 1) {
    const next = [];
    for (const cur of level) {
      let entries;
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || JUNK_NAMES.has(e.name)) continue;
        const sub = path.join(cur, e.name);
        const pj = path.join(sub, 'project.json');
        if (fs.existsSync(pj)) return { file: pj, wallDir: sub };
        next.push(sub);
      }
    }
    level = next;
  }
  return null;
}

// 读取并解析 project.json，抽取我们需要的字段；宽容处理（缺字段给默认值）
export function parseProjectJson(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('project.json 不是合法的 JSON：' + err.message);
  }
  // 依赖型包：资源全在它依赖的那个壁纸里，单独拿出来没有画面。
  // 这个判断必须放在 type 检查之前——这类包的 type 往往写得正常，
  // 只会在后面「找主文件」那步失败，报出来的原因就完全跑偏了。
  if (raw.dependency) {
    throw new Error(`这是依赖型壁纸（依赖 ${raw.dependency}），本体是另一个壁纸，单独导入不会有画面`);
  }
  const type = normalizeType(raw.type);
  if (!type) {
    throw new Error(`project.json 缺少可识别的 type（实际值 ${JSON.stringify(raw.type)}）`);
  }
  return {
    type,
    title: String(raw.title || '未命名壁纸'),
    file: String(raw.file || ''),
    preview: String(raw.preview || ''),
    description: String(raw.description || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    author: String(raw.author || ''),
    raw, // 保留原始对象，便于导出时原样写回
  };
}

// 生成规范 project.json（导出时若原文件夹没有则新建）
export function buildProjectJson(meta) {
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  return {
    contentrating: 'Questionable',
    description: meta.description || '',
    file: meta.file || '',
    general: { properties: {}, supportsvideo: meta.type !== 'scene' },
    preview: meta.preview || '',
    ratingsex: 'mild',
    ratingviolence: 'none',
    tags,
    title: meta.title || '未命名壁纸',
    type: TYPE_TO_WE[meta.type] || meta.type,
    version: 1,
  };
}

// project.json 里的 file/preview 是相对壁纸目录的路径，必须挡住 ../ 越界：
// 否则声明 ../../secret.mp4 会命中包外文件，登记出指向包外的 main_file。
function safeDeclared(wallDir, declared) {
  if (!declared || typeof declared !== 'string') return false;
  const rel = declared.replace(/\\/g, '/');
  if (rel.includes('..') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  const full = path.resolve(wallDir, rel);
  const base = path.resolve(wallDir);
  if (full !== base && !full.startsWith(base + path.sep)) return false;
  return fs.existsSync(full) && fs.statSync(full).isFile();
}

// 判断文件夹里该用哪个主文件：优先 project.json 声明的 file，否则挑第一个媒体文件
export function pickMainFile(wallDir, declared, type) {
  if (safeDeclared(wallDir, declared)) return declared;
  const exts = type === 'video'
    ? ['.mp4', '.webm']
    : type === 'web'
      ? ['.html', '.htm']
      : ['.pkg', '.json'];
  const files = fs.readdirSync(wallDir, { withFileTypes: true })
    .filter((e) => e.isFile()
      && exts.includes(path.extname(e.name).toLowerCase())
      // project.json 是描述文件，不是画面本体，别把它当主文件
      && e.name.toLowerCase() !== 'project.json')
    .map((e) => e.name);
  // 按扩展名优先级取，避免 .json 抢在 .pkg 前面；同优先级里 index.* 最像入口
  files.sort((a, b) => {
    const d = exts.indexOf(path.extname(a).toLowerCase()) - exts.indexOf(path.extname(b).toLowerCase());
    if (d !== 0) return d;
    const ai = /^index\./i.test(a) ? 0 : 1;
    const bi = /^index\./i.test(b) ? 0 : 1;
    return ai - bi;
  });
  // declared 只有通过 safeDeclared 才会走到函数开头返回；这里不能再回退到它，
  // 否则 ../ 越界的声明会在「没找到媒体文件」时漏出去
  return files[0] || '';
}

// 判断预览图
export function pickPreview(wallDir, declared) {
  if (safeDeclared(wallDir, declared)) return declared;
  const imgs = fs.readdirSync(wallDir, { withFileTypes: true })
    .filter((e) => e.isFile() && ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);
  if (!imgs.length) return '';
  // 没声明 preview 时不能随便抓第一张图：很多包根目录躺着 bg.png（背景素材），
  // 拿它当封面等于给用户看一张空背景。优先名字里带 preview/cover/thumb 的。
  const named = imgs.find((n) => /(^|[^a-z])(preview|cover|thumb)/i.test(n));
  return named || imgs[0];
}
