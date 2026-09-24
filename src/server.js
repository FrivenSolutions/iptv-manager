import path from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const dataDir = path.resolve(process.env.DATA_DIR || './data');

const app = createApp({ dataDir, adminPassword: process.env.ADMIN_PASSWORD || '' });
const addr = await app.start(port, host);
app.ctx.log(`IPTV Manager ${app.ctx.appVersion} listening on http://${host}:${addr.port} (data: ${dataDir})`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    app.ctx.log(`${sig} received, shutting down`);
    app.ctx.jobs.queue.length = 0;
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))]);
    process.exit(0);
  });
}
