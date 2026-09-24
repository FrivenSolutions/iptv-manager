import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_UA = 'VLC/3.0.21 LibVLC/3.0.21';
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Credentials live in query strings for most providers; keep them out of logs and errors.
export function redact(url) {
  return String(url)
    .replace(/(username|password|user|pass|token|deviceauth)=([^&]+)/gi, '$1=***')
    .replace(/\/(live|movie|series)\/[^/]+\/[^/]+\//i, '/$1/***/***/');
}

export function uploadPath(dataDir, ref) {
  return path.join(dataDir, 'uploads', path.basename(ref.slice('upload:'.length)));
}

/**
 * Fetch `url` into `dest` and return the path to read. `upload:<name>` refers to a
 * file previously uploaded through the UI and is read in place.
 */
export async function download(url, dest, { userAgent, dataDir } = {}) {
  if (url.startsWith('upload:')) {
    const p = uploadPath(dataDir, url);
    if (!fs.existsSync(p)) throw new Error(`Uploaded file is missing: ${path.basename(p)}`);
    return p;
  }
  if (!/^https?:\/\//i.test(url)) throw new Error(`Unsupported URL: ${redact(url)}`);
  const res = await fetch(url, {
    headers: { 'user-agent': userAgent || DEFAULT_UA, accept: '*/*' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}`);
  if (!res.body) throw new Error(`Empty response from ${redact(url)}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return dest;
}

export async function fetchJson(url, { userAgent } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': userAgent || DEFAULT_UA, accept: 'application/json' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${redact(url)}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${redact(url)}`);
  }
}

// Providers serve EPGs both plain and gzipped, often without a telling extension.
export async function openMaybeGzip(file) {
  const fh = await fs.promises.open(file, 'r');
  const buf = Buffer.alloc(2);
  await fh.read(buf, 0, 2, 0);
  await fh.close();
  const stream = fs.createReadStream(file);
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const gunzip = zlib.createGunzip();
    stream.on('error', (e) => gunzip.destroy(e));
    gunzip.on('close', () => stream.destroy());
    return stream.pipe(gunzip);
  }
  return stream;
}
