// Two-factor sign-in with time-based one-time codes (RFC 6238, as used by every authenticator
// app: 6 digits, 30-second steps, HMAC-SHA1), plus one-time recovery codes.
import crypto from 'node:crypto';
import qrcode from 'qrcode-generator';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_S = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect. */
export const newSecret = () => base32Encode(crypto.randomBytes(20));

/** The code for one 30-second step. */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

export const stepNow = (t = Date.now()) => Math.floor(t / 1000 / STEP_S);

/**
 * The step a code belongs to, allowing one step either side for clock drift, or null. A step at
 * or before lastStep was already used: a code works once.
 */
export function checkCode(secret, code, lastStep = -1, t = Date.now()) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = stepNow(t);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

export function otpauthUri(secret, account = 'admin', issuer = 'IPTV Manager') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
}

/** The setup QR code, as an SVG to put in the page. */
export function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// Recovery codes: "abcd-efgh", stored as SHA-256 (they are random, so no slow hash is needed).
const hashRecovery = (code) => crypto.createHash('sha256').update(String(code).toLowerCase().replace(/[\s-]/g, '')).digest('hex');

export function newRecoveryCodes(n = 8) {
  const codes = Array.from({ length: n }, () => {
    const s = base32Encode(crypto.randomBytes(5)).toLowerCase();
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`;
  });
  return { codes, hashes: codes.map(hashRecovery) };
}

/** If code is one of the recovery codes, the hashes left after using it; else null. */
export function useRecoveryCode(hashes, code) {
  const h = hashRecovery(code);
  return hashes.includes(h) ? hashes.filter((x) => x !== h) : null;
}
