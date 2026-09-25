// Problems worth telling someone about, shown on the dashboard and optionally pushed to ntfy or
// a webhook: a source that keeps failing, an account about to expire, a guide that has run out.
import { now } from './db.js';

const FAILS_BEFORE_ALERT = 3;
const EXPIRY_STEPS_DAYS = [14, 7, 3, 1]; // a reminder as each of these is crossed
const CHECK_EVERY_MS = 3600 * 1000;

/** Current problems. Each has a stable key, so a notification is sent once per problem. */
export function computeAlerts(db, t = now()) {
  const alerts = [];
  for (const s of db.all('SELECT * FROM sources WHERE enabled = 1 ORDER BY sort, id')) {
    if (s.fail_count >= FAILS_BEFORE_ALERT) {
      alerts.push({
        key: `failing:${s.id}`, kind: 'failing', level: 'error', source_id: s.id,
        title: `${s.name} keeps failing`,
        message: `The last ${s.fail_count} refreshes failed${s.last_error ? `: ${s.last_error}` : '.'}`,
      });
    }
    let info = null;
    try {
      info = s.account_info ? JSON.parse(s.account_info) : null;
    } catch {}
    const exp = Number(info?.exp_date);
    if (exp > 0) {
      const days = Math.ceil((exp - t) / 86400);
      const date = new Date(exp * 1000).toISOString().slice(0, 10);
      if (days <= 0) {
        alerts.push({
          key: `expired:${s.id}`, kind: 'expired', level: 'error', source_id: s.id,
          title: `${s.name} account has expired`, message: `The provider account expired on ${date}.`,
        });
      } else if (days <= EXPIRY_STEPS_DAYS[0]) {
        // The key names the step, so a new reminder goes out at 14, 7, 3 and 1 days.
        const step = [...EXPIRY_STEPS_DAYS].reverse().find((d) => days <= d);
        alerts.push({
          key: `expiring:${s.id}:${step}`, kind: 'expiring', level: 'warn', source_id: s.id,
          title: `${s.name} account expires in ${days} day${days === 1 ? '' : 's'}`, message: `The provider account expires on ${date}.`,
        });
      }
    }
    // A guide that has anything at all is expected to have something airing now.
    if (s.epg_gen > 0 && db.get('SELECT 1 AS x FROM programmes WHERE source_id = ? AND gen = ? LIMIT 1', [s.id, s.epg_gen])
      && !db.get('SELECT 1 AS x FROM programmes WHERE source_id = ? AND gen = ? AND start_ts <= ? AND stop_ts > ? LIMIT 1', [s.id, s.epg_gen, t, t])) {
      alerts.push({
        key: `guide:${s.id}`, kind: 'guide', level: 'warn', source_id: s.id,
        title: `${s.name} guide has nothing on now`,
        message: 'Its guide lists nothing airing on any channel; it may have run out or stopped refreshing. Guide-based hiding is paused for this source.',
      });
    }
  }
  return alerts;
}

export class Alerts {
  constructor(ctx) {
    this.ctx = ctx;
    this.timer = null;
  }

  get target() {
    const { db } = this.ctx;
    return { type: db.getSetting('notify_type') || '', url: db.getSetting('notify_url') || '' };
  }

  async send(event, a) {
    const { type, url } = this.target;
    if (!type || !url) return;
    const title = event === 'resolved' ? `Resolved: ${a.title}` : a.title;
    const signal = AbortSignal.timeout(15_000);
    let res;
    if (type === 'ntfy') {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Title: title,
          Tags: event === 'resolved' ? 'white_check_mark' : a.level === 'error' ? 'rotating_light' : 'warning',
          Priority: event !== 'resolved' && a.level === 'error' ? 'high' : 'default',
        },
        body: a.message,
        signal,
      });
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'iptv-manager', event, kind: a.kind, level: a.level, title, message: a.message, source_id: a.source_id ?? null }),
        signal,
      });
    }
    if (!res.ok) throw new Error(`notification target answered HTTP ${res.status}`);
  }

  /** Notify about new problems and about ones that went away. Never throws. */
  async evaluate() {
    const { db, log } = this.ctx;
    const current = computeAlerts(db);
    let sent = {};
    try {
      sent = JSON.parse(db.getSetting('alerts_sent') || '{}');
    } catch {}
    const next = {};
    for (const a of current) {
      if (sent[a.key]) {
        next[a.key] = sent[a.key];
        continue;
      }
      try {
        await this.send('alert', a);
        next[a.key] = { title: a.title, kind: a.kind, level: a.level, source_id: a.source_id, at: now() };
      } catch (e) {
        log(`Could not send alert "${a.title}": ${e.message}`);
        // Not recorded as sent, so it is retried on the next evaluation.
      }
    }
    // Problems that cleared (expiry steps simply move on to the next key and are not "resolved").
    for (const [key, a] of Object.entries(sent)) {
      if (next[key] || current.some((c) => c.key === key)) continue;
      if (a.kind === 'expiring') continue;
      try {
        await this.send('resolved', { ...a, message: 'This is no longer a problem.' });
      } catch (e) {
        log(`Could not send "resolved" for "${a.title}": ${e.message}`);
        next[key] = a; // retry later
      }
    }
    db.setSetting('alerts_sent', JSON.stringify(next));
    return current;
  }

  start() {
    this.timer = setInterval(() => this.evaluate(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
