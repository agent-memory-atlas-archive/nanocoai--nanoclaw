import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { harness, until } from '../harness.mjs';
import { publicKey, authorize } from '../nanocode-helpers.mjs';
import { CellConnection } from '../../device/connection.mjs';
import { CHUNK, WINDOW } from '../../worker/src/ssh-relay.mjs';

const send = (ws, m) => ws.send(JSON.stringify(m));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const h = await harness(), sockets = [], streams = new Map();
  const terminal = await h.connectInstallation(0), host = await h.connectInstallation(1), key = await authorize(h, terminal);
  await host.request('POST', '/api/v1/nanocode/host', { hostKey: publicKey(), user: 'test', enabled: true });
  let paused = false, accepted = 0;
  const errors = [];
  const connection = new CellConnection({ origin: h.origin, heartbeatMs: 100, timeoutMs: 350, retryMs: 20, maxRetryMs: 100,
    getTicket: signal => host.request('POST', '/api/v1/cell-ticket', {}, signal),
    onChange: () => accepted++, onDisconnect: () => streams.clear(),
    onMessage: frame => {
      if (frame.type === 'ssh.open') {
        streams.set(frame.id, { sent: 0, received: 0, acked: 0 }); connection.send({ type: 'ssh.ready', id: frame.id });
      } else if (frame.type === 'ssh.close') streams.delete(frame.id);
      else if (frame.type === 'ssh.data') {
        const s = streams.get(frame.id); if (!s) return;
        const bytes = Buffer.from(frame.data, 'base64');
        if (frame.seq !== s.received) errors.push('out of order at Host');
        s.received += bytes.length;
        if (!paused) connection.send({ type: 'ssh.ack', id: frame.id, seq: s.received });
        // Loop ciphertext-shaped bytes back, respecting the same peer window.
        if (s.sent - s.acked + bytes.length > WINDOW) errors.push('Host window exceeded');
        connection.send({ type: 'ssh.data', id: frame.id, seq: s.sent, data: frame.data }); s.sent += bytes.length;
      } else if (frame.type === 'ssh.ack') { const s = streams.get(frame.id); if (s) s.acked = frame.seq; }
    },
  });
  connection.start();
  t.after(async () => { connection.stop(); for (const ws of sockets) ws.terminate(); await h.close(); assert.deepEqual(errors, []); });
  await until(() => connection.connected);
  async function open() {
    const grant = await terminal.request('POST', '/api/v1/nanocode/ticket', { deviceId: host.local.deviceId, fingerprint: key.fingerprint });
    const ws = new WebSocket(grant.socketUrl, ['nc-cell', `ticket.${grant.ticket}`]); sockets.push(ws);
    let ready = false, sent = 0, acked = 0, received = 0;
    const output = [];
    ws.on('error', () => {});
    ws.on('message', raw => {
      const f = JSON.parse(String(raw));
      if (f.type === 'ssh.ready') ready = true;
      if (f.type === 'ssh.ack') acked = f.seq;
      if (f.type === 'ssh.data') {
        const b = Buffer.from(f.data, 'base64'); if (f.seq !== received) errors.push('out of order at terminal');
        received += b.length; output.push(b); send(ws, { type: 'ssh.ack', seq: received });
      }
    });
    await once(ws, 'open'); await until(() => ready);
    return { ws, async exchange(bytes) {
      const base = received;
      for (let offset = 0; offset < bytes.length;) {
        await until(() => sent - acked < WINDOW && ws.readyState === WebSocket.OPEN, 5000, 'available credit');
        const end = Math.min(bytes.length, offset + CHUNK, offset + WINDOW - sent + acked);
        const chunk = bytes.subarray(offset, end); send(ws, { type: 'ssh.data', seq: sent, data: chunk.toString('base64') });
        sent += chunk.length; offset = end;
      }
      await until(() => received === base + bytes.length, 10000, 'echoed bytes');
      const combined = Buffer.concat(output); assert.equal(digest(combined.subarray(base)), digest(bytes));
    }, output, get outstanding() { return sent - acked; } };
  }
  return { h, host, terminal, key, connection, streams, open, accepted: () => accepted, pause: value => { paused = value; } };
}

