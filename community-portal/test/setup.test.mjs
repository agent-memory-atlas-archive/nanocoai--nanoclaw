import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { harness, until } from './harness.mjs';
import { SetupClient } from '../device/setup-client.mjs';

test('CLI journal excludes a second writer and is reusable after the first stage closes', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const options = { origin: h.origin, token: h.tokens[0], file: path.join(h.dir, 'exclusive.json'), exclusive: true };
  const first = await new SetupClient(options).initialize(); t.after(() => first.stop());
  await assert.rejects(new SetupClient(options).initialize(), /Another setup or receiver owns/);
  first.local.imageSource = 'local'; await first.save(); await first.stop();
  const next = await new SetupClient(options).initialize(); t.after(() => next.stop());
  assert.equal(next.local.imageSource, 'local');
  assert.equal((await stat(options.file)).mode & 0o777, 0o600);
});

test('CLI → browser → original device: Echo choice, Slack create, perks and private credentials', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await new SetupClient({ origin: h.origin, token: h.tokens[0], file: path.join(h.dir, 'setup.json'), label: 'Setup laptop' }).initialize();
  for (const stage of ['echo', 'slack', 'perks']) {
    const flow = await client.start(stage, 'CLI default');
    assert.equal((await h.browser(`/setup/${flow.code}`)).data.stage, stage);
    const input = stage === 'echo' ? { imageSource: 'hardened' } : stage === 'slack' ? { workspaceId: 'TDEMO', name: 'Browser name' } : {};
    if (stage === 'perks') for (const perk of ['tavily', 'dial']) assert.equal((await h.browser(`/grants/${perk}`, { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } })).status, 200);
    const approval = await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { ...input, accepted: true } });
    assert.equal(approval.status, 200, JSON.stringify(approval.data));
    assert.deepEqual((await client.wait()).choice, input);
    if (stage === 'slack') {
      const app = await client.request('POST', `/api/v1/setup/${client.flow.code}/demo-slack`, {}); client.local.slack = app; await client.save();
      assert.equal(app.name, 'Browser name');
      await assert.rejects(client.request('POST', `/api/v1/setup/${client.flow.code}/demo-slack`, {}), e => e.code === 'already_created');
      await client.complete('complete', { appId: app.appId });
      const me = (await h.browser('/me')).data;
      assert.ok(me.included.find(p => p.id === 'slack').apps.some(a => a.id === app.appId));
      assert.ok(!JSON.stringify(me).includes(app.botToken)); assert.ok(!JSON.stringify(await h.store.load('acct_demo')).includes(app.appToken));
      assert.equal((await h.browser('/slack/revoke', { method: 'POST', body: { appId: app.appId, accepted: true } })).status, 200);
    } else { if (stage === 'perks') await client.reconcile(); await client.complete(); }
    assert.equal((await client.status()).status, 'complete');
  }
  assert.equal((await h.browser('/me')).data.devices[0].imageSource, 'hardened');
  assert.equal((await stat(client.file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(client.file, 'utf8'));
  assert.ok(saved.credentials.tavily.secret); assert.ok(saved.credentials.dial.secret);
});

test('setup approval binds account, key and browser session; claims cannot masquerade as setup', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await new SetupClient({ origin: h.origin, token: h.tokens[0], file: path.join(h.dir, 'setup-guards.json') }).initialize();
  const flow = await client.start('echo');
  await assert.rejects(client.request('POST', `/api/v1/setup/${flow.code}/approve`, { accepted: true, imageSource: 'hardened' }), e => e.status === 403);
  await assert.rejects(client.complete(), e => e.status === 409);
  assert.equal((await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', csrf: 'bad', body: { accepted: true, imageSource: 'hardened' } })).status, 403);
  assert.equal((await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { imageSource: 'hardened' } })).status, 400);
  const foreign = await new SetupClient({ origin: h.origin, token: h.tokens[3], file: path.join(h.dir, 'foreign.json') }).initialize();
  await assert.rejects(foreign.request('GET', `/api/v1/setup/${flow.code}`), e => e.status === 403);
  const otherDevice = await new SetupClient({ origin: h.origin, token: h.tokens[1], file: path.join(h.dir, 'other-device.json') }).initialize();
  await assert.rejects(otherDevice.request('GET', `/api/v1/setup/${flow.code}`), e => e.status === 403);
  assert.equal((await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true, imageSource: 'local' } })).status, 200);
  assert.equal((await h.browser(`/setup/${flow.code}/complete`, { method: 'POST', body: { status: 'complete' } })).status, 403);
  await client.wait(); await client.complete();
  assert.equal((await h.browser('/slack/connect', { method: 'POST', body: {} })).status, 400);
  assert.equal((await h.browser('/slack/revoke', { method: 'POST', body: { appId: 'NOTMINE', accepted: true } })).status, 404);
  assert.equal((await h.browser('/slack/disconnect', { method: 'POST', body: { teamId: 'TDEMO', accepted: true } })).status, 200);
  assert.equal((await h.browser('/slack/connect', { method: 'POST', body: { accepted: true } })).status, 200);
  const next = await client.start('slack');
  assert.equal((await h.browser(`/setup/${next.code}/approve`, { method: 'POST', body: { accepted: true, workspaceId: 'TFOREIGN', name: 'Agent' } })).status, 409);
});

test('existing account sources retain stale data independently and never publish token fields', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  let initial = (await h.browser('/me')).data;
  assert.deepEqual(initial.included.map(p => p.id), ['echo', 'slack']);
  const echo = initial.included[0], slack = initial.included[1];
  h.app.service.accountPerks.slack = async () => { throw new Error('not reachable'); };
  await until(() => Date.now() > Date.parse(slack.checkedAt));
  let refreshed = (await h.browser('/included/refresh', { method: 'POST', body: {} })).data;
  assert.equal(refreshed.included[0].freshness, 'current');
  assert.equal(refreshed.included[1].freshness, 'stale'); assert.deepEqual(refreshed.included[1].apps, slack.apps);
  h.app.service.accountPerks.echo = async () => ({ status: 'active', grantedAt: echo.grantedAt, secret: 'do-not-publish', token_ciphertext: 'ciphertext' });
  h.app.service.accountPerks.slack = async () => ({ status: 'not_connected', workspaces: [], apps: [], token: 'do-not-publish' });
  await until(() => Date.now() > Date.parse(refreshed.included[0].checkedAt));
  refreshed = (await h.browser('/included/refresh', { method: 'POST', body: {} })).data;
  assert.equal(refreshed.included[1].status, 'not_connected');
  assert.ok(!JSON.stringify(await h.store.load('acct_demo')).includes('do-not-publish'));
});
