import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SetupClient } from '../device/setup-client.mjs';
import { buildHost } from '../scripts/build-host.mjs';

export async function signedInHost(h) {
  const file = path.join(h.dir, 'data/community-portal.json');
  const cli = await new SetupClient({ origin: h.origin, file, exclusive: true, label: 'Actual host checkout' }).initialize();
  const flow = await cli.start('perks');
  assert.equal((await h.browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true } })).status, 200);
  await cli.wait(); await cli.complete();
  const identity = structuredClone(cli.local);
  await cli.stop();
  const output = path.join(h.dir, 'packaged-host');
  await buildHost(output);
  const { startPortalRuntime } = await import(pathToFileURL(path.join(output, 'setup/portal-runtime.mjs')).href);
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const cell = async () => {
    const ticket = h.app.service.ticket(h.user.account.id, 'browser');
    return (await fetch(`${h.cellOrigin}/cell/state`, { headers: { authorization: `Bearer ${ticket}` } })).json();
  };
  return { file, identity, startPortalRuntime, read, cell };
}
