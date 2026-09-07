import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { albHandler } from '../service/lambda.mjs';
import { kmsSigner } from '../service/kms.mjs';
import { createApp } from '../service/app.mjs';
import { catalog } from '../service/catalog.mjs';
import { harness } from './harness.mjs';
import { DeviceClient } from '../device/client.mjs';

test('KMS signer converts real DER signatures into valid ES256 tickets', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signer = kmsSigner('test-key', { async send(command) {
    assert.equal(command.input.SigningAlgorithm, 'ECDSA_SHA_256');
    assert.equal(command.input.MessageType, 'RAW');
    return { Signature: sign('sha256', command.input.Message, privateKey) };
  } });
  // Vary both integer encodings, including signatures whose R or S needs padding.
  for (let i = 0; i < 40; i++) {
    const ticket = await signer({ sub: 'acct_demo', leg: 'browser' });
    const [h, p, s] = ticket.split('.');
    assert.equal(Buffer.from(s, 'base64url').length, 64);
    assert.equal(verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
  }
});

test('ALB Lambda transport preserves cookies, encoded bodies and callback query values', async () => {
  process.env.PORTAL_ORIGIN = 'https://portal.example.test';
  const handler = albHandler(async () => ({ async fetch(request) {
    assert.equal(request.url, 'https://portal.example.test/api/v1/example?state=a%2Bb&state=second');
    assert.equal(request.headers.get('cookie'), 'first=1; second=2');
    assert.equal(await request.text(), '{"accepted":true}');
    const headers = new Headers(); headers.append('set-cookie', 'one=1; Secure'); headers.append('set-cookie', 'two=2; Secure');
    return new Response('ok', { status: 201, headers });
  } }));
  const response = await handler({ requestContext: { elb: {} }, path: '/api/v1/example', httpMethod: 'POST', multiValueHeaders: { cookie: ['first=1', 'second=2'], host: ['evil.example'] }, multiValueQueryStringParameters: { state: ['a%2Bb', 'second'] }, body: Buffer.from('{"accepted":true}').toString('base64'), isBase64Encoded: true });
  assert.equal(response.statusCode, 201); assert.deepEqual(response.multiValueHeaders['set-cookie'], ['one=1; Secure', 'two=2; Secure']);
});

test('production setup cannot enable demo login or claim unconfigured partners', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  assert.throws(() => createApp({ origin: 'https://portal.example.test', demo: true }), /loopback/);
  assert.throws(() => new DeviceClient({ origin: 'http://portal.example.test' }), /HTTPS/);
  const app = createApp({ store: h.store, identity: {}, origin: h.origin, demo: false, catalog: catalog(), adapters: {} });
  assert.equal((await app.fetch(new Request(`${h.origin}/api/v1/auth/demo`))).status, 404);
  await assert.rejects(app.service.claim('acct_demo', 'tavily', { accepted: true, termsVersion: 'demo-2026-09-05' }, 'test'), e => e.code === 'partner_unconfigured');
});


test('release catalog skips unavailable partners and rejects their setup or redemption while Echo and Slack remain available', async t => {
  const h = await harness({ withCell: false, limits: { catalog: catalog() } }); t.after(() => h.close());
  const { SetupClient } = await import('../device/setup-client.mjs');
  const client = await new SetupClient({ origin: h.origin, file: `${h.dir}/release-client.json` }).initialize();
  t.after(() => client.stop());
  for (const stage of ['tavily', 'dial', 'perks']) {
    assert.equal(await client.available(stage), false);
    await assert.rejects(client.start(stage), e => e.code === 'partner_unconfigured');
  }
  for (const stage of ['echo', 'slack']) assert.equal(await client.available(stage), true);
  assert.equal((await client.start('echo')).stage, 'echo');
  const app = createApp({ store: h.store, identity: {}, origin: h.origin, demo: false, catalog: catalog(), adapters: {}, globalDailyLimit: 0,
    workos: { clientId: 'client_test', apiKey: 'test-placeholder' } });
  const data = await (await app.fetch(new Request(`${h.origin}/api/v1/catalog`))).json();
  assert.equal(data.authentication, 'workos');
  assert.ok(data.items.filter(p => p.kind === 'account').every(p => p.mode === 'existing'));
  assert.ok(data.items.filter(p => p.kind !== 'account').every(p => !p.enabled && !p.termsVersion && !p.credits));
  for (const perk of ['tavily', 'dial']) {
    assert.equal((await app.fetch(new Request(`${h.origin}/api/v1/simulators/${perk}/use`, { method: 'POST' }))).status, 404);
    await assert.rejects(app.service.redeem('acct_demo', 'existing-device', perk, 'old-redemption-operation'), e => e.code === 'partner_unconfigured');
  }
  const auth = await app.fetch(new Request(`${h.origin}/api/v1/auth/start`));
  assert.equal(new URL(auth.headers.get('location')).hostname, 'api.workos.com');
  assert.deepEqual(await (await app.fetch(new Request(`${h.origin}/api/healthz`))).json(), { ok: true, service: 'community-perks' });
});
