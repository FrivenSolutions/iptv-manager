// Category filtering and channel selection for an output profile.
import { parseJellyfin } from './outputs/epg.js';

export const OPS = ['contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with',
  'equals', 'not_equals', 'regex'];

export function testRule(rule, name) {
  const n = String(name || '').toLowerCase();
  const v = String(rule.value || '').toLowerCase();
  switch (rule.op) {
    case 'contains': return n.includes(v);
    case 'not_contains': return !n.includes(v);
    case 'starts_with': return n.startsWith(v);
    case 'not_starts_with': return !n.startsWith(v);
    case 'ends_with': return n.endsWith(v);
    case 'not_ends_with': return !n.endsWith(v);
    case 'equals': return n === v;
    case 'not_equals': return n !== v;
    case 'regex':
      try {
        return new RegExp(rule.value, 'i').test(name);
      } catch {
        return false;
      }
    default: return false;
  }
}

/**
 * Decide whether a category belongs in an output.
 *   1. A manual include/exclude always wins.
 *   2. Any matching exclude rule removes it.
 *   3. With include rules for its source, it must match at least one.
 *   4. With no include rules, the output's "include everything" default applies.
 * Rules are evaluated against the provider's category name, so new categories
 * that appear upstream are picked up automatically on the next refresh.
 */
export function categoryState(cat, rules, override, includeAll) {
  if (override) return { included: override === 'include', reason: 'manual' };
  const applicable = rules.filter((r) => r.source_id == null || r.source_id === cat.source_id);
  const exclude = applicable.find((r) => r.action === 'exclude' && testRule(r, cat.name));
  if (exclude) return { included: false, reason: 'rule', rule_id: exclude.id };
  const includes = applicable.filter((r) => r.action === 'include');
  if (!includes.length) return { included: !!includeAll, reason: 'default' };
  const hit = includes.find((r) => testRule(r, cat.name));
  return hit ? { included: true, reason: 'rule', rule_id: hit.id } : { included: false, reason: 'rule' };
}

/**
 * Decide whether a channel belongs in an output.
 *   1. The channel's category must be included; an excluded category excludes all of
 *      its channels. Hand picks inside it are kept, and apply again once it is included.
 *   2. A manual include/exclude on the channel then wins.
 *   3. Otherwise the category's channel rules refine it the same way category rules do:
 *      an exclude match removes it, and with include rules it must match one.
 * Channel rules match the provider's channel name, so channels the provider adds
 * later are sorted automatically too.
 */
export function channelState(name, catIncluded, rules, override, emptyEvent = false) {
  if (!catIncluded) return { included: false, reason: 'category' };
  if (override) return { included: override === 'include', reason: 'manual' };
  // Placeholder channels for events that aren't on ("ESPN+ 03:", "PPV 12 NO EVENT").
  if (emptyEvent) return { included: false, reason: 'empty' };
  const exclude = rules.find((r) => r.action === 'exclude' && testRule(r, name));
  if (exclude) return { included: false, reason: 'rule', rule_id: exclude.id };
  const includes = rules.filter((r) => r.action === 'include');
  if (!includes.length) return { included: true, reason: 'category' };
  const hit = includes.find((r) => testRule(r, name));
  return hit ? { included: true, reason: 'rule', rule_id: hit.id } : { included: false, reason: 'nomatch' };
}

// Event providers list idle placeholders whose names end in ":", "-", a number or "NO EVENT";
// once an event is scheduled the name gains a title ("ESPN+ 03: Team A vs Team B").
export const DEFAULT_EMPTY_EVENT_PATTERNS = [':\\s*$', '-\\s*$', '\\d\\s*$', 'no event\\s*$'];

/** The configured empty-event patterns (the defaults unless changed in Settings). */
export function emptyEventPatterns(db) {
  const raw = db.getSetting('empty_event_patterns');
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    } catch {}
  }
  return DEFAULT_EMPTY_EVENT_PATTERNS;
}

export function compilePatterns(list) {
  return list.flatMap((p) => {
    try {
      return [new RegExp(p, 'i')];
    } catch {
      return [];
    }
  });
}

export const isEmptyEvent = (name, regexes) => regexes.some((r) => r.test(String(name || '')));

/** Channel rules of an output, grouped by category id. */
export function loadChannelRules(db, outputId) {
  const map = new Map();
  for (const r of db.all('SELECT * FROM output_channel_rules WHERE output_id = ? ORDER BY sort, id', [outputId])) {
    if (!map.has(r.category_id)) map.set(r.category_id, []);
    map.get(r.category_id).push(r);
  }
  return map;
}

const NEW_FOR_S = 7 * 86400;

/** A category is "new" for a week after appearing in any refresh but the source's first. */
export function isNewCategory(c, t = Math.floor(Date.now() / 1000)) {
  return c.added_in > 1 && c.first_seen > t - NEW_FOR_S;
}

