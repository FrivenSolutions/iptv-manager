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
      return res.end(guide([['cnn.us', 'CNN'], ['sky.uk', 'Sky Sports'], ['foxnews.us', 'Fox News']]));
    }
    if (u.pathname.startsWith('/live/xu/xp/')) {
      if (req.headers['user-agent'] !== 'TestAgent/1') {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' });
      return res.end(`TS-${u.pathname.split('/').pop()}`);
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
  app = createApp({ dataDir, adminPassword: PASSWORD, log: () => {}, hdhrApiBase: up });
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
