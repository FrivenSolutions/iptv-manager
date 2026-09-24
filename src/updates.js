// Daily check against GitHub for a newer version. It only reports: updating stays with the
// install method (Portainer redeploy, iptv-manager-update in a Proxmox container, git pull).
import fs from 'node:fs';
import path from 'node:path';
import { now } from './db.js';

export const DEFAULT_UPDATE_REPO = 'frittsasaurus/iptv-manager';
const CHECK_EVERY_S = 24 * 3600;
const TICK_MS = 3600 * 1000;

/** How this copy was installed, which decides the update instructions shown. */
export function installType(root) {
  if (fs.existsSync(path.join(root, 'version.json')) || fs.existsSync('/.dockerenv')) return 'docker';
  if (fs.existsSync('/usr/local/bin/iptv-manager-update')) return 'proxmox';
  return 'other';
}

const firstLine = (s) => String(s || '').split('\n')[0].slice(0, 200);

export class UpdateChecker {
  constructor({ db, commit, apiBase, repo, branch = 'main', delayMs = 60_000, log = () => {} }) {
    Object.assign(this, { db, commit, apiBase, repo, branch, delayMs, log });
    this.timers = [];
    this.running = null;
  }

  get enabled() {
    return this.db.getSetting('update_check', '1') !== '0';
  }

  state() {
    try {
      return JSON.parse(this.db.getSetting('update_state') || 'null') || {};
    } catch {
      return {};
    }
  }

  async getJson(p) {
    const res = await fetch(`${this.apiBase}${p}`, {
      headers: { 'user-agent': 'iptv-manager', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached; will try again later');
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    return res.json();
  }

  /** Check now; concurrent callers share one request. Never throws. */
  check() {
    this.running ||= this.doCheck().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async doCheck() {
    const prev = this.state();
    let st;
    try {
      const latest = await this.getJson(`/repos/${this.repo}/commits/${encodeURIComponent(this.branch)}`);
      st = {
        checked_at: now(),
        latest: { sha: latest.sha, date: latest.commit?.committer?.date || null, message: firstLine(latest.commit?.message) },
        behind: 0,
        commits: [],
        note: null,
        error: null,
      };
      if (!this.commit) {
        st.behind = null;
        st.note = 'The running version is unknown, so it cannot be compared.';
      } else if (latest.sha !== this.commit) {
        try {
          const cmp = await this.getJson(`/repos/${this.repo}/compare/${this.commit}...${latest.sha}`);
          st.behind = cmp.ahead_by ?? 0;
          st.commits = (cmp.commits || []).slice(-20).reverse().map((c) => ({
            sha: c.sha, date: c.commit?.committer?.date || null, message: firstLine(c.commit?.message),
          }));
          if (!st.behind && cmp.behind_by) st.note = 'This copy is newer than the published version.';
        } catch {
          st.behind = null;
          st.note = 'The running version is not on GitHub (a fork or local changes?).';
        }
      }
      if (st.behind) this.log(`Update available: ${st.behind} new change${st.behind === 1 ? '' : 's'} on GitHub`);
    } catch (e) {
      st = { ...prev, checked_at: now(), error: e.message };
    }
    this.db.setSetting('update_state', JSON.stringify(st));
    return st;
  }

  /** First check shortly after start, then whenever the last one is a day old (checked hourly). */
  start() {
    const due = () => this.enabled && now() - (this.state().checked_at || 0) >= CHECK_EVERY_S;
    const first = setTimeout(() => due() && this.check(), this.delayMs);
    const tick = setInterval(() => due() && this.check(), TICK_MS);
    first.unref();
    tick.unref();
    this.timers.push(first, tick);
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
