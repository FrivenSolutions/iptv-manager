// HDHomeRun network tuners: the lineup comes from the box, the guide from SiliconDust's
// cloud service, authorized by the DeviceAuth the box reports in discover.json.
import fs from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { download, fetchJson } from './fetch.js';
import { escapeXml } from './xmltv.js';

export const HDHR_API = 'https://api.hdhomerun.com';
const GUIDE_DAYS = 14;
const MAX_GUIDE_REQUESTS = 200;

export function hdhrBase(host) {
  let h = String(host || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  return h.replace(/\/(discover|lineup)\.json.*$/i, '');
}

/** Channels and device details straight from the tuner. */
export async function loadHdhrLineup(src) {
  const base = hdhrBase(src.hdhr_host);
  const opts = { userAgent: src.user_agent };
  let disc;
  try {
    disc = await fetchJson(`${base}/discover.json`, opts);
  } catch (e) {
    throw new Error(`No HDHomeRun answered at ${base} (${e.message}). Use the box's IP address; hdhomerun.local does not resolve inside most containers.`);
  }
  if (!disc || !disc.DeviceID) throw new Error(`${base} did not answer like an HDHomeRun (no DeviceID in discover.json)`);
  const lineup = await fetchJson(`${base}/lineup.json`, opts);
  if (!Array.isArray(lineup)) throw new Error('The HDHomeRun lineup.json was not a list; has a channel scan been run on the box?');

  const items = lineup
    .filter((c) => c.URL && c.GuideNumber != null)
    .map((c) => ({
      key: `hdhr:${c.GuideNumber}`,
      // Keep the tuner number in the name: several channels often share a call sign ("9.1 KUSA", "9.2 KUSA").
      name: c.GuideName ? `${c.GuideNumber} ${c.GuideName}` : String(c.GuideNumber),
      tvgId: String(c.GuideNumber),
      tvgName: '',
      logo: '',
      // Copy-protected (DRM) channels play in few clients; their own group makes them easy to drop.
      group: c.DRM ? 'HDHomeRun (DRM)' : 'HDHomeRun',
      url: c.URL,
      chno: String(c.GuideNumber),
      xcStreamId: null,
      extra: null,
    }));
  const account = {
    model: disc.ModelNumber ?? null,
    friendly_name: disc.FriendlyName ?? null,
    firmware: disc.FirmwareVersion ?? null,
    tuners: disc.TunerCount ?? null,
    device_id: disc.DeviceID,
  };
  return { disc, items, account };
}

const xmltvTime = (ts) => new Date(ts * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';

// Jellyfin files programmes under "Movie" (singular); the guide service says "Movies".
const EXTRA_CATEGORIES = { movies: 'Movie' };

function programmeXml(guideNumber, p) {
  let x = `<programme start="${xmltvTime(p.StartTime)}" stop="${xmltvTime(p.EndTime)}" channel="${escapeXml(guideNumber)}">`;
  x += `<title>${escapeXml(p.Title || '')}</title>`;
  if (p.EpisodeTitle) x += `<sub-title>${escapeXml(p.EpisodeTitle)}</sub-title>`;
  if (p.Synopsis) x += `<desc>${escapeXml(p.Synopsis)}</desc>`;
  if (p.OriginalAirdate) x += `<date>${xmltvTime(p.OriginalAirdate).slice(0, 8)}</date>`;
  const cats = new Set();
  for (const f of Array.isArray(p.Filter) ? p.Filter : []) {
    cats.add(String(f));
    const extra = EXTRA_CATEGORIES[String(f).toLowerCase()];
    if (extra) cats.add(extra);
  }
  for (const c of cats) x += `<category lang="en">${escapeXml(c)}</category>`;
  if (p.ImageURL) x += `<icon src="${escapeXml(p.ImageURL)}"/>`;
  const ep = /^S(\d+)E(\d+)$/i.exec(String(p.EpisodeNumber || ''));
  if (ep) x += `<episode-num system="xmltv_ns">${Number(ep[1]) - 1}.${Number(ep[2]) - 1}.</episode-num>`;
  if (p.EpisodeNumber) x += `<episode-num system="onscreen">${escapeXml(p.EpisodeNumber)}</episode-num>`;
  return x + '</programme>\n';
}

/** Page through the free JSON guide (what the HDHomeRun apps use) and write it as XMLTV. */
export async function writeGuideFromJson({ apiBase, auth, file, userAgent, days = GUIDE_DAYS }) {
  const channels = new Map(); // GuideNumber -> { info, progs: Map(StartTime -> programme) }
  let start = Math.floor(Date.now() / 1000);
  const end = start + days * 86400;
  for (let i = 0; i < MAX_GUIDE_REQUESTS && start < end; i++) {
    const data = await fetchJson(`${apiBase}/api/guide?DeviceAuth=${encodeURIComponent(auth)}&Start=${start}`, { userAgent });
    if (!Array.isArray(data) || !data.length) break;
    let next = Infinity;
    let added = false;
    for (const ch of data) {
      if (ch.GuideNumber == null) continue;
      const key = String(ch.GuideNumber);
      if (!channels.has(key)) channels.set(key, { info: ch, progs: new Map() });
      const entry = channels.get(key);
      const guide = Array.isArray(ch.Guide) ? ch.Guide : [];
      for (const p of guide) {
        if (!p.StartTime || !p.EndTime || entry.progs.has(p.StartTime)) continue;
        entry.progs.set(p.StartTime, p);
        added = true;
      }
      if (guide.length) next = Math.min(next, guide[guide.length - 1].EndTime);
    }
    // Advance to where the shortest channel's listings end; stop once nothing new arrives.
    if (!added || !(next > start)) break;
    start = next;
  }
  if (!channels.size) throw new Error('The HDHomeRun guide service returned no listings');

  const out = fs.createWriteStream(file);
  const write = async (s) => {
    if (!out.write(s)) await once(out, 'drain');
  };
  await write('<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="iptv-manager (HDHomeRun guide)">\n');
  let programmes = 0;
  for (const [num, { info }] of channels) {
    let x = `<channel id="${escapeXml(num)}">`;
    if (info.GuideName) x += `<display-name>${escapeXml(info.GuideName)}</display-name>`;
    x += `<display-name>${escapeXml(num)}</display-name>`;
    if (info.Affiliate) x += `<display-name>${escapeXml(info.Affiliate)}</display-name>`;
    if (info.ImageURL) x += `<icon src="${escapeXml(info.ImageURL)}"/>`;
    await write(x + '</channel>\n');
  }
  for (const [num, { progs }] of channels) {
    let chunk = '';
    for (const p of [...progs.values()].sort((a, b) => a.StartTime - b.StartTime)) {
      chunk += programmeXml(num, p);
      programmes++;
    }
    await write(chunk);
  }
  out.end('</tv>\n');
  await finished(out);
  return { channels: channels.size, programmes };
}

async function hasProgrammes(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(512 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    // A gzip body is left to the XMLTV parser; plain text must contain listings.
    if (head[0] === 0x1f && head[1] === 0x8b) return true;
    const text = head.toString('utf8');
    return /<tv[\s>]/.test(text) && /<programme[\s>]/.test(text);
  } finally {
    await fh.close();
  }
}

/**
 * Build an XMLTV file for the box. The full XMLTV feed is tried first; it may need an
 * HDHomeRun DVR subscription, so on any failure the free JSON guide is converted instead.
 */
export async function buildHdhrGuide({ disc, file, apiBase = HDHR_API, userAgent }) {
  const auth = disc.DeviceAuth;
  if (!auth) throw new Error('The HDHomeRun did not report a DeviceAuth, so its guide cannot be fetched');
  let fallbackReason;
  try {
    await download(`${apiBase}/api/xmltv?DeviceAuth=${encodeURIComponent(auth)}`, file, { userAgent });
    if (await hasProgrammes(file)) return { method: 'xmltv' };
    fallbackReason = 'the XMLTV feed had no listings';
  } catch (e) {
    fallbackReason = e.message;
  }
  const r = await writeGuideFromJson({ apiBase, auth, file, userAgent });
  return { method: 'guide', fallbackReason, ...r };
}
