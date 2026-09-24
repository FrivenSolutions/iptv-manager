import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_UA } from './fetch.js';

/** Upstream URL for a channel, honoring the extension a client asked for on XC sources. */
export function upstreamUrl(ch, ext) {
  if (ch.source_type === 'xc' && (ext === 'ts' || ext === 'm3u8')) return ch.url.replace(/\.(ts|m3u8)$/i, `.${ext}`);
  return ch.url;
}

function sign(secret, token, channelId, url) {
  return crypto.createHmac('sha256', secret).update(`${token}|${channelId}|${url}`).digest('base64url').slice(0, 32);
}

function segmentUrl(secret, output, channelId, abs) {
  const u = Buffer.from(abs).toString('base64url');
  return `/s/${output.token}/seg/${channelId}?u=${u}&sig=${sign(secret, output.token, channelId, abs)}`;
}

/** Point every URI in an HLS playlist back through this server. */
export function rewriteHls(text, baseUrl, map) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${map(new URL(uri, baseUrl).href)}"`);
      }
      return map(new URL(t, baseUrl).href);
    })
    .join('\n');
}

async function proxy(ctx, res, url, ua, output, channelId) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let up;
  try {
    up = await fetch(url, { headers: { 'user-agent': ua || DEFAULT_UA }, signal: ac.signal, redirect: 'follow' });
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
    return;
  }
  if (!up.ok || !up.body) {
    up.body?.cancel().catch(() => {});
    if (!res.headersSent) res.writeHead(up.status === 404 ? 404 : 502).end();
    return;
  }
  const ct = up.headers.get('content-type') || '';
  if (/mpegurl/i.test(ct) || /\.m3u8$/i.test(new URL(up.url).pathname)) {
    const body = rewriteHls(await up.text(), up.url, (abs) => segmentUrl(ctx.secret, output, channelId, abs));
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' }).end(body);
    return;
  }
  const headers = { 'content-type': ct || 'video/mp2t', 'cache-control': 'no-cache' };
  const len = up.headers.get('content-length');
  if (len) headers['content-length'] = len;
  res.writeHead(200, headers);
  try {
    await pipeline(Readable.fromWeb(up.body), res);
  } catch {
    // Client hung up or upstream dropped; nothing useful to report.
  }
}

/** Serve a channel according to the output's stream mode. */
export async function serveChannel(ctx, res, output, ch, ext) {
  const url = upstreamUrl(ch, ext);
  if (output.stream_mode === 'proxy') return proxy(ctx, res, url, ch.user_agent, output, ch.id);
  res.writeHead(302, { location: url, 'cache-control': 'no-cache' }).end();
}

export async function serveSegment(ctx, res, output, ch, u, sig) {
  let abs;
  try {
    abs = Buffer.from(String(u || ''), 'base64url').toString();
  } catch {
    abs = '';
  }
  const expected = sign(ctx.secret, output.token, ch.id, abs);
  if (!abs || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    res.writeHead(403).end();
    return;
  }
  return proxy(ctx, res, abs, ch.user_agent, output, ch.id);
}
