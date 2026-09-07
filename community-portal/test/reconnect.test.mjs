import test from 'node:test';
import assert from 'node:assert/strict';
import { ReconnectBudget, transient, retryAttachExit } from '../device/reconnect.mjs';

test('an hours-long terminal gets a full recovery window, and repeated failed handshakes exhaust it', () => {
  let now = 7_200_000;
  const retry = new ReconnectBudget({ now: () => now, random: () => 1 });
  retry.interrupted(now);
  assert.equal(retry.delay(), 600);
  for (let i = 0; i < 8; i++) { now += 15_000; retry.interrupted(15_000); }
  assert.equal(retry.delay(), null);
  now += 3_600_000; retry.interrupted(3_600_000);
  assert.equal(retry.delay(), 600);
});
test('retry delays include jitter, stay capped, and permanent authorization failures stop', () => {
  const retry = new ReconnectBudget({ now: () => 0, random: () => 0.5 }); retry.interrupted();
  for (let i = 0; i < 100; i++) assert.ok(retry.delay() > 0 && retry.delay() <= 10_100);
  for (const status of [400, 401, 403, 404, 409, 410]) assert.equal(transient({ status }), false);
  for (const error of [new TypeError('fetch failed'), { status: 408 }, { status: 429 }, { status: 503 }]) assert.equal(transient(error), true);
});

test('an interrupted remote command can exit 1 or on SIGHUP, while clean detach and permanent SSH failures stop', () => {
  for (const code of [1, 129, 143, 255]) assert.equal(retryAttachExit(code, 'Connection to installation closed.'), true);
  for (const code of [0, 126, 127]) assert.equal(retryAttachExit(code), false);
  for (const error of ['Permission denied (publickey).', 'Host key verification failed.', "no sandbox 'missing' — create it", 'not in code mode']) assert.equal(retryAttachExit(1, error), false);
});
