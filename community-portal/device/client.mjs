import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { deviceProof, random } from '../service/security.mjs';
import { processLock } from './process-lock.mjs';
import { CellConnection } from './connection.mjs';

export async function readJson(file, fallback = null) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
export async function writePrivate(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${random(8)}.tmp`;
  const output = await open(temp, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(value, null, 2)); await output.sync(); } finally { await output.close(); }
  await rename(temp, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export class DeviceClient {
  constructor({ origin, token, file, label = 'NanoClaw installation', log = () => {}, exclusive = false, waitForLockMs = 0, signal, existingOnly = false }) {
    const url = new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Portal origin must use HTTPS, except on loopback.');
    Object.assign(this, { origin: url.origin, token, file, label, log, exclusive, waitForLockMs, signal, existingOnly });
  }
  async initialize() {
    if (this.exclusive) {
      // Honor an older CLI still holding its plain lock. New clients use a
      // transactional owner record, recoverable after a crash or reboot.
      const deadline = Date.now() + this.waitForLockMs;
      do {
        const legacy = await readJson(`${this.file}.lock`);
        let legacyLive = false;
        if (legacy?.pid) { try { process.kill(legacy.pid, 0); legacyLive = true; } catch (e) { legacyLive = e.code !== 'ESRCH'; } }
        if (!legacyLive) this.releaseLock = await processLock(`${this.file}.owner.sqlite`);
        if (this.releaseLock) break;
        if (Date.now() >= deadline) throw Object.assign(new Error('Another setup or receiver owns this installation journal. Retry after it finishes.'), { code: 'journal_busy' });
        await sleep(100, undefined, { signal: this.signal });
      } while (true);
    }
    try {
    this.local = await readJson(this.file);
    if (!this.local) {
      if (this.existingOnly) throw Object.assign(new Error('Installation is not signed in.'), { code: 'installation_required' });
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      this.local = { privateKey: privateKey.export({ format: 'jwk' }), publicKey: publicKey.export({ format: 'jwk' }), credentials: {}, operations: {} };
      await this.save();
    }
    if (this.local.origin && this.local.origin !== this.origin) throw new Error('This installation belongs to a different portal. Use a separate state file.');
    this.local.origin = this.origin;
    this.local.installId ||= randomUUID();
    if (!this.local.wrappingPrivateKey) {
      const pair = generateKeyPairSync('x25519');
      this.local.wrappingPrivateKey = pair.privateKey.export({ format: 'jwk' });
      this.local.wrappingPublicKey = pair.publicKey.export({ format: 'jwk' });
    }
    this.token ??= this.local.registryAccount?.token;
    await this.save();
    return this;
    } catch (error) { await this.stop(); throw error; }
  }
  save() { return writePrivate(this.file, this.local); }
  async request(method, route, body, signal = this.signal) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const response = await fetch(`${this.origin}${route}`, { method, headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), 'content-type': 'application/json', ...deviceProof(this.local.privateKey, method, route, raw) }, ...(raw ? { body: raw } : {}), signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])]), redirect: 'error' });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.message || result.error); error.code = result.error; error.status = response.status; throw error; }
    return result;
  }
  async reconcile() {
    if (this.syncing) { this.again = true; return this.syncing; }
    this.syncing = this.sync().finally(() => { this.syncing = null; if (this.again && !this.stopped) { this.again = false; void this.reconcile().catch(error => this.log({ event: 'retry', code: error.code || 'unavailable' })); } });
    return this.syncing;
  }
  async sync() {
    const state = await this.request('GET', '/api/v1/device/state');
    const active = new Set(state.grants.filter(g => g.desired === 'active' && Date.parse(g.expiresAt) > Date.now()).map(g => g.perk));
    for (const perk of Object.keys(this.local.credentials)) if (!active.has(perk)) { delete this.local.credentials[perk]; delete this.local.operations[perk]; await this.save(); this.log({ event: 'removed', perk }); }
    for (const grant of state.grants) {
      if (!active.has(grant.perk)) continue;
      const redemption = grant.redemptions.find(r => r.deviceId === this.local.deviceId);
      if (redemption && ['REVOKING', 'REVOKED'].includes(redemption.state)) continue;
      let credential = this.local.credentials[grant.perk];
      if (credential && redemption?.keyId === credential.keyId && redemption.operationId === credential.operationId) {
        if (redemption.state === 'DELIVERED') continue;
      } else {
        const previous = this.local.operations[grant.perk];
        if (!previous || previous.grantId !== grant.id) { this.local.operations[grant.perk] = { grantId: grant.id, idempotencyKey: random(24) }; await this.save(); }
        const result = await this.request('POST', `/api/v1/grants/${grant.perk}/redeem`, { idempotencyKey: this.local.operations[grant.perk].idempotencyKey });
        if (!result.secret) { this.log({ event: 'local_credential_missing', perk: grant.perk }); continue; }
        credential = this.local.credentials[grant.perk] = result;
        // Persist before ACK, atomically, with owner-only file permissions.
        await this.save(); this.log({ event: 'stored', perk: grant.perk, resource: result.resource.label });
      }
      await this.request('POST', `/api/v1/grants/${grant.perk}/ack`, { operationId: credential.operationId, keyId: credential.keyId });
    }
    return state;
  }
  async run() {
    if (this.connection) return;
    this.stopped = false;
    this.connection = new CellConnection({ origin: this.origin, getTicket: signal => this.request('POST', '/api/v1/cell-ticket', {}, signal), log: this.log,
      onChange: () => void this.reconcile().catch(e => this.log({ event: 'retry', code: e.code || 'unavailable' })) });
    this.connection.start();
    this.pollTimer = setInterval(() => void this.reconcile().catch(e => {
      if (['installation_required', 'installation_revoked', 'invalid_token'].includes(e.code)) { this.local.credentials = {}; void this.save(); }
      this.log({ event: 'retry', code: e.code || 'unavailable' });
    }), 5000);
  }
  async stop() { this.stopped = true; clearInterval(this.pollTimer); this.connection?.stop(); this.connection = null; if (this.syncing) await this.syncing.catch(() => {}); if (this.releaseLock) { this.releaseLock(); this.releaseLock = null; } }
}
