import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';
import { SshStream } from './ssh-stream.mjs';
import { readJson } from './client.mjs';
import { sshKey } from '../service/nanocode.mjs';

const quote = text => `'${text.replace(/'/g, `'\\''`)}'`;
export class NanocodeHost {
  constructor({ root, client, send, log = () => {} }) {
    Object.assign(this, { root, client, send, log });
    this.channels = new Map(); this.abort = new AbortController();
    this.dir = path.join(root, 'data/nanocode');
  }
  authorize() {
    return this.authorizing ||= this.readAuthorization().finally(() => { this.authorizing = undefined; });
  }
  async readAuthorization() {
    const config = await readJson(path.join(this.dir, 'config.json'));
    if (!config?.enabled || config.installId !== this.client.local.installId || config.accountId !== this.client.local.registryAccount?.account_id) throw new Error('code_mode_disabled');
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('invalid_ssh_port');
    const state = await this.client.request('GET', '/api/v1/nanocode/state', undefined, this.abort.signal);
    const host = state.devices.find(d => d.id === this.client.local.deviceId);
    const hostKey = (await readFile(path.join(this.dir, 'host_ed25519.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
    if (!host?.enabled || host.hostKey !== hostKey) throw new Error('code_mode_disabled');
    const session = path.join(this.root, 'setup/nanocode-session.mjs');
    const command = `${quote(process.execPath)} ${quote(session)} ${quote(this.root)}`;
    if (/[\r\n]/.test(command)) throw new Error('invalid_host_path');
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (this.stopped) throw new Error('host_stopped');
    const lines = state.keys.map(k => `restrict,pty,command="${escaped}" ${sshKey(k.publicKey).publicKey}`);
    const tmp = path.join(this.dir, `authorized_keys.${randomUUID()}.next`);
    try {
      await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      if (this.stopped) throw new Error('host_stopped');
      await rename(tmp, path.join(this.dir, 'authorized_keys'));
    } finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    this.config = config;
    return state;
  }
  async ensure() { if (!this.sshd && !this.starting && !this.stopped) { this.starting = true; try { await this.start(); } finally { this.starting = false; } } }
  async start() {
    try {
      await this.authorize();
      if (this.stopped) return;
      // High, loopback-only port, dedicated host key and strict forced keys.
      // No system sshd configuration, login key or user shell is modified.
      this.sshd = spawn(process.execPath, [path.join(this.root, 'setup/nanocode-daemon.mjs'), this.config.sshd, path.join(this.dir, 'sshd_config')], { stdio: ['pipe', 'ignore', 'pipe'] });
      this.sshd.on('error', () => this.disconnect());
      this.sshd.on('exit', () => { this.sshd = undefined; this.disconnect(); });
      this.sshd.stderr.on('data', () => {});
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.refresh(), 15_000);
    } catch { this.disconnect(); }
  }
  async refresh() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const state = await this.authorize();
      for (const [id, ch] of this.channels) if (!state.keys.some(k => k.fingerprint === ch.fingerprint && k.deviceId === ch.client)) this.close(id);
    } catch { this.disconnect(); this.sshd?.kill(); }
    finally { this.refreshing = false; }
  }
  async message(message) {
    if (this.stopped || typeof message.id !== 'string') return;
    const id = message.id;
    if (message.type === 'ssh.open') {
      if (this.channels.has(id) || this.channels.size >= 8) { this.send({ type: 'ssh.close', id }); return; }
      const ch = { client: message.client, fingerprint: message.fingerprint };
      this.channels.set(id, ch);
      try {
        const state = await this.authorize();
        if (!state.keys.some(k => k.fingerprint === ch.fingerprint && k.deviceId === ch.client)) throw new Error('key_not_authorized');
        if (this.channels.get(id) !== ch || this.stopped) return;
        const socket = ch.socket = connect({ host: '127.0.0.1', port: this.config.port });
        socket.on('error', () => this.close(id));
        socket.on('close', hadError => { if (hadError || !ch.stream) this.close(id); else { ch.stream.end(); ch.endTimer = setTimeout(() => this.close(id), 10_000); } });
        socket.once('connect', () => {
          if (this.channels.get(id) !== ch) { socket.destroy(); return; }
          this.send({ type: 'ssh.ready', id });
          ch.stream = new SshStream({ readable: socket, writable: socket, send: frame => this.send({ ...frame, id }), close: () => this.close(id) });
        });
      } catch { this.close(id); }
    } else if (message.type === 'ssh.close') this.close(id);
    else {
      try { this.channels.get(id)?.stream?.message(message); }
      catch { this.close(id); }
    }
  }
  close(id) {
    const ch = this.channels.get(id);
    if (!ch) return;
    this.channels.delete(id); clearTimeout(ch.endTimer); ch.stream?.stop(); ch.socket?.destroy();
    this.send({ type: 'ssh.close', id });
  }
  disconnect() { for (const id of [...this.channels.keys()]) this.close(id); }
  stop() { this.stopped = true; this.abort.abort(); clearInterval(this.timer); this.disconnect(); this.sshd?.kill(); }
}
