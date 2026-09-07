import { generateKeyPairSync } from 'node:crypto';
import { mkdir, open, cp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalog } from '../test/fixtures/catalog.mjs';
import { createAdapters } from '../service/partners.mjs';
import { sqliteStore } from '../service/store.mjs';
import { hash, random } from '../service/security.mjs';
import { demoIdentity } from '../service/identity.mjs';
import { demoAccountPerks } from '../service/account-perks.mjs';
import { demoSlack } from '../service/slack.mjs';
import { createApp } from '../service/app.mjs';
import { listen } from '../service/http.mjs';
import { startPartners } from './partner-simulator.mjs';
import { readJson, writePrivate } from '../device/client.mjs';

import { SetupClient } from '../device/setup-client.mjs';
import { buildNanocode } from './build-host.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, '.runtime'); await mkdir(runtime, { recursive: true, mode: 0o700 });
// celld dev watches its project. Keep service databases, logs and receiver files
// outside that tree, otherwise each delivery triggers another cell restart.
const cellProject = path.join(runtime, 'cell-app');
for (const item of ['worker', 'web', 'wrangler.jsonc']) await cp(path.join(root, item), path.join(cellProject, item), { recursive: true });
await buildNanocode(path.join(cellProject, 'web/downloads/nanocode.mjs'));
const port = Number(process.env.PORT || 7310), cellPort = port + 1;
for (const candidate of [port, cellPort, port + 2]) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', () => reject(new Error(`Port ${candidate} is in use. Stop the previous demo or set PORT.`))); probe.listen(candidate, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
const origin = `http://127.0.0.1:${port}`, cellOrigin = `http://127.0.0.1:${cellPort}`;
const configPath = path.join(runtime, 'demo.json');
let config = await readJson(configPath);
if (!config) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  config = { privateKey: privateKey.export({ format: 'jwk' }), publicKey: publicKey.export({ format: 'jwk' }), partnerKeys: { tavily: random(32), dial: random(32) }, installs: [{ installId: 'demo-first', token: random(32) }, { installId: 'demo-second', token: random(32) }, { installId: 'demo-third', token: random(32) }] };
}
config.origin = origin; await writePrivate(configPath, config);
const store = await sqliteStore(path.join(runtime, 'perks.sqlite'));
const partners = await startPartners({ port: port + 2, filename: path.join(runtime, 'partners.sqlite'), keys: config.partnerKeys });
const log = await open(path.join(runtime, 'cell.log'), 'a', 0o600);
const cell = spawn(process.env.CELLD_BIN || path.join(runtime, 'bin/celld'), ['dev', cellProject, '--host', '127.0.0.1', '--port', String(cellPort), '--no-watch'], {
  cwd: root, env: { ...process.env, CELLD_WORKER_LOADER: 'LOADER', CELLD_ESBUILD: path.join(root, 'node_modules/.bin/esbuild'), CELLD_VAR_GRANT_PUBLIC_KEY_JWK: JSON.stringify(config.publicKey), CELLD_WATCH: path.join(runtime, 'cell-cache') }, stdio: ['ignore', log.fd, log.fd],
});
cell.on('error', error => { console.error(`celld could not start (${error.code}). Run node scripts/install-celld.mjs.`); });
let ready = false;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${cellOrigin}/healthz`)).ok) { ready = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!ready) { console.error('celld did not become ready. See .runtime/cell.log.'); cell.kill(); await partners.close(); store.close(); process.exit(1); }
const appConfig = { store, identity: demoIdentity(Object.fromEntries(config.installs.map(i => [hash(i.token), { accountId: 'acct_demo', installId: i.installId }])), store), origin, demo: true, catalog: catalog(), adapters: createAdapters(Object.fromEntries(['tavily', 'dial'].map(id => [id, { baseUrl: `${partners.origin}/${id}`, serviceKey: config.partnerKeys[id], allowLoopback: true }]))), signingKey: config.privateKey, cellOrigin };
const app = createApp(appConfig);
await app.service.change('acct_demo', a => {
  for (const fixture of config.installs) { const d = a.devices[`dev_${hash(fixture.installId).slice(0, 24)}`]; if (d) d.installId = fixture.installId; }
  return {};
});
const scenario = async () => (await readJson(path.join(runtime, 'account-scenario.json')))?.scenario || 'connected';
const slack = demoSlack(app.service, scenario);
app.service.accountPerks = { ...demoAccountPerks(scenario), slack: slack.read };
appConfig.slackManage = slack.manage; appConfig.demoSlackCreate = slack.create;
const server = await listen(app, { port, origin, cellOrigin });
const client = await new SetupClient({ origin, token: config.installs[0].token, file: path.join(runtime, 'devices/demo-device.json'), label: 'Demo laptop', log: e => console.log(JSON.stringify(e)) }).initialize();
const signIn = await fetch(`${origin}/api/v1/auth/demo`, { redirect: 'manual' });
const sessionCookie = signIn.headers.get('set-cookie').split(';')[0];
const me = await (await fetch(`${origin}/api/v1/me`, { headers: { cookie: sessionCookie } })).json();
if (!me.devices?.some(d => d.id === client.local.deviceId)) {
  const flow = await client.start('perks');
  const response = await fetch(`${origin}/api/v1/setup/${flow.code}/approve`, { method: 'POST', headers: { cookie: sessionCookie, origin, 'x-csrf-token': me.csrf, 'content-type': 'application/json' }, body: '{"accepted":true}' });
  if (!response.ok) throw new Error('Demo installation sign-in failed.');
  await client.wait(); await client.complete();
}
await client.run();
let draining = false;
const drain = setInterval(async () => { if (draining) return; draining = true; try { await app.service.drain(); } catch { console.error('Outbox retry scheduled.'); } finally { draining = false; } }, 2000);
console.log(`\nNanoClaw perks demo: ${origin}\nTavily and Dial are simulated. The cell is real celld 0.4.1.\nA signed-in demo laptop receives credentials in a local 0600 test file.\n`);
let closing = false;
async function stop(code = 0) {
  if (closing) return; closing = true; clearInterval(drain); await client.stop();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await partners.close();
  if (cell.exitCode === null && cell.signalCode === null) { const exited = once(cell, 'exit'); cell.kill('SIGTERM'); await exited; }
  store.close(); await log.close(); process.exit(code);
}
cell.once('exit', () => { if (!closing) { console.error('celld exited. See .runtime/cell.log.'); void stop(1); } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop());
