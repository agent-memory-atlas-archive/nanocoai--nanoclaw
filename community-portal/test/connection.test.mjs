import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { CellConnection } from '../device/connection.mjs';
import { until } from './harness.mjs';
import { connectionDeadline, livePresence } from '../worker/src/presence.mjs';

test('a lost host heartbeat removes presence and frees the connection before its ticket expires', () => {
  const now = 100_000;
  const old = { leg: 'device', dev: 'old-host', exp: 900, lastSeen: now - 65_001 };
  const active = { leg: 'device', dev: 'active-host', exp: 900, lastSeen: now - 20_000 };
  const expired = { leg: 'device', dev: 'expired-ticket', exp: 99, lastSeen: now };
  const browser = { leg: 'browser', exp: 900, lastSeen: 0 };
  assert.deepEqual(livePresence([old, active, expired, browser], now), [{ deviceId: 'active-host', connected: true }]);
  assert.ok(connectionDeadline(old) < now);
  assert.equal(connectionDeadline(browser), 900_000);
  assert.equal(connectionDeadline(null), 0);
});

test('a silent connection is replaced with a freshly authenticated socket; stop cancels reconnect', async t => {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let accepted = 0, tickets = 0, notifications = 0;
  sockets.on('connection', ws => {
    const number = ++accepted;
    ws.on('message', raw => {
      if (number > 1 && String(raw) === 'ping') ws.send('{"type":"pong"}');
    });
    ws.send('{"type":"run","command":"untrusted"}');
  });
  const connection = new CellConnection({ origin, heartbeatMs: 20, timeoutMs: 70, retryMs: 20,
    getTicket: async () => ({ ticket: `fresh-${++tickets}`, socketUrl: `${origin.replace('http:', 'ws:')}/cell/link` }),
    onChange: () => notifications++,
  });
  t.after(async () => { connection.stop(); for (const ws of sockets.clients) ws.terminate(); await new Promise(r => sockets.close(r)); await new Promise(r => server.close(r)); });
  connection.start();
  await until(() => accepted === 2, 5000, 'heartbeat recovery');
  await sleep(150);
  assert.equal(tickets, 2);
  assert.equal(notifications, 2, 'only the connection wakes reconciliation; arbitrary messages do not');
  assert.equal(connection.connected, true);
  connection.stop();
  await sleep(150);
  assert.equal(accepted, 2);
  assert.equal(connection.connected, false);
});

test('shutdown during ticket acquisition cannot open a late socket', async () => {
  let deliver, signal;
  const connection = new CellConnection({ origin: 'https://portal.example.test', getTicket: received => {
    signal = received;
    return new Promise(resolve => { deliver = resolve; });
  }});
  connection.start();
  connection.stop();
  assert.equal(signal.aborted, true);
  deliver({ ticket: 'unused', socketUrl: 'wss://portal.example.test/cell/link' });
  await sleep(10);
  assert.equal(connection.socket, undefined);
  assert.equal(connection.reconnect, undefined);
});

test('cell tickets cannot redirect an installation credential to a different origin', async () => {
  const events = [];
  const connection = new CellConnection({ origin: 'https://portal.example.test', retryMs: 60_000,
    getTicket: async () => ({ ticket: 'must-stay-private', socketUrl: 'wss://elsewhere.example.test/cell/link' }), log: event => events.push(event) });
  connection.start();
  await until(() => events.length > 0);
  connection.stop();
  assert.equal(connection.socket, undefined);
  assert.equal(JSON.stringify(events).includes('must-stay-private'), false);
});
