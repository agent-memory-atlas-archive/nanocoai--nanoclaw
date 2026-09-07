import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

// Shared by the registry issuer and the bundled CLI. The browser and portal
// store only ciphertext; only the originating installation has the private key.
export function wrappingKey(jwk) {
  if (jwk?.kty !== 'OKP' || jwk.crv !== 'X25519' || jwk.d || !/^[\w-]{43}$/.test(jwk.x || '')) throw new Error('Invalid installation wrapping key');
  const key = { kty: 'OKP', crv: 'X25519', x: jwk.x };
  createPublicKey({ key, format: 'jwk' });
  return key;
}
const aad = context => Buffer.from(JSON.stringify(['nanoclaw-install-v1', context]));
function derive(privateKey, publicKey, context) {
  const secret = diffieHellman({ privateKey, publicKey });
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), aad(context), 32));
}
export function sealInstall(publicJwk, context, credential) {
  const pair = generateKeyPairSync('x25519'), iv = randomBytes(12);
  const key = derive(pair.privateKey, createPublicKey({ key: wrappingKey(publicJwk), format: 'jwk' }), context);
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
  return { version: 1, context, publicKey: pair.publicKey.export({ format: 'jwk' }), iv: iv.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
export function openInstall(privateJwk, expectedContext, envelope) {
  if (envelope?.version !== 1 || envelope.context !== expectedContext) throw new Error('Installation credential belongs to another setup');
  const key = derive(createPrivateKey({ key: privateJwk, format: 'jwk' }), createPublicKey({ key: wrappingKey(envelope.publicKey), format: 'jwk' }), expectedContext);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAAD(aad(expectedContext)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString());
}
