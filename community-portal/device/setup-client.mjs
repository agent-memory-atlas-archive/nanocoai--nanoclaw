import { DeviceClient } from './client.mjs';
import { openInstall } from '../protocol/install-envelope.mjs';

// Used by the CLI handoffs and bundled into NanoClaw's setup tree. It carries
// no browser session and cannot approve its own request.
export class SetupClient extends DeviceClient {
  constructor({ autoContinue = false, ...options }) { super(options); this.autoContinue = autoContinue; }
  async available(stage) {
    const { items } = await this.request('GET', '/api/v1/catalog');
    return items.some(p => (stage === 'perks' ? p.kind !== 'account' : p.id === stage) && (p.kind === 'account' || p.enabled));
  }
  async resumeEnabled(stage, name = 'Nano') {
    if (!this.token) return false;
    try { await this.start(stage, name, { reuseEnabled: true }); return true; }
    catch (error) {
      if (error.status === 401) { await this.clearToken(); return false; }
      if (['perk_not_enabled', 'installation_required'].includes(error.code)) return false;
      throw error;
    }
  }
  async start(stage, name = 'Nano', { reuseEnabled = false } = {}) {
    const previous = this.local.setupFlow;
    if (!reuseEnabled && previous?.stage === stage && Date.parse(previous.expiresAt) > Date.now()) {
      this.flow = previous;
      try { if (['pending', 'authorizing', 'browsing', 'approved', 'awaiting_approval'].includes((await this.status()).status)) return previous; }
      catch (error) { if (error.status !== 410 && error.status !== 401) throw error; if (error.status === 401) await this.clearToken(); }
    }
    const body = { stage, name, reuseEnabled, autoContinue: this.autoContinue, installId: this.local.installId, label: this.label, publicKey: this.local.publicKey, wrappingKey: this.local.wrappingPublicKey, ...(stage === 'nanocode' ? { sshPublicKey: this.local.sshPublicKey } : {}) };
    try { this.flow = await this.request('POST', '/api/v1/setup/start', body); }
    catch (error) { if (reuseEnabled || error.status !== 401 || !this.token) throw error; await this.clearToken(); this.flow = await this.request('POST', '/api/v1/setup/start', body); }
    this.local.installId = this.flow.installId;
    this.flow.stage = stage;
    this.local.setupFlow = this.flow; await this.save(); return this.flow;
  }
  async status() { return this.request('GET', `/api/v1/setup/${this.flow.code}`); }
  async clearToken() { this.token = undefined; delete this.local.registryAccount; this.local.credentials = {}; await this.save(); }
  async wait({ pollMs = 1500, onState = () => {} } = {}) {
    while (Date.now() < Date.parse(this.flow.expiresAt)) {
      let result;
      try { result = await this.status(); }
      catch (error) {
        if (error.status && error.status < 500 && error.status !== 429) throw error;
        await new Promise(resolve => setTimeout(resolve, pollMs)); continue;
      }
      onState(result);
      if (['approved', 'awaiting_approval', 'skipped'].includes(result.status)) {
        if (result.envelope) {
          const account = openInstall(this.local.wrappingPrivateKey, `${this.flow.id}:${this.local.installId}`, result.envelope);
          if (!account.token || !account.account_id || account.install_id !== this.local.installId) throw new Error('Invalid installation credential');
          this.local.registryAccount = account;
          // Persist before use or completion. A lost response or process exit
          // replays the same encrypted credential, not another enrollment.
          await this.save(); this.token = account.token;
        }
        if (result.status !== 'skipped' || this.token) { this.local.deviceId = result.deviceId; await this.save(); }
        delete result.envelope; return result;
      }
      if (['cancelled', 'failed'].includes(result.status)) throw new Error('Setup was cancelled or failed. Restart this step.');
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error('Browser setup timed out. Restart this step to get a new link.');
  }
  async complete(status = 'complete', detail = {}) { return this.request('POST', `/api/v1/setup/${this.flow.code}/complete`, { status, ...detail }); }
}

export { DeviceClient, readJson, writePrivate } from './client.mjs';
export { NanocodeHost } from './nanocode-host.mjs';
export { CellConnection } from './connection.mjs';
export { processLock, processLockOwner } from './process-lock.mjs';
