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

function busy(res, limit) {
  res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '10', 'cache-control': 'no-cache' })
    .end(`All ${limit} stream${limit === 1 ? '' : 's'} for this source are in use. Stop watching another channel from it and try again.`);
}

const hlsHeaders = { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' };

/** Relay one request of an HLS channel (a segment, or a variant playlist that is rewritten too). */
async function relay(ctx, res, url, output, ch) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let up;
  try {
    up = await fetch(url, { headers: { 'user-agent': ch.user_agent || DEFAULT_UA }, signal: ac.signal, redirect: 'follow' });
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
    const body = rewriteHls(await up.text(), up.url, (abs) => segmentUrl(ctx.secret, output, ch.id, abs));
    res.writeHead(200, hlsHeaders).end(body);
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

/** A channel through this server: HLS playlists are rewritten, TS streams shared between viewers. */
async function proxy(ctx, res, url, output, ch, viewer) {
  const admit = ctx.streams.admit(ch);
  if (!admit.ok) return busy(res, admit.limit);
  const hub = ctx.streams.hub(ch, url);
  const r = await hub.result;
  if (res.destroyed || res.writableEnded) {
    // Gave up while it was opening. Unless someone else joined, don't hold a slot open.
    setImmediate(() => { if (!hub.clients.size) hub.close(); });
    return;
  }
  if (r.status) return res.writeHead(r.status).end();
  if (r.hls) {
    ctx.streams.touchHls(ch);
    if (viewer) ctx.viewers.touch(viewer);
    return res.writeHead(200, hlsHeaders).end(rewriteHls(r.hls, r.url, (abs) => segmentUrl(ctx.secret, output, ch.id, abs)));
  }
  // Live TS has no length; a late joiner starts wherever the shared stream is.
  res.writeHead(200, { 'content-type': r.ts, 'cache-control': 'no-cache' });
  if (hub.closed) return res.end();
  hub.add(res);
  if (viewer) res.on('close', ctx.viewers.open(viewer));
}

// Headers passed back from the provider for a movie or episode, so players can seek.
const VOD_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

/**
 * A movie or series episode. Direct and Redirect send the player to the provider; Proxy relays
 * it, passing Range requests through for seeking, and counts it against the source's limit.
 */
export async function serveVod(ctx, req, res, output, target, viewer = null) {
  if (output.stream_mode !== 'proxy') {
    if (viewer) ctx.viewers.redirect(viewer);
    res.writeHead(302, { location: target.url, 'cache-control': 'no-cache' }).end();
    return;
  }
  const item = { id: target.key, source_id: target.src.id };
  const admit = ctx.streams.admit(item);
  if (!admit.ok) return busy(res, admit.limit);
  const release = ctx.streams.hold(item);
  const unview = viewer ? ctx.viewers.open(viewer) : () => {};
  const ac = new AbortController();
  res.on('close', () => {
    ac.abort();
    release();
    unview();
  });
  const headers = { 'user-agent': target.src.user_agent || DEFAULT_UA };
  if (req.headers.range) headers.range = req.headers.range;
  let up;
  try {
    up = await fetch(target.url, { headers, signal: ac.signal, redirect: 'follow' });
  } catch {
    if (!res.headersSent) res.writeHead(502).end();
    return;
  }
  if (!up.ok || !up.body) {
    up.body?.cancel().catch(() => {});
    if (!res.headersSent) res.writeHead(up.status === 404 || up.status === 416 ? up.status : 502).end();
    return;
  }
  const out = { 'cache-control': 'no-cache' };
  for (const h of VOD_HEADERS) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  try {
    await pipeline(Readable.fromWeb(up.body), res);
  } catch {
    // Players close and reopen connections when seeking.
  }
}

/** Serve a channel according to the output's stream mode. */
export async function serveChannel(ctx, res, output, ch, ext, viewer = null) {
  const url = upstreamUrl(ch, ext);
  if (output.stream_mode === 'proxy') return proxy(ctx, res, url, output, ch, viewer);
  if (viewer) ctx.viewers.redirect(viewer);
  res.writeHead(302, { location: url, 'cache-control': 'no-cache' }).end();
}

export async function serveSegment(ctx, res, output, ch, u, sig, viewer = null) {
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
  const admit = ctx.streams.admit(ch);
  if (!admit.ok) return busy(res, admit.limit);
  ctx.streams.touchHls(ch);
  if (viewer) ctx.viewers.touch(viewer);
  return relay(ctx, res, abs, output, ch);
}
