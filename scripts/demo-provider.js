// A fake IPTV provider for trying the UI without real credentials.
//   node scripts/demo-provider.js [port]
// M3U:  http://localhost:9090/playlist.m3u   (guide advertised in its header)
// XC:   host http://localhost:9090, username demo, password demo
import http from 'node:http';

const port = Number(process.argv[2] || 9090);
const base = `http://localhost:${port}`;

const COUNTRIES = ['US', 'UK', 'CA', 'FR', 'DE'];
const GENRES = ['NEWS', 'SPORTS', 'ENTERTAINMENT', 'KIDS', 'MOVIES', 'DOCUMENTARY', 'MUSIC', 'ADULT'];
const cats = [];
const streams = [];
let sid = 1000;
COUNTRIES.forEach((cc, ci) => {
  GENRES.forEach((g, gi) => {
    const id = String(ci * 100 + gi + 1);
    cats.push({ category_id: id, category_name: `${cc}| ${g}`, parent_id: 0 });
    for (let n = 1; n <= 4 + ((ci + gi) % 5); n++) {
      sid++;
      streams.push({
        num: streams.length + 1,
        name: `${cc}: ${g[0]}${g.slice(1).toLowerCase()} ${n}${n % 3 === 0 ? ' HD' : ''}`,
        stream_type: 'live',
        stream_id: sid,
        stream_icon: '',
        epg_channel_id: n % 4 === 0 ? '' : `${g.toLowerCase()}${n}.${cc.toLowerCase()}`,
        category_id: id,
      });
    }
  });
});
cats.push({ category_id: '900', category_name: '24/7 | CLASSIC TV', parent_id: 0 });
for (let n = 1; n <= 6; n++) streams.push({ num: streams.length + 1, name: `24/7 Classic ${n}`, stream_id: ++sid, stream_icon: '', epg_channel_id: '', category_id: '900' });

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const t = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

function guide() {
  let x = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="demo">\n';
  const ids = new Map();
  for (const s of streams) {
    const id = s.epg_channel_id || `${s.name.replace(/^\w+: /, '').replace(/\s+HD$/, '').toLowerCase().replace(/\W+/g, '')}.demo`;
    ids.set(id, s.name.replace(/^\w+: /, '').replace(/\s+HD$/, ''));
  }
  for (const [id, name] of ids) x += `<channel id="${esc(id)}"><display-name>${esc(name)}</display-name></channel>\n`;
  const start = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  for (const [id, name] of ids) {
    for (let h = -2; h < 24; h++) {
      x += `<programme start="${t(new Date(start + h * 3_600_000))}" stop="${t(new Date(start + (h + 1) * 3_600_000))}" channel="${esc(id)}">` +
        `<title lang="en">${esc(name)} at ${(new Date(start + h * 3_600_000).getUTCHours() + '').padStart(2, '0')}:00</title>` +
        `<desc lang="en">A demo programme on ${esc(name)}.</desc><category lang="en">Demo</category></programme>\n`;
    }
  }
  return x + '</tv>\n';
}

http.createServer((req, res) => {
  const u = new URL(req.url, base);
  const json = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
  if (u.pathname === '/playlist.m3u') {
    const catName = new Map(cats.map((c) => [c.category_id, c.category_name]));
    const lines = [`#EXTM3U url-tvg="${base}/guide.xml"`];
    for (const s of streams) {
      lines.push(`#EXTINF:-1 tvg-id="${s.epg_channel_id}" tvg-name="${s.name}" group-title="${catName.get(s.category_id)}",${s.name}`);
      lines.push(`${base}/live/demo/demo/${s.stream_id}.ts`);
    }
    return res.writeHead(200, { 'content-type': 'audio/x-mpegurl' }).end(lines.join('\n'));
  }
  if (u.pathname === '/guide.xml' || u.pathname === '/xmltv.php') {
    return res.writeHead(200, { 'content-type': 'application/xml' }).end(guide());
  }
  if (u.pathname === '/player_api.php') {
    if (u.searchParams.get('username') !== 'demo' || u.searchParams.get('password') !== 'demo') return json({ user_info: { auth: 0 } });
    const a = u.searchParams.get('action');
    if (!a) return json({ user_info: { auth: 1, status: 'Active', exp_date: String(Math.floor(Date.now() / 1000) + 90 * 86400), max_connections: '2', active_cons: '0' }, server_info: {} });
    if (a === 'get_live_categories') return json(cats);
    if (a === 'get_live_streams') return json(streams);
    return json([]);
  }
  if (u.pathname.startsWith('/live/')) return res.writeHead(200, { 'content-type': 'video/mp2t' }).end('demo stream');
  res.writeHead(404).end();
}).listen(port, () => console.log(`Demo provider on ${base} (${cats.length} categories, ${streams.length} channels)`));
