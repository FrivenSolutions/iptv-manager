// Proxy-mode stream bookkeeping. Everyone watching the same channel shares one upstream
// connection, and each source can be capped at a number of channels open at once (providers
// allow only so many connections per account; an HDHomeRun has only so many tuners).
// Direct and Redirect outputs hand the provider's URL to the player, so they can't be counted.
import { Readable } from 'node:stream';
import { DEFAULT_UA } from './fetch.js';

// An HLS channel counts as open this long after its last playlist or segment request.
const HLS_IDLE_MS = 30_000;
// A client this far behind the shared stream is dropped rather than slowing everyone down.
const MAX_BEHIND_BYTES = 16 * 1024 * 1024;
// Stall diagnostics (the defaults; Streams carries them, so tests can shorten them):
// - the provider sending nothing this long is a pause;
// - a viewer this far behind is shown as lagging on the dashboard, and logged at the second mark.
const STALL_MS = 5000;
const LAG_SHOW_BYTES = 2 * 1024 * 1024;
const LAG_LOG_BYTES = 4 * 1024 * 1024;
const mb = (n) => Math.round((n / 1048576) * 10) / 10;
const ordinal = (n) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
};

const isHls = (ct, url) => /mpegurl/i.test(ct) || /\.m3u8$/i.test(new URL(url).pathname);

/**
 * Why the provider turned a stream down, for the log: the connection error, or the HTTP status
 * with what it usually means.
 */
export function refusalReason(err, status) {
  if (err) return `couldn't reach the provider (${err.cause?.code || err.code || err.message})`;
  const hint = status === 401 || status === 403 ? 'access refused: user agent, IP lock or account?'
    : status === 404 ? 'no such stream at the provider'
    : [429, 458, 509].includes(status) ? 'too many connections on the account?'
    : status >= 500 ? "an error on the provider's side"
    : null;
  return `the provider refused it (HTTP ${status}${hint ? `, ${hint}` : ''})`;
}

