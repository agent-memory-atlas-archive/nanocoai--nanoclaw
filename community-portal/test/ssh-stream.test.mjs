import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { SshStream } from '../device/ssh-stream.mjs';
import { CHUNK, WINDOW } from '../worker/src/ssh-relay.mjs';

test('a stalled local sink cannot be flooded even by a misbehaving relay', () => {
  const input = new PassThrough(), writes = [];
  const output = new Writable({ write(data, _, done) { writes.push({ data, done }); } });
  const stream = new SshStream({ readable: input, writable: output, send() {}, close() {} });
  try {
    const data = Buffer.alloc(CHUNK, 1).toString('base64');
    for (let seq = 0; seq < WINDOW; seq += CHUNK) stream.message({ type: 'ssh.data', seq, data });
    assert.equal(output.writableLength, WINDOW);
    assert.throws(() => stream.message({ type: 'ssh.data', seq: WINDOW, data }), /flow_control/);
    assert.equal(output.writableLength, WINDOW);
  } finally { stream.stop(); input.destroy(); output.destroy(); }
});

test('EOF waits for delivered credits, preserving final SSH exit-status bytes', async () => {
  const input = new PassThrough(), output = new PassThrough(), frames = [];
  let closed = 0;
  const stream = new SshStream({ readable: input, writable: output, send: f => frames.push(f), close: () => closed++ });
  try {
    input.end(Buffer.alloc(WINDOW + CHUNK, 7));
    await sleep(10);
    assert.equal(frames.reduce((n, f) => n + Buffer.from(f.data, 'base64').length, 0), WINDOW);
    assert.equal(closed, 0);
    stream.message({ type: 'ssh.ack', seq: WINDOW });
    await sleep(10);
    assert.equal(frames.at(-1).seq, WINDOW);
    assert.equal(closed, 0);
    stream.message({ type: 'ssh.ack', seq: WINDOW + CHUNK });
    assert.equal(closed, 1);
  } finally { stream.stop(); input.destroy(); output.destroy(); }
});

test('out-of-order bytes and credits cannot silently corrupt an SSH stream', () => {
  const input = new PassThrough(), output = new PassThrough();
  const stream = new SshStream({ readable: input, writable: output, send() {}, close() {} });
  try {
    assert.throws(() => stream.message({ type: 'ssh.data', seq: 1, data: 'YQ==' }), /flow_control/);
    assert.throws(() => stream.message({ type: 'ssh.ack', seq: 1 }), /invalid_ack/);
    assert.throws(() => stream.message({ type: 'ssh.data', seq: 0, data: '!!!' }), /invalid_data/);
  } finally { stream.stop(); input.destroy(); output.destroy(); }
});
