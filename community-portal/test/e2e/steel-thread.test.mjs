import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness, until } from '../harness.mjs';
import { signTicket } from '../../service/security.mjs';

test('real celld: both partners reach two devices, sockets stay isolated, restart restores state', { timeout: 90_000 }, async t => {
  const h = await harness(); t.after(() => h.close());
  const first = await h.connectInstallation(0), second = await h.connectInstallation(1);
  const browser = await h.socketFor(), host1 = await h.socketFor('device', first.local.deviceId), host2 = await h.socketFor('device', second.local.deviceId);
  assert.equal(host2.messages.find(m => m.type === 'snapshot').presence.length, 2);
  for (const perk of ['tavily', 'dial']) {
    assert.equal((await h.browser(`/grants/${perk}`, { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } })).status, 200);
    await until(() => host1.messages.some(m => m.type === 'perks.changed' && m.snapshot.grants.some(g => g.perk === perk)), 5000, 'perk notification');
    await Promise.all([first.reconcile(), second.reconcile()]);
    const account = await h.store.load('acct_demo');
    assert.equal(Object.values(account.grants[perk].redemptions).filter(r => r.state === 'DELIVERED').length, 2);
    assert.notEqual(first.local.credentials[perk].secret, second.local.credentials[perk].secret);
    if (perk === 'dial') assert.notEqual(first.local.credentials[perk].resource.phoneNumber, second.local.credentials[perk].resource.phoneNumber);
  }
  const third = await h.connectInstallation(2);
  await assert.rejects(third.reconcile(), e => e.code === 'device_cap');
  const secrets = [...Object.values(first.local.credentials), ...Object.values(second.local.credentials)].map(c => c.secret);
  const published = JSON.stringify([...browser.messages, ...host1.messages, ...host2.messages]);
  for (const secret of secrets) assert.equal(published.includes(secret), false);
  host1.ws.send(JSON.stringify({ type: 'revoke', perk: 'dial' }));
  await until(() => host1.messages.some(m => m.error === 'read_only'));
  assert.equal((await h.store.load('acct_demo')).grants.dial.desired, 'active');
  const browserTicket = h.app.service.ticket('acct_demo', 'browser');
  assert.equal((await fetch(`${h.cellOrigin}/cell/events`, { method: 'POST', headers: { authorization: `Bearer ${browserTicket}`, 'x-cell-claims': JSON.stringify({ leg: 'service', sub: 'acct_demo' }) }, body: '{}' })).status, 403);
  const expired = signTicket(h.signingKey, { sub: 'acct_demo', leg: 'browser', exp: 1 });
  assert.equal((await fetch(`${h.cellOrigin}/cell/state`, { headers: { authorization: `Bearer ${expired}` } })).status, 401);
  const before = await (await fetch(`${h.cellOrigin}/cell/state`, { headers: { authorization: `Bearer ${browserTicket}` } })).json();
  await h.stopCell(); await h.startCell();
  // Read directly, without obtaining a new ticket or reseeding from the service.
  const restored = await (await fetch(`${h.cellOrigin}/cell/state`, { headers: { authorization: `Bearer ${browserTicket}` } })).json();
  assert.deepEqual(restored.snapshot, before.snapshot);
  await h.socketFor('device', first.local.deviceId);
  await h.browser(`/devices/${first.local.deviceId}`, { method: 'DELETE' });
  await until(async () => {
    const a = await h.store.load('acct_demo');
    return Object.values(a.grants).every(g => g.redemptions[first.local.deviceId].state === 'REVOKED');
  });
  for (const perk of ['tavily', 'dial']) {
    assert.equal((await fetch(`${h.partners.origin}/${perk}/use`, { headers: { authorization: `Bearer ${first.local.credentials[perk].secret}` } })).status, 401);
    assert.equal((await fetch(`${h.partners.origin}/${perk}/use`, { headers: { authorization: `Bearer ${second.local.credentials[perk].secret}` } })).status, 200);
  }
  const cellLog = await readFile(`${h.dir}/cell.log`, 'utf8');
  for (const secret of secrets) assert.equal(cellLog.includes(secret), false);
});

test('outbox catches up after a cell outage, and a stale snapshot cannot roll it back', { timeout: 60_000 }, async t => {
  const h = await harness(); t.after(() => h.close());
  await h.connectInstallation();
  const early = (await h.browser('/me')).data;
  await h.stopCell();
  await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM outbox').get().n, 1);
  await h.startCell(); await h.app.service.reconcile('acct_demo');
  const ticket = h.app.service.ticket('acct_demo', 'browser');
  const snapshot = await (await fetch(`${h.cellOrigin}/cell/state`, { headers: { authorization: `Bearer ${ticket}` } })).json();
  assert.equal(snapshot.snapshot.grants[0].desired, 'active');
  const { hash } = await import('../../service/security.mjs');
  const body = JSON.stringify({ account: early.account, revision: early.revision, devices: early.devices, grants: early.grants, events: early.events });
  const serviceTicket = signTicket(h.signingKey, { sub: 'acct_demo', leg: 'service', digest: hash(body) }, 60);
  const stale = await fetch(`${h.cellOrigin}/cell/events`, { method: 'POST', headers: { authorization: `Bearer ${serviceTicket}` }, body });
  assert.equal((await stale.json()).applied, false);
  const after = await (await fetch(`${h.cellOrigin}/cell/state`, { headers: { authorization: `Bearer ${ticket}` } })).json();
  assert.equal(after.snapshot.revision, snapshot.snapshot.revision);
});
