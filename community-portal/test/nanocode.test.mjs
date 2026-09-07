import test from 'node:test';
import assert from 'node:assert/strict';
import { sshKey } from '../service/nanocode.mjs';
import { harness } from './harness.mjs';

import { publicKey, authorize } from './nanocode-helpers.mjs';

test('login authorizes the public key; device credentials alone cannot grant access', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const c = await h.connectInstallation(); c.local.sshPublicKey = publicKey();
  const f = await c.start('nanocode');
  assert.deepEqual((await c.request('GET', '/api/v1/nanocode/state')).keys, []);
  assert.equal((await h.browser(`/setup/${f.code}`)).status, 200);
  assert.deepEqual((await c.request('GET', '/api/v1/nanocode/state')).keys, []);
  await assert.rejects(c.request('POST', `/api/v1/setup/${f.code}/approve`, { accepted: true }), e => e.status === 403);
  assert.equal((await h.browser(`/setup/${f.code}/approve`, { method: 'POST', csrf: 'wrong', body: { accepted: true } })).status, 403);
  assert.equal((await h.browser(`/setup/${f.code}/approve`, { method: 'POST', body: { accepted: true } })).status, 200);
  await c.wait();
  const key = (await c.request('GET', '/api/v1/nanocode/state')).keys[0];
  assert.equal(key.actor, 'demo-member');
  assert.equal(key.deviceId, c.local.deviceId);
  assert.equal(key.publicKey, c.local.sshPublicKey);
  assert.equal(JSON.stringify(key).includes('private'), false);
});

test('access is installation-specific, opt-in, key-bound and revocable', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const owner = await h.connectInstallation(0), target = await h.connectInstallation(1), stranger = await h.connectInstallation(2);
  const key = await authorize(h, owner);
  const body = { deviceId: target.local.deviceId, fingerprint: key.fingerprint };
  await assert.rejects(owner.request('POST', '/api/v1/nanocode/ticket', body), e => e.status === 403);
  const hostKey = publicKey();
  await target.request('POST', '/api/v1/nanocode/host', { hostKey, user: 'test', enabled: true });
  const grant = await owner.request('POST', '/api/v1/nanocode/ticket', body);
  const claims = JSON.parse(Buffer.from(grant.ticket.split('.')[1], 'base64url'));
  assert.equal(claims.dev, target.local.deviceId); assert.equal(claims.client, owner.local.deviceId);
  assert.equal(claims.sub, h.user.account.id); assert.equal(claims.leg, 'ssh');
  assert.equal(grant.hostKey, hostKey); assert.equal(grant.socketUrl.includes('ticket='), false);
  await assert.rejects(stranger.request('POST', '/api/v1/nanocode/ticket', body), e => e.status === 403);
  await assert.rejects(target.request('POST', '/api/v1/nanocode/host', { hostKey: publicKey(), user: 'test', enabled: true }), e => e.status === 409);
  assert.equal((await h.browser('/nanocode/access', { method: 'POST', body: { deviceId: body.deviceId, enabled: false } })).status, 200);
  await assert.rejects(owner.request('POST', '/api/v1/nanocode/ticket', body), e => e.status === 403);
  await h.browser('/nanocode/access', { method: 'POST', body: { deviceId: body.deviceId, enabled: true, accepted: true } });
  await h.browser('/nanocode/key/revoke', { method: 'POST', body: { fingerprint: key.fingerprint } });
  await assert.rejects(owner.request('POST', '/api/v1/nanocode/ticket', body), e => e.status === 403);
});

test('SSH public-key parser rejects options, malformed wire lengths and private material', () => {
  const key = publicKey(); assert.match(sshKey(key).fingerprint, /^SHA256:/);
  for (const bad of [`command="sh" ${key}`, `${key}\n${key}`, 'ssh-ed25519 AAAA', '-----BEGIN OPENSSH PRIVATE KEY-----']) assert.throws(() => sshKey(bad));
});
