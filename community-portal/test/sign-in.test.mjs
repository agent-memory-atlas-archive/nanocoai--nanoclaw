import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { harness } from './harness.mjs';
import { SetupClient } from '../device/setup-client.mjs';
import { createApp } from '../service/app.mjs';
import { demoIdentity } from '../service/identity.mjs';
import { hash } from '../service/security.mjs';
import { currentSession } from '../service/session.mjs';
import { openInstall } from '../protocol/install-envelope.mjs';

const tokens = () => ({ access_token: `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`, refresh_token: 'workos-refresh-private', user: { id: 'user_test', email: 'test@example.test', email_verified: true } });

test('one WorkOS code exchange signs in the browser and fresh CLI; later stages reuse both credentials', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const identity = demoIdentity({}, h.store);
  let userCalls = 0, workosCalls = 0;
  const app = createApp({ origin: h.origin, store: h.store, identity: { ...identity, user: async user => { assert.equal(user.email_verified, true); userCalls++; return identity.user(); } }, workos: { clientId: 'client_test', apiKey: 'server-key' }, catalog: [], adapters: {} });
  app.service.flush = async () => true;
  const fetchOriginal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).startsWith('https://api.workos.com/')) {
      const body = JSON.parse(options.body); assert.equal(body.grant_type, 'authorization_code'); assert.ok(body.code_verifier);
      workosCalls++; return Response.json(tokens());
    }
    return fetchOriginal(url, options);
  });
  const cli = await new SetupClient({ origin: h.origin, file: path.join(h.dir, 'fresh.json'), label: 'Fresh laptop' }).initialize();
  let flow = await cli.start('echo');
  assert.equal(cli.token, undefined);
  const begin = await app.fetch(new Request(`${h.origin}/api/v1/auth/start?returnTo=${encodeURIComponent(`/?setup=${flow.code}`)}`));
  const authorize = new URL(begin.headers.get('location')), oauthCookie = begin.headers.get('set-cookie').split(';')[0];
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  const callbackUrl = `${h.origin}/api/v1/auth/callback?state=${authorize.searchParams.get('state')}&code=workos-code`;
  assert.equal((await app.fetch(new Request(callbackUrl))).status, 401, 'login CSRF rejects a different browser');
  const callback = await app.fetch(new Request(callbackUrl, { headers: { cookie: oauthCookie } }));
  assert.equal(callback.status, 303); assert.equal(callback.headers.get('location'), `/?setup=${flow.code}`);
  assert.equal((await app.fetch(new Request(callbackUrl, { headers: { cookie: oauthCookie } }))).status, 401, 'callback is single-use');
  const cookie = callback.headers.get('set-cookie').split(';')[0];
  const me = await (await app.fetch(new Request(`${h.origin}/api/v1/me`, { headers: { cookie } }))).json();
  const browser = async (route, body) => {
    const response = await fetchOriginal(`${h.origin}/api/v1${route}`, { method: body ? 'POST' : 'GET', headers: { cookie, origin: h.origin, 'x-csrf-token': me.csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response.json();
  };
  const view = await browser(`/setup/${flow.code}`);
  assert.equal(view.status, 'pending'); assert.equal((await cli.status()).status, 'pending', 'viewing a link cannot authorize a CLI');
  const approved = await browser(`/setup/${flow.code}/approve`, { accepted: true, imageSource: 'hardened' });
  assert.equal(approved.envelope, undefined, 'browser never receives the credential handoff');
  const delivery = await cli.status();
  assert.ok(delivery.envelope);
  const wrongKey = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  assert.throws(() => openInstall(wrongKey, `${flow.id}:${cli.local.installId}`, delivery.envelope));
  assert.throws(() => openInstall(cli.local.wrappingPrivateKey, 'different-setup', delivery.envelope));
  // Simulate a lost delivery response and process restart before persistence.
  const resumed = await new SetupClient({ origin: h.origin, file: cli.file }).initialize();
  assert.equal((await resumed.start('echo')).code, flow.code);
  await resumed.wait(); const token = resumed.token;
  assert.ok(token); assert.equal((await stat(cli.file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(cli.file)).registryAccount.token, token);
  await resumed.complete();
  const sessionKey = `SESSION#${hash(cookie.split('=')[1])}`, session = await h.store.get(sessionKey);
  await h.store.compareSwap(sessionKey, session, { ...session, authenticatedAt: Date.now() - 30 * 60_000 }, session.expires);
  for (const stage of ['slack', 'perks']) {
    flow = await resumed.start(stage);
    await browser(`/setup/${flow.code}/approve`, { accepted: true, ...(stage === 'slack' ? { workspaceId: 'TDEMO', name: 'Nova' } : {}) });
    assert.equal((await resumed.status()).envelope, undefined, 'returning stage reuses its installation token');
    await resumed.wait(); await resumed.complete(); assert.equal(resumed.token, token);
  }
  assert.equal(workosCalls, 1); assert.equal(userCalls, 1);
  assert.ok(!JSON.stringify(await h.store.load('acct_demo')).includes(token));
  assert.ok(!JSON.stringify(await h.store.load('acct_demo')).includes('workos-refresh-private'));
  assert.equal((await h.browser('/device-codes', { method: 'POST', body: {} })).status, 404);
});

test('installation revocation rejects old tokens and setup receipts; re-sign-in requires a new browser choice', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const other = await h.connectInstallation(1);
  const cli = await new SetupClient({ origin: h.origin, file: path.join(h.dir, 'revoke.json') }).initialize();
  let flow = await cli.start('perks');
  await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true } });
  await cli.wait(); const oldToken = cli.token;
  await cli.complete();
  assert.equal((await h.browser(`/devices/${cli.local.deviceId}`, { method: 'DELETE' })).status, 200);
  await assert.rejects(cli.reconcile(), e => e.code === 'installation_revoked');
  await assert.rejects(cli.status(), e => e.code === 'installation_revoked');
  cli.token = undefined;
  await assert.rejects(cli.status(), e => e.code === 'installation_revoked', 'a receipt cannot resurrect a revoked installation');
  cli.token = oldToken;
  flow = await cli.start('perks');
  assert.equal((await cli.status()).status, 'pending'); assert.equal(cli.token, undefined);
  await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true } });
  await cli.wait(); await cli.reconcile(); assert.notEqual(cli.token, oldToken);
  await other.reconcile();
  const freshToken = cli.token; cli.token = oldToken;
  await assert.rejects(cli.reconcile(), e => e.code === 'installation_revoked'); cli.token = freshToken;
});

