import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { harness } from './harness.mjs';
import { SetupClient } from '../device/setup-client.mjs';

const termsVersion = 'demo-2026-09-05';
async function clientFor(h, t, name = 'activation') {
  const client = await new SetupClient({ origin: h.origin, file: path.join(h.dir, `${name}.json`), label: 'Activation laptop' }).initialize();
  t.after(() => client.stop()); return client;
}
async function enable(h, code, id, extra = {}) {
  const response = await h.browser(`/activations/${id}`, { method: 'POST', body: { accepted: true, termsVersion, setupCode: code, ...extra } });
  assert.equal(response.status, 200, JSON.stringify(response.data)); return response.data;
}

test('one-click activation holds the CLI for browsing, then delivers credentials and reuses all enabled perks', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t);
  assert.equal(await client.resumeEnabled('tavily'), false);
  const flow = await client.start('tavily');
  assert.equal((await client.status()).status, 'pending');
  const activated = await enable(h, flow.code, 'tavily');
  assert.equal(activated.activations.tavily.enabled, true);
  const pending = await client.status();
  assert.equal(pending.status, 'browsing'); assert.equal(pending.envelope, undefined);
  assert.equal(client.token, undefined);
  const grant = activated.grants.find(g => g.perk === 'tavily');
  const repeated = await enable(h, flow.code, 'tavily');
  assert.equal(repeated.grants.find(g => g.perk === 'tavily').id, grant.id);
  await enable(h, flow.code, 'echo'); await enable(h, flow.code, 'dial');
  await enable(h, flow.code, 'slack', { workspaceId: 'TDEMO' });
  assert.equal((await client.status()).status, 'browsing');
  assert.equal((await h.browser(`/setup/${flow.code}/return`, { method: 'POST' })).data.status, 'approved');
  const result = await client.wait(); assert.equal(result.status, 'approved'); assert.ok(client.token);
  await client.reconcile(); await client.complete();
  assert.ok(client.local.credentials.tavily.secret); assert.ok(client.local.credentials.dial.secret);
  const browser = JSON.stringify((await h.browser('/me')).data);
  for (const secret of [client.token, client.local.credentials.tavily.secret, client.local.credentials.dial.secret]) assert.ok(!browser.includes(secret));
  for (const stage of ['echo', 'slack', 'tavily', 'dial']) {
    assert.equal(await client.resumeEnabled(stage, 'Nova'), true);
    const saved = await client.wait();
    if (stage === 'echo') assert.equal(saved.choice.imageSource, 'hardened');
    if (stage === 'slack') assert.deepEqual(saved.choice, { workspaceId: 'TDEMO', name: 'Nova' });
    await client.complete();
  }
  assert.equal((await h.browser('/me')).data.devices.length, 1);
});

test('return without activating anything skips the stage without enrolling the installation', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t), flow = await client.start('echo');
  const response = await h.browser(`/setup/${flow.code}/return`, { method: 'POST' });
  assert.equal(response.status, 200); assert.equal(response.data.status, 'skipped');
  assert.equal((await client.wait()).status, 'skipped');
  assert.equal(client.token, undefined); assert.equal(client.local.deviceId, undefined);
  assert.equal((await h.browser('/me')).data.devices.length, 0);
  assert.equal(await client.resumeEnabled('echo'), false);
  assert.notEqual((await client.start('echo')).id, flow.id);
});

test('activating a different perk still delivers it when the original stage is skipped', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t), flow = await client.start('echo');
  await enable(h, flow.code, 'dial');
  assert.equal((await h.browser(`/setup/${flow.code}/return`, { method: 'POST' })).data.status, 'skipped');
  assert.equal((await client.wait()).status, 'skipped'); assert.ok(client.token);
  await client.reconcile(); assert.ok(client.local.credentials.dial.secret);
  assert.equal(await client.resumeEnabled('echo'), false);
  assert.equal(await client.resumeEnabled('dial'), true);
});

test('explicit dismissal skips a browsing flow even when that account already has Slack enabled', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t), flow = await client.start('slack');
  await h.browser(`/setup/${flow.code}/authorize`, { method: 'POST', body: { accepted: true } });
  assert.equal((await h.browser('/me')).data.activations.slack.enabled, true);
  const result = await h.browser(`/setup/${flow.code}/return`, { method: 'POST', body: { skip: true } });
  assert.equal(result.status, 200); assert.equal(result.data.status, 'skipped');
  assert.deepEqual((await client.wait()).choice, {});
  await assert.rejects(client.request('POST', `/api/v1/setup/${flow.code}/demo-slack`, {}), e => e.code === 'setup_not_approved');
  assert.equal((await h.browser('/me')).data.activations.slack.enabled, true, 'dismissal does not revoke account access');
  assert.notEqual((await client.start('slack')).id, flow.id, 'a later offer creates a new handoff');
});

