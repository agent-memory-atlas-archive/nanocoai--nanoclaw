import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { harness, until } from '../harness.mjs';
import { publicKey, authorize } from '../nanocode-helpers.mjs';
import { signTicket } from '../../service/security.mjs';

async function fixture(t) {
  const h = await harness(), sockets = [];
  t.after(async () => { for (const ws of sockets) ws.terminate(); await h.close(); });
  const terminal = await h.connectInstallation(0), one = await h.connectInstallation(1), two = await h.connectInstallation(2);
  const key = await authorize(h, terminal);
  for (const host of [one, two]) await host.request('POST', '/api/v1/nanocode/host', { hostKey: publicKey(), user: 'test', enabled: true });
  const a = await h.socketFor('device', one.local.deviceId), b = await h.socketFor('device', two.local.deviceId), browser = await h.socketFor();
  const send = (ws, frame) => ws.send(JSON.stringify(frame));
  async function open(target = one) {
    const grant = await terminal.request('POST', '/api/v1/nanocode/ticket', { deviceId: target.local.deviceId, fingerprint: key.fingerprint });
    const ws = new WebSocket(grant.socketUrl, ['nc-cell', `ticket.${grant.ticket}`]); sockets.push(ws);
    const messages = []; ws.on('message', raw => messages.push(JSON.parse(String(raw)))); ws.on('error', () => {});
    await once(ws, 'open');
    const host = target === one ? a : b;
    const event = await until(() => host.messages.find(m => m.type === 'ssh.open' && !m.used)); event.used = true;
    send(host.ws, { type: 'ssh.ready', id: event.id });
    await until(() => messages.some(m => m.type === 'ssh.ready'));
    return { ws, messages, id: event.id, grant };
  }
  return { h, terminal, key, one, two, a, b, browser, send, open };
}

test('real cell routes each SSH stream to one installation and never broadcasts bytes', { timeout: 40_000 }, async t => {
  const f = await fixture(t), x = await f.open(), y = await f.open(f.two);
  const data = Buffer.from('encrypted-stream-one').toString('base64');
  f.send(x.ws, { type: 'ssh.data', seq: 0, data, id: y.id }); // caller's id is ignored
  await until(() => f.a.messages.some(m => m.type === 'ssh.data'));
  assert.equal(f.a.messages.find(m => m.type === 'ssh.data').id, x.id);
  assert.equal(f.b.messages.some(m => m.type === 'ssh.data'), false);
  assert.equal(f.browser.messages.some(m => m.type?.startsWith('ssh.')), false);
  f.send(f.a.ws, { type: 'ssh.data', id: x.id, seq: 0, data });
  await until(() => x.messages.some(m => m.type === 'ssh.data'));
  assert.equal(y.messages.some(m => m.type === 'ssh.data'), false);
  // A host cannot address another installation's channel.
  f.send(f.a.ws, { type: 'ssh.data', id: y.id, seq: 0, data });
  await sleep(100);
  assert.equal(f.a.ws.readyState, WebSocket.OPEN);
  assert.equal(y.ws.readyState, WebSocket.OPEN);
  assert.equal(y.messages.some(m => m.type === 'ssh.data'), false);
});

test('credit cap closes a stalled stream and key revocation closes existing connections', { timeout: 40_000 }, async t => {
  const f = await fixture(t), x = await f.open();
  const data = Buffer.alloc(16_384, 7).toString('base64');
  for (let i = 0; i < 5; i++) f.send(x.ws, { type: 'ssh.data', seq: i * 16_384, data });
  await until(() => x.ws.readyState === WebSocket.CLOSED);
  const y = await f.open();
  await f.h.browser('/nanocode/key/revoke', { method: 'POST', body: { fingerprint: f.key.fingerprint } });
  await until(() => y.ws.readyState === WebSocket.CLOSED);
  assert.equal(f.a.ws.readyState, WebSocket.OPEN);
});

test('ticket renewal keeps a stream alive, and host loss requires a fresh stream', { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  f.h.app.service.signer = (claims, seconds) => signTicket(f.h.signingKey, claims, claims.leg === 'ssh' ? 3 : seconds ?? 900);
  const x = await f.open();
  f.h.app.service.signer = (claims, seconds) => signTicket(f.h.signingKey, claims, seconds ?? 900);
  const renewed = await f.terminal.request('POST', '/api/v1/nanocode/ticket', { deviceId: f.one.local.deviceId, fingerprint: f.key.fingerprint });
  f.send(x.ws, { type: 'auth.renew', ticket: renewed.ticket });
  await sleep(3500);
  assert.equal(x.ws.readyState, WebSocket.OPEN);
  f.a.ws.close();
  await until(() => x.ws.readyState === WebSocket.CLOSED);
  const next = await f.h.socketFor('device', f.one.local.deviceId); f.a = next;
  // Cold reconnect resolves the same target, with no saved relay session token.
  const grant = await f.terminal.request('POST', '/api/v1/nanocode/ticket', { deviceId: f.one.local.deviceId, fingerprint: f.key.fingerprint });
  assert.equal(grant.hostKey, x.grant.hostKey);
});
