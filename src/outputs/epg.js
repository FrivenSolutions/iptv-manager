import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { escapeXml } from '../xmltv.js';
import { now } from '../db.js';

// Jellyfin sorts guide programmes into these sections by their XMLTV <category>;
// the values match its default category lists (case-insensitive).
export const JELLYFIN_CATEGORIES = ['Movie', 'Sports', 'News', 'Kids'];

export function parseJellyfin(value) {
  const wanted = new Set(String(value || '').split(',').map((s) => s.trim().toLowerCase()));
  return JELLYFIN_CATEGORIES.filter((c) => wanted.has(c.toLowerCase()));
}

// XMLTV orders <category> after these elements; inserting there keeps the guide DTD-valid.
const BEFORE_CATEGORY = /<\/(?:title|sub-title|desc|credits|date|category)>|<(?:title|sub-title|desc|credits|date|category)(?:\s[^>]*)?\/>/g;

/** Add <category> elements to a programme's inner markup, skipping ones it already has. */
export function addCategories(xml, categories) {
  xml = xml || '';
  const existing = new Set();
  for (const m of xml.matchAll(/<category(?:\s[^>]*)?>([^<]*)<\/category>/g)) existing.add(m[1].trim().toLowerCase());
  const add = categories.filter((c) => !existing.has(c.toLowerCase()));
  if (!add.length) return xml;
  const tags = add.map((c) => `<category lang="en">${escapeXml(c)}</category>`).join('');
  let at = 0;
  for (const m of xml.matchAll(BEFORE_CATEGORY)) at = m.index + m[0].length;
  return xml.slice(0, at) + tags + xml.slice(at);
}

/** Write the trimmed XMLTV guide for an output as a gzip file. */
export async function writeEpg(db, output, channels, file) {
  const tmp = `${file}.tmp`;
  const gz = zlib.createGzip({ level: 6 });
  const sink = fs.createWriteStream(tmp);
  gz.pipe(sink);
  const write = async (s) => {
    if (!gz.write(s)) await once(gz, 'drain');
  };

  await write('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="iptv-manager">\n');

  // One <channel> per output tvg-id; several playlist entries may share a guide.
  const guides = new Map();
  const tags = new Map(); // tvg-id -> Jellyfin categories from every group using that guide
  for (const ch of channels) {
    if (!ch.epg_id) continue;
    if (ch.jellyfin.length) {
      const set = tags.get(ch.tvg_id) || new Set();
      for (const c of ch.jellyfin) set.add(c);
      tags.set(ch.tvg_id, set);
    }
    if (guides.has(ch.tvg_id)) continue;
    guides.set(ch.tvg_id, ch);
    let x = `<channel id="${escapeXml(ch.tvg_id)}"><display-name>${escapeXml(ch.name)}</display-name>`;
    if (ch.logo) x += `<icon src="${escapeXml(ch.logo)}"/>`;
    await write(x + '</channel>\n');
  }

  const t = now();
  const until = t + Math.max(1, Number(output.epg_days) || 7) * 86400;
  for (const [tvgId, ch] of guides) {
    const rows = db.all(
      `SELECT start, stop, xml FROM programmes
        WHERE source_id = ? AND gen = ? AND channel = ? AND stop_ts > ? AND start_ts < ?
        ORDER BY start_ts`,
      [ch.source_id, ch.epg_gen, ch.epg_id, t - 3600, until],
    );
    if (!rows.length) continue;
    const id = escapeXml(tvgId);
    const cats = [...(tags.get(tvgId) || [])];
    let chunk = '';
    for (const r of rows) {
      const inner = cats.length ? addCategories(r.xml, cats) : r.xml || '';
      chunk += `<programme start="${escapeXml(r.start)}"${r.stop ? ` stop="${escapeXml(r.stop)}"` : ''} channel="${id}">${inner}</programme>\n`;
    }
    await write(chunk);
  }

  gz.end('</tv>\n');
  await finished(sink);
  fs.renameSync(tmp, file);
}

/**
 * Cache of generated guides keyed by data version and hour, so the file is rebuilt
 * after any refresh or edit, and at least hourly as the time window slides.
 */
export class EpgCache {
  constructor(dir) {
    this.dir = dir;
    this.entries = new Map(); // outputId -> { key, file, promise }
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  }

  async get(outputId, version, build) {
    const key = `${version}-${Math.floor(Date.now() / 3_600_000)}`;
    const cur = this.entries.get(outputId);
    if (cur && cur.key === key) return cur.promise;
    const file = path.join(this.dir, `epg-${outputId}-${key}.xml.gz`);
    const promise = build(file).then(() => file);
    this.entries.set(outputId, { key, file, promise });
    promise.then(
      () => {
        if (cur && cur.file !== file) fs.rm(cur.file, { force: true }, () => {});
      },
      () => {
        if (this.entries.get(outputId)?.promise === promise) this.entries.delete(outputId);
      },
    );
    return promise;
  }

  drop(outputId) {
    const cur = this.entries.get(outputId);
    if (cur) fs.rm(cur.file, { force: true }, () => {});
    this.entries.delete(outputId);
  }
}