test('anonymous setup is proof-bound, rate limited and cannot be claimed by two accounts', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const cli = await new SetupClient({ origin: h.origin, file: path.join(h.dir, 'anon.json') }).initialize();
  const stranger = await new SetupClient({ origin: h.origin, file: path.join(h.dir, 'stranger.json') }).initialize();
  const flow = await cli.start('perks');
  await assert.rejects(stranger.request('GET', `/api/v1/setup/${flow.code}`), e => e.status === 401);
  await assert.rejects(cli.complete(), e => e.status === 409);
  assert.equal((await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', csrf: 'bad', body: { accepted: true } })).status, 403);
  await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true } });
  const key = `SESSION#${hash(h.cookie.split('=')[1])}`, session = await h.store.get(key);
  await h.store.compareSwap(key, session, { ...session, accountId: 'acct_other' }, session.expires);
  assert.equal((await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true } })).status, 403);
  const body = { stage: 'perks', installId: cli.local.installId, publicKey: cli.local.publicKey, wrappingKey: cli.local.wrappingPublicKey };
  let limited = false;
  for (let i = 0; i < 35; i++) { try { await cli.request('POST', '/api/v1/setup/start', body); } catch (e) { assert.equal(e.status, 429); limited = true; break; } }
  assert.equal(limited, true);
});

test('WorkOS refresh is shared across concurrent requests, preserves transient failures, and cannot revive logout', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const data = { accountId: 'acct_demo', refreshToken: 'old', accessExpires: 0, expires: Date.now() + 60000 };
  const key = 'SESSION#refresh-test'; await h.store.putOnce(key, data, data.expires);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; await new Promise(r => setTimeout(r, 20)); return Response.json(tokens()); });
  const results = await Promise.all([currentSession(h.store, key, {}), currentSession(h.store, key, {})]);
  assert.equal(calls, 1); assert.deepEqual(results[0], results[1]);
  await h.store.delete(key); await h.store.putOnce(key, data, data.expires);
  globalThis.fetch = async () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  await assert.rejects(currentSession(h.store, key, {}), e => e.status === 503); assert.deepEqual(await h.store.get(key), data);
  globalThis.fetch = async () => { await h.store.delete(key); return Response.json(tokens()); };
  await assert.rejects(currentSession(h.store, key, {}), e => e.status === 401); assert.equal(await h.store.get(key), null);
  await h.store.putOnce(key, data, data.expires);
  globalThis.fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await assert.rejects(currentSession(h.store, key, {}), e => e.status === 401); assert.equal(await h.store.get(key), null);
});