function parseJson(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/**
 * One upstream request, shared. Requests for the same channel that arrive while it is opening
 * wait for it; if it turns out to be a continuous TS stream, every client is fed from it.
 * `result` resolves to { ts: contentType }, { hls: text, url } or { status } (an error).
 */
class Hub {
  constructor(streams, key, ch, url) {
    this.streams = streams;
    this.key = key;
    this.ch = ch;
    this.clients = new Set();
    this.ac = new AbortController();
    this.closed = false;
    this.started = Date.now();
    this.lastData = null; // when the provider last sent anything (null until the first chunk)
    this.pauses = 0;
    this.longestPause = 0;
    this.result = this.open(url);
  }

  /**
   * How the provider side of this stream is doing: pauses so far (each 5 s or more with no data),
   * the longest, and how long it has been silent right now (0 when data is flowing).
   */
  health() {
    const silent = this.lastData && !this.closed ? Date.now() - this.lastData : 0;
    return {
      provider_pauses: this.pauses,
      longest_pause_s: this.pauses ? Math.max(1, Math.round(this.longestPause / 1000)) : 0,
      silent_s: silent >= this.streams.stallMs ? Math.max(1, Math.floor(silent / 1000)) : 0,
    };
  }

  async open(url) {
    let up;
    try {
      up = await fetch(url, { headers: { 'user-agent': this.ch.user_agent || DEFAULT_UA }, signal: this.ac.signal, redirect: 'follow' });
    } catch (e) {
      // Aborted means everyone who asked gave up while it was opening: not the provider's doing.
      if (!this.ac.signal.aborted) this.streams.refused(this.ch.source_id, this.ch.name, refusalReason(e));
      this.close();
      return { status: 502 };
    }
    if (!up.ok || !up.body) {
      up.body?.cancel().catch(() => {});
      this.streams.refused(this.ch.source_id, this.ch.name, refusalReason(null, up.status));
      this.close();
      return { status: up.status === 404 ? 404 : 502 };
    }
    const ct = up.headers.get('content-type') || '';
    if (isHls(ct, up.url)) {
      const text = await up.text().catch(() => null);
      this.close();
      return text == null ? { status: 502 } : { hls: text, url: up.url };
    }
    this.pump(up.body);
    return { ts: ct || 'video/mp2t' };
  }

  add(res) {
    this.clients.add(res);
    res.on('close', () => {
      this.clients.delete(res);
      if (!this.clients.size) this.close();
    });
  }

  async pump(body) {
    const started = Date.now();
    const mins = () => Math.round((Date.now() - started) / 6000) / 10;
    const log = (msg) => this.streams.ctx.log?.(msg);
    let failure = null;
    try {
      for await (const chunk of Readable.fromWeb(body)) {
        // Clients attach as soon as the response starts; by the first chunk, none left means
        // everyone who asked has gone.
        if (!this.clients.size) break;
        const now = Date.now();
        if (this.lastData) {
          const gap = now - this.lastData;
          if (gap >= this.streams.stallMs) {
            this.pauses++;
            this.longestPause = Math.max(this.longestPause, gap);
            log(`Stream "${this.ch.name}": the provider sent nothing for ${Math.max(1, Math.round(gap / 1000))} s (${ordinal(this.pauses)} pause in ${mins()} min)`);
          }
        }
        this.lastData = now;
        for (const res of this.clients) {
          const who = res.iptvmWho || 'a viewer';
          if (res.writableLength > MAX_BEHIND_BYTES) {
            log(`Stream "${this.ch.name}": dropped ${who} that fell ${Math.round(MAX_BEHIND_BYTES / 1048576)} MB behind, after ${mins()} min`);
            res.destroy();
            continue;
          }
          if (res.writableLength > this.streams.lagLogBytes && !res.iptvmLagLogged) {
            res.iptvmLagLogged = true;
            log(`Stream "${this.ch.name}": ${who} is ${mb(res.writableLength)} MB behind (${res.iptvmEncoder ? 'the encoder' : 'their device or network'} is not keeping up), after ${mins()} min`);
          }
          res.write(chunk);
        }
      }
    } catch (e) {
      failure = e; // upstream dropped, or aborted because everyone left
    }
    // Ended while people were still watching: the provider closed it (or the connection broke).
    if (this.clients.size && !this.ac.signal.aborted) {
      log(`Stream "${this.ch.name}": the provider ${failure ? `connection failed (${failure.message})` : 'ended it'} after ${mins()} min`);
    }
    this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.ac.abort();
    if (this.streams.hubs.get(this.key) === this) this.streams.hubs.delete(this.key);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }
}

export class Streams {
  constructor(ctx) {
    this.ctx = ctx;
    this.hubs = new Map(); // "channelId|url" -> Hub (opening, or streaming TS)
    this.hls = new Map(); // channelId -> { source_id, at }
    this.vod = new Map(); // "movie:id" / "episode:id" -> { source_id, n } (open proxied requests)
    this.refusedLogged = new Map(); // sourceId -> time of the last "all in use" log line
    this.refusalLogged = new Map(); // "source|title|reason" -> time last logged
    this.lastRefusal = new Map(); // sourceId -> { what, reason, at } (for the Sources page)
    this.stallMs = STALL_MS;
    this.lagShowBytes = LAG_SHOW_BYTES;
    this.lagLogBytes = LAG_LOG_BYTES;
  }

  /**
   * The provider turned a stream down. Logged (the same reason for the same title at most once a
   * minute: HLS players retry segments quickly) and kept as the source's latest refusal.
   */
  refused(sourceId, what, reason) {
    const key = `${sourceId}|${what}|${reason}`;
    const now = Date.now();
    if (now - (this.refusalLogged.get(key) || 0) > 60_000) {
      if (this.refusalLogged.size > 500) this.refusalLogged.clear();
      this.refusalLogged.set(key, now);
      this.ctx.log?.(`Stream "${what}": ${reason}`);
    }
    this.lastRefusal.set(sourceId, { what, reason, at: Math.floor(now / 1000) });
  }

  /** How far behind a client is, in MB (0 while under the dashboard's threshold). */
  behindMb(res) {
    const n = res?.writableLength || 0;
    return n >= this.lagShowBytes ? mb(n) : 0;
  }

  /** How many channels a source may have open at once; 0 means no limit. */
  limitFor(sourceId) {
    const s = this.ctx.db.get('SELECT type, max_streams, account_info FROM sources WHERE id = ?', [sourceId]);
    if (!s) return 0;
    if (s.max_streams != null) return s.max_streams;
    return autoLimit(s);
  }

  /** Channel ids open right now for a source. */
  open(sourceId) {
    const ids = new Set();
    for (const hub of this.hubs.values()) if (hub.ch.source_id === sourceId) ids.add(hub.ch.id);
    for (const [key, x] of this.vod) if (x.source_id === sourceId) ids.add(key);
    const cutoff = Date.now() - HLS_IDLE_MS;
    for (const [id, x] of this.hls) {
      if (x.at < cutoff) this.hls.delete(id);
      else if (x.source_id === sourceId) ids.add(id);
    }
    return ids;
  }

  /** A channel already open can always take more viewers; a new one needs a free slot. */
  admit(ch) {
    const open = this.open(ch.source_id);
    if (open.has(ch.id)) return { ok: true };
    const limit = this.limitFor(ch.source_id);
    if (!limit || open.size < limit) return { ok: true };
    const last = this.refusedLogged.get(ch.source_id) || 0;
    if (Date.now() - last > 60_000) {
      this.refusedLogged.set(ch.source_id, Date.now());
      const name = this.ctx.db.get('SELECT name FROM sources WHERE id = ?', [ch.source_id])?.name;
      this.ctx.log(`Source "${name}": all ${limit} stream${limit === 1 ? '' : 's'} are in use; refused another channel`);
    }
    return { ok: false, limit };
  }

  /**
   * Count a proxied movie or episode while its request is open; returns the release function.
   * Several requests for one title (players seek with new ones) take a single slot.
   */
  hold(item) {
    const x = this.vod.get(item.id) || { source_id: item.source_id, n: 0 };
    x.n++;
    this.vod.set(item.id, x);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--x.n <= 0) this.vod.delete(item.id);
    };
  }

  touchHls(ch) {
    this.hls.set(ch.id, { source_id: ch.source_id, at: Date.now() });
  }

  /** Join the shared request for this channel and URL, or start one. */
  hub(ch, url) {
    const key = `${ch.id}|${url}`;
    let hub = this.hubs.get(key);
    if (!hub || hub.closed) {
      hub = new Hub(this, key, ch, url);
      if (!hub.closed) this.hubs.set(key, hub);
    }
    return hub;
  }

  stop() {
    for (const hub of [...this.hubs.values()]) hub.close();
  }
}

/** The limit a source has when none is set: the account's connection limit, or the box's tuners. */
export function autoLimit(s) {
  const info = parseJson(s.account_info);
  if (s.type === 'xc') return Number(info?.max_connections) || 0;
  if (s.type === 'hdhr') return Number(info?.tuners) || 0;
  return 0;
}
