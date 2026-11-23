import { Router } from 'express';
import multer from 'multer';
import ffmpeg from 'ffmpeg-static';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import db, { getLibraryDir } from '../db.js';
import { newLocalFolder } from '../naming.js';

const router = Router();
const success = (res, data) => res.json({ code: 0, message: 'ok', data });
const fail = (res, status, message) => res.status(status).json({ code: status, message, data: null });

// 临时帧目录：按 jobId 隔离，放在系统临时区
const JOBS_DIR = path.join(os.tmpdir(), 'wallflow-bake');
fs.mkdirSync(JOBS_DIR, { recursive: true });
const jobDir = (id) => path.join(JOBS_DIR, String(id).replace(/[^\w-]/g, ''));

// 帧上传：multer 内存接收，按 jobId + 帧序号落盘为 frame00001.png 形式
const frameUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20 },
});

// POST /api/v1/bake/frames  接收一批帧图
// body: jobId, index (本批起始帧号), fps；files: field "frames"
router.post('/frames', frameUpload.array('frames', 20), (req, res) => {
  const jobId = String(req.body.jobId || '').replace(/[^\w-]/g, '');
  const startIndex = parseInt(req.body.index, 10) || 0;
  if (!jobId) return fail(res, 400, '缺少 jobId');
  const files = req.files || [];
  if (!files.length) return fail(res, 400, '没有收到帧图');
  try {
    const dir = jobDir(jobId);
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((f, i) => {
      // 固定 5 位序号，FFmpeg 图片序列按字典序读取
      fs.writeFileSync(path.join(dir, `frame${String(startIndex + i).padStart(5, '0')}.png`), f.buffer);
    });
    success(res, { jobId, received: files.length, nextIndex: startIndex + files.length });
  } catch (e) {
    fail(res, 500, '保存帧失败：' + e.message);
  }
});

// POST /api/v1/bake/finalize  合成 mp4 并登记入库
// body: jobId, title, fps, category, frameCount?（只编码前 N 帧，用于循环点截断）, loop?（是否做了无缝截断）
router.post('/finalize', (req, res) => {
  const jobId = String(req.body.jobId || '').replace(/[^\w-]/g, '');
  const fps = Math.min(60, Math.max(1, parseInt(req.body.fps, 10) || 30));
  if (!jobId) return fail(res, 400, '缺少 jobId');
  const dir = jobDir(jobId);
  if (!fs.existsSync(dir)) return fail(res, 404, '没有找到该任务的帧，请先上传');

  const frames = fs.readdirSync(dir).filter((f) => /^frame\d{5}\.png$/.test(f)).sort();
  if (frames.length < 2) return fail(res, 400, '帧数不足，至少需要 2 帧');

  // 循环点截断：前端算出「第 N 帧与首帧几乎相同」，只编码前 N 帧 → 末帧接回首帧无跳变
  const rawCount = parseInt(req.body.frameCount, 10);
  const usedCount = Number.isFinite(rawCount) && rawCount >= 2
    ? Math.min(frames.length, rawCount)
    : frames.length;
  const trimmed = usedCount < frames.length;

  // 目标：存到「视频」目录，独占一个按统一规则命名的文件夹
  const folderName = newLocalFolder('video');
  const targetDir = path.join(getLibraryDir(), '视频', folderName);
  fs.mkdirSync(targetDir, { recursive: true });
  const outFile = path.join(targetDir, 'video.mp4');
  const pattern = path.join(dir, 'frame%05d.png');

  // FFmpeg：图片序列 → H.264 mp4。yuv420p 保证 WE 和浏览器都能播
  // -frames:v usedCount 放在输出端：只编码前 N 帧（图片序列多出的帧不参与编码）
  const args = [
    '-y', '-framerate', String(fps), '-i', pattern,
    '-frames:v', String(usedCount),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outFile,
  ];
  const proc = spawn(ffmpeg, args, { windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  proc.on('error', (err) => fail(res, 500, 'FFmpeg 启动失败：' + err.message));
  proc.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(outFile)) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      return fail(res, 500, '视频合成失败：' + stderr.slice(-300));
    }
    try {
      // 用第一帧当封面：转成真正的 JPG（直接复制 PNG 会导致 1MB+ 的"假 jpg"）
      const coverSrc = path.join(dir, frames[0]);
      const coverDst = path.join(targetDir, 'preview.jpg');
      const coverRes = spawnSync(ffmpeg, [
        '-y', '-i', coverSrc, '-frames:v', '1', '-q:v', '4', coverDst,
      ], { windowsHide: true });
      // 转码失败则回退为直接复制（保证封面至少存在）
      if (coverRes.status !== 0 || !fs.existsSync(coverDst)) fs.copyFileSync(coverSrc, coverDst);

      const title = String(req.body.title || folderName).slice(0, 100);
      const category = String(req.body.category || '动漫').slice(0, 50);
      // 描述用"时长"而非帧数（用户要看秒数）；实际编码帧数 / fps
      const seconds = (usedCount / fps).toFixed(1);
      const loopTag = trimmed && req.body.loop ? '，无缝循环' : '';
      // 相对库根的路径，和 installWallDir 写出来的条目一致
      // （首段是类型目录，前端 mediaPathUrl 会按库根解析）
      const info = db.prepare(`
        INSERT INTO wallpapers (title, type, dir_name, cover, main_file, author, category, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(title, 'video', folderName, `视频/${folderName}/preview.jpg`,
        `视频/${folderName}/video.mp4`, '场景转视频', category,
        `由场景烘焙生成（${seconds} 秒 / ${fps}fps${loopTag}）`);

      // 清理临时帧，释放磁盘
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }

      success(res, {
        id: Number(info.lastInsertRowid), frames: usedCount, totalFrames: frames.length,
        fps, seconds: Number(seconds), trimmed, title,
      });
    } catch (e) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
      fail(res, 500, '登记入库失败：' + e.message);
    }
  });
});

// POST /api/v1/bake/cancel  取消任务，清理临时帧
router.post('/cancel', (req, res) => {
  const jobId = String(req.body.jobId || '').replace(/[^\w-]/g, '');
  const dir = jobDir(jobId);
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  success(res, { jobId, canceled: true });
});

export default router;