test('stress: eight simultaneous streams move 16 MiB intact; extra admission is refused and all slots are reclaimed', { timeout: 120_000 }, async t => {
  const f = await fixture(t), peers = [];
  for (let i = 0; i < 8; i++) peers.push(await f.open());
  const grant = await f.terminal.request('POST', '/api/v1/nanocode/ticket', { deviceId: f.host.local.deviceId, fingerprint: f.key.fingerprint });
  const refused = new WebSocket(grant.socketUrl, ['nc-cell', `ticket.${grant.ticket}`]);
  refused.on('error', () => {}); await once(refused, 'close').catch(() => {});
  assert.notEqual(refused.readyState, WebSocket.OPEN);
  for (let round = 0; round < 16; round++) await Promise.all(peers.map((p, i) => p.exchange(Buffer.alloc(128 * 1024, round * 8 + i))));
  for (const p of peers) p.ws.close();
  await until(() => f.streams.size === 0, 5000, 'all host streams reclaimed');
  for (let i = 0; i < 8; i++) { const p = await f.open(); await p.exchange(randomBytes(8192)); p.ws.close(); }
  await until(() => f.streams.size === 0);
});

test('chaos: 20 abrupt host-socket losses retire streams, recover one installation connection, and preserve byte order', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  for (let round = 0; round < 20; round++) {
    const peer = await f.open(); await peer.exchange(randomBytes(32_768));
    f.connection.socket.terminate();
    await until(() => peer.ws.readyState === WebSocket.CLOSED && !f.streams.size);
    await until(() => f.connection.connected, 5000, 'host reconnect');
    assert.equal(f.streams.size, 0);
  }
  const peer = await f.open(); await peer.exchange(randomBytes(128_000)); peer.ws.close();
  assert.ok(f.accepted() >= 21);
  assert.equal(Object.keys((await f.h.store.load(f.h.user.account.id)).devices).length, 2);
});

test('chaos: relay process restarts and a silent network stall recover; revocation during retry stops fresh admission', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  for (let round = 0; round < 3; round++) {
    const peer = await f.open(); await peer.exchange(randomBytes(20_000));
    await f.h.stopCell(); await sleep(150); await f.h.startCell();
    await until(() => peer.ws.readyState === WebSocket.CLOSED);
    await until(() => f.connection.connected, 10_000, 'cell process recovery');
  }
  const peer = await f.open(), oldSocket = f.connection.socket;
  oldSocket._socket.pause(); // test-only blackhole: no FIN/RST/pong reaches Host
  await until(() => f.connection.socket !== oldSocket && f.connection.connected, 5000, 'heartbeat blackhole recovery');
  await until(() => peer.ws.readyState === WebSocket.CLOSED);
  const next = await f.open(); await next.exchange(randomBytes(4096));
  f.connection.socket.terminate();
  await f.h.browser('/nanocode/key/revoke', { method: 'POST', body: { fingerprint: f.key.fingerprint } });
  await until(() => f.connection.connected);
  await assert.rejects(f.terminal.request('POST', '/api/v1/nanocode/ticket', { deviceId: f.host.local.deviceId, fingerprint: f.key.fingerprint }), e => e.status === 403);
  await until(() => f.streams.size === 0);
});

test('chaos: repeated short ticket renewals preserve active stream counters and the one Host connection', { timeout: 35_000 }, async t => {
  const f = await fixture(t);
  const { signTicket } = await import('../../service/security.mjs');
  f.h.app.service.signer = (claims, seconds) => signTicket(f.h.signingKey, claims, ['device', 'ssh'].includes(claims.leg) ? 3 : seconds ?? 900);
  f.connection.getTicket = async signal => ({ ...await f.host.request('POST', '/api/v1/cell-ticket', {}, signal), expiresIn: 3 });
  const previous = f.connection.socket; previous.terminate();
  await until(() => f.connection.socket !== previous && f.connection.connected);
  const socket = f.connection.socket, peer = await f.open();
  for (let round = 0; round < 10; round++) {
    const grant = await f.terminal.request('POST', '/api/v1/nanocode/ticket', { deviceId: f.host.local.deviceId, fingerprint: f.key.fingerprint });
    // Data and renewal deliberately overlap; renewal must not restore old
    // sequence/credit counters from before signature verification yielded.
    send(peer.ws, { type: 'auth.renew', ticket: grant.ticket });
    await peer.exchange(randomBytes(32768)); await sleep(700);
    assert.equal(peer.ws.readyState, WebSocket.OPEN);
    assert.equal(f.connection.socket, socket);
  }
  peer.ws.close(); await until(() => f.streams.size === 0);
});
