// "Update now" for Proxmox installs. The app runs unprivileged and cannot update itself: it
// drops a request file in its data folder, a systemd path unit notices it and runs the root
// updater (proxmox/iptv-manager-update), which writes progress back to status.json/last.log.
import fs from 'node:fs';
import path from 'node:path';
import { now } from './db.js';

export const PATH_UNIT = '/etc/systemd/system/iptv-manager-update.path';
const STALE_RUNNING_S = 15 * 60; // an updater that died mid-run must not block the button forever

export class WebUpdater {
  constructor({ dataDir, pathUnit = PATH_UNIT }) {
    this.dir = path.join(dataDir, 'update');
    this.pathUnit = pathUnit;
  }

  /** The updater's path unit is installed, so a request will be picked up. */
  get available() {
    return fs.existsSync(this.pathUnit);
  }

  get pending() {
    return fs.existsSync(path.join(this.dir, 'request'));
  }

  status() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'status.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  log(maxLines = 30) {
    try {
      return fs.readFileSync(path.join(this.dir, 'last.log'), 'utf8').trimEnd().split('\n').slice(-maxLines);
    } catch {
      return [];
    }
  }

  busy() {
    const st = this.status();
    return this.pending || (st?.state === 'running' && now() - (st.started_at || 0) < STALE_RUNNING_S);
  }

  view() {
    return { available: this.available, pending: this.pending, busy: this.busy(), status: this.status(), log: this.log() };
  }

  /** Returns false when an update is already requested or running. */
  request() {
    if (this.busy()) return false;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'request'), JSON.stringify({ requested_at: now() }) + '\n');
    return true;
  }
}
