import path from 'node:path';
import { createApp } from './app.js';
import { isFetchInternalError } from './fetch.js';

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const dataDir = path.resolve(process.env.DATA_DIR || './data');

const app = createApp({ dataDir, adminPassword: process.env.ADMIN_PASSWORD || '', disableTwoFactor: process.env.DISABLE_2FA === '1' });
// Proxied streams still use fetch, whose internal assertion would otherwise end every stream at
// once; it only breaks one connection, so log it and carry on. Anything else still ends the process.
process.on('uncaughtException', (err) => {
  if (isFetchInternalError(err)) {
    app.ctx.log(`Survived an internal error in Node's fetch (${String(err.message).replace(/\s+/g, ' ').trim()}); one connection was dropped`);
    return;
  }
  console.error(err);
  process.exit(1);
});

const addr = await app.start(port, host);
app.ctx.log(`Simple IPTV Manager ${app.ctx.appVersion} listening on http://${host}:${addr.port} (data: ${dataDir})`);

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