export function loadOutput(db, outputId) {
  const output = db.get('SELECT * FROM outputs WHERE id = ?', [outputId]);
  if (!output) return null;
  output.sources = db.all(
    `SELECT s.id, s.name, s.epg_gen, s.user_agent, s.type, s.xc_stream_ext, os.sort
       FROM output_sources os JOIN sources s ON s.id = os.source_id
      WHERE os.output_id = ? ORDER BY os.sort, s.id`,
    [outputId],
  );
  output.rules = db.all('SELECT * FROM output_rules WHERE output_id = ? ORDER BY sort, id', [outputId]);
  return output;
}

/** Categories from every source attached to the output, each with its decision. */
export function evaluateCategories(db, output) {
  if (!output.sources.length) return [];
  const overrides = new Map(
    db.all('SELECT category_id, state FROM output_category_overrides WHERE output_id = ?', [output.id])
      .map((r) => [r.category_id, r.state]),
  );
  const order = new Map(output.sources.map((s, i) => [s.id, i]));
  const ids = output.sources.map((s) => s.id);
  const cats = db.all(
    `SELECT c.id, c.source_id, c.name, c.custom_name, c.jellyfin, c.sort, c.first_seen, c.added_in,
            (SELECT COUNT(*) FROM channels ch WHERE ch.category_id = c.id AND ch.active = 1) AS channel_count
       FROM categories c
      WHERE c.active = 1 AND c.source_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  cats.sort((a, b) => order.get(a.source_id) - order.get(b.source_id) || a.sort - b.sort);
  const chRules = loadChannelRules(db, output.id);
  const hideEmpty = new Set(
    db.all('SELECT category_id FROM output_category_settings WHERE output_id = ? AND hide_empty = 1', [output.id])
      .map((r) => r.category_id),
  );
  for (const c of cats) {
    const override = overrides.get(c.id) || null;
    Object.assign(c, categoryState(c, output.rules, override, output.include_all), { override });
    c.channel_rules = chRules.get(c.id) || [];
    c.hide_empty = hideEmpty.has(c.id);
    c.is_new = isNewCategory(c);
    c.jellyfin = parseJellyfin(c.jellyfin);
  }
  return cats;
}

/**
 * Resolve the final channel list for an output with every per-channel edit applied.
 * tvg ids are made unique per source so two providers' "CNN.us" never collide in one guide.
 */
export function selectChannels(db, output) {
  const cats = evaluateCategories(db, output);
  if (!cats.length) return { categories: cats, channels: [] };
  const catById = new Map(cats.map((c) => [c.id, c]));
  const chOverrides = new Map(
    db.all('SELECT channel_id, state FROM output_channel_overrides WHERE output_id = ?', [output.id])
      .map((r) => [r.channel_id, r.state]),
  );
  const srcById = new Map(output.sources.map((s) => [s.id, s]));
  const emptyRegexes = compilePatterns(emptyEventPatterns(db));
  const ids = output.sources.map((s) => s.id);
  const rows = db.all(
    `SELECT * FROM channels WHERE active = 1 AND source_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );

  const channels = [];
  for (const ch of rows) {
    const cat = catById.get(ch.category_id);
    if (!cat) continue;
    const empty = cat.hide_empty && isEmptyEvent(ch.name, emptyRegexes);
    if (!channelState(ch.name, cat.included, cat.channel_rules, chOverrides.get(ch.id), empty).included) continue;
    channels.push({ ch, cat });
  }
  const order = new Map(output.sources.map((s, i) => [s.id, i]));
  channels.sort((a, b) =>
    order.get(a.ch.source_id) - order.get(b.ch.source_id) || a.cat.sort - b.cat.sort || a.ch.sort - b.ch.sort);

  const idOwner = new Map(); // output tvg-id -> "sourceId|epgId"
  let num = output.number_start != null ? Number(output.number_start) : null;
  const result = channels.map(({ ch, cat }) => {
    const src = srcById.get(ch.source_id);
    const epgId = ch.custom_epg_id || ch.epg_id || null;
    // HDHomeRun channels publish their tuner number ("5.1") as the guide id, so it stays the
    // same whether the listings came from the XMLTV feed (opaque ids) or the JSON guide.
    let tvgId = (src.type === 'hdhr' ? ch.tvg_id : epgId || ch.tvg_id) || '';
    if (tvgId) {
      const owner = `${ch.source_id}|${tvgId}`;
      const prev = idOwner.get(tvgId);
      if (prev && prev !== owner) tvgId = `${tvgId}.s${ch.source_id}`;
      else idOwner.set(tvgId, owner);
    }
    let extra = null;
    try {
      extra = ch.extra ? JSON.parse(ch.extra) : null;
    } catch {}
    return {
      id: ch.id,
      source_id: ch.source_id,
      category_id: cat.id,
      name: ch.custom_name || ch.name,
      logo: ch.custom_logo || ch.logo || '',
      group: cat.custom_name || cat.name,
      jellyfin: cat.jellyfin,
      tvg_id: tvgId,
      epg_id: epgId,
      epg_gen: src.epg_gen,
      chno: num != null ? String(num++) : ch.custom_chno || ch.chno || '',
      url: ch.url,
      opts: extra?.opts || [],
      user_agent: src.user_agent,
      xc_stream_id: ch.xc_stream_id,
      source_type: src.type,
      added: ch.first_seen,
    };
  });
  return { categories: cats, channels: result };
}
