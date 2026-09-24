import crypto from 'node:crypto';
import { parseCookies } from './http.js';

const SESSION_DAYS = 30;
export const COOKIE = 'iptvm_session';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Stateless session: "<expiry>.<generation>.<hmac>". Bumping the generation
// (on password change or logout-everywhere) invalidates every existing cookie.
export function makeSession(secret, generation) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${exp}.${generation}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return { value: `${payload}.${sig}`, maxAge: SESSION_DAYS * 86400 };
}

export function checkSession(req, secret, generation) {
  const v = parseCookies(req)[COOKIE];
  if (!v) return false;
  const [exp, gen, sig] = v.split('.');
  if (!exp || !gen || !sig) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${exp}.${gen}`).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now() / 1000 && gen === String(generation);
}

export function sessionCookie(value, maxAge, secure) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
