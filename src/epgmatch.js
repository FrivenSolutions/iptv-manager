// Associates playlist channels with XMLTV channel ids from the same source.

const QUALITY = /\b(uhd|fhd|hd|sd|4k|8k|hevc|h\.?26[45]|1080[pi]?|720p?|2160p?|50fps|60fps|backup|raw|vip)\b/g;

export function normalizeName(s, stripPrefix = true) {
  let v = String(s || '')
    .toLowerCase()
    .replace(/[[({][^\])}]*[\])}]/g, ' '); // (US), [HD], {backup}
  if (stripPrefix) {
    v = v
      .replace(/^\s*[a-z]{2,4}\s*[:|\-–]\s*/, '') // "US: ", "UK | ", "CA - " country prefixes
      .replace(/^\s*\|[a-z]{2,4}\|\s*/, ''); // "|US| "
  }
  return v
    .replace(QUALITY, ' ')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9+]/g, '');
}

/**
 * @param channels     [{ id, name, tvg_id, tvg_name, custom_name, custom_epg_id }]
 * @param epgChannels  [{ id, names: [] }]
 * @returns Map channelId -> { epgId, how } where how is manual | tvg-id | name | null
 */
export function matchChannels(channels, epgChannels) {
  const exact = new Set();
  const lower = new Map();
  const byName = new Map();
  const byDisplay = new Map(); // exact display-name -> id (HDHomeRun lists "5.1" as a display name)
  for (const e of epgChannels) {
    exact.add(e.id);
    if (!lower.has(e.id.toLowerCase())) lower.set(e.id.toLowerCase(), e.id);
    for (const n of e.names) if (!byDisplay.has(n.trim().toLowerCase())) byDisplay.set(n.trim().toLowerCase(), e.id);
    for (const n of [...e.names, e.id]) {
      for (const k of [normalizeName(n, false), normalizeName(n)]) {
        if (k && !byName.has(k)) byName.set(k, e.id);
      }
    }
  }

  const out = new Map();
  for (const ch of channels) {
    if (ch.custom_epg_id) {
      out.set(ch.id, { epgId: ch.custom_epg_id, how: 'manual' });
      continue;
    }
    const tvg = (ch.tvg_id || '').trim();
    if (tvg && exact.has(tvg)) {
      out.set(ch.id, { epgId: tvg, how: 'tvg-id' });
      continue;
    }
    if (tvg && lower.has(tvg.toLowerCase())) {
      out.set(ch.id, { epgId: lower.get(tvg.toLowerCase()), how: 'tvg-id' });
      continue;
    }
    if (tvg && byDisplay.has(tvg.toLowerCase())) {
      out.set(ch.id, { epgId: byDisplay.get(tvg.toLowerCase()), how: 'tvg-id' });
      continue;
    }
    let hit = null;
    search: for (const n of [ch.custom_name, ch.tvg_name, ch.name]) {
      for (const k of [normalizeName(n, false), normalizeName(n)]) {
        if (k && byName.has(k)) {
          hit = byName.get(k);
          break search;
        }
      }
    }
    out.set(ch.id, hit ? { epgId: hit, how: 'name' } : { epgId: null, how: null });
  }
  return out;
}
