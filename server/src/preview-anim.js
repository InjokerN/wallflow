// 动态缩略图：把视频壁纸切 1.8 秒做成一枚小 mp4，卡片上悬停就能看动效。
// 懒生成 + 磁盘缓存：只有真的被请求过才跑 ffmpeg，不会一次性给上千个壁纸排队转码。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { DATA_ROOT, getCacheDir } from './db.js';

const require = createRequire(import.meta.url);
let FFMPEG = '';
try {
  FFMPEG = require('ffmpeg-static') || '';
} catch {
  FFMPEG = ''; // 打包时没带 ffmpeg 就退化成静态图，不影响主流程
}

// 缓存落在 <壁纸库>/.cache 里，跟着库走：换盘搬库时缓存一起过去，不再占系统盘。
// 老版本把它放在数据目录的 previews/，第一次用到时整体搬一次，免得重新生成上千张缩略图。
let legacyMigrated = false;
function cacheDir() {
  const dir = getCacheDir();
  if (!legacyMigrated) {
    legacyMigrated = true;
    try {
      const legacy = path.join(DATA_ROOT, 'previews');
      if (fs.existsSync(legacy) && fs.readdirSync(dir).length === 0) {
        for (const name of fs.readdirSync(legacy)) {
          const from = path.join(legacy, name);
          const to = path.join(dir, name);
          try { fs.renameSync(from, to); }
          catch { try { fs.copyFileSync(from, to); fs.rmSync(from, { force: true }); } catch { /* 单个搬不动就留着 */ } }
        }
        try { fs.rmdirSync(legacy); } catch { /* 非空说明还有没搬走的 */ }
      }
    } catch { /* 迁移失败不影响新缓存写入 */ }
  }
  return dir;
}

const DURATION = 1.8;
const WIDTH = 480;
const FAIL_TTL = 6 * 3600 * 1000; // 失败后 6 小时内不重试，避免同一个坏文件反复烧 CPU

// 同时只允许 2 个 ffmpeg 在跑：列表悬停可能瞬间触发十几个请求
const queue = [];
let running = 0;
const LIMIT = 2;
function runJob(fn) {
  return new Promise((resolve, reject) => {
    const go = () => {
      running += 1;
      fn().then(resolve, reject).finally(() => {
        running -= 1;
        const next = queue.shift();
        if (next) next();
      });
    };
    if (running < LIMIT) go();
    else queue.push(go);
  });
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 6000) err = err.slice(-6000);
    });
    p.on('error', (e) => reject(new Error('无法启动 ffmpeg：' + e.message)));
    p.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error('ffmpeg 退出码 ' + code + '：' + err.trim().split('\n').slice(-2).join(' ')));
    });
  });
}

const animFile = (id) => path.join(cacheDir(), `${id}.mp4`);
const failFile = (id) => path.join(cacheDir(), `${id}.fail`);

function readFail(id) {
  try {
    const st = fs.statSync(failFile(id));
    if (Date.now() - st.mtimeMs > FAIL_TTL) { fs.rmSync(failFile(id), { force: true }); return null; }
    return fs.readFileSync(failFile(id), 'utf8').slice(0, 300) || '上次生成失败';
  } catch { return null; }
}
function writeFail(id, msg) {
  try { fs.writeFileSync(failFile(id), String(msg).slice(0, 300)); } catch { /* 记不下来也不影响 */ }
}

export function animStatus(id) {
  const f = animFile(id);
  try {
    if (fs.statSync(f).size > 1024) return { ready: true, file: f };
  } catch { /* 没生成过 */ }
  const fail = readFail(id);
  return { ready: false, fail };
}

// 从第 1 秒开始截：开头往往是黑场或 logo，取中段更像"这个壁纸长什么样"
async function encode(id, src) {
  const out = animFile(id);
  const tmp = path.join(cacheDir(), `${id}.${process.pid}.tmp.mp4`);
  const common = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-an',
    '-vf', `fps=15,scale=${WIDTH}:-2:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    tmp,
  ];
  try {
    try {
      await ffmpegRun(['-ss', '1', '-t', String(DURATION), '-i', src, ...common]);
    } catch {
      // 短于一秒的素材取不到中段，退回从头截
      await ffmpegRun(['-t', String(DURATION), '-i', src, ...common]);
    }
    const st = fs.statSync(tmp);
    if (st.size < 1024) throw new Error('产出文件异常小（' + st.size + ' 字节）');
    fs.renameSync(tmp, out);
    return out;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 确保某个视频壁纸有动态缩略图。
 * @param {string} id workshop id
 * @param {string} src 视频绝对路径
 * @returns {Promise<string>} mp4 绝对路径
 */
export async function ensureVideoAnim(id, src) {
  const st = animStatus(id);
  if (st.ready) return st.file;
  if (st.fail) throw new Error(st.fail);
  if (!FFMPEG) throw new Error('这个版本没有内置 ffmpeg，无法生成动态缩略图');
  if (!fs.existsSync(src)) throw new Error('源视频不存在：' + src);

  await runJob(async () => {
    const again = animStatus(id);
    if (again.ready) return; // 排队期间别人已经生成好了
    try {
      await encode(id, src);
    } catch (e) {
      writeFail(id, e.message);
      throw e;
    }
  });
  return animFile(id);
}

export function animAvailable() {
  return Boolean(FFMPEG);
}

// ---------- 列表缩略图：原作者的 preview.jpg 经常是 4K 大图（单张 600KB+），
// 一页 50 张就要下 30MB，列表根本滚不动。这里按需缩到 480 宽并缓存。
const thumbFile = (id) => path.join(cacheDir(), `t-${id}.jpg`);

export async function ensureImageThumb(id, src) {
  const out = thumbFile(id);
  try {
    const a = fs.statSync(out);
    const b = fs.statSync(src);
    // 源文件没变就直接用缓存
    if (a.size > 512 && a.mtimeMs >= b.mtimeMs) return out;
  } catch { /* 没有缓存 */ }
  if (!FFMPEG) return null;
  try {
    await runJob(async () => {
      try {
        if (fs.statSync(out).size > 512) return;
      } catch { /* 继续生成 */ }
      const tmp = path.join(cacheDir(), `t-${id}.${process.pid}.tmp.jpg`);
      try {
        await ffmpegRun([
          '-y', '-hide_banner', '-loglevel', 'error',
          // min(480,iw)：小图不放大，避免糊成一片
          '-i', src,
          '-vf', "scale='min(480,iw)':-2:flags=lanczos",
          '-q:v', '5',
          tmp,
        ]);
        if (fs.statSync(tmp).size < 512) throw new Error('缩略图产出异常');
        fs.renameSync(tmp, out);
      } finally {
        try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
      }
    });
    return out;
  } catch {
    return null; // 缩不出来就退回原图，不影响显示
  }
}
