import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline as pipelineRaw } from 'node:stream/promises';
import { openDb } from './db.js';
import { Router, HttpError, sendJson, sendText, baseUrl } from './http.js';
import { checkSession, hashPassword, randomToken } from './auth.js';
import { Jobs } from './jobs.js';
import { registerApi } from './api.js';
import { loadOutput, selectChannels, evaluateCategories, nameCleaner, checkNameRules, parseNameRules } from './filters.js';
import { buildM3U, streamUrl, streamExt } from './outputs/m3u.js';
import { writeEpg, EpgCache } from './outputs/epg.js';
import { findXcOutput, playerApi } from './outputs/xc.js';
import { serveChannel, serveSegment, serveVod } from './stream.js';
import { vodTarget } from './outputs/xcvod.js';
import { Streams } from './streams.js';
import { HDHR_API } from './hdhomerun.js';
import { currentVersion } from './version.js';
import { UpdateChecker, installType, DEFAULT_UPDATE_REPO } from './updates.js';
import { WebUpdater } from './webupdate.js';
import { Alerts } from './alerts.js';
import { AutoBackup } from './autobackup.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const UI_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

export function createApp({
  dataDir, adminPassword = '', log = defaultLog, hdhrApiBase = HDHR_API,
  updateApiBase = 'https://api.github.com', updateRepo = process.env.IPTV_UPDATE_REPO || DEFAULT_UPDATE_REPO,
  updateCheckDelayMs = 60_000, appCommit, webUpdatePathUnit, autoBackupDelayMs = 2 * 60_000,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(path.join(dataDir, 'tmp'), { recursive: true, force: true });
  const db = openDb(path.join(dataDir, 'iptv-manager.db'));

  if (!db.getSetting('secret')) db.setSetting('secret', randomToken(32));
  // ADMIN_PASSWORD is applied on every start, which doubles as password recovery.
  if (adminPassword) db.setSetting('admin_hash', hashPassword(adminPassword));

  let version = 1;
  const selections = new Map();
  const vodSelections = new Map();

  const ctx = {
    db,
    dataDir,
    log,
    hdhrApi: hdhrApiBase,
    appVersion: APP_VERSION,
    secret: db.getSetting('secret'),
    get version() {
      return version;
    },
    bump() {
      version++;
    },
    sessionGen: () => Number(db.getSetting('session_gen', '1')),
    isAuthed: (req) => checkSession(req, ctx.secret, ctx.sessionGen()),
    secureCookies: (req) => req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').startsWith('https'),
    /**
     * Resolved channel list for an output, cached until the next data change, and for at most
     * a minute: hiding channels by what the guide says is on now changes the list over time.
     */
    selection(outputId) {
      const minute = Math.floor(Date.now() / 60_000);
      const hit = selections.get(outputId);
      if (hit && hit.version === version && hit.minute === minute) return hit.sel;
      const output = loadOutput(db, outputId);
      if (!output) return null;
      const { channels } = selectChannels(db, output);
      const signature = crypto.createHash('sha1').update(channels.map((c) => c.id).join(',')).digest('hex').slice(0, 12);
      const sel = { output, channels, signature, byId: new Map(channels.map((c) => [c.id, c])) };
      selections.set(outputId, { version, minute, sel });
      return sel;
    },
    /**
     * Movies and series of an output, or null when it doesn't include them: for each kind, its
     * categories with their decisions, the included ids, and their order. Cached until data changes.
     */
    vod(outputId) {
      const hit = vodSelections.get(outputId);
      if (hit && hit.version === version) return hit.vod;
      const output = loadOutput(db, outputId);
      let vod = null;
      if (output?.vod_enabled) {
        vod = {};
        const clean = nameCleaner(checkNameRules(parseNameRules(output.name_rules)).rules || [], 'vod');
        for (const kind of ['movie', 'series']) {
          const cats = evaluateCategories(db, output, kind);
          vod[kind] = {
            cats,
            clean,
            included: new Set(cats.filter((c) => c.included).map((c) => c.id)),
            order: new Map(cats.map((c, i) => [c.id, i])),
          };
        }
      }
      vodSelections.set(outputId, { version, vod });
      return vod;
    },
    epgCache: new EpgCache(path.join(dataDir, 'cache')),
  };
  ctx.jobs = new Jobs(ctx);
  const running = currentVersion(ROOT);
  ctx.build = {
    version: APP_VERSION,
    commit: appCommit === undefined ? running.commit : appCommit,
    commitSource: appCommit === undefined ? running.source : 'test',
    installType: installType(ROOT),
    repo: updateRepo,
  };
  ctx.webUpdate = new WebUpdater({ dataDir, pathUnit: webUpdatePathUnit });
  ctx.alerts = new Alerts(ctx);
  ctx.autoBackup = new AutoBackup(ctx, { firstDelayMs: autoBackupDelayMs });
  ctx.streams = new Streams(ctx);
  ctx.updates = new UpdateChecker({
    db, commit: ctx.build.commit, apiBase: updateApiBase, repo: updateRepo, delayMs: updateCheckDelayMs, log,
  });

  const router = new Router();
  registerApi(router, ctx);

  const statics = new Map();
  for (const f of fs.readdirSync(PUBLIC)) {
    const type = STATIC_TYPES[path.extname(f)];
    if (type) statics.set(`/${f}`, { body: fs.readFileSync(path.join(PUBLIC, f)), type });
  }
  statics.set('/', statics.get('/index.html'));

  // --- published outputs ---------------------------------------------------
  const byToken = (token) => {
    const row = db.get('SELECT id FROM outputs WHERE token = ?', [String(token)]);
    if (!row) throw new HttpError(404, 'Unknown output');
    return ctx.selection(row.id);
  };
  const base = (req) => baseUrl(req, db.getSetting('base_url'));

  const sendPlaylist = (req, res, sel, urlFor) => {
    const body = buildM3U(sel.output, sel.channels, base(req), urlFor);
    sendText(res, 200, body, 'audio/x-mpegurl; charset=utf-8', {
      'content-disposition': 'inline; filename="playlist.m3u"',
      'cache-control': 'no-cache',
    });
  };

  // A player closing the connection mid-download is routine, not a server error.
  const pipeline = (...streams) => pipelineRaw(...streams).catch((e) => {
    if (e.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw e;
  });

  const sendEpg = async (req, res, sel, gzipped) => {
    // Keyed by the channel list too, so the guide follows channels hidden or shown by the clock.
    const file = await ctx.epgCache.get(sel.output.id, `${version}-${sel.signature}`, (f) => writeEpg(db, sel.output, sel.channels, f));
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const headers = { 'cache-control': 'no-cache' };
    if (gzipped) {
      res.writeHead(200, { ...headers, 'content-type': 'application/gzip', 'content-length': fs.statSync(file).size });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(file), res);
    }
    if (acceptsGzip) {
      res.writeHead(200, { ...headers, 'content-type': 'application/xml; charset=utf-8', 'content-encoding': 'gzip', vary: 'accept-encoding' });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(file), res);
    }
    res.writeHead(200, { ...headers, 'content-type': 'application/xml; charset=utf-8' });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file), zlib.createGunzip(), res);
  };

  router.get('/healthz', (req, res) => sendJson(res, 200, { ok: true }));

  for (const name of ['playlist.m3u', 'playlist.m3u8', 'get.m3u']) {
    router.get(`/o/:token/${name}`, (req, res, { params }) => {
      const sel = byToken(params.token);
      sendPlaylist(req, res, sel, (ch) => streamUrl(base(req), sel.output, ch));
    });
  }
  router.get('/o/:token/epg.xml', (req, res, { params }) => sendEpg(req, res, byToken(params.token), false));
  router.get('/o/:token/epg.xml.gz', (req, res, { params }) => sendEpg(req, res, byToken(params.token), true));

  const channelOf = (sel, id) => {
    const ch = sel.byId.get(Number(id));
    if (!ch) throw new HttpError(404, 'Channel is not in this output');
    return ch;
  };
  router.get('/s/:token/seg/:id', (req, res, { params, query }) => {
    const sel = byToken(params.token);
    return serveSegment(ctx, res, sel.output, channelOf(sel, params.id), query.get('u'), query.get('sig'));
  });
  router.get('/s/:token/:id.:ext', (req, res, { params }) => {
    const sel = byToken(params.token);
    return serveChannel(ctx, res, sel.output, channelOf(sel, params.id), params.ext);
  });

  // --- Xtream Codes compatible endpoints -----------------------------------
  const xcAuth = (username, password) => {
    const id = findXcOutput(db, username, password);
    return id ? ctx.selection(id) : null;
  };
  const xcUrl = (req, sel) => (ch) => {
    if (sel.output.stream_mode === 'direct') return ch.url;
    const o = sel.output;
    return `${base(req)}/live/${encodeURIComponent(o.xc_username)}/${encodeURIComponent(o.xc_password)}/${ch.id}.${streamExt(ch.url)}`;
  };

  const xcApi = async (req, res, { query }) => {
    const sel = xcAuth(query.get('username'), query.get('password'));
    if (!sel) return sendJson(res, 200, { user_info: { auth: 0 } });
    sendJson(res, 200, await playerApi(db, sel.output, sel, base(req), query, ctx.vod(sel.output.id)));
  };
  router.get('/player_api.php', xcApi);
  router.post('/player_api.php', xcApi);
  router.get('/get.php', (req, res, { query }) => {
    const sel = xcAuth(query.get('username'), query.get('password'));
    if (!sel) throw new HttpError(401, 'Invalid credentials');
    sendPlaylist(req, res, sel, xcUrl(req, sel));
  });
  router.get('/xmltv.php', (req, res, { query }) => {
    const sel = xcAuth(query.get('username'), query.get('password'));
    if (!sel) throw new HttpError(401, 'Invalid credentials');
    return sendEpg(req, res, sel, false);
  });
  const xcStream = (req, res, { params }) => {
    const sel = xcAuth(params.u, params.p);
    if (!sel) throw new HttpError(401, 'Invalid credentials');
    const [id, ext = 'ts'] = params.file.split('.');
    return serveChannel(ctx, res, sel.output, channelOf(sel, id), ext);
  };
  router.get('/live/:u/:p/:file', xcStream);
  // Movies and series episodes: ids are this server's, checked against the output's categories.
  for (const kind of ['movie', 'series']) {
    router.get(`/${kind}/:u/:p/:file`, (req, res, { params }) => {
      const sel = xcAuth(params.u, params.p);
      if (!sel) throw new HttpError(401, 'Invalid credentials');
      const vod = ctx.vod(sel.output.id);
      const target = vod && vodTarget(db, vod, kind, params.file.split('.')[0]);
      if (!target) throw new HttpError(404, `${kind === 'movie' ? 'Movie' : 'Episode'} is not in this output`);
      return serveVod(ctx, req, res, sel.output, target);
    });
  }
  router.get('/:u/:p/:file', xcStream);

  // --- request dispatch ----------------------------------------------------
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && statics.has(pathname)) {
        const s = statics.get(pathname);
        res.writeHead(200, { 'content-type': s.type, 'content-length': s.body.length, 'cache-control': 'no-cache', ...UI_HEADERS });
        return res.end(req.method === 'HEAD' ? undefined : s.body);
      }
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'Not found');
      if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');

      if (pathname.startsWith('/api/')) {
        const open = ['/api/session', '/api/setup', '/api/login'].includes(pathname);
        if (!open && !ctx.isAuthed(req)) throw new HttpError(401, 'Not logged in');
        // Custom header blocks cross-site form posts (CSRF) without a token dance.
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'fetch') {
          throw new HttpError(403, 'Missing X-Requested-With header');
        }
      }
      await m.handler(req, res, { params: m.params, query: url.searchParams });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log(`Error handling ${req.method} ${pathname}: ${e.stack || e}`);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal error' : e.message });
      else res.destroy();
    }
  });

  return {
    server,
    ctx,
    start(port, host) {
      ctx.jobs.start();
      ctx.updates.start();
      ctx.alerts.start();
      ctx.autoBackup.start();
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      ctx.jobs.stop();
      ctx.updates.stop();
      ctx.alerts.stop();
      ctx.autoBackup.stop();
      ctx.streams.stop();
      await new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      await ctx.jobs.idle();
      db.close();
    },
  };
}

function defaultLog(msg) {
  console.log(`${new Date().toISOString()} ${msg}`);
}
