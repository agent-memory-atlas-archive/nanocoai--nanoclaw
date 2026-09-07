import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { SetupClient } from '../../device/setup-client.mjs';
import { harness, until } from '../harness.mjs';

test('real celld: CLI handoffs and Slack management reach the browser, survive client restart, and carry no secrets', { timeout: 60_000 }, async t => {
  const h = await harness(); t.after(() => h.close());
  const browser = await h.socketFor();
  const file = path.join(h.dir, 'cli-setup.json');
  let cli = await new SetupClient({ origin: h.origin, file, label: 'CLI device' }).initialize();
  let flow = await cli.start('echo');
  await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true, imageSource: 'hardened' } });
  cli = await new SetupClient({ origin: h.origin, file, label: 'CLI device' }).initialize();
  assert.equal((await cli.start('echo')).code, flow.code, 'restart resumes the approved handoff');
  await cli.wait(); await cli.complete();
  await until(() => browser.messages.some(m => m.snapshot?.setups?.some(s => s.id === flow.id)));
  flow = await cli.start('slack', 'Nova');
  await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true, workspaceId: 'TDEMO', name: 'Nova' } });
  await cli.wait(); const app = await cli.request('POST', `/api/v1/setup/${cli.flow.code}/demo-slack`, {}); cli.local.slack = app; await cli.save(); await cli.complete('complete', { appId: app.appId });
  await until(() => browser.messages.some(m => m.snapshot?.included?.some(p => p.id === 'slack' && p.apps.some(a => a.id === app.appId))));
  const published = JSON.stringify(browser.messages);
  assert.ok(!published.includes(cli.token)); assert.ok(!published.includes('ciphertext'));
  assert.ok(!published.includes(app.botToken)); assert.ok(!published.includes(app.appToken)); assert.ok(!published.includes(cli.local.privateKey.d));
  await h.browser('/slack/revoke', { method: 'POST', body: { appId: app.appId, accepted: true } });
  await until(() => browser.messages.some(m => m.snapshot?.included?.some(p => p.id === 'slack' && p.apps.some(a => a.id === app.appId && a.status === 'deleted'))));
});
