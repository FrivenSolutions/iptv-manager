// End-to-end: a fake provider (M3U + gzipped XMLTV + Xtream Codes + HLS) feeding the real app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp } from '../src/app.js';

const PASSWORD = 'correct horse';
let upstream;
let up; // upstream base URL
let app;
let base;
let cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-test-'));

// Mutable provider state so tests can simulate a provider adding categories.
const xcCats = [
  { category_id: '10', category_name: 'US| NEWS' },
  { category_id: '11', category_name: 'US| ADULT' },
  { category_id: '12', category_name: 'UK| SPORTS' },
];
// Movies and series of the fake XC account. One series category shares a live category's name.
const vodData = {
  movieCats: [
    { category_id: '201', category_name: 'EN| ACTION' },
    { category_id: '202', category_name: 'EN| KIDS' },
    { category_id: '203', category_name: 'FR| FILMS' },
  ],
  movies: [
    { num: 1, name: 'Die Hard', stream_id: 5001, stream_icon: 'http://p/dh.jpg', rating: '8', added: '1700000000', category_id: '201', container_extension: 'mkv' },
    { num: 2, name: 'Heat', stream_id: 5002, stream_icon: '', rating: '7', added: '1700000001', category_id: '201', container_extension: 'mp4' },
    { num: 3, name: 'Frozen', stream_id: 5003, stream_icon: '', added: '1700000002', category_id: '202', container_extension: 'mp4' },
    { num: 4, name: 'Amélie', stream_id: 5004, stream_icon: '', added: '1700000003', category_id: '203', container_extension: 'mp4' },
  ],
  seriesCats: [
    { category_id: '301', category_name: 'EN| DRAMA' },
    { category_id: '302', category_name: 'US| NEWS' },
  ],
  series: [
    { num: 1, name: 'Breaking Bad', series_id: 7001, cover: 'http://p/bb.jpg', plot: 'Chemistry', last_modified: '1700000100', category_id: '301' },
    { num: 2, name: 'The Newsroom', series_id: 7002, cover: '', last_modified: '1700000101', category_id: '302' },
  ],
};

const xcStreams = [
  { num: 1, name: 'US: CNN HD', stream_id: 101, stream_icon: 'http://logo/cnn.png', epg_channel_id: 'cnn.us', category_id: '10' },
  { num: 2, name: 'US: Fox News', stream_id: 102, stream_icon: '', epg_channel_id: '', category_id: '10' },
  { num: 3, name: 'Late Night', stream_id: 103, stream_icon: '', epg_channel_id: '', category_id: '11' },
  { num: 4, name: 'UK: Sky Sports', stream_id: 104, stream_icon: '', epg_channel_id: 'sky.uk', category_id: '12' },
];

// DeviceAuth deliberately contains characters that must be URL-encoded.
const HDHR_AUTH = 'aB3+/x=Zq';
const hdhr = { xmltvAllowed: false, guideRequests: 0 };
// The "running" commit the app reports, and what the fake GitHub says is latest.
const RUNNING = 'a'.repeat(40);
const gh = { latest: RUNNING, newer: [], fail: false };
// Extra guide channels served by the fake xmltv.php: [{ id, title-airing-now }].
const eventGuide = [];
// The fake XC account's expiry, and what the fake ntfy/webhook receiver got.
const xcAccount = { exp: 1900000000 };
const notified = [];
// Continuous live streams (XC stream ids 950-959): upstream connections open per id, and made.
const live = { open: new Map(), requests: 0 };

const xmltvTime = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
function guide(ids) {
  const now = Date.now();
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n';
  for (const [id, name] of ids) x += `<channel id="${id}"><display-name>${name}</display-name></channel>\n`;
  for (const [id, name] of ids) {
    for (let h = -1; h < 3; h++) {
      const s = new Date(now + h * 3600_000);
      const e = new Date(now + (h + 1) * 3600_000);
      x += `<programme start="${xmltvTime(s)}" stop="${xmltvTime(e)}" channel="${id}"><title>${name} show ${h}</title><desc>About ${name}</desc></programme>\n`;
    }
  }
  // A stale programme outside the window must be dropped.
  x += `<programme start="20000101000000 +0000" stop="20000101010000 +0000" channel="${ids[0][0]}"><title>Old</title></programme>\n`;
  return x + '</tv>\n';
}

function startUpstream() {
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (u.pathname === '/playlist.m3u') {
      res.writeHead(200, { 'content-type': 'audio/x-mpegurl' });
      return res.end([
        `#EXTM3U url-tvg="${up}/m3u-guide.xml.gz"`,
        '#EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://logo/bbc.png" group-title="UK| GENERAL",BBC One HD',
        `${up}/hls/bbc/index.m3u8`,
        '#EXTINF:-1 tvg-id="" group-title="UK| GENERAL",ITV 1',
        'http://streams/itv.ts',
        '#EXTINF:-1 tvg-id="cnn.us" group-title="US| NEWS",CNN',
        'http://streams/cnn.ts',
        '#EXTINF:-1 group-title="MOVIES",Some Movie',
        'http://h/movie/u/p/5.mp4',
        '#EXTINF:-1 tvg-logo="http://logo/lost.png" group-title="SHOWS",Lost S01 E01',
        'http://h/series/u/p/77.mkv',
        '#EXTINF:-1 group-title="SHOWS",Lost S01 E02',
        'http://h/series/u/p/78.mkv',
      ].join('\n'));
    }
    if (u.pathname === '/m3u-guide.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(zlib.gzipSync(guide([['bbc1.uk', 'BBC One'], ['itv1.uk', 'ITV 1'], ['cnn.us', 'CNN M3U']])));
    }
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'xu' || u.searchParams.get('password') !== 'xp') return json({ user_info: { auth: 0 } });
      const action = u.searchParams.get('action');
      if (!action) return json({ user_info: { auth: 1, status: 'Active', exp_date: String(xcAccount.exp), max_connections: '2' }, server_info: {} });
      if (action === 'get_live_categories') return json(xcCats);
      if (action === 'get_live_streams') return json(xcStreams);
      if (action === 'get_vod_categories') return json(vodData.movieCats);
      if (action === 'get_vod_streams') return json(vodData.movies);
      if (action === 'get_series_categories') return json(vodData.seriesCats);
      if (action === 'get_series') return json(vodData.series);
      if (action === 'get_vod_info') {
        return json({ info: { plot: 'A cop in a tower', tmdb_id: '562' }, movie_data: { stream_id: Number(u.searchParams.get('vod_id')), container_extension: 'mkv' } });
      }
      if (action === 'get_series_info' && u.searchParams.get('series_id') === '7001') {
        return json({
          seasons: [{ season_number: 1, name: 'Season 1' }],
          info: { name: 'Breaking Bad', plot: 'Chemistry teacher' },
          episodes: { 1: [
            { id: '90001', episode_num: 1, title: 'Pilot', container_extension: 'mkv', season: 1, info: { duration: '00:58:00' } },
            { id: '90002', episode_num: 2, title: 'Cat in the Bag', container_extension: 'mkv', season: 1, info: {} },
          ] },
        });
      }
      return json([]);
    }
    if (u.pathname === '/xmltv.php') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      // Event channels whose programme airing now has a chosen title (e.g. "No Game Today").
      // Deliberately appended after the other programmes, like a merged guide: ingest must
      // still match these late <channel> entries.
      const now = Date.now();
      // fromH/toH place the listing in time (default: airing now); channelOnly lists the channel
      // with no programmes at all.
      const events = eventGuide.map(({ id, title, fromH = -1, toH = 1, channelOnly, icon }) =>
        `<channel id="${id}"><display-name>${id}</display-name>${icon ? `<icon src="${icon}"/>` : ''}</channel>\n` +
        (channelOnly ? '' : `<programme start="${xmltvTime(new Date(now + fromH * 3600_000))}" stop="${xmltvTime(new Date(now + toH * 3600_000))}" channel="${id}"><title>${title}</title></programme>\n`)).join('');
      return res.end(guide([['cnn.us', 'CNN'], ['sky.uk', 'Sky Sports'], ['foxnews.us', 'Fox News']]).replace('</tv>', `${events}</tv>`));
    }
    const liveId = /^\/live\/xu\/xp\/(95\d)\.ts$/.exec(u.pathname)?.[1];
    if (liveId) {
      live.requests++;
      live.open.set(liveId, (live.open.get(liveId) || 0) + 1);
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      const timer = setInterval(() => res.write(`chunk-${liveId};`), 20);
      res.on('close', () => {
        clearInterval(timer);
        live.open.set(liveId, live.open.get(liveId) - 1);
      });
      return;
    }
    // Movie and episode files, with Range support like a real server.
    const vodFile = /^\/(movie|series)\/xu\/xp\/(\d+)\.(\w+)$/.exec(u.pathname);
    if (vodFile) {
      const body = Buffer.from(`${vodFile[1].toUpperCase()}-${vodFile[2]}-`.padEnd(100, '.'));
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (range) {
        const from = Number(range[1]);
        const to = range[2] ? Number(range[2]) : body.length - 1;
        res.writeHead(206, { 'content-type': 'video/x-matroska', 'content-range': `bytes ${from}-${to}/${body.length}`, 'accept-ranges': 'bytes', 'content-length': to - from + 1 });
        return res.end(body.subarray(from, to + 1));
      }
      res.writeHead(200, { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': body.length });
      return res.end(body);
    }
    if (u.pathname.startsWith('/live/xu/xp/')) {
      if (req.headers['user-agent'] !== 'TestAgent/1') {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end(`TS-${u.pathname.split('/').pop()}`);
    }
    // A fake ntfy / webhook receiver for alerts.
    if (u.pathname === '/notify') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        notified.push({ title: req.headers.title || null, priority: req.headers.priority || null, type: req.headers['content-type'] || '', body });
        res.writeHead(200);
        res.end('ok');
      });
      return;
    }
    // A fake GitHub API for the update check.
    if (u.pathname.startsWith('/repos/test/repo/')) {
      if (gh.fail) {
        res.writeHead(500);
        return res.end();
      }
      if (u.pathname === '/repos/test/repo/commits/main') {
        return json({ sha: gh.latest, commit: { message: 'Latest change\n\nLonger body', committer: { date: '2026-09-24T12:00:00Z' } } });
      }
      const m = /^\/repos\/test\/repo\/compare\/(\w+)\.\.\.(\w+)$/.exec(u.pathname);
      if (m) {
        if (m[1] !== RUNNING) {
          res.writeHead(404);
          return res.end();
        }
        return json({
          ahead_by: gh.newer.length,
          behind_by: 0,
          commits: gh.newer.map((msg, i) => ({ sha: String(i).repeat(40), commit: { message: msg, committer: { date: '2026-09-2' + i + 'T00:00:00Z' } } })),
        });
      }
    }
    // A fake HDHomeRun box and SiliconDust guide service.
    if (u.pathname === '/hdhr/discover.json') {
      return json({ DeviceID: '1234ABCD', DeviceAuth: HDHR_AUTH, ModelNumber: 'HDFX-4K', TunerCount: 4, FirmwareVersion: '20240101' });
    }
    if (u.pathname === '/hdhr/lineup.json') {
      return json([
        { GuideNumber: '2.1', GuideName: 'WCBS-HD', HD: 1, URL: `${up}/hdhr/auto/v2.1` },
        { GuideNumber: '4.1', GuideName: 'WNBC-HD', HD: 1, URL: `${up}/hdhr/auto/v4.1` },
        { GuideNumber: '13.1', GuideName: 'PREMIUM', DRM: 1, URL: `${up}/hdhr/auto/v13.1` },
      ]);
    }
    if (u.pathname.startsWith('/api/')) {
      if (u.searchParams.get('DeviceAuth') !== HDHR_AUTH) {
        res.writeHead(401);
        return res.end();
      }
      if (u.pathname === '/api/xmltv') {
        if (!hdhr.xmltvAllowed) {
          res.writeHead(403);
          return res.end('subscription required');
        }
        const s = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
        const e = new Date(s.getTime() + 3600_000);
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><tv>
<channel id="US101.hdhomerun.com"><display-name>2.1</display-name><display-name>WCBS</display-name></channel>
<channel id="US102.hdhomerun.com"><display-name>4.1</display-name><display-name>WNBC</display-name></channel>
<programme start="${xmltvTime(s)}" stop="${xmltvTime(e)}" channel="US101.hdhomerun.com"><title>Feed News</title></programme>
<programme start="${xmltvTime(s)}" stop="${xmltvTime(e)}" channel="US102.hdhomerun.com"><title>Feed Movie</title></programme>
</tv>`);
      }
      if (u.pathname === '/api/guide') {
        hdhr.guideRequests++;
        // Each page covers 4 hours from Start, as two 2-hour shows; nothing past 8 hours.
        const anchor = Math.floor(Date.now() / 3600_000) * 3600;
        const start = Math.floor(Number(u.searchParams.get('Start')) / 3600) * 3600;
        if (start >= anchor + 8 * 3600) return json([]);
        const shows = (num, title, filter) => [0, 1].map((i) => ({
          StartTime: start + i * 7200, EndTime: start + (i + 1) * 7200, Title: `${title} ${i}`, EpisodeTitle: 'Pilot',
          Synopsis: `About ${title}`, EpisodeNumber: 'S02E05', Filter: filter, ImageURL: 'http://img/x.jpg',
        }));
        return json([
          { GuideNumber: '2.1', GuideName: 'WCBS', Affiliate: 'CBS', Guide: shows('2.1', 'Evening News', ['News']) },
          { GuideNumber: '4.1', GuideName: 'WNBC', Affiliate: 'NBC', Guide: shows('4.1', 'Big Film', ['Movies']) },
        ]);
      }
    }
    if (u.pathname === '/hls/bbc/index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg1.ts\n');
    }
    if (u.pathname === '/hls/bbc/seg1.ts') {
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end('SEGMENT-1');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => upstream.listen(0, '127.0.0.1', () => {
    up = `http://127.0.0.1:${upstream.address().port}`;
    r();
  }));
}

