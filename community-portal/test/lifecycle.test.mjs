import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { harness, until } from './harness.mjs';
import { DeviceClient } from '../device/client.mjs';
import { deviceProof, random } from '../service/security.mjs';

test('Tavily and Dial: claim, provision, durable receiver, ACK, usable credential, revoke', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const device = await h.connectInstallation();
  for (const perk of ['tavily', 'dial']) {
    assert.equal((await h.browser(`/grants/${perk}`, { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } })).status, 200);
    await device.reconcile();
    const credential = device.local.credentials[perk]; assert.ok(credential.secret);
    const use = await fetch(`${h.partners.origin}/${perk}/use`, { headers: { authorization: `Bearer ${credential.secret}` } });
    assert.equal(use.status, 200); assert.equal((await use.json()).simulated, true);
    const account = await h.store.load('acct_demo');
    assert.equal(account.grants[perk].redemptions[device.local.deviceId].state, 'DELIVERED');
    assert.equal(JSON.stringify(account).includes(credential.secret), false);
    assert.equal(h.store.db.prepare('SELECT body FROM audit').all().some(r => r.body.includes(credential.secret)), false);
    assert.equal((await stat(device.file)).mode & 0o777, 0o600);
    assert.equal((await h.browser(`/grants/${perk}`, { method: 'DELETE' })).status, 200);
    await device.reconcile(); assert.equal(device.local.credentials[perk], undefined);
    assert.equal((await fetch(`${h.partners.origin}/${perk}/use`, { headers: { authorization: `Bearer ${credential.secret}` } })).status, 401);
  }
  assert.equal(h.store.db.prepare("SELECT count(*) AS n FROM audit WHERE body LIKE '%termsHash%'").get().n, 2);
});

test('lost provider response recovers by name; retries and concurrency do not consume extra quota', async t => {
  const h = await harness({ withCell: false, limits: { globalDailyLimit: 1 } }); t.after(() => h.close());
  const device = await h.connectInstallation();
  await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  h.partners.faults.tavily = { dropNextIssue: true };
  const idempotencyKey = random();
  await assert.rejects(device.request('POST', '/api/v1/grants/tavily/redeem', { idempotencyKey }), e => e.status === 503);
  assert.equal((await h.store.load('acct_demo')).grants.tavily.redemptions[device.local.deviceId].state, 'UNCERTAIN');
  const calls = await Promise.allSettled([device.request('POST', '/api/v1/grants/tavily/redeem', { idempotencyKey }), device.request('POST', '/api/v1/grants/tavily/redeem', { idempotencyKey })]);
  assert.equal(calls.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.partners.db.prepare("SELECT count(*) AS n FROM resources WHERE provider='tavily' AND status='active'").get().n, 1);
  assert.equal(h.partners.db.prepare("SELECT count(*) AS n FROM resources WHERE provider='tavily'").get().n, 2);
  assert.equal(h.store.db.prepare('SELECT count FROM quotas').get().count, 1);
  const second = await h.connectInstallation(1);
  await assert.rejects(second.request('POST', '/api/v1/grants/tavily/redeem', { idempotencyKey: random() }), e => e.status === 429);
});

test('lost ACK: a restarted receiver acknowledges the existing local key without reissuing', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const device = await h.connectInstallation();
  await h.browser('/grants/dial', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  const original = device.request.bind(device);
  device.request = (method, route, body) => route.endsWith('/ack') ? Promise.reject(new Error('connection lost')) : original(method, route, body);
  await assert.rejects(device.reconcile(), /connection lost/);
  const recovered = await new DeviceClient({ origin: h.origin, token: h.tokens[0], file: device.file }).initialize();
  await recovered.reconcile();
  assert.equal(h.partners.db.prepare("SELECT count(*) AS n FROM resources WHERE provider='dial'").get().n, 1);
  assert.equal((await h.store.load('acct_demo')).grants.dial.redemptions[device.local.deviceId].state, 'DELIVERED');
  assert.match(JSON.parse(await readFile(device.file, 'utf8')).credentials.dial.resource.phoneNumber, /^\+120255501/);
});

