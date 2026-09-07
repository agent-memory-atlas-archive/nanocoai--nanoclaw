import { createHash, randomBytes, createPrivateKey, createPublicKey, sign, verify, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export const random = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
});
export function publicDeviceKey(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.d || !jwk.x || !jwk.y) fail(400, 'invalid_key', 'Provide a public P-256 device key.');
  try { createPublicKey({ key: jwk, format: 'jwk' }); } catch { fail(400, 'invalid_key', 'The device key is invalid.'); }
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}
export function proofText(method, path, body, timestamp, nonce) {
  return ['nanoclaw-perks-device-v1', method, path, hash(body), timestamp, nonce].join('\n');
}
export function deviceProof(privateKey, method, path, body = '') {
  const timestamp = String(Date.now()), nonce = random(16);
  const signature = sign('sha256', Buffer.from(proofText(method, path, body, timestamp, nonce)), {
    key: createPrivateKey({ key: privateKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { 'x-device-time': timestamp, 'x-device-nonce': nonce, 'x-device-proof': signature };
}
export async function verifyDeviceProof(request, body, key, store, deviceId) {
  const timestamp = request.headers.get('x-device-time'), nonce = request.headers.get('x-device-nonce');
  const signature = request.headers.get('x-device-proof');
  if (!/^\d{13}$/.test(timestamp || '') || !/^[\w-]{16,80}$/.test(nonce || '') || Math.abs(Date.now() - Number(timestamp)) > 60_000 || !signature) {
    fail(401, 'device_proof_required', 'A fresh device-key proof is required.');
  }
  let valid = false;
  try {
    valid = verify('sha256', Buffer.from(proofText(request.method, new URL(request.url).pathname, body, timestamp, nonce)), {
      key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signature, 'base64url'));
  } catch { /* malformed signatures are authentication failures */ }
  if (!valid || !await store.putOnce(`NONCE#${deviceId}#${nonce}`, {}, Date.now() + 120_000)) fail(401, 'invalid_proof', 'The device proof is invalid or has already been used.');
}
export function signTicket(privateJwk, claims, seconds = 900) {
  const input = ticketInput(claims, seconds);
  const signature = sign('sha256', Buffer.from(input), { key: createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${input}.${signature}`;
}
export function ticketInput(claims, seconds = 900) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iss: 'nanoclaw-perks', aud: 'nanoclaw-cell', iat: now, exp: now + seconds, ...claims })).toString('base64url');
  return `${header}.${payload}`;
}
