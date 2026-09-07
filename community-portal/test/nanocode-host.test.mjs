import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NanocodeHost } from '../device/nanocode-host.mjs';
import { publicKey } from './nanocode-helpers.mjs';

test('a late response after Host sign-out cannot rewrite the next identity’s SSH authorization', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'nanocode-identity-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'data/nanocode'); await mkdir(dir, { recursive: true });
  const key = publicKey();
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ enabled: true, port: 22220, installId: 'install', accountId: 'account' }));
  await writeFile(path.join(dir, 'host_ed25519.pub'), key);
  await writeFile(path.join(dir, 'authorized_keys'), 'current identity');
  let deliver, signal;
  const host = new NanocodeHost({ root, send() {}, client: {
    local: { installId: 'install', registryAccount: { account_id: 'account' }, deviceId: 'host' },
    request: (_method, _path, _body, s) => { signal = s; return new Promise(resolve => { deliver = resolve; }); },
  } });
  const pending = host.authorize();
  while (!deliver) await new Promise(resolve => setImmediate(resolve));
  host.stop(); assert.equal(signal.aborted, true);
  deliver({ devices: [{ id: 'host', hostKey: key, enabled: true }], keys: [{ publicKey: publicKey() }] });
  await assert.rejects(pending, /host_stopped/);
  assert.equal(await readFile(path.join(dir, 'authorized_keys'), 'utf8'), 'current identity');
});
