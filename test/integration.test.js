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
      ].join('\n'));
    }
    if (u.pathname === '/m3u-guide.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(zlib.gzipSync(guide([['bbc1.uk', 'BBC One'], ['itv1.uk', 'ITV 1'], ['cnn.us', 'CNN M3U']])));
    }
    if (u.pathname === '/player_api.php') {
      if (u.searchParams.get('username') !== 'xu' || u.searchParams.get('password') !== 'xp') return json({ user_info: { auth: 0 } });
      const action = u.searchParams.get('action');
      if (!action) return json({ user_info: { auth: 1, status: 'Active', exp_date: '1900000000', max_connections: '2' }, server_info: {} });
      if (action === 'get_live_categories') return json(xcCats);
      if (action === 'get_live_streams') return json(xcStreams);
      return json([]);
    }
    if (u.pathname === '/xmltv.php') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      // Event channels whose programme airing now has a chosen title (e.g. "No Game Today").
      // Deliberately appended after the other programmes, like a merged guide: ingest must
      // still match these late <channel> entries.
      const now = Date.now();
      const events = eventGuide.map(({ id, title }) =>
        `<channel id="${id}"><display-name>${id}</display-name></channel>\n` +
        `<programme start="${xmltvTime(new Date(now - 3600_000))}" stop="${xmltvTime(new Date(now + 3600_000))}" channel="${id}"><title>${title}</title></programme>\n`).join('');
      return res.end(guide([['cnn.us', 'CNN'], ['sky.uk', 'Sky Sports'], ['foxnews.us', 'Fox News']]).replace('</tv>', `${events}</tv>`));
    }
    if (u.pathname.startsWith('/live/xu/xp/')) {
      if (req.headers['user-agent'] !== 'TestAgent/1') {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end(`TS-${u.pathname.split('/').pop()}`);
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
  assert.deepEqual(exported.outputs.find((x) => x.token === o.token).category_options, [{ source: xcId, category: 'US| ESPN+ EVENTS', hide_empty: true, hide_by_guide: false }]);
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
  assert.deepEqual(events.category_options, [{ source: xcId, category: 'US| ESPN+ EVENTS', hide_empty: true, hide_by_guide: false }]);

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
    [{ source: xcId, category: 'US| NFL SUNDAY', hide_empty: false, hide_by_guide: true }]);
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
