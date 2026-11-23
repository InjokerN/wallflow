// 存储驱动：R2（S3 兼容，SigV4 签名）与本地文件夹两种实现，接口一致。
// 只用 put / get / del 三个动作；列目录靠 index.json 清单，不依赖 ListObjects
// （R2 的公开桶不支持匿名 ListObjects，这个坑早就踩过）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AwsClient } from 'aws4fetch';

const encodeKey = (key) => String(key).split('/').map(encodeURIComponent).join('/');
const isStream = (body) => body && typeof body.pipe === 'function';

function r2Store(cfg) {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const endpoint = (key) => `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}/${encodeKey(key)}`;

  return {
    mode: 'r2',
    async put(key, body, contentType, byteLength) {
      const headers = {};
      if (contentType) headers['Content-Type'] = contentType;
      // 流式 PUT 最好带上准确长度：S3 协议对 chunked 的支持各家不一，给死长度最稳
      if (byteLength != null) headers['Content-Length'] = String(byteLength);
      // 流式上传必须显式声明 half duplex，否则 fetch 会报 body 无法结束
      const init = { method: 'PUT', body, headers };
      if (isStream(body)) init.duplex = 'half';
      const res = await client.fetch(endpoint(key), init);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`上传 ${key} 失败：HTTP ${res.status} ${text.slice(0, 300)}`);
      }
    },
    async get(key) {
      const res = await client.fetch(endpoint(key), { method: 'GET' });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`读取 ${key} 失败：HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async del(key) {
      const res = await client.fetch(endpoint(key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`删除 ${key} 失败：HTTP ${res.status}`);
    },
  };
}

function localStore(cfg) {
  const root = path.resolve(cfg.localDir);
  const abs = (key) => path.join(root, ...String(key).split('/'));

  return {
    mode: 'local',
    async put(key, body, _contentType) {
      const file = abs(key);
      if (!file.startsWith(root)) throw new Error('非法的对象 key');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      if (isStream(body)) await pipeline(body, fs.createWriteStream(file));
      else await fsp.writeFile(file, body);
    },
    async get(key) {
      const file = abs(key);
      if (!file.startsWith(root)) return null;
      try { return await fsp.readFile(file); } catch { return null; }
    },
    async del(key) {
      const file = abs(key);
      if (!file.startsWith(root)) return;
      try { await fsp.rm(file); } catch { /* 不存在就算了 */ }
    },
  };
}

export function getStore(cfg) {
  return cfg.mode === 'r2' ? r2Store(cfg) : localStore(cfg);
}

// 上传用文件流包装，避免大包整个读进内存
export function fileStream(filePath) {
  return fs.createReadStream(filePath);
}

export { Readable };
