import { generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { sqliteStore } from '../service/store.mjs';
import { createApp } from '../service/app.mjs';
import { listen } from '../service/http.mjs';
import { demoIdentity } from '../service/identity.mjs';
import { demoAccountPerks } from '../service/account-perks.mjs';
import { demoSlack } from '../service/slack.mjs';
import { catalog } from './fixtures/catalog.mjs';
import { createAdapters } from '../service/partners.mjs';
import { hash, random } from '../service/security.mjs';
import { startPartners } from '../scripts/partner-simulator.mjs';
import { SetupClient } from '../device/setup-client.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function until(check, timeout = 15_000, message = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out waiting for ${message}`);
}
async function port() { const s = http.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
export async function harness({ withCell = true, limits = {}, store: providedStore } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nc-perks-test-'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const signingKey = privateKey.export({ format: 'jwk' }), publicJwk = publicKey.export({ format: 'jwk' });
  const store = providedStore ?? await sqliteStore(path.join(dir, 'perks.sqlite'));
  const keys = { tavily: random(), dial: random() };
  const partners = await startPartners({ keys });
  const origin = `http://127.0.0.1:${await port()}`, cellOrigin = `http://127.0.0.1:${await port()}`;
  const tokens = Array.from({ length: 4 }, () => random(32));
  const identities = Object.fromEntries(tokens.map((token, i) => [hash(token), { accountId: i === 3 ? 'acct_other' : 'acct_demo', installId: `test-install-${i}` }]));
  const config = { store, identity: demoIdentity(identities, store), catalog: catalog(), accountPerks: demoAccountPerks(), adapters: createAdapters(Object.fromEntries(['tavily', 'dial'].map(id => [id, { baseUrl: `${partners.origin}/${id}`, serviceKey: keys[id], allowLoopback: true }]))), origin, cellOrigin, demo: true, signingKey, leaseMs: 500, ...limits };
  const app = createApp(config), slack = demoSlack(app.service);
  if (!limits.accountPerks) app.service.accountPerks.slack = slack.read;
  config.slackManage = slack.manage; config.demoSlackCreate = slack.create;
  let cell, log;
  if (withCell) {
    await mkdir(path.join(dir, 'worker')); await mkdir(path.join(dir, 'cell'));
    for (const name of ['worker', 'web', 'wrangler.jsonc']) await cp(path.join(root, name), path.join(dir, 'cell', name), { recursive: true, filter: source => !source.includes('/.celld') });
    log = await open(path.join(dir, 'cell.log'), 'a');
  }
  async function startCell() {
    cell = spawn(path.join(root, '.runtime/bin/celld'), ['dev', path.join(dir, 'cell'), '--host', '127.0.0.1', '--port', new URL(cellOrigin).port], { env: { ...process.env, CELLD_WORKER_LOADER: 'LOADER', CELLD_ESBUILD: path.join(root, 'node_modules/.bin/esbuild'), CELLD_VAR_GRANT_PUBLIC_KEY_JWK: JSON.stringify(publicJwk) }, stdio: ['ignore', log.fd, log.fd], detached: true });
    await until(async () => { try { return (await fetch(`${cellOrigin}/healthz`)).ok; } catch { return false; } }, 60_000, `celld startup (${dir}/cell.log)`);
  }
  async function stopCell() { if (cell?.exitCode === null && cell.signalCode === null) { process.kill(-cell.pid, 'SIGTERM'); await once(cell, 'exit'); } }
  if (withCell) await startCell();
  else app.service.flush = async () => true;
  const server = await listen(app, { port: Number(new URL(origin).port), origin, cellOrigin });
  const login = await fetch(`${origin}/api/v1/auth/demo`, { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const user = await (await fetch(`${origin}/api/v1/me`, { headers: { cookie } })).json();
  const clients = [], sockets = [];
  async function browser(route, { method = 'GET', body, csrf = user.csrf } = {}) {
    const response = await fetch(`${origin}/api/v1${route}`, { method, headers: { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); return { status: response.status, data };
  }
  async function connectInstallation(index = 0) {
    const client = await new SetupClient({ origin, token: tokens[index], file: path.join(dir, `device-${index}.json`), label: `Device ${index + 1}` }).initialize();
    const flow = await client.start('perks');
    const result = await browser(`/setup/${flow.code}/approve`, { method: 'POST', body: { accepted: true } });
    if (result.status !== 200) throw Object.assign(new Error(JSON.stringify(result)), { status: result.status });
    await client.wait(); await client.complete(); clients.push(client); return client;
  }

  async function socketFor(leg = 'browser', deviceId, accountId = 'acct_demo') {
    const ws = new WebSocket(`${cellOrigin.replace(/^http/, 'ws')}/cell/link`, ['nc-cell', `ticket.${app.service.ticket(accountId, leg, deviceId)}`]);
    const messages = []; ws.on('message', raw => messages.push(JSON.parse(String(raw)))); ws.on('error', () => {}); sockets.push(ws);
    await once(ws, 'open'); await until(() => messages.find(m => m.type === 'snapshot'), 5000, 'initial socket snapshot');
    return { ws, messages };
  }
  return { dir, origin, cellOrigin, app, store, partners, tokens, user, cookie, keys, browser, connectInstallation, socketFor, signingKey, publicJwk, stopCell, startCell, async crashCell() { if (cell?.exitCode === null && cell.signalCode === null) { process.kill(-cell.pid, 'SIGKILL'); await once(cell, 'exit'); } },
    async close() { for (const client of clients) await client.stop(); for (const ws of sockets) ws.terminate(); server.closeAllConnections(); await new Promise(r => server.close(r)); await stopCell(); await partners.close(); store.close?.(); await log?.close(); },
  };
}
