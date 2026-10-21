// Who is really asking, and how many wrong guesses they've made.
//
// Behind a reverse proxy every request arrives from the proxy's address; the visitor's is in
// X-Forwarded-For. That header can be written by anyone, so it is only believed when the
// connection itself comes from a trusted proxy: by default anything on the local network or this
// machine (nginx, Caddy, Nginx Proxy Manager, Traefik, a Cloudflare tunnel), or the addresses in
// TRUSTED_PROXIES ("none" to trust no proxy).
import net from 'node:net';

const PRIVATE_V4 = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['100.64.0.0', 10]];
const PRIVATE_V6 = [['::1', 128], ['fc00::', 7], ['fe80::', 10]];

const plain = (ip) => String(ip || '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
const family = (ip) => (net.isIPv6(ip) ? 'ipv6' : net.isIPv4(ip) ? 'ipv4' : null);

function blockList(entries) {
  const list = new net.BlockList();
  for (const [addr, bits] of entries) {
    const f = family(addr);
    if (f) list.addSubnet(addr, bits, f);
  }
  return list;
}

const privateNets = blockList([...PRIVATE_V4, ...PRIVATE_V6]);

/** An address on a local network or this machine (not reachable from the internet). */
export function isPrivateAddress(ip) {
  const a = plain(ip);
  const f = family(a);
  return !!f && privateNets.check(a, f);
}

/**
 * Which proxies to believe, from TRUSTED_PROXIES: unset = the local network and this machine;
 * "none" = no proxy; otherwise a comma-separated list of addresses and CIDR ranges.
 */
export function trustedProxies(setting = process.env.TRUSTED_PROXIES) {
  const s = String(setting ?? '').trim();
  if (!s) return isPrivateAddress;
  if (/^none$/i.test(s)) return () => false;
  const list = new net.BlockList();
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [addr, bits] = part.split('/');
    const a = plain(addr);
    const f = family(a);
    if (!f) continue;
    if (bits) list.addSubnet(a, Number(bits), f);
    else list.addAddress(a, f);
  }
  return (ip) => {
    const a = plain(ip);
    const f = family(a);
    return !!f && list.check(a, f);
  };
}

/**
 * The visitor's address. X-Forwarded-For is read from the right (each proxy appends the address it
 * saw) and only through trusted proxies: the first hop that isn't one is the visitor.
 */
export function clientAddress(req, trusted = trustedProxies()) {
  let addr = plain(req.socket?.remoteAddress);
  if (!trusted(addr)) return addr;
  const hops = String(req.headers?.['x-forwarded-for'] || '').split(',').map(plain).filter((h) => family(h));
  for (let i = hops.length - 1; i >= 0; i--) {
    addr = hops[i];
    if (!trusted(addr)) break;
  }
  return addr;
}

/**
 * Counts wrong guesses per key (an address) in a time window: blocked once `max` is reached, until
 * the window passes. A success clears the key.
 */
export class Attempts {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map(); // key -> { count, until }
  }

  blocked(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (e.until <= Date.now()) {
      this.map.delete(key);
      return false;
    }
    return e.count >= this.max;
  }

  /** Records a wrong guess; returns true when this one reached the limit. */
  fail(key) {
    const now = Date.now();
    let e = this.map.get(key);
    if (!e || e.until <= now) e = { count: 0, until: now + this.windowMs };
    e.count++;
    this.map.set(key, e);
    if (this.map.size > 10_000) this.prune();
    return e.count === this.max;
  }

  ok(key) {
    this.map.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [k, e] of this.map) if (e.until <= now) this.map.delete(k);
  }
}
