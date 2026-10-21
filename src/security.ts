import type { Store } from './store';
import type { Row } from './types';

const encoder = new TextEncoder();
export const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
export const randomToken = (length = 32) => hex(crypto.getRandomValues(new Uint8Array(length)));
export const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
function unhex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[\da-f]{2})+$/i.test(value)) throw new Error('Invalid password hash');
  return Uint8Array.from(value.match(/../g)!, (c) => parseInt(c, 16));
}
export async function hashPassword(password: string, salt = randomToken(16), iterations = 100000) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unhex(salt), iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2_sha256$${iterations}$${salt}$${hex(bits)}`;
}
export function equal(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, salt, digest] = encoded.split('$');
  const iterations = Number(n);
  if (
    algorithm !== 'pbkdf2_sha256' ||
    !Number.isInteger(iterations) ||
    iterations < 10000 ||
    iterations > 1000000 ||
    !salt ||
    !digest
  )
    return false;
  // Existing local hashes remain valid; Web Crypto performs PBKDF2 asynchronously.
  return equal(await hashPassword(password, salt, iterations), encoded);
}
async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
const MAX_AGE = 14 * 86400;
export async function createSession(
  store: Store,
  user: Row,
  secret: string,
  secure: boolean,
): Promise<string> {
  const token = randomToken();
  const hash = await sha256(token);
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE;
  await store.run(
    'INSERT INTO sessions(token_hash,user_id,expires_at,password_version) VALUES(?,?,?,?)',
    [hash, user.id, expires, user.password_hash],
  );
  const cookie = `${token}.${await sign(token, secret)}`;
  return `iptv_cloud_session=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${secure ? '; Secure' : ''}`;
}
export async function sessionToken(request: Request, secret: string): Promise<string | null> {
  const cookie = request.headers.get('cookie')?.match(/(?:^|;\s*)iptv_cloud_session=([^;]+)/)?.[1];
  if (!cookie || !secret || secret.length < 32) return null;
  const [token, signature] = cookie.split('.');
  if (!/^[a-f0-9]{64}$/.test(token) || !signature || !equal(await sign(token, secret), signature))
    return null;
  return sha256(token);
}
export async function currentUser(
  store: Store,
  request: Request,
  secret: string,
): Promise<Row | null> {
  const token = await sessionToken(request, secret);
  if (!token) return null;
  return store.one(
    'SELECT u.* FROM sessions s JOIN admin_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.password_version=u.password_hash',
    [token, Math.floor(Date.now() / 1000)],
  );
}
export function safeReturn(value: string, fallback = '/_admin'): string {
  return value === '/_admin' || value.startsWith('/_admin/') || value.startsWith('/_admin?')
    ? value
    : fallback;
}