test('consent, CSRF, account binding, key possession and nonce replay are enforced', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  assert.equal((await h.browser('/grants/tavily', { method: 'POST', body: { accepted: false, termsVersion: 'demo-2026-09-05' } })).status, 400);
  assert.equal((await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'old' } })).status, 400);
  assert.equal((await h.browser('/grants/tavily', { method: 'POST', csrf: 'wrong', body: { accepted: true, termsVersion: 'demo-2026-09-05' } })).status, 403);
  await assert.rejects(h.connectInstallation(3), e => e.status === 403);
  const device = await h.connectInstallation();
  const route = '/api/v1/device/state', headers = { authorization: `Bearer ${h.tokens[0]}`, ...deviceProof(device.local.privateKey, 'GET', route) };
  assert.equal((await fetch(`${h.origin}${route}`, { headers })).status, 200);
  assert.equal((await fetch(`${h.origin}${route}`, { headers })).status, 401);
  assert.equal((await fetch(`${h.origin}${route}`, { headers: { authorization: `Bearer ${h.tokens[0]}` } })).status, 401);
});

test('one provider can be unavailable; withdrawal stays pending and the other provider works', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const device = await h.connectInstallation();
  await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } }); await device.reconcile();
  h.partners.faults.tavily = { revokeUnavailable: true };
  await h.browser('/grants/tavily', { method: 'DELETE' });
  assert.equal((await h.store.load('acct_demo')).grants.tavily.redemptions[device.local.deviceId].state, 'REVOKING');
  await h.browser('/grants/dial', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } }); await device.reconcile();
  assert.ok(device.local.credentials.dial.secret);
  h.partners.faults.tavily.revokeUnavailable = false; await h.app.service.reconcile('acct_demo');
  assert.equal((await h.store.load('acct_demo')).grants.tavily.redemptions[device.local.deviceId].state, 'REVOKED');
});

test('recovery retains spent credits when replacement provisioning fails after revocation', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const device = await h.connectInstallation();
  await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  const idempotencyKey = random();
  const minted = await device.request('POST', '/api/v1/grants/tavily/redeem', { idempotencyKey });
  await fetch(`${h.partners.origin}/tavily/use`, { headers: { authorization: `Bearer ${minted.secret}` } });
  h.partners.faults.tavily = { issueUnavailable: true };
  await assert.rejects(device.request('POST', '/api/v1/grants/tavily/redeem', { idempotencyKey }), e => e.status === 503);
  assert.equal((await h.store.load('acct_demo')).grants.tavily.redemptions[device.local.deviceId].spent, 1);
  h.partners.faults.tavily.issueUnavailable = false;
  const recovered = await device.request('POST', '/api/v1/grants/tavily/redeem', { idempotencyKey });
  assert.equal(h.partners.db.prepare('SELECT credits FROM resources WHERE id=?').get(recovered.keyId).credits, 999);
});

test('withdrawing during an in-flight mint never delivers a new credential', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const device = await h.connectInstallation();
  await h.browser('/grants/dial', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  h.partners.faults.dial = { delayMs: 150 };
  const issuing = device.request('POST', '/api/v1/grants/dial/redeem', { idempotencyKey: random() });
  const rejected = assert.rejects(issuing, e => e.status === 409);
  await until(async () => (await h.store.load('acct_demo')).grants.dial.redemptions[device.local.deviceId]);
  await h.browser('/grants/dial', { method: 'DELETE' });
  await rejected; await h.app.service.reconcile('acct_demo');
  assert.equal(h.partners.db.prepare("SELECT count(*) AS n FROM resources WHERE status='active'").get().n, 0);
  assert.equal((await h.store.load('acct_demo')).grants.dial.redemptions[device.local.deviceId].state, 'REVOKED');
});

test('term expiry revokes resources even without a browser request', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const device = await h.connectInstallation();
  await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } }); await device.reconcile();
  await h.app.service.change('acct_demo', a => { a.grants.tavily.expiresAt = new Date(Date.now() - 1000).toISOString(); return { type: 'test.expiry' }; });
  await h.app.service.drain();
  assert.equal((await h.store.load('acct_demo')).grants.tavily.desired, 'withdrawn');
  assert.equal(h.partners.db.prepare("SELECT count(*) AS n FROM resources WHERE status='active'").get().n, 0);
  await device.reconcile(); assert.equal(device.local.credentials.tavily, undefined);
});
