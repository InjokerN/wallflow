// 云端壁纸库的配置：一个 JSON 文件，放在数据目录里，不进发布包、不进 git。
//
// mode 有两种：
//   r2    → Cloudflare R2（S3 兼容），桶公开读 + 密钥私有写
//   local → 本地文件夹当桶，用来在没有账号时把整条链路跑通
// 两种驱动对外接口完全一致，业务代码不关心用的是哪个。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.js';

export const CLOUD_CONFIG_FILE = path.join(DATA_DIR, 'cloud.json');

const DEFAULTS = {
  mode: 'local',
  accountId: '',
  bucket: '',
  accessKeyId: '',
  secretAccessKey: '',
  publicBase: '',
  localDir: path.join(DATA_DIR, 'cloud-mock'),
};

// 环境变量覆盖：敏感字段可不落在 cloud.json 明文里，适合打包分发。
// 优先级：环境变量 > cloud.json > DEFAULTS。UI 保存仍写回 cloud.json，不受影响。
const ENV_OVERRIDE = {
  accountId: 'WF_R2_ACCOUNT_ID',
  bucket: 'WF_R2_BUCKET',
  accessKeyId: 'WF_R2_ACCESS_KEY_ID',
  secretAccessKey: 'WF_R2_SECRET_ACCESS_KEY',
  publicBase: 'WF_R2_PUBLIC_BASE',
  localDir: 'WF_CLOUD_LOCAL_DIR',
};

export function readCloudConfig() {
  let disk = {};
  try {
    disk = JSON.parse(fs.readFileSync(CLOUD_CONFIG_FILE, 'utf8'));
  } catch { /* 用默认值 */ }
  const cfg = { ...DEFAULTS, ...disk };
  for (const [key, envName] of Object.entries(ENV_OVERRIDE)) {
    const v = process.env[envName];
    if (v && String(v).trim()) cfg[key] = String(v).trim();
  }
  return cfg;
}

export function writeCloudConfig(patch) {
  const next = { ...readCloudConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CLOUD_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// 缺什么就说什么，别只丢一句「还没配置」让人猜
export function missingFields(cfg = readCloudConfig()) {
  if (cfg.mode === 'local') return cfg.localDir ? [] : ['localDir'];
  const need = ['accountId', 'bucket', 'accessKeyId', 'secretAccessKey', 'publicBase'];
  return need.filter((k) => !String(cfg[k] || '').trim());
}

export function isConfigured(cfg = readCloudConfig()) {
  if (cfg.mode === 'local') return Boolean(cfg.localDir);
  if (cfg.mode === 'r2') return missingFields(cfg).length === 0;
  return false;
}

// 对外展示用：绝不把 secretAccessKey 送到前端
export function publicStatus(cfg = readCloudConfig()) {
  return {
    mode: cfg.mode,
    configured: isConfigured(cfg),
    bucket: cfg.bucket,
    publicBase: cfg.publicBase,
    accountId: cfg.accountId,
    hasKey: Boolean(cfg.accessKeyId),
    missing: missingFields(cfg),
    localDir: cfg.mode === 'local' ? cfg.localDir : '',
  };
}

export function publicUrl(cfg, key) {
  const encoded = String(key).split('/').map(encodeURIComponent).join('/');
  // 本地模拟桶由后端自己静态托管，直接给相对路径，前端不用知道端口
  if (cfg.mode === 'local') return `/cloud-mock/${encoded}`;
  const base = String(cfg.publicBase || '').replace(/\/+$/, '');
  if (!base) return '';
  return `${base}/${encoded}`;
}
