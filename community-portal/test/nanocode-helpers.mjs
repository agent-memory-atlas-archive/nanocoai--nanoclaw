import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { sshKey } from '../service/nanocode.mjs';

export function publicKey() {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const wire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), raw]);
  return `ssh-ed25519 ${wire.toString('base64')}`;
}
export async function authorize(h, c, key = publicKey()) {
  c.local.sshPublicKey = key;
  const flow = await c.start('nanocode');
  const answer = await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true, actor: 'forged' } });
  assert.equal(answer.status, 200, JSON.stringify(answer));
  await c.wait(); await c.complete();
  return sshKey(c.local.sshPublicKey);
}
