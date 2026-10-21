import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_UA = 'VLC/3.0.21 LibVLC/3.0.21';
// A download that sends nothing for this long is given up.
const DOWNLOAD_IDLE_MS = 2 * 60 * 1000;
const MAX_REDIRECTS = 5;

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
 * GET with Node's own http/https client, following redirects; resolves to the response stream
 * (decompressed if the server compressed it) with `status` and `ok`. Downloads and provider API
 * calls use this rather than fetch(): Node's fetch can end the whole process with an internal
 * assertion no code can catch, when a server closes the connection while a big download is
 * briefly paused (writing to disk slower than the network).
 */
export function httpGet(url, { headers = {}, idleMs = DOWNLOAD_IDLE_MS, redirects = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`Unsupported URL: ${redact(url)}`));
    }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error(`Unsupported URL: ${redact(url)}`));
    const req = lib.get(u, { headers: { 'accept-encoding': 'gzip, deflate', ...headers } }, (res) => {
      const { statusCode: status, headers: h } = res;
      if (status >= 300 && status < 400 && h.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`Too many redirects from ${redact(url)}`));
        return resolve(httpGet(new URL(h.location, u).href, { headers, idleMs, redirects: redirects - 1 }));
      }
      const enc = String(h['content-encoding'] || '').toLowerCase();
      const unzip = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : null;
      let body = res;
      if (unzip) {
        res.on('error', (e) => unzip.destroy(e));
        body = res.pipe(unzip);
      }
      body.status = status;
      body.ok = status >= 200 && status < 300;
      resolve(body);
    });
    req.setTimeout(idleMs, () => req.destroy(new Error(`No data for ${Math.round(idleMs / 1000)} s from ${redact(url)}`)));
    req.on('error', reject);
  });
}

/**
 * The internal assertion Node's fetch (undici) can throw from a socket event, outside any code
 * that could catch it, when a server closes a connection at an awkward moment. It only breaks that
 * one connection, so the process logs it and carries on instead of exiting (see server.js).
 */
export function isFetchInternalError(err) {
  return err?.code === 'ERR_ASSERTION' && /internal\/deps\/undici/.test(String(err.stack || ''));
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
  const res = await httpGet(url, { headers: { 'user-agent': userAgent || DEFAULT_UA, accept: '*/*' } });
  if (!res.ok) {
    res.resume();
    throw new Error(`HTTP ${res.status} from ${redact(url)}`);
  }
  await pipeline(res, fs.createWriteStream(dest));
  return dest;
}

export async function fetchJson(url, { userAgent } = {}) {
  const res = await httpGet(url, { headers: { 'user-agent': userAgent || DEFAULT_UA, accept: 'application/json' } });
  if (!res.ok) {
    res.resume();
    throw new Error(`HTTP ${res.status} from ${redact(url)}`);
  }
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
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