test('dismissal releases a new CLI without enrollment and cannot undo an activation already accepted', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t), first = await client.start('echo');
  const post = code => h.browser(`/setup/${code}/return`, { method: 'POST', body: { skip: true } });
  assert.equal((await post(first.code)).data.status, 'skipped');
  assert.equal((await client.wait()).status, 'skipped'); assert.equal(client.token, undefined);
  assert.equal((await h.browser('/me')).data.devices.length, 0);
  client.autoContinue = true;
  const second = await client.start('echo');
  await enable(h, second.code, 'echo');
  assert.equal((await post(second.code)).data.status, 'approved');
  await client.wait(); await client.complete();
  assert.equal((await post(second.code)).data.status, 'complete');
});

test('activation and terminal return require the browser session, consent, CSRF and the owning account', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t), flow = await client.start('tavily');
  assert.equal((await h.browser('/activations/tavily', { method: 'POST', body: { setupCode: flow.code, termsVersion } })).status, 400);
  assert.equal((await h.browser('/activations/tavily', { method: 'POST', csrf: 'wrong', body: { accepted: true, setupCode: flow.code, termsVersion } })).status, 403);
  assert.equal((await client.status()).status, 'pending');
  await assert.rejects(client.request('POST', `/api/v1/setup/${flow.code}/return`, {}), e => e.status === 403);
  assert.equal((await h.browser(`/setup/${flow.code}/return`, { method: 'POST', csrf: 'wrong' })).status, 403);
  const foreign = await new SetupClient({ origin: h.origin, token: h.tokens[3], file: path.join(h.dir, 'foreign.json') }).initialize(); t.after(() => foreign.stop());
  const other = await foreign.start('tavily');
  assert.equal((await h.browser(`/setup/${other.code}/return`, { method: 'POST' })).status, 403);
  assert.equal((await h.browser('/activations/tavily', { method: 'POST', body: { accepted: true, setupCode: other.code, termsVersion } })).status, 403);
});

test('later steps recheck revocation, source freshness and the installation before skipping the browser', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t), flow = await client.start('echo');
  await enable(h, flow.code, 'echo');
  await h.browser(`/setup/${flow.code}/return`, { method: 'POST' }); await client.wait(); await client.complete();
  assert.equal(await client.resumeEnabled('echo'), true); await client.wait(); await client.complete();
  h.app.service.accountPerks.echo = async () => ({ status: 'revoked' });
  assert.equal(await client.resumeEnabled('echo'), false);
  h.app.service.accountPerks.slack = async () => { throw new Error('source unavailable'); };
  assert.equal(await client.resumeEnabled('slack'), false);
  await h.browser(`/devices/${client.local.deviceId}`, { method: 'DELETE' });
  assert.equal(await client.resumeEnabled('echo'), false); assert.equal(client.token, undefined);
});

test('Slack authorization survives OAuth while the CLI waits, then stores the connected workspace', async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const client = await clientFor(h, t), flow = await client.start('slack', 'Nova');
  await h.browser('/slack/disconnect', { method: 'POST', body: { accepted: true, teamId: 'TDEMO' } });
  assert.equal((await h.browser(`/setup/${flow.code}/authorize`, { method: 'POST', body: { accepted: true } })).data.status, 'browsing');
  assert.equal((await client.status()).envelope, undefined);
  assert.equal((await h.browser('/activations/slack', { method: 'POST', body: { accepted: true, setupCode: flow.code, workspaceId: 'TDEMO' } })).status, 409);
  await h.browser('/slack/connect', { method: 'POST', body: { accepted: true } });
  await enable(h, flow.code, 'slack', { workspaceId: 'TDEMO' });
  assert.equal((await client.status()).status, 'browsing');
  await h.browser(`/setup/${flow.code}/return`, { method: 'POST' });
  assert.deepEqual((await client.wait()).choice, { workspaceId: 'TDEMO', name: 'Nova' });
  const app = await client.request('POST', `/api/v1/setup/${client.flow.code}/demo-slack`, {}); assert.ok(app.botToken); await client.complete('complete', { appId: app.appId });
});
