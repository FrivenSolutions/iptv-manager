// Xtream Codes compatible API over an output profile: live TV, plus movies and series when the
// output includes them.
import crypto from 'node:crypto';
import { vodCategoryList, vodStreams, seriesList, vodInfo, seriesInfo } from './xcvod.js';
import { now } from '../db.js';
import { firstText } from '../xmltv.js';

export { firstText };

const b64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');

function fmt(ts) {
  return new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * The output an Xtream Codes login belongs to: the output's own login, or one of its extra logins
 * (switched on). Only while the output publishes its Xtream Codes login at all.
 */
export function findXcOutput(db, username, password) {
  if (!username) return null;
  const row = db.get('SELECT id, xc_password FROM outputs WHERE xc_enabled = 1 AND xc_username = ?', [String(username)]);
  if (row) return safeEqual(row.xc_password, password) ? row.id : null;
  const login = db.get(
    `SELECT l.id, l.output_id, l.password, l.last_used_at FROM output_xc_logins l JOIN outputs o ON o.id = l.output_id
      WHERE o.xc_enabled = 1 AND l.enabled = 1 AND l.username = ?`,
    [String(username)],
  );
  if (!login || !safeEqual(login.password, password)) return null;
  // "Last used", to see whether a shared login is still in use (written at most once a minute).
  const t = now();
  if (!login.last_used_at || login.last_used_at < t - 60) db.run('UPDATE output_xc_logins SET last_used_at = ? WHERE id = ?', [t, login.id]);
  return login.output_id;
}

export function userInfo(output, base) {
  const u = new URL(base);
  const t = now();
  return {
    user_info: {
      username: output.xc_username,
      password: output.xc_password,
      message: output.name,
      auth: 1,
      status: 'Active',
      exp_date: null,
      is_trial: '0',
      active_cons: '0',
      created_at: String(output.created_at || t),
      max_connections: '10',
      allowed_output_formats: ['m3u8', 'ts'],
    },
    server_info: {
      url: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80'),
      https_port: u.protocol === 'https:' ? u.port || '443' : '',
      server_protocol: u.protocol.replace(':', ''),
      rtmp_port: '',
      timezone: 'UTC',
      timestamp_now: t,
      time_now: fmt(t),
    },
  };
}

function categoriesOf(sel) {
  const seen = new Map();
  for (const ch of sel.channels) if (!seen.has(ch.category_id)) seen.set(ch.category_id, ch.group);
  return [...seen].map(([id, name]) => ({ category_id: String(id), category_name: name, parent_id: 0 }));
}

function streamsOf(sel, categoryId) {
  return sel.channels
    .filter((ch) => !categoryId || String(ch.category_id) === String(categoryId))
    .map((ch, i) => ({
      num: Number(ch.chno) || i + 1,
      name: ch.name,
      stream_type: 'live',
      stream_id: ch.id,
      stream_icon: ch.logo,
      epg_channel_id: ch.tvg_id || null,
      added: String(ch.added || 0),
      is_adult: '0',
      category_id: String(ch.category_id),
      category_ids: [ch.category_id],
      custom_sid: '',
      tv_archive: 0,
      direct_source: '',
      tv_archive_duration: 0,
    }));
}

function listings(db, ch, limit) {
  if (!ch?.epg_id) return [];
  const t = now();
  const rows = db.all(
    `SELECT start_ts, stop_ts, xml FROM programmes
      WHERE source_id = ? AND gen = ? AND channel = ? AND stop_ts > ?
      ORDER BY start_ts LIMIT ?`,
    [ch.source_id, ch.epg_gen, ch.epg_id, t, limit],
  );
  return rows.map((r, i) => ({
    id: String(i + 1),
    epg_id: String(ch.id),
    title: b64(firstText(r.xml, 'title')),
    lang: '',
    start: fmt(r.start_ts),
    end: fmt(r.stop_ts),
    description: b64(firstText(r.xml, 'desc')),
    channel_id: ch.tvg_id,
    start_timestamp: String(r.start_ts),
    stop_timestamp: String(r.stop_ts),
    now_playing: r.start_ts <= t && r.stop_ts > t ? 1 : 0,
    has_archive: 0,
  }));
}

/**
 * Returns the JSON body for player_api.php. vod is { movie, series } (each the output's categories
 * of that kind), or null when the output has no movies and series.
 */
export async function playerApi(db, output, sel, base, params, vod = null) {
  const action = params.get('action') || '';
  switch (action) {
    case '':
      return userInfo({ ...output, xc_username: params.get('username'), xc_password: params.get('password') }, base);
    case 'get_live_categories':
      return categoriesOf(sel);
    case 'get_live_streams':
      return streamsOf(sel, params.get('category_id'));
    case 'get_vod_categories':
      return vod ? vodCategoryList(vod.movie) : [];
    case 'get_series_categories':
      return vod ? vodCategoryList(vod.series) : [];
    case 'get_vod_streams':
      return vod ? vodStreams(db, vod.movie, params.get('category_id')) : [];
    case 'get_series':
      return vod ? seriesList(db, vod.series, params.get('category_id')) : [];
    case 'get_vod_info':
      return vod ? vodInfo(db, vod.movie, params.get('vod_id')) : {};
    case 'get_series_info':
      return vod ? seriesInfo(db, vod.series, params.get('series_id')) : {};
    case 'get_short_epg': {
      const ch = sel.byId.get(Number(params.get('stream_id')));
      return { epg_listings: listings(db, ch, Math.min(Number(params.get('limit')) || 4, 50)) };
    }
    case 'get_simple_data_table': {
      const ch = sel.byId.get(Number(params.get('stream_id')));
      return { epg_listings: listings(db, ch, 1000) };
    }
    default:
      return [];
  }
}
