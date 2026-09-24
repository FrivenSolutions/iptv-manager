import { refreshSource } from './ingest.js';
import { now } from './db.js';

const ERROR_RETRY_S = 30 * 60;

/** Serial refresh queue plus the schedule that feeds it; one source at a time keeps memory flat. */
export class Jobs {
  constructor(ctx) {
    this.ctx = ctx;
    this.queue = [];
    this.state = new Map();
    this.running = false;
    this.timer = null;
    this.waiters = [];
  }

  enqueue(id) {
    id = Number(id);
    if (this.state.has(id)) return false;
    this.state.set(id, 'queued');
    this.queue.push(id);
    this.pump();
    return true;
  }

  status(id) {
    return this.state.get(Number(id)) || null;
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift();
        this.state.set(id, 'running');
        try {
          await refreshSource(this.ctx, id);
        } catch (e) {
          this.ctx.log(`Refresh of source ${id} crashed: ${e.stack || e}`);
        } finally {
          this.state.delete(id);
        }
      }
    } finally {
      this.running = false;
      for (const w of this.waiters.splice(0)) w();
    }
  }

  /** Resolves once the queue is empty (used by tests and graceful shutdown). */
  idle() {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  nextDue(s) {
    if (!s.enabled || s.refresh_minutes <= 0) return null;
    if (!s.last_refresh_at) return now();
    const wait = s.last_status === 'error' ? Math.min(s.refresh_minutes * 60, ERROR_RETRY_S) : s.refresh_minutes * 60;
    return s.last_refresh_at + wait;
  }

  tick() {
    const t = now();
    const rows = this.ctx.db.all('SELECT id, enabled, refresh_minutes, last_refresh_at, last_status FROM sources');
    for (const s of rows) {
      const due = this.nextDue(s);
      if (due != null && due <= t) this.enqueue(s.id);
    }
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