async function api(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { cookie, 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

before(async () => {
  await startUpstream();
  app = createApp({
    dataDir, adminPassword: PASSWORD, log: () => {}, hdhrApiBase: up,
    updateApiBase: up, updateRepo: 'test/repo', appCommit: RUNNING, updateCheckDelayMs: 1e9,
  });
  const addr = await app.start(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
  await new Promise((r) => upstream.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let m3uId;
let xcId;
let outputId;
let token;

test('admin API requires login and the CSRF header', async () => {
  assert.equal((await api('GET', '/api/sources')).status, 401);
  assert.equal((await api('POST', '/api/login', { password: 'nope' })).status, 401);
  assert.equal((await api('POST', '/api/login', { password: PASSWORD })).status, 200);
  assert.equal((await api('GET', '/api/sources')).status, 200);
  const res = await fetch(`${base}/api/outputs`, { method: 'POST', headers: { cookie } });
  assert.equal(res.status, 403);
});

test('M3U source: parses, skips VOD, auto-associates the header EPG', async () => {
  const r = await api('POST', '/api/sources', { name: 'M3U', type: 'm3u', url: `${up}/playlist.m3u` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  m3uId = r.data.id;
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${m3uId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.counts.channels, 3);
  assert.equal(s.counts.categories, 2);
  // bbc1.uk by tvg-id, ITV 1 by name, cnn.us by tvg-id
  assert.equal(s.counts.epg_matched, 3);
  const chans = (await api('GET', `/api/sources/${m3uId}/channels`)).data.items;
  assert.equal(chans.find((c) => c.name === 'ITV 1').epg_match, 'name');
});

test('Xtream Codes source: categories, streams, account info and EPG', async () => {
  const r = await api('POST', '/api/sources', {
    name: 'XC', type: 'xc', xc_host: up, xc_username: 'xu', xc_password: 'xp', user_agent: 'TestAgent/1',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  xcId = r.data.id;
  assert.equal(r.data.xc_password, '', 'password is never echoed');
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${xcId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.counts.channels, 4);
  assert.equal(s.counts.categories, 3);
  assert.equal(s.account_info.max_connections, '2');
  assert.equal(s.counts.epg_matched, 3); // cnn.us, sky.uk by id; Fox News by name
});

test('bad XC credentials produce an error status without wiping data', async () => {
  const bad = await api('POST', '/api/sources', { name: 'Bad', type: 'xc', xc_host: up, xc_username: 'no', xc_password: 'no' });
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${bad.data.id}`)).data;
  assert.equal(s.last_status, 'error');
  assert.match(s.last_error, /rejected/);
  await api('DELETE', `/api/sources/${bad.data.id}`);
});

test('output with rules across two sources', async () => {
  const o = await api('POST', '/api/outputs', { name: 'Family' });
  assert.equal(o.status, 201);
  outputId = o.data.id;
  token = o.data.token;
  const r = await api('PUT', `/api/outputs/${outputId}`, {
    source_ids: [xcId, m3uId],
    stream_mode: 'proxy',
    number_start: 100,
    xc_enabled: true,
    xc_username: 'family',
    xc_password: 'pw123',
    rules: [
      { action: 'include', op: 'starts_with', value: 'us|' },
      { action: 'include', op: 'contains', value: 'general', source_id: m3uId },
      { action: 'exclude', op: 'contains', value: 'adult' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const state = Object.fromEntries(cats.map((c) => [`${c.source_id}:${c.name}`, c.included]));
  assert.deepEqual(state, {
    [`${xcId}:US| NEWS`]: true,
    [`${xcId}:US| ADULT`]: false,
    [`${xcId}:UK| SPORTS`]: false,
    [`${m3uId}:UK| GENERAL`]: true,
    [`${m3uId}:US| NEWS`]: true,
  });
});

test('M3U output: order, numbering, proxied URLs and EPG link', async () => {
  const res = await fetch(`${base}/o/${token}/playlist.m3u`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const names = [...text.matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(names, ['US: CNN HD', 'US: Fox News', 'BBC One HD', 'ITV 1', 'CNN']);
  assert.match(text, /^#EXTM3U url-tvg="http:\/\/127\.0\.0\.1:\d+\/o\/[^/]+\/epg\.xml"/);
  assert.match(text, /tvg-chno="100"[^\n]*,US: CNN HD/);
  assert.match(text, /tvg-chno="104"[^\n]*,CNN/);
  // cnn.us exists in both sources: the second gets a source-scoped id.
  assert.match(text, /tvg-id="cnn\.us"[^\n]*,US: CNN HD/);
  assert.match(text, new RegExp(`tvg-id="cnn\\.us\\.s${m3uId}"[^\\n]*,CNN`));
  assert.ok(!text.includes('xu/xp'), 'provider credentials must not leak in proxy mode');
  assert.equal((await fetch(`${base}/o/nottoken/playlist.m3u`)).status, 404);
});

test('EPG output contains only selected channels, in window, with renamed ids', async () => {
  const res = await fetch(`${base}/o/${token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } });
  assert.equal(res.status, 200);
  const xml = await res.text();
  const channelIds = [...xml.matchAll(/<channel id="([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(channelIds, ['bbc1.uk', 'cnn.us', `cnn.us.s${m3uId}`, 'foxnews.us', 'itv1.uk'].sort());
  assert.ok(!xml.includes('sky.uk'));
  assert.ok(!xml.includes('>Old<'), 'stale programmes are dropped');
  assert.match(xml, new RegExp(`channel="cnn\\.us\\.s${m3uId}"><title>CNN M3U show 0</title>`));
  assert.match(xml, /channel="cnn\.us"><title>CNN show 0<\/title>/);
  const gz = await fetch(`${base}/o/${token}/epg.xml.gz`);
  assert.equal(zlib.gunzipSync(Buffer.from(await gz.arrayBuffer())).toString(), xml);
});

test('Jellyfin categories on a group tag every programme of its channels, and only those', async () => {
  const cats = (await api('GET', `/api/sources/${xcId}/categories`)).data;
  const news = cats.find((c) => c.name === 'US| NEWS');
  assert.equal((await api('PUT', `/api/categories/${news.id}`, { jellyfin: ['Sports'] })).status, 200);
  assert.equal((await api('PUT', `/api/categories/${news.id}`, { jellyfin: ['Cartoons'] })).status, 400);
  // Partial update: changing the name keeps the tag, and vice versa.
  await api('PUT', `/api/categories/${news.id}`, { custom_name: 'US News' });
  const r = await api('PUT', `/api/categories/${news.id}`, { jellyfin: ['news', 'Kids'] });
  assert.deepEqual(r.data, { ok: true, custom_name: 'US News', jellyfin: ['News', 'Kids'] });

  const xml = await (await fetch(`${base}/o/${token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  const programmes = (id) => [...xml.matchAll(new RegExp(`<programme [^>]*channel="${id.replace(/\./g, '\\.')}">(.*?)</programme>`, 'g'))].map((m) => m[1]);
  const tagged = [...programmes('cnn.us'), ...programmes('foxnews.us')];
  assert.ok(tagged.length >= 6);
  for (const p of tagged) {
    assert.match(p, /<\/desc><category lang="en">News<\/category><category lang="en">Kids<\/category>$/);
  }
  // Same group name from the M3U source is a different group: untouched.
  for (const p of [...programmes(`cnn.us.s${m3uId}`), ...programmes('bbc1.uk')]) assert.doesNotMatch(p, /<category/);

  const m3u = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.match(m3u, /group-title="US News",US: CNN HD/);
  await api('PUT', `/api/categories/${news.id}`, { custom_name: '' });
});

test('proxy mode relays TS with the source user agent and rewrites HLS', async () => {
  const text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  const cnn = text.split('\n').find((l) => /\/s\/.+\.ts$/.test(l));
  const ts = await fetch(cnn);
  assert.equal(ts.status, 200);
  assert.equal(await ts.text(), 'TS-101.ts');

  const hlsUrl = text.split('\n').find((l) => l.endsWith('.m3u8'));
  const playlist = await (await fetch(hlsUrl)).text();
  const seg = playlist.split('\n').find((l) => l.startsWith('/s/'));
  assert.ok(seg, playlist);
  assert.equal(await (await fetch(base + seg)).text(), 'SEGMENT-1');
  assert.equal((await fetch(base + seg.replace(/sig=.*/, 'sig=forged'))).status, 403);
});

test('Xtream Codes output API', async () => {
  const q = (action, extra = '') => fetch(`${base}/player_api.php?username=family&password=pw123&action=${action}${extra}`).then((r) => r.json());
  const info = await (await fetch(`${base}/player_api.php?username=family&password=pw123`)).json();
  assert.equal(info.user_info.auth, 1);
  assert.equal((await (await fetch(`${base}/player_api.php?username=family&password=wrong`)).json()).user_info.auth, 0);
  const cats = await q('get_live_categories');
  assert.deepEqual(cats.map((c) => c.category_name), ['US| NEWS', 'UK| GENERAL', 'US| NEWS']);
  const streams = await q('get_live_streams');
  assert.equal(streams.length, 5);
  const inCat = await q('get_live_streams', `&category_id=${cats[1].category_id}`);
  assert.deepEqual(inCat.map((s) => s.name), ['BBC One HD', 'ITV 1']);
  assert.deepEqual(await q('get_vod_streams'), []);
  const epg = await q('get_short_epg', `&stream_id=${streams[0].stream_id}&limit=2`);
  assert.equal(epg.epg_listings.length, 2);
  assert.equal(Buffer.from(epg.epg_listings[0].title, 'base64').toString(), 'CNN show 0');
  assert.equal(Buffer.from(epg.epg_listings[0].description, 'base64').toString(), 'About CNN');
  const live = await fetch(`${base}/live/family/pw123/${streams[0].stream_id}.ts`);
  assert.equal(await live.text(), 'TS-101.ts');
  assert.equal((await fetch(`${base}/live/family/bad/${streams[0].stream_id}.ts`)).status, 401);
  const m3u = await (await fetch(`${base}/get.php?username=family&password=pw123&type=m3u_plus`)).text();
  assert.match(m3u, /\/live\/family\/pw123\/\d+\.ts/);
});

test('new upstream categories that match rules join automatically; manual overrides stick', async () => {
  xcCats.push({ category_id: '13', category_name: 'US| SPORTS' }, { category_id: '14', category_name: 'FR| INFO' });
  xcStreams.push(
    { num: 5, name: 'US: ESPN', stream_id: 105, epg_channel_id: '', category_id: '13' },
    { num: 6, name: 'France 24', stream_id: 106, epg_channel_id: '', category_id: '14' },
  );
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const sports = cats.find((c) => c.name === 'US| SPORTS');
  const fr = cats.find((c) => c.name === 'FR| INFO');
  assert.equal(sports.included, true);
  assert.equal(sports.is_new, true);
  assert.equal(fr.included, false);
  assert.equal(fr.is_new, true);

  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [sports.id], state: 'exclude' });
  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [fr.id], state: 'include' });
  let text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.ok(!text.includes('US: ESPN'));
  assert.ok(text.includes('France 24'));

  // Survives another refresh.
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.ok(!text.includes('US: ESPN'));
  assert.ok(text.includes('France 24'));
});

test('channel edits and per-output channel overrides', async () => {
  const chans = (await api('GET', `/api/sources/${m3uId}/channels?q=ITV`)).data.items;
  const itv = chans[0];
  const r = await api('PUT', `/api/channels/${itv.id}`, { custom_name: 'ITV One', custom_logo: 'http://logo/itv.png' });
  assert.equal(r.status, 200);
  const bbc = (await api('GET', `/api/sources/${m3uId}/channels?q=BBC`)).data.items[0];
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [bbc.id], state: 'exclude' });
  const text = await (await fetch(`${base}/o/${token}/playlist.m3u`)).text();
  assert.match(text, /tvg-logo="http:\/\/logo\/itv\.png"[^\n]*,ITV One/);
  assert.ok(!text.includes('BBC One'));
});

test('channel rules inside one category; manual channel picks still win', async () => {
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const news = cats.find((c) => c.name === 'US| NEWS' && c.source_id === xcId);
  const names = async () => [...(await (await fetch(`${base}/o/${token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);

  assert.equal((await api('PUT', `/api/outputs/${outputId}/categories/${news.id}/channel-rules`, { rules: [{ action: 'exclude', op: 'wat', value: 'x' }] })).status, 400);
  await api('PUT', `/api/outputs/${outputId}/categories/${news.id}/channel-rules`, { rules: [{ action: 'exclude', op: 'contains', value: 'fox' }] });
  let list = await names();
  assert.ok(list.includes('US: CNN HD') && !list.includes('US: Fox News'));
  // The M3U source's "US| NEWS" is a different category and is untouched.
  assert.ok(list.includes('CNN'));

  const view = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${news.id}`)).data;
  assert.deepEqual(view.rules.map((r) => [r.action, r.op, r.value]), [['exclude', 'contains', 'fox']]);
  const fox = view.channels.find((c) => c.name === 'US: Fox News');
  assert.deepEqual([fox.included, fox.reason], [false, 'rule']);

  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [fox.id], state: 'include' });
  assert.ok((await names()).includes('US: Fox News'), 'manual include beats the rule');
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [fox.id], state: null });

  await api('PUT', `/api/outputs/${outputId}/categories/${news.id}/channel-rules`, { rules: [{ action: 'include', op: 'starts_with', value: 'us: cnn' }] });
  list = await names();
  assert.ok(list.includes('US: CNN HD') && !list.includes('US: Fox News'));
  const cnn = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${news.id}`)).data.channels.find((c) => c.name === 'US: CNN HD');
  assert.equal(cnn.reason, 'rule');
});

test('find a channel across an output: every attached source, with its state and why', async () => {
  const find = async (q) => (await api('GET', `/api/outputs/${outputId}/search?q=${encodeURIComponent(q)}`)).data;
  const cats = new Map((await api('GET', `/api/outputs/${outputId}/categories`)).data.map((c) => [c.id, c]));
  const brief = (r) => r.matches.map((m) => [m.name, cats.get(m.category_id).source_id === xcId ? 'xc' : 'm3u', m.included, m.reason]);

  // Case-insensitive, from both sources; the XC news category still has 'starts with "us: cnn"'.
  let r = await find('CnN');
  assert.deepEqual(brief(r).sort(), [['CNN', 'm3u', true, 'category'], ['US: CNN HD', 'xc', true, 'rule']]);
  assert.equal(r.total, 2);
  r = await find('fox news');
  assert.deepEqual(brief(r).filter((m) => m[1] === 'xc'), [['US: Fox News', 'xc', false, 'nomatch']]);
  r = await find('sky sports');
  assert.deepEqual(brief(r), [['UK: Sky Sports', 'xc', false, 'category']], 'channels of excluded categories are found too');
  assert.deepEqual(await find('c'), { matches: [], total: 0 }, 'two characters at least');
  assert.deepEqual((await find('no such channel zz')).matches, []);
  assert.equal((await api('GET', '/api/outputs/99999/search?q=cnn')).status, 404);
});

test('an excluded category excludes its channels even if picked by hand; picks return when included', async () => {
  const cats = (await api('GET', `/api/outputs/${outputId}/categories`)).data;
  const uk = cats.find((c) => c.name === 'UK| SPORTS' && c.source_id === xcId);
  assert.equal(uk.included, false);
  const sky = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${uk.id}`)).data.channels[0];
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [sky.id], state: 'include' });
  const has = async () => (await (await fetch(`${base}/o/${token}/playlist.m3u`)).text()).includes('UK: Sky Sports');
  assert.equal(await has(), false, 'a hand pick cannot pull a channel out of an excluded category');
  const view = (await api('GET', `/api/outputs/${outputId}/channels?category_id=${uk.id}`)).data;
  assert.deepEqual([view.category_included, view.channels[0].included, view.channels[0].override], [false, false, 'include']);

  // Include the category, but exclude its channel by hand: the stored pick applies again.
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [sky.id], state: 'exclude' });
  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [uk.id], state: 'include' });
  assert.equal(await has(), false);
  await api('PUT', `/api/outputs/${outputId}/channels`, { ids: [sky.id], state: null });
  assert.equal(await has(), true);
  await api('PUT', `/api/outputs/${outputId}/categories`, { ids: [uk.id], state: null });
});

test('ends with / does not end with, for categories and channels', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Endings' })).data;
  const r = await api('PUT', `/api/outputs/${o.id}`, {
    source_ids: [xcId],
    rules: [{ action: 'include', op: 'ends_with', value: 'news' }, { action: 'exclude', op: 'not_ends_with', value: 's' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cats = (await api('GET', `/api/outputs/${o.id}/categories`)).data;
  assert.deepEqual(cats.filter((c) => c.included).map((c) => c.name), ['US| NEWS']);

  const news = cats.find((c) => c.name === 'US| NEWS');
  await api('PUT', `/api/outputs/${o.id}/categories/${news.id}/channel-rules`, { rules: [{ action: 'exclude', op: 'not_ends_with', value: ' hd' }] });
  const names = [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(names, ['US: CNN HD']);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('a second output with different criteria and direct mode', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Sports' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'sports' }] });
  const text = await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text();
  const names = [...text.matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(names, ['UK: Sky Sports', 'US: ESPN']);
  assert.match(text, /\/live\/xu\/xp\/104\.ts/, 'direct mode hands out provider URLs');
  const list = (await api('GET', '/api/outputs')).data;
  assert.equal(list.length, 2);
});

test('an empty upstream response keeps the previous channels', async () => {
  const saved = xcStreams.splice(0);
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  xcStreams.push(...saved);
  const s = (await api('GET', `/api/sources/${xcId}`)).data;
  assert.equal(s.last_status, 'error');
  assert.equal(s.counts.channels, 6);
});

test('export, then import into a fresh instance, reproduces every output', async () => {
  const full = (await api('GET', '/api/export')).data;
  assert.equal(full.format, 'iptv-manager-settings');
  assert.equal(full.sources.find((s) => s.type === 'xc').xc_password, 'xp');
  const bare = (await api('GET', '/api/export?secrets=0')).data;
  assert.equal(bare.sources.find((s) => s.type === 'xc').xc_password, null);
  assert.equal(bare.outputs.find((o) => o.xc_username === 'family').xc_password, null);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-import-'));
  const app2 = createApp({ dataDir: dir2, adminPassword: PASSWORD, log: () => {} });
  const base2 = `http://127.0.0.1:${(await app2.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${base2}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie2 = login.headers.get('set-cookie').split(';')[0];
    const post = (body) => fetch(`${base2}/api/import`, {
      method: 'POST', headers: { cookie: cookie2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body),
    });
    assert.equal((await post({ format: 'something-else' })).status, 400);
    const r = await post(full);
    assert.equal(r.status, 200, await r.clone().text());
    assert.deepEqual(await r.json(), { ok: true, sources: 2, outputs: 2 });
    await app2.ctx.jobs.idle();

    // Same tokens, same lineups: names, groups, logos, numbering, tvg ids, category and channel picks.
    const norm = (text, b) => text.split(b).join('BASE').replace(/\/s\/([^/]+)\/\d+\./g, '/s/$1/N.');
    for (const o of full.outputs) {
      const before = norm(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text(), base);
      const after = norm(await (await fetch(`${base2}/o/${o.token}/playlist.m3u`)).text(), base2);
      assert.equal(after, before, `output "${o.name}" differs after import`);
    }
    const xml = await (await fetch(`${base2}/o/${token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
    assert.match(xml, /<category lang="en">Kids<\/category>/, 'Jellyfin tags survive the round trip');
    const info = await (await fetch(`${base2}/player_api.php?username=family&password=pw123`)).json();
    assert.equal(info.user_info.auth, 1);
    // New categories seen for the first time on the imported instance are not flagged "new".
    const cats = await (await fetch(`${base2}/api/sources`, { headers: { cookie: cookie2 } })).json();
    assert.equal(cats.length, 2);
  } finally {
    await app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

let hdhrId;
let hdhrToken;

test('HDHomeRun: lineup from the box, guide from the free JSON service when the XMLTV feed is refused', async () => {
  assert.equal((await api('POST', '/api/sources', { name: 'Antenna', type: 'hdhr' })).status, 400);
  assert.equal((await api('POST', '/api/sources', { name: 'Antenna', type: 'hdhr', hdhr_host: 'http://x/y?z' })).status, 400);
  const r = await api('POST', '/api/sources', { name: 'Antenna', type: 'hdhr', hdhr_host: `${up}/hdhr` });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  hdhrId = r.data.id;
  await app.ctx.jobs.idle();

  const s = (await api('GET', `/api/sources/${hdhrId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.counts.channels, 3);
  assert.equal(s.counts.categories, 2); // HDHomeRun + HDHomeRun (DRM)
  assert.equal(s.counts.epg_matched, 2); // 13.1 has no listings
  assert.equal(s.account_info.model, 'HDFX-4K');
  assert.equal(s.account_info.tuners, 4);
  assert.match(s.stats.epg.hdhr, /guide service .*XMLTV feed unavailable: HTTP 403/);
  assert.ok(!JSON.stringify(s).includes(HDHR_AUTH), 'DeviceAuth never lands in stored status');
  assert.ok(hdhr.guideRequests >= 2, 'the JSON guide is paged through time');
  assert.equal(s.stats.epg.programmes, 8); // 2 channels x 8 hours of 2-hour shows

  const o = (await api('POST', '/api/outputs', { name: 'OTA' })).data;
  hdhrToken = o.token;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [hdhrId], include_all: true });
  const m3u = await (await fetch(`${base}/o/${hdhrToken}/playlist.m3u`)).text();
  // Names keep the tuner number so channels sharing a call sign stay distinguishable.
  assert.match(m3u, new RegExp(`tvg-id="2\\.1" tvg-name="2\\.1 WCBS-HD"[^\\n]*tvg-chno="2\\.1" group-title="HDHomeRun",2\\.1 WCBS-HD\\n${up.replace(/\./g, '\\.')}/hdhr/auto/v2\\.1`));
  assert.match(m3u, /group-title="HDHomeRun \(DRM\)",13\.1 PREMIUM/);

  const xml = await (await fetch(`${base}/o/${hdhrToken}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  const film = /<programme [^>]*channel="4\.1">(.*?)<\/programme>/.exec(xml)[1];
  assert.match(film, /<title>Big Film 0<\/title><sub-title>Pilot<\/sub-title><desc>About Big Film<\/desc>/);
  // The service says "Movies"; Jellyfin needs "Movie" too.
  assert.match(film, /<category lang="en">Movies<\/category><category lang="en">Movie<\/category>/);
  assert.match(film, /<episode-num system="xmltv_ns">1\.4\.<\/episode-num><episode-num system="onscreen">S02E05<\/episode-num>/);
  assert.match(xml, /<channel id="2\.1"><display-name>2\.1 WCBS-HD<\/display-name>/);
});

test('HDHomeRun: the XMLTV feed is used when available, matched to tuner numbers', async () => {
  hdhr.xmltvAllowed = true;
  const before = hdhr.guideRequests;
  await api('POST', `/api/sources/${hdhrId}/refresh`);
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${hdhrId}`)).data;
  assert.equal(s.last_status, 'ok', s.last_error);
  assert.equal(s.stats.epg.hdhr, 'SiliconDust XMLTV feed');
  assert.equal(hdhr.guideRequests, before, 'no JSON fallback needed');
  // Feed channel ids are opaque; the tuner number is one of their display names.
  assert.equal(s.counts.epg_matched, 2);
  const xml = await (await fetch(`${base}/o/${hdhrToken}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  assert.match(xml, /channel="2\.1"><title>Feed News<\/title>/);
  assert.match(xml, /channel="4\.1"><title>Feed Movie<\/title>/);
});

test('HDHomeRun: an unreachable box is a clear error and keeps the last lineup', async () => {
  await api('PUT', `/api/sources/${hdhrId}`, { name: 'Antenna', hdhr_host: '127.0.0.1:9' });
  await app.ctx.jobs.idle();
  const s = (await api('GET', `/api/sources/${hdhrId}`)).data;
  assert.equal(s.last_status, 'error');
  assert.match(s.last_error, /No HDHomeRun answered at http:\/\/127\.0\.0\.1:9/);
  assert.equal(s.counts.channels, 3);
});

test('hide empty event channels: per-category toggle, editable patterns, backup round trip', async () => {
  xcCats.push({ category_id: '20', category_name: 'US| ESPN+ EVENTS' });
  const events = ['ESPN+ 01:', 'ESPN+ 02: Lakers vs Celtics', 'ESPN+ 03 -', 'ESPN+ 04', 'ESPN+ 05 NO EVENT', 'ESPN+ 06: Bills - Jets'];
  events.forEach((name, i) => xcStreams.push({ num: 50 + i, name, stream_id: 500 + i, epg_channel_id: '', category_id: '20' }));
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();

  const o = (await api('POST', '/api/outputs', { name: 'Events' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'espn+' }] });
  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| ESPN+ EVENTS');
  const names = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.equal((await names()).length, 6, 'off by default');

  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_empty: true });
  assert.deepEqual(await names(), ['ESPN+ 02: Lakers vs Celtics', 'ESPN+ 06: Bills - Jets']);
  const view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.equal(view.hide_empty, true);
  assert.deepEqual(view.channels.filter((c) => c.reason === 'empty').map((c) => c.name), ['ESPN+ 01:', 'ESPN+ 03 -', 'ESPN+ 04', 'ESPN+ 05 NO EVENT']);

  // A hand pick still wins over the toggle.
  const idle = view.channels.find((c) => c.name === 'ESPN+ 04');
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [idle.id], state: 'include' });
  assert.ok((await names()).includes('ESPN+ 04'));
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [idle.id], state: null });

  // Edit the patterns: drop "ends with a number", keep the rest.
  assert.equal((await api('PUT', '/api/settings', { empty_event_patterns: ['('] })).status, 400);
  const s = await api('PUT', '/api/settings', { empty_event_patterns: [':\\s*$', '-\\s*$', 'no event\\s*$'] });
  assert.equal(s.status, 200);
  assert.deepEqual(await names(), ['ESPN+ 02: Lakers vs Celtics', 'ESPN+ 04', 'ESPN+ 06: Bills - Jets']);
  const settings = (await api('GET', '/api/settings')).data;
  assert.equal(settings.empty_event_patterns.length, 3);
  assert.equal(settings.base_url, '', 'saving patterns leaves other settings alone');

  // Export keeps both the custom patterns and the toggle; a fresh instance reproduces the output.
  const exported = (await api('GET', '/api/export')).data;
  assert.deepEqual(exported.settings.empty_event_patterns, [':\\s*$', '-\\s*$', 'no event\\s*$']);
  assert.deepEqual(exported.outputs.find((x) => x.token === o.token).category_options, [{ source: xcId, category: 'US| ESPN+ EVENTS', hide_empty: true, hide_by_guide: false, hide_unlisted: false }]);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-import2-'));
  const app2 = createApp({ dataDir: dir2, adminPassword: PASSWORD, log: () => {} });
  const base2 = `http://127.0.0.1:${(await app2.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${base2}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie2 = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base2}/api/import`, { method: 'POST', headers: { cookie: cookie2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(exported) });
    assert.equal(r.status, 200, await r.clone().text());
    await app2.ctx.jobs.idle();
    const after = [...(await (await fetch(`${base2}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
    assert.deepEqual(after, await names());
  } finally {
    await app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // null restores the defaults.
  await api('PUT', '/api/settings', { empty_event_patterns: null });
  assert.deepEqual(await names(), ['ESPN+ 02: Lakers vs Celtics', 'ESPN+ 06: Bills - Jets']);
});

test('export/import of empty-event settings: defaults, empty list, old files, bad files', async () => {
  // A fresh instance to import into, reset for each case.
  const fresh = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-ee-'));
    const a = createApp({ dataDir: dir, adminPassword: PASSWORD, log: () => {} });
    const b = `http://127.0.0.1:${(await a.start(0, '127.0.0.1')).port}`;
    const login = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie2 = login.headers.get('set-cookie').split(';')[0];
    const call = async (method, p, body) => {
      const r = await fetch(b + p, { method, headers: { cookie: cookie2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: body && JSON.stringify(body) });
      return { status: r.status, data: await r.json() };
    };
    return { a, b, call, close: async () => { await a.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  };
  const names = async (b, tok) => [...(await (await fetch(`${b}/o/${tok}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);

  // 1. Defaults export as null, so a restore follows the built-in defaults.
  await api('PUT', '/api/settings', { empty_event_patterns: null });
  let file = (await api('GET', '/api/export')).data;
  assert.equal(file.settings.empty_event_patterns, null);
  const events = file.outputs.find((o) => o.name === 'Events');
  assert.deepEqual(events.category_options, [{ source: xcId, category: 'US| ESPN+ EVENTS', hide_empty: true, hide_by_guide: false, hide_unlisted: false }]);

  // 2. The toggle's category does not exist on the new instance until its first refresh;
  //    the import creates it as a placeholder and the toggle applies once channels arrive.
  let t = await fresh();
  try {
    const custom = await t.call('PUT', '/api/settings', { empty_event_patterns: ['x$'] });
    assert.equal(custom.status, 200);
    assert.equal((await t.call('POST', '/api/import', file)).status, 200);
    await t.a.ctx.jobs.idle();
    assert.equal((await t.call('GET', '/api/settings')).data.empty_event_patterns.length, 4, 'defaults restored over the custom list');
    assert.deepEqual(await names(t.b, events.token), ['ESPN+ 02: Lakers vs Celtics', 'ESPN+ 06: Bills - Jets']);
  } finally {
    await t.close();
  }

  // 3. An empty list round-trips as "no patterns": the toggle then hides nothing.
  await api('PUT', '/api/settings', { empty_event_patterns: [] });
  file = (await api('GET', '/api/export')).data;
  assert.deepEqual(file.settings.empty_event_patterns, []);
  t = await fresh();
  try {
    assert.equal((await t.call('POST', '/api/import', file)).status, 200);
    await t.a.ctx.jobs.idle();
    assert.deepEqual((await t.call('GET', '/api/settings')).data.empty_event_patterns, []);
    assert.equal((await names(t.b, events.token)).length, 6);
  } finally {
    await t.close();
    await api('PUT', '/api/settings', { empty_event_patterns: null });
  }

  // 4. A file from before these settings existed restores the defaults, and toggles are simply off.
  const old = JSON.parse(JSON.stringify(file));
  delete old.settings.empty_event_patterns;
  for (const o of old.outputs) delete o.category_options;
  t = await fresh();
  try {
    await t.call('PUT', '/api/settings', { empty_event_patterns: ['x$'] });
    assert.equal((await t.call('POST', '/api/import', old)).status, 200);
    await t.a.ctx.jobs.idle();
    assert.equal((await t.call('GET', '/api/settings')).data.empty_event_patterns.length, 4);
    assert.equal((await names(t.b, events.token)).length, 6);
  } finally {
    await t.close();
  }

  // 5. Bad files are rejected before anything is replaced.
  t = await fresh();
  try {
    const bad1 = { ...file, settings: { ...file.settings, empty_event_patterns: ['('] } };
    const bad2 = JSON.parse(JSON.stringify(file));
    bad2.outputs[0].category_options = [{ source: 999, category: 'X', hide_empty: true }];
    for (const bad of [bad1, bad2]) {
      const r = await t.call('POST', '/api/import', bad);
      assert.equal(r.status, 400, JSON.stringify(r.data));
      assert.match(r.data.error, /Invalid settings file/);
    }
    assert.equal((await t.call('GET', '/api/outputs')).data.length, 0, 'nothing imported');
  } finally {
    await t.close();
  }
});

test('hide channels by guide: title airing now, separate from the name toggle, clock-driven, backed up', async () => {
  xcCats.push({ category_id: '30', category_name: 'US| NFL SUNDAY' });
  xcStreams.push(
    { num: 70, name: 'NFL 01', stream_id: 700, epg_channel_id: 'nfl1', category_id: '30' },
    { num: 71, name: 'NFL 02', stream_id: 701, epg_channel_id: 'nfl2', category_id: '30' },
    { num: 72, name: 'NFL 03', stream_id: 702, epg_channel_id: '', category_id: '30' }, // no guide at all
    { num: 73, name: 'NFL 04', stream_id: 703, epg_channel_id: 'nfl4', category_id: '30' },
  );
  eventGuide.push({ id: 'nfl1', title: 'No Game Today' }, { id: 'nfl2', title: 'Bills at Jets' }, { id: 'nfl4', title: 'Off Air' });
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();

  const o = (await api('POST', '/api/outputs', { name: 'NFL' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'nfl' }] });
  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| NFL SUNDAY');
  const names = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  assert.deepEqual(await names(), ['NFL 01', 'NFL 02', 'NFL 03', 'NFL 04'], 'off by default');

  // The panel shows what is on now even before the toggle is on.
  let view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual(view.channels.map((c) => [c.name, c.now_title, c.is_guide_placeholder]),
    [['NFL 01', 'No Game Today', true], ['NFL 02', 'Bills at Jets', false], ['NFL 03', null, false], ['NFL 04', 'Off Air', true]]);

  // Separate toggle: guide on, names off (these names end in numbers, which the name toggle would hide).
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_by_guide: true });
  assert.deepEqual(await names(), ['NFL 02', 'NFL 03'], 'placeholders hidden; no listing means not hidden');
  view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual([view.hide_by_guide, view.hide_empty], [true, false]);
  assert.equal(view.channels.find((c) => c.name === 'NFL 01').reason, 'guide');
  const xml = await (await fetch(`${base}/o/${o.token}/epg.xml`, { headers: { 'accept-encoding': 'identity' } })).text();
  assert.ok(!xml.includes('channel="nfl1"') && xml.includes('channel="nfl2"'), 'the guide output follows the playlist');

  // Turning on the name toggle too does not undo the guide one (partial update of options).
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_empty: true });
  assert.deepEqual(await names(), []);
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_empty: false });

  // The clock: once the placeholder's slot has ended, the channel returns without any refresh.
  const src = app.ctx.db.get('SELECT epg_gen FROM sources WHERE id = ?', [xcId]);
  const t = Math.floor(Date.now() / 1000);
  app.ctx.db.run('UPDATE programmes SET stop_ts = ? WHERE source_id = ? AND gen = ? AND channel = ?', [t - 1, xcId, src.epg_gen, 'nfl1']);
  app.ctx.bump(); // stands in for the one-minute cache expiring
  assert.deepEqual(await names(), ['NFL 01', 'NFL 02', 'NFL 03']);

  // Hand picks win; custom patterns apply; settings are partial.
  const nfl4 = view.channels.find((c) => c.name === 'NFL 04');
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [nfl4.id], state: 'include' });
  assert.ok((await names()).includes('NFL 04'));
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [nfl4.id], state: null });
  assert.equal((await api('PUT', '/api/settings', { guide_patterns: ['['] })).status, 400);
  await api('PUT', '/api/settings', { guide_patterns: ['^bills'] });
  assert.deepEqual(await names(), ['NFL 01', 'NFL 03', 'NFL 04']);
  const s = (await api('GET', '/api/settings')).data;
  assert.deepEqual([s.guide_patterns, s.empty_event_patterns.length], [['^bills'], 4]);

  // Backup: guide patterns and the toggle travel with the export.
  const file = (await api('GET', '/api/export')).data;
  assert.deepEqual(file.settings.guide_patterns, ['^bills']);
  assert.deepEqual(file.outputs.find((x) => x.token === o.token).category_options,
    [{ source: xcId, category: 'US| NFL SUNDAY', hide_empty: false, hide_by_guide: true, hide_unlisted: false }]);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-guide-'));
  const app2 = createApp({ dataDir: dir2, adminPassword: PASSWORD, log: () => {} });
  const base2 = `http://127.0.0.1:${(await app2.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${base2}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const c2 = login.headers.get('set-cookie').split(';')[0];
    const r = await fetch(`${base2}/api/import`, { method: 'POST', headers: { cookie: c2, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(file) });
    assert.equal(r.status, 200, await r.clone().text());
    await app2.ctx.jobs.idle();
    // Fresh guide data on the new instance: nfl2 ("Bills at Jets") matches ^bills and is hidden.
    const after = [...(await (await fetch(`${base2}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
    assert.deepEqual(after, ['NFL 01', 'NFL 03', 'NFL 04']);
  } finally {
    await app2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  await api('PUT', '/api/settings', { guide_patterns: null });
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('hide channels with nothing listed now: sub-option of the guide toggle, with a stale-guide safety net', async () => {
  xcCats.push({ category_id: '31', category_name: 'US| NBA LEAGUE PASS' });
  xcStreams.push(
    { num: 80, name: 'NBA 01', stream_id: 800, epg_channel_id: 'nba1', category_id: '31' }, // game on now
    { num: 81, name: 'NBA 02', stream_id: 801, epg_channel_id: 'nba2', category_id: '31' }, // game later tonight
    { num: 82, name: 'NBA 03', stream_id: 802, epg_channel_id: 'nba3', category_id: '31' }, // listed, no programmes
    { num: 83, name: 'NBA 04', stream_id: 803, epg_channel_id: 'nba4', category_id: '31' }, // guide id unknown to the guide
    { num: 84, name: 'NBA 05', stream_id: 804, epg_channel_id: '', category_id: '31' }, // no guide id at all
    { num: 85, name: 'NBA 06', stream_id: 805, epg_channel_id: 'nba6', category_id: '31' }, // blank title now
  );
  eventGuide.push(
    { id: 'nba1', title: 'Lakers at Celtics' },
    { id: 'nba2', title: 'Knicks at Heat', fromH: 2, toH: 4 },
    { id: 'nba3', channelOnly: true },
    { id: 'nba6', title: '' },
  );
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();

  const o = (await api('POST', '/api/outputs', { name: 'NBA' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'contains', value: 'nba' }] });
  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| NBA LEAGUE PASS');
  const names = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).matchAll(/,([^\n]+)\n/g)].map((m) => m[1]);
  const all = ['NBA 01', 'NBA 02', 'NBA 03', 'NBA 04', 'NBA 05', 'NBA 06'];

  // The sub-option does nothing without the guide toggle, and the guide toggle alone hides nothing here.
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_unlisted: true });
  assert.deepEqual(await names(), all);
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_by_guide: true, hide_unlisted: false });
  assert.deepEqual(await names(), all);

  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/options`, { hide_unlisted: true });
  assert.deepEqual(await names(), ['NBA 01', 'NBA 05'], 'only the game on now and the channel with no guide id stay');
  const view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual([view.hide_by_guide, view.hide_unlisted, view.guide_current], [true, true, true]);
  assert.deepEqual(view.channels.map((c) => [c.name, c.is_unlisted, c.reason]), [
    ['NBA 01', false, 'category'], ['NBA 02', true, 'unlisted'], ['NBA 03', true, 'unlisted'],
    ['NBA 04', true, 'unlisted'], ['NBA 05', false, 'category'], ['NBA 06', true, 'unlisted'],
  ]);

  // Hand picks still win.
  const nba2 = view.channels.find((c) => c.name === 'NBA 02');
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [nba2.id], state: 'include' });
  assert.ok((await names()).includes('NBA 02'));
  await api('PUT', `/api/outputs/${o.id}/channels`, { ids: [nba2.id], state: null });

  // Safety net: if the source's guide has nothing airing now for any channel (it ran out or
  // failed to refresh), nothing is hidden as "unlisted".
  const gen = app.ctx.db.get('SELECT epg_gen FROM sources WHERE id = ?', [xcId]).epg_gen;
  const t = Math.floor(Date.now() / 1000);
  app.ctx.db.run('UPDATE programmes SET stop_ts = ? WHERE source_id = ? AND gen = ? AND start_ts <= ?', [t - 1, xcId, gen, t]);
  app.ctx.bump();
  assert.deepEqual(await names(), all);
  assert.equal((await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data.guide_current, false);

  // Backed up with the other switches.
  const file = (await api('GET', '/api/export')).data;
  assert.deepEqual(file.outputs.find((x) => x.token === o.token).category_options,
    [{ source: xcId, category: 'US| NBA LEAGUE PASS', hide_empty: false, hide_by_guide: true, hide_unlisted: true }]);
  // Restore the guide for later tests.
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('guide logos fill in missing channel logos, only when the advanced setting is on', async () => {
  xcCats.push({ category_id: '32', category_name: 'US| LOGOS' });
  xcStreams.push(
    { num: 90, name: 'Logo Missing', stream_id: 900, stream_icon: '', epg_channel_id: 'logo1', category_id: '32' },
    { num: 91, name: 'Logo Own', stream_id: 901, stream_icon: 'http://provider/own.png', epg_channel_id: 'logo2', category_id: '32' },
  );
  eventGuide.push({ id: 'logo1', title: 'Show', icon: 'http://guide/logo1.png' }, { id: 'logo2', title: 'Show', icon: 'http://guide/logo2.png' });
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const o = (await api('POST', '/api/outputs', { name: 'Logos' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| logos' }] });
  const logos = async () => Object.fromEntries([...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text())
    .matchAll(/tvg-logo="([^"]*)"[^\n]*,([^\n]+)\n/g)].map((m) => [m[2], m[1]]));

  assert.equal((await api('GET', '/api/settings')).data.guide_logo_fallback, false, 'off by default');
  assert.deepEqual(await logos(), { 'Logo Missing': '', 'Logo Own': 'http://provider/own.png' });
  await api('PUT', '/api/settings', { guide_logo_fallback: true, advanced: true });
  assert.deepEqual(await logos(), { 'Logo Missing': 'http://guide/logo1.png', 'Logo Own': 'http://provider/own.png' }, 'provider logos still win');
  const xc = await (await fetch(`${base}/player_api.php?username=family&password=pw123&action=get_live_streams`)).json();
  assert.ok(Array.isArray(xc));
  const file = (await api('GET', '/api/export')).data;
  assert.deepEqual([file.settings.advanced, file.settings.guide_logo_fallback], [true, true]);
  await api('PUT', '/api/settings', { guide_logo_fallback: false, advanced: false });
  assert.equal((await logos())['Logo Missing'], '');
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('name cleanup: per-output find/replace on channel and category names, in every format', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Tidy' })).data;
  await api('PUT', `/api/outputs/${o.id}`, {
    source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| news' }],
    xc_enabled: true, xc_username: 'tidy', xc_password: 'pw',
  });
  const m3u = async () => [...(await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text())
    .matchAll(/tvg-name="([^"]*)".*group-title="([^"]*)",([^\n]+)\n/g)].map((m) => [m[1], m[2], m[3]]);
  const before = await m3u();
  assert.deepEqual(before.map((r) => r[2]).sort(), ['US: CNN HD', 'US: Fox News']);

  const rules = [
    { scope: 'both', find: '^\\|?[A-Z]{2,3}\\s*[|:\\-]\\s*', replace: '' },
    { scope: 'channel', find: '\\s*\\b(?:HD|FHD)\\b', replace: '' },
    { scope: 'category', find: '^NEWS$', replace: 'News & Talk' },
  ];
  // Preview first: nothing is saved yet.
  let r = await api('POST', `/api/outputs/${o.id}/name-preview`, { rules });
  assert.deepEqual([r.data.channels.changed, r.data.channels.total, r.data.categories.changed, r.data.categories.total], [2, 2, 1, 1]);
  assert.deepEqual(r.data.categories.samples, [['US| NEWS', 'News & Talk']]);
  assert.deepEqual(r.data.channels.samples.find((s) => s[0] === 'US: CNN HD'), ['US: CNN HD', 'CNN']);
  assert.deepEqual(await m3u(), before);
  r = await api('POST', `/api/outputs/${o.id}/name-preview`, { rules: [{ scope: 'channel', find: '(', replace: '' }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Not a valid pattern: \( \(Unterminated group\)/);
  assert.equal((await api('PUT', `/api/outputs/${o.id}`, { name_rules: [{ scope: 'nope', find: 'x' }] })).status, 400);

  r = await api('PUT', `/api/outputs/${o.id}`, { name_rules: rules });
  assert.deepEqual(r.data.name_rules, rules.map((x) => ({ ...x, media: 'live' })), 'rules without a target are live TV');
  assert.deepEqual((await m3u()).sort(), [['CNN', 'News & Talk', 'CNN'], ['Fox News', 'News & Talk', 'Fox News']]);
  const xc = (action) => fetch(`${base}/player_api.php?username=tidy&password=pw&action=${action}`).then((x) => x.json());
  assert.deepEqual((await xc('get_live_categories')).map((c) => c.category_name), ['News & Talk']);
  assert.deepEqual((await xc('get_live_streams')).map((s) => s.name).sort(), ['CNN', 'Fox News']);
  assert.match(await (await fetch(`${base}/o/${o.token}/epg.xml`)).text(), /<display-name>CNN<\/display-name>/);

  // A name set by hand wins; saving other settings leaves the rules alone.
  const cnn = (await api('GET', `/api/sources/${xcId}/channels?q=cnn`)).data.items.find((c) => c.name === 'US: CNN HD');
  const edits = { custom_logo: cnn.custom_logo, custom_epg_id: cnn.custom_epg_id, custom_chno: cnn.custom_chno };
  await api('PUT', `/api/channels/${cnn.id}`, { ...edits, custom_name: 'US: CNN HD (mine)' });
  await api('PUT', `/api/outputs/${o.id}`, { name: 'Tidy 2' });
  assert.ok((await m3u()).some((x) => x[2] === 'US: CNN HD (mine)'));
  assert.equal((await api('GET', `/api/outputs/${o.id}`)).data.name_rules.length, 3);
  await api('PUT', `/api/channels/${cnn.id}`, { ...edits, custom_name: cnn.custom_name });

  // Backed up with the output, and checked on import.
  const file = (await api('GET', '/api/export')).data;
  const saved = file.outputs.find((x) => x.token === o.token);
  assert.deepEqual(saved.name_rules, rules.map((x) => ({ ...x, media: 'live' })));
  saved.name_rules = [{ scope: 'channel', find: '[', replace: '' }];
  r = await api('POST', '/api/import', file);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /output "Tidy 2": Not a valid pattern/);
  assert.equal((await api('GET', `/api/outputs/${o.id}`)).status, 200, 'a rejected import changes nothing');

  await api('PUT', `/api/outputs/${o.id}`, { name_rules: [] });
  assert.deepEqual((await m3u()).map((x) => x[2]).sort(), ['US: CNN HD', 'US: Fox News']);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('proxy mode: viewers of a channel share one upstream stream; a source is capped at its connection limit', async () => {
  xcCats.push({ category_id: '33', category_name: 'US| LIVE' });
  xcStreams.push(...[950, 951, 952].map((id, i) => ({ num: 95 + i, name: `Live ${i + 1}`, stream_id: id, stream_icon: '', epg_channel_id: '', category_id: '33' })));
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  const o = (await api('POST', '/api/outputs', { name: 'Live' })).data;
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy', source_ids: [xcId], rules: [{ action: 'include', op: 'equals', value: 'us| live' }] });
  const urls = (await (await fetch(`${base}/o/${o.token}/playlist.m3u`)).text()).split('\n').filter((l) => l.startsWith('http'));
  assert.equal(urls.length, 3);
  const until = async (cond, what) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(cond(), what);
  };
  // A viewer: the response, a reader that has received data, and a way to hang up.
  const watch = async (url) => {
    const ac = new AbortController();
    const r = await fetch(url, { signal: ac.signal });
    if (r.status !== 200) return { status: r.status, text: await r.text() };
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    return { status: 200, first, stop: () => { ac.abort(); reader.cancel().catch(() => {}); } };
  };
  const streams = async () => (await api('GET', `/api/sources/${xcId}`)).data.streams;
  // The source form sends every field; a blank password keeps the stored one.
  const setMax = async (id, max) => {
    const src = (await api('GET', `/api/sources/${id}`)).data;
    assert.equal((await api('PUT', `/api/sources/${id}`, { ...src, max_streams: max })).status, 200);
  };
  const before = live.requests;

  const a = await watch(urls[0]);
  const b = await watch(urls[0]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.match(a.first + b.first, /chunk-950;/);
  assert.equal(live.requests - before, 1, 'two viewers, one upstream connection');
  assert.deepEqual(await streams(), { open: 1, limit: 2, auto: 2 }, 'the limit comes from the XC account (max_connections 2)');

  const c = await watch(urls[1]);
  assert.equal(c.status, 200);
  const d = await watch(urls[2]);
  assert.equal(d.status, 503, 'a third channel is over the limit');
  assert.match(d.text, /All 2 streams for this source are in use/);
  const b2 = await watch(urls[0]);
  assert.equal(b2.status, 200, 'more viewers of a channel already open are always let in');
  b2.stop();

  // The upstream stays open while anyone watches, and closes with the last viewer.
  a.stop();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(live.open.get('950'), 1);
  b.stop();
  await until(() => live.open.get('950') === 0, 'upstream closed after the last viewer left');
  const e = await watch(urls[2]);
  assert.equal(e.status, 200, 'the freed slot can be used');
  e.stop();
  c.stop();
  await until(() => live.open.get('951') === 0 && live.open.get('952') === 0, 'all upstreams closed');

  // Set by hand: 0 = no limit, a number overrides the account, blank goes back to automatic.
  await setMax(xcId, 0);
  const all = await Promise.all(urls.map(watch));
  assert.deepEqual(all.map((x) => x.status), [200, 200, 200]);
  assert.deepEqual(await streams(), { open: 3, limit: 0, auto: 2 });
  all.forEach((x) => x.stop());
  await until(() => [...live.open.values()].every((n) => n === 0), 'all upstreams closed');
  await setMax(xcId, 1);
  const one = await watch(urls[0]);
  assert.equal((await watch(urls[1])).status, 503);
  one.stop();
  const file = (await api('GET', '/api/export')).data;
  assert.equal(file.sources.find((x) => x.ref === xcId).max_streams, 1);
  await setMax(xcId, '');
  assert.equal((await api('GET', `/api/sources/${xcId}`)).data.max_streams, null);

  // HLS channels count while their playlist or segments are being fetched.
  await setMax(m3uId, 1);
  const o2 = (await api('POST', '/api/outputs', { name: 'HLS' })).data;
  await api('PUT', `/api/outputs/${o2.id}`, { stream_mode: 'proxy', source_ids: [m3uId], rules: [{ action: 'include', op: 'equals', value: 'uk| general' }] });
  const lines = (await (await fetch(`${base}/o/${o2.token}/playlist.m3u`)).text()).split('\n').filter((l) => l.startsWith('http'));
  const bbc = lines.find((l) => l.endsWith('.m3u8'));
  const other = lines.find((l) => l.endsWith('.ts'));
  assert.ok(bbc && other, lines.join('\n'));
  assert.equal((await fetch(bbc)).status, 200);
  assert.equal((await fetch(other)).status, 503, 'the HLS channel holds the only slot');
  assert.equal((await fetch(bbc)).status, 200);
  await api('DELETE', `/api/outputs/${o2.id}`);
  await setMax(m3uId, '');
  app.ctx.streams.hls.clear();

  // Redirect mode can't be counted: nothing is refused.
  await setMax(xcId, 1);
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'redirect' });
  const r = await Promise.all(urls.map((u) => fetch(u, { redirect: 'manual' })));
  assert.deepEqual(r.map((x) => x.status), [302, 302, 302]);
  await setMax(xcId, '');
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('movies and series: loaded when a source includes them, filtered per output, served over the Xtream Codes login', async () => {
  const setSource = async (id, fields) => {
    const src = (await api('GET', `/api/sources/${id}`)).data;
    assert.equal((await api('PUT', `/api/sources/${id}`, { ...src, ...fields })).status, 200);
    await app.ctx.jobs.idle();
    return (await api('GET', `/api/sources/${id}`)).data;
  };
  let src = await setSource(xcId, { live_only: false });
  assert.deepEqual([src.counts.movies, src.counts.series], [4, 2]);
  assert.deepEqual([src.vod_stats.movies, src.vod_stats.series], [4, 2]);
  // Live TV lists are unchanged: VOD categories live apart, even one named like a live category.
  const liveCats = (await api('GET', `/api/sources/${xcId}/categories`)).data.map((c) => c.name);
  assert.ok(!liveCats.includes('EN| ACTION'));
  assert.equal(liveCats.filter((n) => n === 'US| NEWS').length, 1);

  const o = (await api('POST', '/api/outputs', { name: 'Movie night' })).data;
  let r = await api('PUT', `/api/outputs/${o.id}`, {
    source_ids: [xcId, m3uId], stream_mode: 'redirect', xc_enabled: true, xc_username: 'vod', xc_password: 'pw', vod_enabled: true,
    rules: [
      { kind: 'movie', action: 'include', op: 'starts_with', value: 'en|' },
      { kind: 'series', action: 'include', op: 'contains', value: 'drama' },
    ],
  });
  assert.equal(r.data.vod_enabled, true);
  assert.deepEqual(r.data.rules.map((x) => x.kind), ['movie', 'series']);
  const cats = async (kind) => Object.fromEntries((await api('GET', `/api/outputs/${o.id}/categories?kind=${kind}`)).data.map((c) => [c.name, c.included]));
  assert.deepEqual(await cats('movie'), { 'EN| ACTION': true, 'EN| KIDS': true, 'FR| FILMS': false });
  assert.deepEqual(await cats('series'), { 'EN| DRAMA': true, 'US| NEWS': false });
  assert.equal((await api('GET', `/api/outputs/${o.id}/categories`)).data.every((c) => !c.included), true, 'no live rules: no live TV');

  const xc = (action, extra = '') => fetch(`${base}/player_api.php?username=vod&password=pw&action=${action}${extra}`).then((x) => x.json());
  const vodCats = await xc('get_vod_categories');
  assert.deepEqual(vodCats.map((c) => c.category_name), ['EN| ACTION', 'EN| KIDS']);
  const movies = await xc('get_vod_streams');
  assert.deepEqual(movies.map((m) => m.name), ['Die Hard', 'Heat', 'Frozen']);
  const dieHard = movies[0];
  assert.notEqual(dieHard.stream_id, 5001, 'ids are this server\'s own');
  assert.deepEqual([dieHard.stream_type, dieHard.rating, dieHard.container_extension, dieHard.stream_icon], ['movie', '8', 'mkv', 'http://p/dh.jpg']);
  assert.deepEqual((await xc('get_vod_streams', `&category_id=${vodCats[1].category_id}`)).map((m) => m.name), ['Frozen']);
  const info = await xc('get_vod_info', `&vod_id=${dieHard.stream_id}`);
  assert.deepEqual([info.info.plot, info.movie_data.stream_id, info.movie_data.container_extension], ['A cop in a tower', dieHard.stream_id, 'mkv']);

  // Renaming a VOD category changes what players see; rules still match the provider's name.
  await api('PUT', `/api/categories/${vodCats[0].category_id}`, { custom_name: 'Action' });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['Action', 'EN| KIDS']);
  const renamed = (await api('GET', '/api/export')).data.sources.find((x) => x.ref === xcId).categories.find((c) => c.custom_name === 'Action');
  assert.deepEqual([renamed.name, renamed.kind], ['EN| ACTION', 'movie'], 'backed up with its kind');
  await api('PUT', `/api/categories/${vodCats[0].category_id}`, { custom_name: '' });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['EN| ACTION', 'EN| KIDS']);

  // Name cleanup for movies and series: only rules aimed at them (or everywhere) apply.
  const nameRules = [
    { scope: 'both', media: 'live', find: 'Die', replace: 'LIVE-ONLY' },
    { scope: 'category', media: 'vod', find: '^[A-Z]{2}\\|\\s*', replace: '' },
    { scope: 'channel', media: 'all', find: '^Die ', replace: 'The ' },
  ];
  const preview = (await api('POST', `/api/outputs/${o.id}/name-preview`, { rules: nameRules })).data;
  assert.deepEqual([preview.vod.categories.changed, preview.vod.titles.changed], [3, 1]);
  assert.deepEqual(preview.vod.titles.samples, [['Die Hard', 'The Hard']]);
  await api('PUT', `/api/outputs/${o.id}`, { name_rules: nameRules });
  assert.deepEqual((await xc('get_vod_categories')).map((c) => c.category_name), ['ACTION', 'KIDS']);
  assert.equal((await xc('get_vod_streams'))[0].name, 'The Hard');
  assert.equal((await xc('get_vod_info', `&vod_id=${dieHard.stream_id}`)).movie_data.name, 'The Hard');
  assert.deepEqual((await xc('get_series_categories')).map((c) => c.category_name), ['DRAMA']);
  await api('PUT', `/api/outputs/${o.id}`, { name_rules: [] });

  assert.deepEqual((await xc('get_series_categories')).map((c) => c.category_name), ['EN| DRAMA']);
  const shows = await xc('get_series');
  assert.deepEqual(shows.map((x) => [x.name, x.plot]), [['Breaking Bad', 'Chemistry']]);
  const bb = await xc('get_series_info', `&series_id=${shows[0].series_id}`);
  assert.equal(bb.info.plot, 'Chemistry teacher');
  assert.deepEqual(bb.episodes['1'].map((e) => [e.episode_num, e.title]), [[1, 'Pilot'], [2, 'Cat in the Bag']]);
  const pilot = bb.episodes['1'][0];
  assert.notEqual(pilot.id, '90001');
  // Opening the show again keeps the same episode ids (players remember what was watched).
  assert.equal((await xc('get_series_info', `&series_id=${shows[0].series_id}`)).episodes['1'][0].id, pilot.id);

  // Playing: Redirect sends the player to the provider's own URL.
  const get = (p, headers = {}) => fetch(`${base}${p}`, { redirect: 'manual', headers });
  r = await get(`/movie/vod/pw/${dieHard.stream_id}.mkv`);
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/movie\/xu\/xp\/5001\.mkv$/);
  r = await get(`/series/vod/pw/${pilot.id}.mkv`);
  assert.match(r.headers.get('location'), /\/series\/xu\/xp\/90001\.mkv$/);
  const amelie = app.ctx.db.get("SELECT id FROM vod_items WHERE name = 'Amélie'").id;
  assert.equal((await get(`/movie/vod/pw/${amelie}.mp4`)).status, 404, 'a movie outside the output is refused');
  assert.equal((await get(`/movie/vod/wrong/${dieHard.stream_id}.mkv`)).status, 401);

  // Proxy relays it, seeking included.
  await api('PUT', `/api/outputs/${o.id}`, { stream_mode: 'proxy' });
  r = await get(`/movie/vod/pw/${dieHard.stream_id}.mkv`, { range: 'bytes=0-9' });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 0-9/100');
  assert.equal(await r.text(), 'MOVIE-5001');
  r = await get(`/series/vod/pw/${pilot.id}.mkv`);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /^SERIES-90001-/);

  // A title the provider drops disappears on the next refresh.
  vodData.movies.splice(1, 1); // Heat
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  assert.deepEqual((await xc('get_vod_streams')).map((m) => m.name), ['Die Hard', 'Frozen']);

  // M3U playlists: movies and episodes come from the playlist itself.
  src = await setSource(m3uId, { live_only: false });
  assert.deepEqual([src.counts.movies, src.counts.series], [1, 1]);
  await api('PUT', `/api/outputs/${o.id}`, {
    stream_mode: 'redirect',
    rules: [
      { kind: 'movie', action: 'include', op: 'starts_with', value: 'en|' },
      { kind: 'series', action: 'include', op: 'contains', value: 'drama' },
      { kind: 'series', action: 'include', op: 'equals', value: 'shows' },
    ],
  });
  const lost = (await xc('get_series')).find((x) => x.name === 'Lost');
  assert.equal(lost.cover, 'http://logo/lost.png');
  const lostEps = (await xc('get_series_info', `&series_id=${lost.series_id}`)).episodes['1'];
  assert.deepEqual(lostEps.map((e) => e.episode_num), [1, 2]);
  r = await get(`/series/vod/pw/${lostEps[1].id}.mkv`);
  assert.equal(r.headers.get('location'), 'http://h/series/u/p/78.mkv');

  // Backed up with the output.
  const file = (await api('GET', '/api/export')).data;
  const saved = file.outputs.find((x) => x.token === o.token);
  assert.equal(saved.vod_enabled, true);
  assert.deepEqual(saved.rules.map((x) => x.kind), ['movie', 'series', 'series']);

  // Switching the output's VOD off, or the source back to live only, takes it all away.
  await api('PUT', `/api/outputs/${o.id}`, { vod_enabled: false });
  assert.deepEqual(await xc('get_vod_categories'), []);
  assert.equal((await get(`/movie/vod/pw/${dieHard.stream_id}.mkv`)).status, 404);
  await api('PUT', `/api/outputs/${o.id}`, { vod_enabled: true });
  src = await setSource(xcId, { live_only: true });
  assert.deepEqual([src.counts.movies, src.counts.series], [0, 0]);
  assert.deepEqual((await xc('get_vod_streams')).map((m) => m.name), []);
  src = await setSource(m3uId, { live_only: true });
  assert.deepEqual([src.counts.movies, src.counts.series], [0, 0]);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('rule order is saved and returned as given, for category and channel rules', async () => {
  const o = (await api('POST', '/api/outputs', { name: 'Order' })).data;
  const rules = [
    { action: 'include', op: 'contains', value: 'news' },
    { action: 'include', op: 'starts_with', value: 'us|' },
    { action: 'exclude', op: 'ends_with', value: 'adult' },
    { action: 'exclude', op: 'contains', value: '24/7' },
  ];
  const saved = (await api('PUT', `/api/outputs/${o.id}`, { source_ids: [xcId], rules: [rules[1], rules[0], rules[3], rules[2]] })).data;
  assert.deepEqual(saved.rules.map((r) => r.value), ['us|', 'news', '24/7', 'adult']);
  const again = (await api('GET', `/api/outputs/${o.id}`)).data;
  assert.deepEqual(again.rules.map((r) => r.value), ['us|', 'news', '24/7', 'adult']);

  const cat = (await api('GET', `/api/outputs/${o.id}/categories`)).data.find((c) => c.name === 'US| NEWS');
  const chRules = [{ action: 'exclude', op: 'contains', value: 'b' }, { action: 'include', op: 'contains', value: 'a' }, { action: 'exclude', op: 'contains', value: 'c' }];
  await api('PUT', `/api/outputs/${o.id}/categories/${cat.id}/channel-rules`, { rules: chRules });
  const view = (await api('GET', `/api/outputs/${o.id}/channels?category_id=${cat.id}`)).data;
  assert.deepEqual(view.rules.map((r) => r.value), ['b', 'a', 'c']);
  await api('DELETE', `/api/outputs/${o.id}`);
});

test('Update now: only where the updater path unit exists; one request at a time; progress reported', async () => {
  // This test instance has no path unit (not a Proxmox install).
  const none = await api('POST', '/api/updates/apply');
  assert.equal(none.status, 409);
  assert.match(none.data.error, /not set up/);
  assert.equal((await api('GET', '/api/updates')).data.web_update.available, false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvm-web-'));
  const unit = path.join(dir, 'iptv-manager-update.path');
  fs.writeFileSync(unit, '[Path]\n');
  const data = path.join(dir, 'data');
  const a = createApp({ dataDir: data, adminPassword: PASSWORD, log: () => {}, webUpdatePathUnit: unit, updateCheckDelayMs: 1e9 });
  const b = `http://127.0.0.1:${(await a.start(0, '127.0.0.1')).port}`;
  try {
    const login = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ password: PASSWORD }) });
    const c = login.headers.get('set-cookie').split(';')[0];
    const call = async (method, p) => {
      const r = await fetch(b + p, { method, headers: { cookie: c, 'x-requested-with': 'fetch' } });
      return { status: r.status, data: await r.json() };
    };
    // Needs the admin session (and the CSRF header), like every other admin action.
    assert.equal((await fetch(`${b}/api/updates/apply`, { method: 'POST', headers: { 'x-requested-with': 'fetch' } })).status, 401);

    let r = await call('POST', '/api/updates/apply');
    assert.equal(r.status, 202);
    assert.ok(fs.existsSync(path.join(data, 'update', 'request')), 'request file written for the path unit');
    assert.deepEqual([r.data.web_update.available, r.data.web_update.pending, r.data.web_update.busy], [true, true, true]);
    assert.equal((await call('POST', '/api/updates/apply')).status, 409, 'no second request while one is pending');

    // The root updater picks it up: consumes the request and reports progress.
    fs.rmSync(path.join(data, 'update', 'request'));
    const t = Math.floor(Date.now() / 1000);
    const status = (s) => fs.writeFileSync(path.join(data, 'update', 'status.json'), JSON.stringify(s));
    status({ state: 'running', message: 'Restarting the app', trigger: 'web', started_at: t, finished_at: null, from: 'a', to: 'b' });
    fs.writeFileSync(path.join(data, 'update', 'last.log'), '10:00:00 Updating\n10:00:05 Restarting\n');
    r = await call('GET', '/api/updates');
    assert.equal(r.data.web_update.status.state, 'running');
    assert.deepEqual(r.data.web_update.log, ['10:00:00 Updating', '10:00:05 Restarting']);
    assert.equal((await call('POST', '/api/updates/apply')).status, 409, 'no request while one is running');

    // A run that died long ago does not block the button forever.
    status({ state: 'running', message: 'x', trigger: 'web', started_at: t - 3600, finished_at: null });
    assert.equal((await call('POST', '/api/updates/apply')).status, 202);
    fs.rmSync(path.join(data, 'update', 'request'));
    status({ state: 'updated', message: 'Updated to b', trigger: 'web', started_at: t, finished_at: t + 20 });
    r = await call('GET', '/api/updates');
    assert.deepEqual([r.data.web_update.busy, r.data.web_update.status.state], [false, 'updated']);
    const req = () => JSON.parse(fs.readFileSync(path.join(data, 'update', 'request'), 'utf8'));

    // Nightly updates: requests carry an action for the root updater.
    const post = async (p, body) => {
      const x = await fetch(b + p, { method: 'POST', headers: { cookie: c, 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body) });
      return { status: x.status, data: await x.json() };
    };
    assert.equal(r.data.web_update.auto, null, 'unknown until the updater writes auto.json');
    assert.equal((await post('/api/updates/auto', { enabled: true, at: '25:00' })).status, 400);
    assert.equal((await post('/api/updates/auto', { enabled: true, at: '03:30' })).status, 202);
    assert.deepEqual([req().action, req().at], ['enable-auto', '03:30']);
    assert.equal((await post('/api/updates/auto', { enabled: false })).status, 409, 'one request at a time');
    fs.rmSync(path.join(data, 'update', 'request'));
    fs.writeFileSync(path.join(data, 'update', 'auto.json'), '{"enabled":true,"at":"03:30"}');
    r = await call('GET', '/api/updates');
    assert.deepEqual(r.data.web_update.auto, { enabled: true, at: '03:30' });
    assert.equal((await post('/api/updates/auto', { enabled: false })).status, 202);
    assert.equal(req().action, 'disable-auto');
    fs.rmSync(path.join(data, 'update', 'request'));
    assert.equal((await call('POST', '/api/updates/apply')).status, 202);
    assert.equal(req().action, 'update');
  } finally {
    await a.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update check: version, up to date, behind, GitHub down, switched off', async () => {
  let u = (await api('GET', '/api/updates')).data;
  assert.deepEqual([u.commit, u.enabled, u.checked_at], [RUNNING, true, undefined], 'nothing checked yet');

  u = (await api('POST', '/api/updates/check')).data;
  assert.deepEqual([u.behind, u.error, u.latest.sha], [0, null, RUNNING]);
  assert.equal(u.latest.message, 'Latest change', 'first line only');

  gh.latest = 'c'.repeat(40);
  gh.newer = ['Older fix', 'Newest feature\n\ndetails'];
  u = (await api('POST', '/api/updates/check')).data;
  assert.equal(u.behind, 2);
  assert.deepEqual(u.commits.map((c) => c.message), ['Newest feature', 'Older fix'], 'newest first');

  // GitHub failing keeps the last good answer and reports the problem.
  gh.fail = true;
  u = (await api('POST', '/api/updates/check')).data;
  assert.match(u.error, /HTTP 500/);
  assert.equal(u.behind, 2);
  gh.fail = false;

  // The daily check can be switched off; a manual check still works.
  await api('PUT', '/api/settings', { update_check: false });
  u = (await api('GET', '/api/updates')).data;
  assert.equal(u.enabled, false);
  assert.equal((await api('POST', '/api/updates/check')).data.error, null);
  await api('PUT', '/api/settings', { update_check: true });

  // After an update the saved result describes the old version. It must not keep saying
  // "Update available" (the bug seen after Update now): the new process re-reads it.
  const { UpdateChecker: UC } = await import('../src/updates.js');
  const opts = { db: app.ctx.db, apiBase: up, repo: 'test/repo' };
  const updatedToLatest = new UC({ ...opts, commit: gh.latest });
  assert.equal(updatedToLatest.isStale(), true);
  assert.deepEqual([updatedToLatest.state().behind, updatedToLatest.state().commits], [0, []], 'now running the latest: up to date, no network');
  const updatedToOther = new UC({ ...opts, commit: 'd'.repeat(40) });
  assert.deepEqual([updatedToOther.state().behind, updatedToOther.state().checking], [null, true]);
  assert.match(updatedToOther.state().note, /Checking/);
  // A result saved before for_commit existed counts as stale too.
  const saved = JSON.parse(app.ctx.db.getSetting('update_state'));
  delete saved.for_commit;
  app.ctx.db.setSetting('update_state', JSON.stringify(saved));
  assert.equal(new UC({ ...opts, commit: RUNNING }).isStale(), true);
  await new UC({ ...opts, commit: RUNNING }).check();
  assert.equal(new UC({ ...opts, commit: RUNNING }).isStale(), false, 'a fresh check records the version it measured');

  // A version that GitHub doesn't know (fork, local changes) is reported, not an error.
  const { UpdateChecker } = await import('../src/updates.js');
  const st = await new UpdateChecker({ db: app.ctx.db, commit: 'f'.repeat(40), apiBase: up, repo: 'test/repo' }).check();
  assert.deepEqual([st.behind, st.error], [null, null]);
  assert.match(st.note, /not on GitHub/);
});

test('alerts: expiring account, failing source, empty guide; sent once, resolved once; ntfy and webhook', async () => {
  const sent = () => notified.splice(0);
  notified.length = 0;
  assert.equal((await api('POST', '/api/alerts/test')).status, 400, 'nothing configured yet');
  assert.equal((await api('PUT', '/api/settings', { notify_type: 'ntfy', notify_url: 'not a url' })).status, 400);
  await api('PUT', '/api/settings', { notify_type: 'ntfy', notify_url: `${up}/notify` });
  assert.equal((await api('POST', '/api/alerts/test')).status, 200);
  assert.deepEqual(sent().map((n) => n.title), ['IPTV Manager test alert']);

  // Account expiring in 5 days: one reminder, not repeated on the next refresh.
  xcAccount.exp = Math.floor(Date.now() / 1000) + 5 * 86400 - 60;
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  let alerts = (await api('GET', '/api/alerts')).data;
  assert.ok(alerts.some((a) => a.kind === 'expiring' && /expires in 5 days/.test(a.title)));
  assert.deepEqual(sent().map((n) => n.title), ['XC account expires in 5 days']);
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  assert.deepEqual(sent(), [], 'no repeat');

  // A source failing three refreshes in a row: alert at the third, "resolved" once it is gone.
  const bad = (await api('POST', '/api/sources', { name: 'Flaky', type: 'xc', xc_host: up, xc_username: 'no', xc_password: 'no' })).data;
  await app.ctx.jobs.idle();
  for (let i = 0; i < 2; i++) {
    await api('POST', `/api/sources/${bad.id}/refresh`);
    await app.ctx.jobs.idle();
  }
  const failing = sent().filter((n) => /Flaky/.test(n.title));
  assert.deepEqual(failing.map((n) => [n.title, n.priority]), [['Flaky keeps failing', 'high']]);
  assert.match(failing[0].body, /last 3 refreshes failed: Xtream Codes login was rejected/);
  await api('DELETE', `/api/sources/${bad.id}`);
  await app.ctx.alerts.evaluate();
  assert.deepEqual(sent().map((n) => n.title), ['Resolved: Flaky keeps failing']);

  // Webhook: JSON body. A guide with nothing airing now raises its own alert.
  await api('PUT', '/api/settings', { notify_type: 'webhook' });
  const gen = app.ctx.db.get('SELECT epg_gen FROM sources WHERE id = ?', [xcId]).epg_gen;
  const t = Math.floor(Date.now() / 1000);
  app.ctx.db.run('UPDATE programmes SET stop_ts = ? WHERE source_id = ? AND gen = ? AND start_ts <= ?', [t - 1, xcId, gen, t]);
  await app.ctx.alerts.evaluate();
  const hook = sent().map((n) => JSON.parse(n.body));
  assert.deepEqual(hook.map((h) => [h.event, h.kind, h.level, h.source_id]), [['alert', 'guide', 'warn', xcId]]);
  assert.match(hook[0].title, /guide has nothing on now/);

  // Refresh brings the guide back and the account far from expiry: guide resolved, expiring just ends.
  xcAccount.exp = 1900000000;
  await api('POST', `/api/sources/${xcId}/refresh`);
  await app.ctx.jobs.idle();
  assert.deepEqual(sent().map((n) => JSON.parse(n.body)).map((h) => [h.event, h.kind]), [['resolved', 'guide']]);
  assert.equal((await api('GET', '/api/alerts')).data.length, 0);

  // Exports carry the target; the URL only with secrets.
  assert.equal((await api('GET', '/api/export')).data.settings.notify_url, `${up}/notify`);
  assert.equal((await api('GET', '/api/export?secrets=0')).data.settings.notify_url, '');
  await api('PUT', '/api/settings', { notify_type: '', notify_url: '' });
});

test('automatic backups: saved daily, 14 kept, downloadable, restorable, no path tricks', async () => {
  const dir = path.join(dataDir, 'backups');
  // Older backups than we keep: the oldest are dropped when a new one is saved.
  fs.mkdirSync(dir, { recursive: true });
  for (let d = 1; d <= 16; d++) fs.writeFileSync(path.join(dir, `settings-2020-01-${String(d).padStart(2, '0')}.json`), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a backup');

  let r = await api('GET', '/api/backups');
  assert.equal(r.data.enabled, true, 'on by default');
  app.ctx.autoBackup.tick(); // what the hourly timer does
  r = await api('GET', '/api/backups');
  const d = new Date();
  const today = `settings-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  assert.equal(r.data.files.length, 14);
  assert.equal(r.data.files[0].name, today, 'newest first');
  assert.ok(!r.data.files.some((f) => f.name === 'settings-2020-01-01.json'), 'oldest dropped');
  assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'other files left alone');

  // The saved file is a full export, secrets included.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, today), 'utf8'));
  assert.equal(saved.format, 'iptv-manager-settings');
  assert.equal(saved.sources.find((s) => s.type === 'xc').xc_password, 'xp');

  const dl = await fetch(`${base}/api/backups/${today}`, { headers: { cookie } });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  for (const bad of ['..%2Fiptv-manager.db', 'notes.txt', 'settings-2020-01-01.json']) {
    assert.equal((await fetch(`${base}/api/backups/${bad}`, { headers: { cookie } })).status, 404, bad);
  }
  assert.equal((await fetch(`${base}/api/backups/${today}`)).status, 401, 'admin only');

  // Switched off: the daily tick does nothing; "Back up now" still works.
  await api('PUT', '/api/settings', { auto_backup: false });
  fs.rmSync(path.join(dir, today));
  app.ctx.autoBackup.tick();
  assert.ok(!fs.existsSync(path.join(dir, today)));
  r = await api('POST', '/api/backups');
  assert.equal(r.data.name, today);
  await api('PUT', '/api/settings', { auto_backup: true });

  // Restore: change something, restore today's backup, and the change is undone.
  const before = (await api('GET', '/api/outputs')).data.map((o) => o.name).sort();
  const extra = (await api('POST', '/api/outputs', { name: 'Made after the backup' })).data;
  assert.ok((await api('GET', '/api/outputs')).data.some((o) => o.id === extra.id));
  r = await api('POST', `/api/backups/${today}/restore`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await app.ctx.jobs.idle();
  assert.deepEqual((await api('GET', '/api/outputs')).data.map((o) => o.name).sort(), before);
});
