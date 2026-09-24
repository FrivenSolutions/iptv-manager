// Admin REST API behind the login session.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError, sendJson, readJson, baseUrl } from './http.js';
import { hashPassword, verifyPassword, makeSession, sessionCookie, randomToken, COOKIE } from './auth.js';
import { OPS, loadOutput, evaluateCategories, isNewCategory, channelState } from './filters.js';
import { rematchSource } from './ingest.js';
import { JELLYFIN_CATEGORIES, parseJellyfin } from './outputs/epg.js';
import { exportSettings, importSettings } from './backup.js';
import { now } from './db.js';

const UPLOAD_LIMIT = 1024 * 1024 * 1024;
const IMPORT_LIMIT = 50 * 1024 * 1024;
const LOGIN_LOCK_AFTER = 5;
const LOGIN_LOCK_S = 60;

const str = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const optStr = (v, max = 2000) => {
  const s = str(v, max);
  return s ? s : null;
};
const int = (v, dflt, min = -Infinity, max = Infinity) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

function mustGet(db, table, id) {
  const row = db.get(`SELECT * FROM ${table} WHERE id = ?`, [Number(id)]);
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

function parseJson(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

function sourceView(ctx, s) {
  const counts = ctx.db.get(
    `SELECT (SELECT COUNT(*) FROM channels WHERE source_id = ? AND active = 1) AS channels,
            (SELECT COUNT(*) FROM channels WHERE source_id = ? AND active = 1 AND epg_id IS NOT NULL) AS epg_matched,
            (SELECT COUNT(*) FROM categories WHERE source_id = ? AND active = 1) AS categories`,
    [s.id, s.id, s.id],
  );
  return {
    ...s,
    xc_password: '',
    has_password: !!s.xc_password,
    live_only: !!s.live_only,
    enabled: !!s.enabled,
    stats: parseJson(s.stats),
    account_info: parseJson(s.account_info),
    job: ctx.jobs.status(s.id),
    next_refresh_at: ctx.jobs.nextDue(s),
    counts,
  };
}

function sourceFields(body, existing) {
  const type = existing?.type || (['xc', 'hdhr'].includes(body.type) ? body.type : 'm3u');
  const f = {
    name: str(body.name, 200) || existing?.name || 'Source',
    type,
    url: optStr(body.url),
    epg_urls: str(body.epg_urls, 20000),
    xc_host: optStr(body.xc_host),
    xc_username: optStr(body.xc_username, 200),
    // A blank password on edit keeps the stored one (the API never echoes it back).
    xc_password: str(body.xc_password, 200) || existing?.xc_password || null,
    xc_stream_ext: body.xc_stream_ext === 'm3u8' ? 'm3u8' : 'ts',
    hdhr_host: optStr(body.hdhr_host, 300),
    user_agent: str(body.user_agent, 500),
    live_only: body.live_only === undefined ? 1 : bool(body.live_only),
    refresh_minutes: int(body.refresh_minutes, 720, 0, 60 * 24 * 30),
    enabled: body.enabled === undefined ? 1 : bool(body.enabled),
  };
  if (type === 'xc') {
    if (!f.xc_host || !f.xc_username || !f.xc_password) throw new HttpError(400, 'Xtream Codes sources need a host, username and password');
  } else if (type === 'hdhr') {
    if (!f.hdhr_host) throw new HttpError(400, 'HDHomeRun sources need the box\'s IP address or hostname');
    if (/[\s?#]/.test(f.hdhr_host)) {
      throw new HttpError(400, 'Enter just the HDHomeRun address, like 192.168.1.50');
    }
  } else if (f.url && !/^(https?:\/\/|upload:)/i.test(f.url)) {
    throw new HttpError(400, 'Playlist URL must start with http:// or https://');
  }
  return f;
}

export function validateRules(list) {
  return list
    .map((r) => {
      if (!['include', 'exclude'].includes(r.action)) throw new HttpError(400, 'Rule action must be include or exclude');
      if (!OPS.includes(r.op)) throw new HttpError(400, `Unknown rule operator: ${r.op}`);
      if (r.op === 'regex') {
        try {
          new RegExp(r.value);
        } catch {
          throw new HttpError(400, `Invalid regular expression: ${r.value}`);
        }
      }
      return { action: r.action, op: r.op, value: str(r.value, 500), source_id: r.source_id ? Number(r.source_id) : null };
    })
    .filter((r) => r.value !== '');
}

function outputUrls(req, ctx, o) {
  const base = baseUrl(req, ctx.db.getSetting('base_url'));
  return {
    m3u: `${base}/o/${o.token}/playlist.m3u`,
    epg: `${base}/o/${o.token}/epg.xml`,
    epg_gz: `${base}/o/${o.token}/epg.xml.gz`,
    xc_server: o.xc_enabled ? base : null,
  };
}

function outputView(req, ctx, o, withDetail = false) {
  const sel = ctx.selection(o.id);
  const view = {
    id: o.id,
    name: o.name,
    token: o.token,
    stream_mode: o.stream_mode,
    include_all: !!o.include_all,
    number_start: o.number_start,
    epg_days: o.epg_days,
    xc_enabled: !!o.xc_enabled,
    xc_username: o.xc_username,
    xc_password: o.xc_password,
    updated_at: o.updated_at,
    channel_count: sel ? sel.channels.length : 0,
    category_count: sel ? new Set(sel.channels.map((c) => c.category_id)).size : 0,
    urls: outputUrls(req, ctx, o),
  };
  if (withDetail) {
    const attached = new Map(ctx.db.all('SELECT source_id, sort FROM output_sources WHERE output_id = ?', [o.id])
      .map((r) => [r.source_id, r.sort]));
    view.sources = ctx.db.all('SELECT id, name, type FROM sources ORDER BY sort, id')
      .map((s) => ({ ...s, attached: attached.has(s.id), sort: attached.get(s.id) ?? 999 }))
      .sort((a, b) => a.sort - b.sort || a.id - b.id);
    view.rules = ctx.db.all('SELECT id, source_id, action, op, value FROM output_rules WHERE output_id = ? ORDER BY sort, id', [o.id]);
  }
  return view;
}

export function registerApi(router, ctx) {
  const { db } = ctx;
  const failures = new Map();

  const touch = () => ctx.bump();

  // --- session ---------------------------------------------------------------
  router.get('/api/session', (req, res) => {
    sendJson(res, 200, { setup_required: !db.getSetting('admin_hash'), authenticated: ctx.isAuthed(req) });
  });

  router.post('/api/setup', async (req, res) => {
    if (db.getSetting('admin_hash')) throw new HttpError(409, 'Already set up');
    const { password } = await readJson(req);
    if (str(password).length < 8) throw new HttpError(400, 'Use at least 8 characters');
    db.setSetting('admin_hash', hashPassword(password));
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/login', async (req, res) => {
    const ip = req.socket.remoteAddress || '';
    const f = failures.get(ip);
    if (f && f.count >= LOGIN_LOCK_AFTER && f.until > Date.now()) throw new HttpError(429, 'Too many attempts; wait a minute');
    const { password } = await readJson(req);
    if (!verifyPassword(password || '', db.getSetting('admin_hash'))) {
      const n = (f && f.until > Date.now() ? f.count : 0) + 1;
      failures.set(ip, { count: n, until: Date.now() + LOGIN_LOCK_S * 1000 });
      throw new HttpError(401, 'Wrong password');
    }
    failures.delete(ip);
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/logout', (req, res) => {
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/password', async (req, res) => {
    const { current, next } = await readJson(req);
    if (!verifyPassword(current || '', db.getSetting('admin_hash'))) throw new HttpError(400, 'Current password is wrong');
    if (str(next).length < 8) throw new HttpError(400, 'Use at least 8 characters');
    db.setSetting('admin_hash', hashPassword(next));
    db.setSetting('session_gen', ctx.sessionGen() + 1);
    const s = makeSession(ctx.secret, ctx.sessionGen());
    res.setHeader('set-cookie', sessionCookie(s.value, s.maxAge, ctx.secureCookies(req)));
    sendJson(res, 200, { ok: true });
  });

  // --- settings --------------------------------------------------------------
  router.get('/api/settings', (req, res) => {
    sendJson(res, 200, {
      base_url: db.getSetting('base_url') || '',
      detected_base_url: baseUrl(req, ''),
      version: ctx.appVersion,
    });
  });

  router.put('/api/settings', async (req, res) => {
    const body = await readJson(req);
    const b = str(body.base_url, 500).replace(/\/+$/, '');
    if (b && !/^https?:\/\/[^/]+(\/.*)?$/i.test(b)) throw new HttpError(400, 'Base URL must start with http:// or https://');
    db.setSetting('base_url', b);
    touch();
    sendJson(res, 200, { ok: true });
  });

  // --- backup ----------------------------------------------------------------
  router.get('/api/export', (req, res, { query }) => {
    const secrets = query.get('secrets') !== '0';
    const data = exportSettings(db, { secrets, appVersion: ctx.appVersion });
    const body = JSON.stringify(data, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="iptv-manager-settings-${stamp}.json"`,
      'cache-control': 'no-store',
    });
    res.end(body);
  });

  router.post('/api/import', async (req, res) => {
    const data = await readJson(req, IMPORT_LIMIT);
    // A refresh writing into a source the import is about to delete would fail half-way.
    if (ctx.jobs.running || ctx.jobs.queue.length) throw new HttpError(409, 'A source refresh is running; try again when it finishes');
    const result = importSettings(db, data);
    ctx.bump();
    for (const id of result.sourceIds) ctx.jobs.enqueue(id);
    ctx.log(`Imported settings: ${result.sources} sources, ${result.outputs} outputs`);
    sendJson(res, 200, { ok: true, sources: result.sources, outputs: result.outputs });
  });

  // --- sources ---------------------------------------------------------------
  router.get('/api/sources', (req, res) => {
    sendJson(res, 200, db.all('SELECT * FROM sources ORDER BY sort, id').map((s) => sourceView(ctx, s)));
  });

  router.get('/api/sources/:id', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    sendJson(res, 200, sourceView(ctx, s));
  });

  router.post('/api/sources', async (req, res) => {
    const f = sourceFields(await readJson(req));
    const r = db.get(
      `INSERT INTO sources (name, type, url, epg_urls, xc_host, xc_username, xc_password, xc_stream_ext, hdhr_host, user_agent,
                            live_only, refresh_minutes, enabled, sort, created_at)
       VALUES ($name, $type, $url, $epg_urls, $xc_host, $xc_username, $xc_password, $xc_stream_ext, $hdhr_host, $user_agent,
               $live_only, $refresh_minutes, $enabled, (SELECT COALESCE(MAX(sort), 0) + 1 FROM sources), $created_at)
       RETURNING id`,
      { ...f, created_at: now() },
    );
    // An M3U source without a URL waits for its playlist upload before the first refresh.
    if (f.enabled && (f.type !== 'm3u' || f.url)) ctx.jobs.enqueue(r.id);
    sendJson(res, 201, sourceView(ctx, mustGet(db, 'sources', r.id)));
  });

  router.put('/api/sources/:id', async (req, res, { params }) => {
    const existing = mustGet(db, 'sources', params.id);
    const f = sourceFields(await readJson(req), existing);
    db.run(
      `UPDATE sources SET name = $name, url = $url, epg_urls = $epg_urls, xc_host = $xc_host, xc_username = $xc_username,
         xc_password = $xc_password, xc_stream_ext = $xc_stream_ext, hdhr_host = $hdhr_host, user_agent = $user_agent, live_only = $live_only,
         refresh_minutes = $refresh_minutes, enabled = $enabled WHERE id = $id`,
      { ...f, id: existing.id },
    );
    const refetch = ['url', 'epg_urls', 'xc_host', 'xc_username', 'xc_password', 'xc_stream_ext', 'hdhr_host', 'user_agent', 'live_only']
      .some((k) => String(existing[k] ?? '') !== String(f[k] ?? ''));
    if (refetch && f.enabled) ctx.jobs.enqueue(existing.id);
    touch();
    sendJson(res, 200, sourceView(ctx, mustGet(db, 'sources', existing.id)));
  });

  router.delete('/api/sources/:id', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    db.run('DELETE FROM sources WHERE id = ?', [s.id]);
    const dir = path.join(ctx.dataDir, 'uploads');
    for (const kind of ['m3u', 'epg']) fs.rm(path.join(dir, `source-${s.id}-${kind}`), { force: true }, () => {});
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/sources/:id/refresh', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    ctx.jobs.enqueue(s.id);
    sendJson(res, 202, { job: ctx.jobs.status(s.id) });
  });

  // Raw file upload (M3U or XMLTV, optionally gzipped); the source then reads it on every refresh.
  router.post('/api/sources/:id/upload', async (req, res, { params, query }) => {
    const s = mustGet(db, 'sources', params.id);
    const kind = query.get('kind') === 'epg' ? 'epg' : 'm3u';
    if (kind === 'm3u' && s.type !== 'm3u') throw new HttpError(400, 'Playlist upload is only for M3U sources');
    const dir = path.join(ctx.dataDir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `source-${s.id}-${kind}`;
    const tmp = path.join(dir, `${name}.part`);
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > UPLOAD_LIMIT) req.destroy(new Error('Upload too large'));
    });
    await pipeline(req, fs.createWriteStream(tmp));
    if (!size) {
      fs.rmSync(tmp, { force: true });
      throw new HttpError(400, 'Empty upload');
    }
    fs.renameSync(tmp, path.join(dir, name));
    const ref = `upload:${name}`;
    if (kind === 'm3u') db.run('UPDATE sources SET url = ? WHERE id = ?', [ref, s.id]);
    else if (!s.epg_urls.split(/\r?\n/).includes(ref)) {
      db.run('UPDATE sources SET epg_urls = ? WHERE id = ?', [[s.epg_urls.trim(), ref].filter(Boolean).join('\n'), s.id]);
    }
    ctx.jobs.enqueue(s.id);
    sendJson(res, 200, { ok: true, size });
  });

  router.get('/api/sources/:id/categories', (req, res, { params }) => {
    const s = mustGet(db, 'sources', params.id);
    const rows = db.all(
      `SELECT c.id, c.name, c.custom_name, c.jellyfin, c.first_seen, c.added_in,
              (SELECT COUNT(*) FROM channels ch WHERE ch.category_id = c.id AND ch.active = 1) AS channel_count
         FROM categories c WHERE c.source_id = ? AND c.active = 1 ORDER BY c.sort`,
      [s.id],
    );
    for (const r of rows) {
      r.is_new = isNewCategory(r);
      r.jellyfin = parseJellyfin(r.jellyfin);
    }
    sendJson(res, 200, rows);
  });

  // Partial update: only the fields present in the body change.
  router.put('/api/categories/:id', async (req, res, { params }) => {
    const c = mustGet(db, 'categories', params.id);
    const body = await readJson(req);
    const customName = body.custom_name === undefined ? c.custom_name : optStr(body.custom_name, 200);
    let jellyfin = c.jellyfin;
    if (body.jellyfin !== undefined) {
      const list = Array.isArray(body.jellyfin) ? body.jellyfin : [];
      const unknown = list.filter((v) => !JELLYFIN_CATEGORIES.some((j) => j.toLowerCase() === String(v).toLowerCase()));
      if (unknown.length) throw new HttpError(400, `Unknown Jellyfin category: ${unknown.join(', ')}`);
      jellyfin = parseJellyfin(list.join(',')).join(',') || null;
    }
    db.run('UPDATE categories SET custom_name = ?, jellyfin = ? WHERE id = ?', [customName, jellyfin, c.id]);
    touch();
    sendJson(res, 200, { ok: true, custom_name: customName, jellyfin: parseJellyfin(jellyfin) });
  });

  router.get('/api/sources/:id/channels', (req, res, { params, query }) => {
    const s = mustGet(db, 'sources', params.id);
    const where = ['ch.source_id = ?', 'ch.active = 1'];
    const args = [s.id];
    if (query.get('category_id')) {
      where.push('ch.category_id = ?');
      args.push(Number(query.get('category_id')));
    }
    const q = str(query.get('q'), 200);
    if (q) {
      where.push('(ch.name LIKE ? OR ch.custom_name LIKE ? OR ch.tvg_id LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (query.get('epg') === 'unmatched') where.push('ch.epg_id IS NULL');
    if (query.get('epg') === 'matched') where.push('ch.epg_id IS NOT NULL');
    const w = where.join(' AND ');
    const total = db.get(`SELECT COUNT(*) AS n FROM channels ch WHERE ${w}`, args).n;
    const limit = int(query.get('limit'), 200, 1, 1000);
    const offset = int(query.get('offset'), 0, 0);
    const items = db.all(
      `SELECT ch.id, ch.name, ch.tvg_id, ch.tvg_name, ch.logo, ch.chno, ch.epg_id, ch.epg_match,
              ch.custom_name, ch.custom_logo, ch.custom_epg_id, ch.custom_chno, ch.category_id,
              c.name AS category
         FROM channels ch LEFT JOIN categories c ON c.id = ch.category_id
        WHERE ${w} ORDER BY c.sort, ch.sort LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    sendJson(res, 200, { total, items });
  });

  router.get('/api/sources/:id/epg-channels', (req, res, { params, query }) => {
    const s = mustGet(db, 'sources', params.id);
    const q = str(query.get('q'), 200);
    const rows = db.all(
      `SELECT xml_id AS id, names, icon FROM epg_channels
        WHERE source_id = ? AND gen = ? AND (? = '' OR xml_id LIKE ? OR names LIKE ?)
        ORDER BY xml_id LIMIT 50`,
      [s.id, s.epg_gen, q, `%${q}%`, `%${q}%`],
    );
    sendJson(res, 200, rows.map((r) => ({ ...r, names: parseJson(r.names) || [] })));
  });

  router.put('/api/channels/:id', async (req, res, { params }) => {
    const ch = mustGet(db, 'channels', params.id);
    const body = await readJson(req);
    const f = {
      custom_name: optStr(body.custom_name, 300),
      custom_logo: optStr(body.custom_logo, 2000),
      custom_epg_id: optStr(body.custom_epg_id, 300),
      custom_chno: optStr(body.custom_chno, 20),
    };
    db.run(
      `UPDATE channels SET custom_name = $custom_name, custom_logo = $custom_logo, custom_epg_id = $custom_epg_id,
         custom_chno = $custom_chno WHERE id = $id`,
      { ...f, id: ch.id },
    );
    // Guide data is only stored for matched channels, so a new manual EPG id needs a fresh pull.
    if ((ch.custom_epg_id || null) !== f.custom_epg_id) {
      const known = f.custom_epg_id && db.get(
        'SELECT 1 FROM programmes p JOIN sources s ON s.id = p.source_id AND s.epg_gen = p.gen WHERE p.source_id = ? AND p.channel = ? LIMIT 1',
        [ch.source_id, f.custom_epg_id],
      );
      rematchSource(db, ch.source_id);
      if (f.custom_epg_id && !known) ctx.jobs.enqueue(ch.source_id);
    } else if ((ch.custom_name || null) !== f.custom_name) {
      rematchSource(db, ch.source_id);
    }
    touch();
    sendJson(res, 200, db.get('SELECT * FROM channels WHERE id = ?', [ch.id]));
  });

  // --- outputs ---------------------------------------------------------------
  router.get('/api/outputs', (req, res) => {
    sendJson(res, 200, db.all('SELECT * FROM outputs ORDER BY id').map((o) => outputView(req, ctx, o)));
  });

  router.post('/api/outputs', async (req, res) => {
    const body = await readJson(req);
    const t = now();
    const id = db.tx(() => {
      const r = db.get(
        'INSERT INTO outputs (name, token, stream_mode, epg_days, created_at, updated_at) VALUES (?, ?, ?, 7, ?, ?) RETURNING id',
        [str(body.name, 200) || 'New output', randomToken(), 'direct', t, t],
      );
      db.all('SELECT id FROM sources ORDER BY sort, id').forEach((s, i) => {
        db.run('INSERT INTO output_sources (output_id, source_id, sort) VALUES (?, ?, ?)', [r.id, s.id, i]);
      });
      return r.id;
    });
    touch();
    sendJson(res, 201, outputView(req, ctx, mustGet(db, 'outputs', id), true));
  });

  router.get('/api/outputs/:id', (req, res, { params }) => {
    sendJson(res, 200, outputView(req, ctx, mustGet(db, 'outputs', params.id), true));
  });

  router.put('/api/outputs/:id', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const body = await readJson(req);
    const xcEnabled = body.xc_enabled === undefined ? o.xc_enabled : bool(body.xc_enabled);
    const xcUser = body.xc_username === undefined ? o.xc_username : optStr(body.xc_username, 100);
    const xcPass = body.xc_password === undefined ? o.xc_password : optStr(body.xc_password, 100);
    if (xcEnabled && (!xcUser || !xcPass)) throw new HttpError(400, 'The Xtream Codes output needs a username and password');
    if (xcUser && /[/?#\s]/.test(xcUser)) throw new HttpError(400, 'The Xtream Codes username cannot contain spaces, "/", "?" or "#"');
    if (xcPass && /[/?#\s]/.test(xcPass)) throw new HttpError(400, 'The Xtream Codes password cannot contain spaces, "/", "?" or "#"');
    if (xcUser && db.get('SELECT 1 FROM outputs WHERE xc_username = ? AND id <> ?', [xcUser, o.id])) {
      throw new HttpError(400, 'Another output already uses that Xtream Codes username');
    }
    const mode = body.stream_mode === undefined ? o.stream_mode : body.stream_mode;
    if (!['direct', 'redirect', 'proxy'].includes(mode)) throw new HttpError(400, 'Unknown stream mode');

    const rules = Array.isArray(body.rules) ? validateRules(body.rules) : null;

    db.tx(() => {
      db.run(
        `UPDATE outputs SET name = ?, stream_mode = ?, include_all = ?, number_start = ?, epg_days = ?,
           xc_enabled = ?, xc_username = ?, xc_password = ?, updated_at = ? WHERE id = ?`,
        [
          body.name === undefined ? o.name : str(body.name, 200) || o.name,
          mode,
          body.include_all === undefined ? o.include_all : bool(body.include_all),
          body.number_start === undefined ? o.number_start : (body.number_start === '' || body.number_start == null ? null : int(body.number_start, null, 0, 1e6)),
          body.epg_days === undefined ? o.epg_days : int(body.epg_days, 7, 1, 14),
          xcEnabled, xcUser, xcPass, now(), o.id,
        ],
      );
      if (Array.isArray(body.source_ids)) {
        db.run('DELETE FROM output_sources WHERE output_id = ?', [o.id]);
        body.source_ids.forEach((sid, i) => {
          if (db.get('SELECT 1 FROM sources WHERE id = ?', [Number(sid)])) {
            db.run('INSERT OR IGNORE INTO output_sources (output_id, source_id, sort) VALUES (?, ?, ?)', [o.id, Number(sid), i]);
          }
        });
      }
      if (rules) {
        db.run('DELETE FROM output_rules WHERE output_id = ?', [o.id]);
        rules.forEach((r, i) => {
          if (r.source_id && !db.get('SELECT 1 FROM sources WHERE id = ?', [r.source_id])) r.source_id = null;
          db.run('INSERT INTO output_rules (output_id, source_id, action, op, value, sort) VALUES (?, ?, ?, ?, ?, ?)', [
            o.id, r.source_id, r.action, r.op, r.value, i,
          ]);
        });
      }
    });
    touch();
    sendJson(res, 200, outputView(req, ctx, mustGet(db, 'outputs', o.id), true));
  });

  router.delete('/api/outputs/:id', (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    db.run('DELETE FROM outputs WHERE id = ?', [o.id]);
    ctx.epgCache.drop(o.id);
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/outputs/:id/token', (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    db.run('UPDATE outputs SET token = ?, updated_at = ? WHERE id = ?', [randomToken(), now(), o.id]);
    touch();
    sendJson(res, 200, outputView(req, ctx, mustGet(db, 'outputs', o.id), true));
  });

  router.get('/api/outputs/:id/categories', (req, res, { params }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    sendJson(res, 200, evaluateCategories(db, o));
  });

  router.put('/api/outputs/:id/categories', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const { ids, state } = await readJson(req);
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list');
    if (state != null && !['include', 'exclude'].includes(state)) throw new HttpError(400, 'state must be include, exclude or null');
    db.tx(() => {
      for (const id of ids) {
        if (state) {
          db.run(
            `INSERT INTO output_category_overrides (output_id, category_id, state) VALUES (?, ?, ?)
             ON CONFLICT (output_id, category_id) DO UPDATE SET state = excluded.state`,
            [o.id, Number(id), state],
          );
        } else {
          db.run('DELETE FROM output_category_overrides WHERE output_id = ? AND category_id = ?', [o.id, Number(id)]);
        }
      }
    });
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/outputs/:id/channels', (req, res, { params, query }) => {
    const o = loadOutput(db, Number(params.id));
    if (!o) throw new HttpError(404, 'Not found');
    const catId = Number(query.get('category_id'));
    const cat = evaluateCategories(db, o).find((c) => c.id === catId);
    if (!cat) throw new HttpError(404, 'Category is not part of this output');
    const overrides = new Map(db.all('SELECT channel_id, state FROM output_channel_overrides WHERE output_id = ?', [o.id])
      .map((r) => [r.channel_id, r.state]));
    const rows = db.all(
      `SELECT id, name, custom_name, logo, custom_logo, epg_id, custom_epg_id, tvg_id
         FROM channels WHERE category_id = ? AND active = 1 ORDER BY sort`,
      [catId],
    );
    sendJson(res, 200, {
      category_included: cat.included,
      rules: cat.channel_rules.map(({ id, action, op, value }) => ({ id, action, op, value })),
      channels: rows.map((r) => {
        const override = overrides.get(r.id) || null;
        return { ...r, override, ...channelState(r.name, cat.included, cat.channel_rules, override) };
      }),
    });
  });

  // Replace the channel rules of one category in this output.
  router.put('/api/outputs/:id/categories/:catId/channel-rules', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const cat = mustGet(db, 'categories', params.catId);
    const body = await readJson(req);
    if (!Array.isArray(body.rules)) throw new HttpError(400, 'rules must be a list');
    const rules = validateRules(body.rules);
    db.tx(() => {
      db.run('DELETE FROM output_channel_rules WHERE output_id = ? AND category_id = ?', [o.id, cat.id]);
      rules.forEach((r, i) => {
        db.run('INSERT INTO output_channel_rules (output_id, category_id, action, op, value, sort) VALUES (?, ?, ?, ?, ?, ?)', [
          o.id, cat.id, r.action, r.op, r.value, i,
        ]);
      });
    });
    touch();
    sendJson(res, 200, { ok: true });
  });

  router.put('/api/outputs/:id/channels', async (req, res, { params }) => {
    const o = mustGet(db, 'outputs', params.id);
    const { ids, state } = await readJson(req);
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list');
    if (state != null && !['include', 'exclude'].includes(state)) throw new HttpError(400, 'state must be include, exclude or null');
    db.tx(() => {
      for (const id of ids) {
        if (state) {
          db.run(
            `INSERT INTO output_channel_overrides (output_id, channel_id, state) VALUES (?, ?, ?)
             ON CONFLICT (output_id, channel_id) DO UPDATE SET state = excluded.state`,
            [o.id, Number(id), state],
          );
        } else {
          db.run('DELETE FROM output_channel_overrides WHERE output_id = ? AND channel_id = ?', [o.id, Number(id)]);
        }
      }
    });
    touch();
    sendJson(res, 200, { ok: true });
  });
}
