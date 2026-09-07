import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { SetupClient } from '../../device/setup-client.mjs';
import { buildHost } from '../../scripts/build-host.mjs';
import { harness, until } from '../harness.mjs';
import { signedInHost } from '../host-harness.mjs';
import { signTicket } from '../../service/security.mjs';

test('packaged host connects after setup exits, receives both perks, survives cell loss and keeps one installation identity', { timeout: 60_000 }, async t => {
  const h = await harness();
  const runtimes = [];
  let cli;
  t.after(async () => { await cli?.stop(); for (const runtime of runtimes.reverse()) await runtime.stop(); await h.close(); });
  const host = await signedInHost(h);
  const events = [];
  const runtime = host.startPortalRuntime({ root: h.dir, intervalMs: 100, log: event => events.push(event) });
  runtimes.push(runtime);
  await until(async () => (await host.cell()).presence.length === 1, 15_000, 'host presence');
  const duplicate = host.startPortalRuntime({ root: h.dir, intervalMs: 100 });
  runtimes.push(duplicate);
  await sleep(250);
  assert.equal((await host.cell()).presence.length, 1);
  assert.equal((await h.store.load(h.user.account.id)).devices[host.identity.deviceId].installId, host.identity.installId);

  await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  await until(async () => (await host.read()).credentials.tavily, 10_000, 'delivery with setup closed');
  await until(async () => (await h.store.load(h.user.account.id)).grants.tavily.redemptions[host.identity.deviceId]?.state === 'DELIVERED');

  // Holding a new foreground setup must not disconnect the service or let a
  // second writer replace the journal. Delivery resumes when that step ends.
  cli = await new SetupClient({ origin: h.origin, file: host.file, exclusive: true, waitForLockMs: 5000 }).initialize();
  cli.local.reminders = { echo: true }; await cli.save();
  await h.browser('/grants/dial', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  await sleep(250);
  assert.equal((await host.cell()).presence.length, 1);
  assert.equal((await host.read()).credentials.dial, undefined);
  await cli.stop();
  await until(async () => (await host.read()).credentials.dial, 10_000, 'delivery after foreground releases journal');
  assert.deepEqual((await host.read()).reminders, { echo: true });
  assert.equal((await stat(host.file)).mode & 0o777, 0o600);

  await h.stopCell();
  await until(() => events.some(event => event.event === 'disconnected'));
  await h.startCell();
  await until(async () => (await host.cell()).presence.length === 1, 15_000, 'host reconnect');
  const local = await host.read();
  assert.equal(local.installId, host.identity.installId);
  assert.equal(local.deviceId, host.identity.deviceId);
  assert.equal(local.registryAccount.token, host.identity.registryAccount.token);
  assert.equal(Object.keys((await h.store.load(h.user.account.id)).devices).length, 1);
  // Force a real cell ticket expiry on the next connection. The returning
  // runtime must reauthenticate, rather than enroll another installation.
  h.app.service.signer = (claims, seconds) => signTicket(h.signingKey, claims, claims.leg === 'device' ? 2 : seconds ?? 900);
  await duplicate.stop();
  await runtime.stop();
  const renewed = host.startPortalRuntime({ root: h.dir, intervalMs: 100, log: event => events.push(event) });
  runtimes.push(renewed);
  const connectionsBefore = events.filter(e => e.event === 'connected').length;
  await until(() => events.filter(e => e.event === 'connected').length >= connectionsBefore + 2, 15_000, 'ticket expiry and renewal');
  assert.equal((await host.read()).installId, host.identity.installId);
  for (const secret of [local.registryAccount.token, ...Object.values(local.credentials).map(c => c.secret)]) assert.equal(JSON.stringify(events).includes(secret), false);
  await duplicate.stop(); await runtime.stop(); await renewed.stop();
  await until(async () => (await host.cell()).presence.length === 0, 5000, 'host shutdown disconnect');
});

test('signing out disconnects the host and removes local perk credentials without enrolling again', { timeout: 30_000 }, async t => {
  const h = await harness();
  let runtime;
  t.after(async () => { await runtime?.stop(); await h.close(); });
  const host = await signedInHost(h);
  const events = [];
  runtime = host.startPortalRuntime({ root: h.dir, intervalMs: 100, log: event => events.push(event) });
  await until(async () => (await host.cell()).presence.length === 1);
  await h.browser('/grants/tavily', { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
  await until(async () => (await host.read()).credentials.tavily);
  await h.browser(`/devices/${host.identity.deviceId}`, { method: 'DELETE' });
  await until(() => events.some(event => event.event === 'sign_in_required'));
  await until(async () => Object.keys((await host.read()).credentials).length === 0);
  assert.equal((await host.read()).installId, host.identity.installId);
  assert.equal((await host.cell()).presence.length, 0);
  assert.equal(Object.keys((await h.store.load(h.user.account.id)).devices).length, 1);
});

test('host lifecycle starts without signing in or generating another installation', { timeout: 30_000 }, async t => {
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const output = path.join(h.dir, 'packaged-host'); await buildHost(output);
  const { startPortalRuntime } = await import(pathToFileURL(path.join(output, 'setup/portal-runtime.mjs')).href);
  const runtime = startPortalRuntime({ root: h.dir, intervalMs: 100 });
  await sleep(200); await runtime.stop();
  await assert.rejects(readFile(path.join(h.dir, 'data/community-portal.json')), { code: 'ENOENT' });
});
