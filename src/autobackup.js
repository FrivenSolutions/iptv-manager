// A settings export saved to the data folder once a day, keeping the last 14. They include provider
// passwords (like the database next to them), so a restore brings back a complete setup.
import fs from 'node:fs';
import path from 'node:path';
import { exportSettings } from './backup.js';

export const KEEP = 14;
const NAME = /^settings-(\d{4}-\d{2}-\d{2})\.json$/;
const TICK_MS = 3600 * 1000;

// Local date (the server's time zone), so "today" matches the clock the user sees.
const todayName = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `settings-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
};

export class AutoBackup {
  constructor(ctx, { firstDelayMs = 2 * 60_000 } = {}) {
    this.ctx = ctx;
    this.dir = path.join(ctx.dataDir, 'backups');
    this.firstDelayMs = firstDelayMs;
    this.timers = [];
  }

  get enabled() {
    return this.ctx.db.getSetting('auto_backup', '1') !== '0';
  }

  /** Newest first. */
  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((n) => NAME.test(n));
    } catch {}
    return names.sort().reverse().map((name) => {
      const st = fs.statSync(path.join(this.dir, name));
      return { name, date: NAME.exec(name)[1], size: st.size, saved_at: Math.floor(st.mtimeMs / 1000) };
    });
  }

  /** Full path of a saved backup, or null for anything that isn't one (no path tricks). */
  file(name) {
    if (!NAME.test(String(name))) return null;
    const p = path.join(this.dir, name);
    return fs.existsSync(p) ? p : null;
  }

  /** Save today's backup (replacing an earlier one from today) and drop the oldest beyond KEEP. */
  run() {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = todayName();
    const data = exportSettings(this.ctx.db, { secrets: true, appVersion: this.ctx.appVersion });
    const tmp = path.join(this.dir, `${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path.join(this.dir, name));
    for (const old of this.list().slice(KEEP)) fs.rmSync(path.join(this.dir, old.name), { force: true });
    return name;
  }

  /** Once a day when enabled: today's file is written if it doesn't exist yet. */
  tick() {
    if (!this.enabled) return;
    const today = todayName();
    if (this.file(today)) return;
    try {
      this.ctx.log(`Saved automatic settings backup ${this.run()}`);
    } catch (e) {
      this.ctx.log(`Automatic settings backup failed: ${e.message}`);
    }
  }

  start() {
    const first = setTimeout(() => this.tick(), this.firstDelayMs);
    const every = setInterval(() => this.tick(), TICK_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
