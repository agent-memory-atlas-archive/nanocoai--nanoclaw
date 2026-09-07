import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { SetupClient, DeviceClient, readJson, writePrivate } from './setup-client.mjs';
import { sshKey } from '../service/nanocode.mjs';
import { SshStream } from './ssh-stream.mjs';
import { ReconnectBudget, transient, retryAttachExit } from './reconnect.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.cwd();
const localState = path.join(root, 'data/community-portal.json');
const inCheckout = await access(localState).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
const file = process.env.NANOCLAW_PORTAL_STATE || (inCheckout ? localState : path.join(os.homedir(), '.config/nanoclaw/community-portal.json'));
const dir = path.join(path.dirname(file), 'nanocode');
const origin = (await readJson(file))?.origin || process.env.NANOCLAW_PORTAL_ORIGIN || 'https://portal.nanoclaw.dev';
const keyFile = path.join(dir, 'client_ed25519');
const publicPart = text => text.trim().split(/\s+/).slice(0, 2).join(' ');
const exists = async file => { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
async function keypair(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!await exists(file)) execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'nanocode', '-f', file], { stdio: 'ignore' });
  return sshKey(publicPart(await readFile(`${file}.pub`, 'utf8')));
}
async function client(Type = DeviceClient) {
  const c = new Type({ origin, file, label: os.hostname(), exclusive: Type === SetupClient, waitForLockMs: 5000 });
  if (Type === SetupClient) return c.initialize();
  c.local = await readJson(file); c.token = c.local?.registryAccount?.token;
  if (!c.token || !c.local.privateKey || !c.local.deviceId) throw new Error('Sign in through NanoClaw setup or nanocode login first.');
  return c;
}
async function login() {
  const key = await keypair(keyFile);
  // Ordinary reconnects and concurrent terminals read the saved identity;
  // only a new browser handoff needs to own the setup journal.
  if ((await readJson(file))?.registryAccount?.token) {
    const existing = await client();
    try {
      const state = await existing.request('GET', '/api/v1/nanocode/state');
      if (state.keys.some(k => k.fingerprint === key.fingerprint && k.deviceId === existing.local.deviceId)) return;
    } catch (error) { if (![401, 403].includes(error.status)) throw error; }
    finally { await existing.stop(); }
  }
  const c = await client(SetupClient);
  try {
    if (c.token) {
      try { const state = await c.request('GET', '/api/v1/nanocode/state'); if (state.keys.some(k => k.fingerprint === key.fingerprint && k.deviceId === c.local.deviceId)) return; }
      catch (e) { if (![401, 403].includes(e.status)) throw e; }
    }
    c.local.sshPublicKey = key.publicKey; await c.save();
    const flow = await c.start('nanocode');
    console.error(`Authorize this terminal in the portal:\n${flow.url}\nYour existing browser sign-in is reused.`);
    const result = await c.wait();
    if (result.status !== 'approved') throw new Error('Terminal access was not authorized.');
    await c.complete(); console.error('Terminal authorized.');
  } finally { await c.stop(); }
}
async function ticket(c, deviceId) {
  const key = sshKey(publicPart(await readFile(`${keyFile}.pub`, 'utf8')));
  return c.request('POST', '/api/v1/nanocode/ticket', { deviceId, fingerprint: key.fingerprint });
}
async function enable(enabled) {
  const c = await client();
  try {
    if (!c.token || !c.local.deviceId) throw new Error('Sign in through NanoClaw setup first.');
    const key = await keypair(path.join(dir, 'host_ed25519'));
    const previous = await readJson(path.join(dir, 'config.json'));
    if (!enabled) {
      if (previous) await writePrivate(path.join(dir, 'config.json'), { ...previous, enabled: false });
      await c.request('POST', '/api/v1/nanocode/host', { hostKey: key.publicKey, user: os.userInfo().username, enabled: false });
      console.log('Remote code mode disabled.'); return;
    }
    if (!await exists(path.join(root, 'dist/cli/client.js'))) throw new Error('Run enable from a built NanoClaw installation.');
    const port = previous?.port || await new Promise((resolve, reject) => {
      const listener = createServer(); listener.once('error', reject);
      listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(error => error ? reject(error) : resolve(port)); });
    });
    const sshd = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find(p => { try { execFileSync(p, ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } });
    if (!sshd) throw new Error('Install the OpenSSH server package on this Host to enable remote code mode.');
    const config = { enabled, port, sshd, installId: c.local.installId, accountId: c.local.registryAccount.account_id };
    if (/[\r\n"]/.test(dir)) throw new Error('The installation path cannot contain quotes or line breaks.');
    const user = os.userInfo().username;
    if (!/^[a-zA-Z0-9_.-]+$/.test(user)) throw new Error('Unsupported local account name.');
    const text = `Port ${port}\nListenAddress 127.0.0.1\nHostKey "${dir}/host_ed25519"\nPidFile "${dir}/sshd.pid"\nAuthorizedKeysFile "${dir}/authorized_keys"\nAllowUsers ${user}\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin prohibit-password\nPermitUserEnvironment no\nPermitUserRC no\nDisableForwarding yes\nX11Forwarding no\nAllowAgentForwarding no\nPermitTunnel no\nPermitTTY yes\nClientAliveInterval 20\nClientAliveCountMax 3\nMaxAuthTries 3\nMaxSessions 1\nLoginGraceTime 20\n`;
    await writeFile(path.join(dir, 'sshd_config'), text, { mode: 0o600 });
    if (!await exists(path.join(dir, 'authorized_keys'))) await writeFile(path.join(dir, 'authorized_keys'), '', { mode: 0o600 });
    execFileSync(sshd, ['-t', '-f', path.join(dir, 'sshd_config')], { stdio: 'inherit' });
    await c.request('POST', '/api/v1/nanocode/host', { hostKey: key.publicKey, user, enabled });
    await writePrivate(path.join(dir, 'config.json'), config);
    console.log(enabled ? 'Remote code mode enabled. Open the portal’s Code mode page to connect.' : 'Remote code mode disabled.');
  } finally { await c.stop(); }
}
async function proxy(deviceId) {
  const c = await client();
  let ws, stream, renew, heartbeat, readyTimer, done = false;
  const finish = code => {
    if (done) return; done = true; clearInterval(renew); clearInterval(heartbeat); clearTimeout(readyTimer);
    stream?.stop(); process.stdin.pause();
    if (code === 0) ws?.close(); else ws?.terminate();
    void c.stop().finally(() => { process.stdout.write('', () => process.exit(code)); });
  };
  try {
    const grant = await ticket(c, deviceId), url = new URL(grant.socketUrl);
    if (url.origin !== origin.replace(/^http/, 'ws') || url.pathname !== '/cell/ssh' || url.search || url.hash || url.username || url.password) throw new Error('Invalid relay URL');
    ws = new WebSocket(url, ['nc-cell', `ticket.${grant.ticket}`], { followRedirects: false, handshakeTimeout: 10_000, maxPayload: 24_000 });
    const send = frame => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };
    readyTimer = setTimeout(() => finish(1), 30_000);
    let lastPong = Date.now();
    heartbeat = setInterval(() => { if (Date.now() - lastPong > 60_000) finish(1); else if (ws.readyState === WebSocket.OPEN) ws.send('ping'); }, 20_000);
    renew = setInterval(() => { void ticket(c, deviceId).then(g => send({ type: 'auth.renew', ticket: g.ticket }), () => finish(1)); }, 600_000);
    ws.on('message', raw => {
      try {
        const frame = JSON.parse(String(raw));
        if (frame.type === 'pong') lastPong = Date.now();
        else if (frame.type === 'ssh.ready' && !stream) {
          clearTimeout(readyTimer);
          stream = new SshStream({ readable: process.stdin, writable: process.stdout, send, close: () => finish(0) });
        }
        else stream?.message(frame);
      } catch { finish(1); }
    });
    ws.on('close', () => finish(1)); ws.on('error', () => finish(1));
  } catch (error) { console.error(`nanocode: ${error.message}`); finish(1); }
}
async function connectTo(deviceId, verb = 'attach', name) {
  if (!/^dev_[a-f0-9]{24}$/.test(deviceId || '') || !['attach', 'new', 'list'].includes(verb) || (name && !/^[A-Za-z0-9_-]{1,63}$/.test(name)) || (verb === 'attach' && !name)) throw new Error('Usage: nanocode connect <device-id> attach <sandbox> | new [name] | list');
  await login();
  const c = await client();
  const known = path.join(dir, 'known_hosts');
  try {
    const grant = await ticket(c, deviceId);
    const old = await readFile(known, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    const line = `${deviceId} ${sshKey(grant.hostKey).publicKey}`;
    const pinned = old.split('\n').find(l => l.startsWith(`${deviceId} `));
    if (pinned && pinned !== line) throw new Error('SSH host key changed. Verify the installation before replacing its local pin.');
    if (!pinned) await writeFile(known, `${old}${line}\n`, { mode: 0o600 });
    const proxyCommand = `${quote(process.execPath)} ${quote(process.argv[1])} proxy ${deviceId}`;
    const args = ['-F', '/dev/null', '-o', `ProxyCommand=${proxyCommand}`, '-o', `HostKeyAlias=${deviceId}`, '-o', `UserKnownHostsFile="${known.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-i', keyFile, '-l', 'nanocode', deviceId];
    // The server uses its local OS account. The portal publishes only that
    // routing hint; neither it nor the SSH username establishes the person.
    const state = await c.request('GET', '/api/v1/nanocode/state');
    const target = state.devices.find(d => d.id === deviceId);
    if (!target?.user || !/^[a-zA-Z0-9_.-]+$/.test(target.user)) throw new Error('Host is missing its SSH account configuration.');
    args[args.indexOf('-l') + 1] = target.user;
    if (verb === 'new') {
      name ||= `sandbox-${randomUUID().slice(0, 8)}`;
      const created = await new Promise((resolve, reject) => {
        const process = spawn('ssh', [...args, 'new', name, '--no-attach', '--json'], { stdio: ['ignore', 'pipe', 'inherit'] });
        let output = '';
        process.stdout.on('data', bytes => { output += bytes; if (output.length > 65_536) process.kill(); });
        process.once('error', reject); process.once('exit', code => resolve({ code, output }));
      });
      if (created.code === 255) throw new Error(`Connection lost during creation. Check the portal's sandbox list, then attach ${name} if it was created. Creation is never replayed automatically.`);
      const frame = JSON.parse(created.output || '{}');
      if (created.code || !frame.ok || frame.data?.sandbox !== name) throw new Error(frame.error?.message || 'Sandbox creation failed.');
      console.error(`Created ${name}. Attaching…`);
      verb = 'attach';
    }
    if (verb !== 'list') args.unshift('-tt');
    args.push(verb, ...(name ? [name] : []));
    const budget = new ReconnectBudget(), abort = new AbortController();
    c.signal = abort.signal;
    let ssh;
    const cancel = () => { abort.abort(); ssh?.kill('SIGTERM'); };
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel); process.once('SIGHUP', cancel);
    try {
      for (;;) {
        const started = Date.now(); let diagnostic = '';
        const code = await new Promise(resolve => {
          ssh = spawn('ssh', args, { stdio: ['inherit', 'inherit', 'pipe'] });
          ssh.stderr.on('data', bytes => { process.stderr.write(bytes); diagnostic = (diagnostic + bytes).slice(-8192); });
          ssh.on('error', () => resolve(1)); ssh.on('exit', c => resolve(c ?? 1));
        });
        if (process.stdout.isTTY) process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
        if (abort.signal.aborted || verb !== 'attach' || !retryAttachExit(code, diagnostic)) { process.exitCode = code; break; }
        budget.interrupted(Date.now() - started);
        console.error('Connection interrupted; reattaching to the same sandbox…');
        // The portal can be down too. Retry network/5xx failures within the
        // same budget; a revoked key, signed-out installation or changed pin
        // terminates immediately, without opening another browser flow.
        for (;;) {
          const delay = budget.delay();
          if (delay === null) throw new Error('Reconnect timed out. Run attach again when the connection is available; your sandbox is preserved.');
          await sleep(delay, undefined, { signal: abort.signal });
          try {
            const fresh = await ticket(c, deviceId);
            if (fresh.hostKey !== grant.hostKey) throw Object.assign(new Error('SSH host key changed. Verify the installation before reconnecting.'), { status: 403 });
            break;
          } catch (error) { if (!transient(error)) throw error; }
        }
      }
    } finally {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, cancel);
      if (process.stdout.isTTY) process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l');
    }
  } finally { await c.stop(); }
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'login') await login();
  else if (command === 'enable' || command === 'disable') await enable(command === 'enable');
  else if (command === 'connect') await connectTo(...args);
  else if (command === 'proxy') await proxy(args[0]);
  else console.log('nanocode enable | disable | login | connect <device-id> new [name] | connect <device-id> list | connect <device-id> attach <sandbox>');
} catch (error) { console.error(`nanocode: ${error.message}`); process.exitCode = 1; }
