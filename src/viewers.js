// Who is watching what, for the dashboard. Kept in memory only.
//
// What this server can see depends on the stream mode:
// - Proxy: every stream passes through, so a viewer is listed from start to stop (TS and movies
//   while their connection is open; HLS while its playlist or segments keep being fetched).
// - Redirect (and Direct over the Xtream Codes login, which works the same way): only the start.
//   The last thing each device started is listed, marked as such, until it starts something else.
// - Direct through the M3U playlist: players never contact this server, so nothing is seen.

const ENDED_GRACE_MS = 15_000; // players reopen connections when seeking or switching quality
const HLS_IDLE_MS = 30_000;
const REDIRECT_KEEP_MS = 4 * 3600_000;

/** The address a request came from (the first proxy hop's client, when behind a reverse proxy). */
export function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export class Viewers {
  constructor() {
    this.entries = new Map();
  }

  #upsert(key, v, now) {
    let e = this.entries.get(key);
    if (!e) {
      e = { key, ...v, started: now, open: 0, ended: null, last: now };
      this.entries.set(key, e);
    } else {
      // Keep who it is from the first request (HLS segments don't say who they are for).
      const keep = e.who && v.who === 'Playlist link';
      Object.assign(e, { ...v, who: keep ? e.who : v.who, username: keep ? e.username : v.username, last: now });
    }
    return e;
  }

  /** A proxied connection (TS stream, movie or episode): listed while open. Returns the close function. */
  open(v) {
    const now = Date.now();
    const e = this.#upsert(`proxy|${v.outputId}|${v.ip}|${v.what}`, { ...v, mode: 'proxy' }, now);
    e.open++;
    e.ended = null;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      if (--e.open <= 0) {
        e.open = 0;
        e.ended = Date.now();
      }
    };
  }

  /** A proxied HLS request (playlist or segment): listed while they keep coming. */
  touch(v) {
    this.#upsert(`proxy|${v.outputId}|${v.ip}|${v.what}`, { ...v, mode: 'hls' }, Date.now());
  }

  /** A redirected start: one entry per device, replaced by whatever it starts next. */
  redirect(v) {
    const key = `redirect|${v.outputId}|${v.who}|${v.ip}`;
    const e = this.entries.get(key);
    if (e && e.what !== v.what) this.entries.delete(key);
    this.#upsert(key, { ...v, mode: 'redirect' }, Date.now());
  }

  /** What is on now, newest first. */
  list() {
    const now = Date.now();
    const out = [];
    for (const [key, e] of this.entries) {
      const gone = e.mode === 'redirect' ? now - e.last > REDIRECT_KEEP_MS
        : e.mode === 'hls' ? now - e.last > HLS_IDLE_MS
        : e.open === 0 && e.ended && now - e.ended > ENDED_GRACE_MS;
      if (gone) {
        this.entries.delete(key);
        continue;
      }
      out.push(e);
    }
    return out.sort((a, b) => b.started - a.started).map((e) => ({
      key: e.key,
      mode: e.mode === 'hls' ? 'proxy' : e.mode,
      output_id: e.outputId,
      output: e.output,
      who: e.who,
      username: e.username || null,
      ip: e.ip,
      kind: e.kind,
      what: e.what,
      source: e.source || null,
      started: Math.floor(e.started / 1000),
      ending: e.mode === 'proxy' && e.open === 0,
    }));
  }
}
