import { codeModeState } from './nanocode.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Conflict, eventFor, nextAccount } from './store.mjs';
import { fail, hash, random, signTicket } from './security.mjs';
import { ACCOUNT_PERKS, publicAccountPerk } from './account-perks.mjs';
import { publicSetup } from './setup.mjs';
import { activationState } from './activation.mjs';

export function mirror(account) {
  return {
    account: { id: account.id, name: account.name }, revision: account.revision,
    activations: activationState(account), nanocode: codeModeState(account),
    included: ACCOUNT_PERKS.map(id => publicAccountPerk(id, account.included?.[id])),
    devices: Object.values(account.devices).filter(d => !d.forgottenAt).map(({ id, label, createdAt, imageSource, slack, nanocode }) => ({ id, label, createdAt, imageSource, slack, nanocode })),
    setups: Object.values(account.setups ?? {}).filter(s => Date.parse(s.expiresAt) > Date.now()).map(publicSetup),
    grants: Object.values(account.grants).map(g => ({
      id: g.id, perk: g.perk, desired: g.desired, claimedAt: g.claimedAt, expiresAt: g.expiresAt,
      redemptions: Object.values(g.redemptions).map(r => ({ deviceId: r.deviceId, operationId: r.operationId, state: r.state, keyId: r.keyId, prefix: r.prefix, resource: r.resource, expiresAt: r.expiresAt, deliveredAt: r.deliveredAt })),
    })),
    events: account.events.map(({ id, type, at, perk, deviceId }) => ({ id, type, at, perk, deviceId })),
  };
}

export class PerksService {
  constructor({ store, catalog, adapters, accountPerks = {}, signingKey, signer, cellOrigin, globalDailyLimit = 100, accountDailyLimit = 10, leaseMs = 20_000, sourceCacheMs = 60_000 }) {
    Object.assign(this, { store, catalog, adapters, accountPerks, signingKey, cellOrigin, globalDailyLimit, accountDailyLimit, leaseMs, sourceCacheMs });
    this.refreshing = new Map();
    this.signer = signer || ((claims, seconds) => signTicket(signingKey, claims, seconds));
  }
  perk(id) { const p = this.catalog.find(p => p.id === id); if (!p) fail(404, 'unknown_perk', 'This perk does not exist.'); return p; }
  async change(id, fn) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const account = await this.store.load(id);
      const result = fn(account);
      if (!result) return account;
      const { type, detail = {}, quota } = result;
      const event = type ? eventFor(account, type, detail) : undefined;
      const next = nextAccount(account, event);
      if (Buffer.byteLength(JSON.stringify(next)) > 250_000) fail(409, 'account_limit', 'This account has reached its storage limit.');
      try { await this.store.commit(next, account.revision, { event, quota }); return next; }
      catch (error) { if (!(error instanceof Conflict)) throw error; }
    }
    fail(409, 'busy', 'Another request is updating this account. Please retry.');
  }
  async initialize(id, name) { return this.change(id, a => { if (a.revision && a.name === name) return; a.name = name; return { type: 'account.ready' }; }); }
  async refreshIncluded(accountId, force = false) {
    if (this.refreshing.has(accountId)) return this.refreshing.get(accountId);
    const run = this.readIncluded(accountId, force).finally(() => this.refreshing.delete(accountId));
    this.refreshing.set(accountId, run); return run;
  }
  async readIncluded(accountId, force) {
    const before = await this.store.load(accountId), started = Date.now();
    const ids = ACCOUNT_PERKS.filter(id => this.accountPerks[id] && (force || started - (before.included?.[id]?.observedAt ?? 0) >= this.sourceCacheMs));
    if (!ids.length) return before;
    const results = await Promise.allSettled(ids.map(id => this.accountPerks[id](accountId)));
    return this.change(accountId, account => {
      let changed = false, statusChanged = false;
      for (const [i, id] of ids.entries()) {
        const previous = account.included?.[id];
        // A slower reader in another Lambda cannot overwrite a newer read.
        if (previous?.observedAt >= started) continue;
        const result = results[i], at = new Date(started).toISOString();
        const next = publicAccountPerk(id, result.status === 'fulfilled'
          ? { ...result.value, freshness: 'current', checkedAt: at, updatedAt: at }
          : { ...previous, freshness: previous?.updatedAt ? 'stale' : 'unavailable', checkedAt: at });
        const content = value => { const { checkedAt, updatedAt, observedAt, ...rest } = value ?? {}; return JSON.stringify(rest); };
        if (content(previous) !== content(next)) statusChanged = true;
        account.included ??= {}; account.included[id] = { ...next, observedAt: started }; changed = true;
      }
      // Checking freshness updates the mirror without filling the activity log.
      if (changed) return { type: statusChanged ? 'account.perks_updated' : null };
    });
  }
  async claim(accountId, perkId, { accepted, termsVersion }, actor) {
    const perk = this.perk(perkId);
    if (perk.kind === 'account') fail(409, 'managed_perk', 'This perk is managed by your existing NanoClaw service.');
    if (!perk.enabled) fail(503, 'partner_unconfigured', 'This partner is not available yet.');
    if (accepted !== true || termsVersion !== perk.termsVersion) fail(400, 'consent_required', 'Read and accept the current terms before claiming this perk.');
    return this.change(accountId, a => {
      const old = a.grants[perkId];
      if (old?.desired === 'active' && new Date(old.expiresAt).getTime() > Date.now()) return;
      if (old && Object.values(old.redemptions).some(r => r.state !== 'REVOKED')) fail(409, 'revocation_pending', 'Wait for the existing resources to be revoked before claiming again.');
      a.subjects[perkId] ??= `nc_${random(16)}`;
      a.grants[perkId] = { id: randomUUID(), perk: perkId, desired: 'active', claimedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + perk.termDays * 86400_000).toISOString(), redemptions: {} };
      return { type: 'perk.claimed', detail: { perk: perkId, actor, termsVersion, termsHash: hash(perk.termsText), termsText: perk.termsText, destination: 'paired-devices' } };
    });
  }
  async registerDevice(accountId, device) {
    return this.change(accountId, a => {
      const old = a.devices[device.id];
      if (old && !old.forgottenAt) {
        if (!isDeepStrictEqual(old.publicKey, device.publicKey)) fail(409, 'device_pinned', 'Forget this device in the portal before signing in a new key.');
        return;
      }
      if (Object.values(a.devices).filter(d => !d.forgottenAt).length >= 10) fail(409, 'device_limit', 'This account already has ten signed-in installations.');
      a.devices[device.id] = { ...device, createdAt: new Date().toISOString() };
      return { type: 'device.registered', detail: { deviceId: device.id } };
    });
  }
  async forget(accountId, deviceId) {
    return this.change(accountId, a => {
      const device = a.devices[deviceId];
      if (!device) fail(404, 'unknown_device', 'This device does not exist.');
      if (device.forgottenAt) return;
      device.forgottenAt = new Date().toISOString();
      for (const grant of Object.values(a.grants)) {
        const r = grant.redemptions[deviceId]; if (r && r.state !== 'REVOKED') r.state = 'REVOKING';
      }
      return { type: 'device.forgotten', detail: { deviceId } };
    });
  }
  async withdraw(accountId, perkId, actor = 'expiry') {
    return this.change(accountId, a => {
      const g = a.grants[perkId];
      if (!g) fail(404, 'unknown_grant', 'This perk has not been claimed.');
      if (g.desired === 'withdrawn') return;
      g.desired = 'withdrawn'; g.withdrawnAt = new Date().toISOString();
      for (const r of Object.values(g.redemptions)) if (r.state !== 'REVOKED') r.state = 'REVOKING';
      return { type: 'perk.withdrawn', detail: { perk: perkId, actor } };
    });
  }
  async redeem(accountId, deviceId, perkId, idempotencyKey) {
    const perk = this.perk(perkId);
    if (!perk.enabled || !this.adapters[perkId]) fail(503, 'partner_unconfigured', 'This perk is not available yet.');
    if (!/^[\w-]{16,100}$/.test(idempotencyKey || '')) fail(400, 'idempotency_required', 'Supply a stable idempotency key for this redemption.');
    const owner = random(16);
    const acquired = await this.change(accountId, a => {
      const g = a.grants[perkId], device = a.devices[deviceId];
      if (!device || device.forgottenAt) fail(403, 'device_forgotten', 'Sign in this installation again before redeeming.');
      if (!g || g.desired !== 'active' || Date.parse(g.expiresAt) <= Date.now()) fail(409, 'not_claimed', 'Claim this perk in the portal first.');
      let r = g.redemptions[deviceId];
      if (r?.state === 'DELIVERED') return;
      if (r?.leaseUntil > Date.now()) fail(409, 'in_progress', 'This redemption is already in progress. Retry shortly.');
      if (r && r.idempotencyKey !== idempotencyKey) fail(409, 'idempotency_conflict', 'Retry with the original idempotency key.');
      let quota;
      if (!r) {
        if (Object.values(g.redemptions).filter(r => r.state !== 'REVOKED').length >= perk.deviceCap) fail(409, 'device_cap', 'This perk is already assigned to two devices.');
        const day = new Date().toISOString().slice(0, 10);
        a.daily = Object.fromEntries(Object.entries(a.daily).filter(([key]) => key.startsWith(day)));
        const dayKey = `${day}:${perkId}`;
        if (!this.globalDailyLimit || (a.daily[dayKey] ?? 0) >= this.accountDailyLimit) fail(429, 'mint_limit', 'The daily provisioning limit has been reached.');
        a.daily[dayKey] = (a.daily[dayKey] ?? 0) + 1;
        quota = { key: dayKey, limit: this.globalDailyLimit };
        r = g.redemptions[deviceId] = { deviceId, operationId: randomUUID(), idempotencyKey, name: `nanoclaw:${a.subjects[perkId]}:${deviceId}:${g.id}`, state: 'ACCEPTED', spent: 0 };
      }
      r.leaseOwner = owner; r.leaseUntil = Date.now() + this.leaseMs;
      return { type: 'redemption.started', detail: { perk: perkId, deviceId }, quota };
    });
    const grant = acquired.grants[perkId], operation = grant.redemptions[deviceId];
    if (operation.state === 'DELIVERED') return { state: 'DELIVERED', operationId: operation.operationId, keyId: operation.keyId };
    const adapter = this.adapters[perkId];
    let issued;
    try {
      const existing = await adapter.lookup(operation.name);
      let spent = operation.spent;
      if (existing && operation.accountedKeyId !== existing.id) {
        // Commit usage before any further external call. If replacement minting
        // fails after revocation, the next retry must not reset the allowance.
        const accounted = await this.change(accountId, a => {
          const r = a.grants[perkId]?.redemptions[deviceId];
          if (!r || r.leaseOwner !== owner) fail(409, 'lease_lost', 'Retry to recover this redemption.');
          r.spent += existing.used; r.accountedKeyId = existing.id;
          return { type: 'redemption.usage_accounted', detail: { perk: perkId, deviceId } };
        });
        spent = accounted.grants[perkId].redemptions[deviceId].spent;
      }
      if (existing?.status === 'active') {
        await adapter.revoke(operation.name);
      }
      if (spent >= perk.credits) fail(409, 'credits_exhausted', 'This perk has no remaining credits.');
      issued = await adapter.issue({ name: operation.name, credits: perk.credits - spent, expiresAt: grant.expiresAt, resourceType: perk.resourceType });
      const completed = await this.change(accountId, a => {
        const g = a.grants[perkId], r = g?.redemptions[deviceId];
        if (!r || r.leaseOwner !== owner || r.operationId !== operation.operationId) fail(409, 'lease_lost', 'The request expired. Retry to recover its result.');
        Object.assign(r, { keyId: issued.id, prefix: issued.prefix, resource: issued.resource, expiresAt: issued.expiresAt, spent, leaseUntil: 0 });
        r.state = g.desired === 'active' && Date.parse(g.expiresAt) > Date.now() && !a.devices[deviceId].forgottenAt ? 'MINTED' : 'REVOKING';
        return { type: 'redemption.minted', detail: { perk: perkId, deviceId } };
      });
      if (completed.grants[perkId].redemptions[deviceId].state === 'REVOKING') { await this.reconcile(accountId); fail(409, 'withdrawn', 'This perk was withdrawn while provisioning.'); }
      return { state: 'MINTED', operationId: operation.operationId, keyId: issued.id, prefix: issued.prefix, resource: issued.resource, expiresAt: issued.expiresAt, secret: issued.secret };
    } catch (error) {
      await this.change(accountId, a => {
        const r = a.grants[perkId]?.redemptions[deviceId];
        if (!r || r.leaseOwner !== owner || ['DELIVERED', 'REVOKED'].includes(r.state)) return;
        r.leaseUntil = 0;
        if (r.state !== 'REVOKING') r.state = 'UNCERTAIN';
        return { type: 'redemption.uncertain', detail: { perk: perkId, deviceId } };
      });
      throw error;
    }
  }
  async ack(accountId, deviceId, perkId, { operationId, keyId }) {
    return this.change(accountId, a => {
      const g = a.grants[perkId], r = g?.redemptions[deviceId];
      if (!r || r.operationId !== operationId || r.keyId !== keyId) fail(409, 'ack_conflict', 'The credential has changed. Reconcile this device again.');
      if (g.desired !== 'active' || Date.parse(g.expiresAt) <= Date.now() || a.devices[deviceId]?.forgottenAt || !['MINTED', 'DELIVERED'].includes(r.state) || r.leaseUntil > Date.now()) fail(409, 'ack_conflict', 'This redemption cannot be acknowledged.');
      if (r.state === 'DELIVERED') return;
      r.state = 'DELIVERED'; r.deliveredAt = new Date().toISOString();
      return { type: 'redemption.delivered', detail: { perk: perkId, deviceId } };
    });
  }
  async reconcile(accountId) {
    let account = await this.store.load(accountId);
    for (const grant of Object.values(account.grants)) {
      if (grant.desired === 'active' && Date.parse(grant.expiresAt) <= Date.now()) account = await this.withdraw(accountId, grant.perk);
    }
    for (const grant of Object.values(account.grants)) for (const r of Object.values(grant.redemptions)) {
      if (r.state !== 'REVOKING' || r.leaseUntil > Date.now()) continue;
      try {
        await this.adapters[grant.perk].revoke(r.name, { terminal: true });
        await this.change(accountId, a => {
          const current = a.grants[grant.perk]?.redemptions[r.deviceId];
          if (current?.operationId !== r.operationId || current.state !== 'REVOKING') return;
          current.state = 'REVOKED'; current.leaseUntil = 0;
          return { type: 'redemption.revoked', detail: { perk: grant.perk, deviceId: r.deviceId } };
        });
      } catch { /* durable outbox retains this account until partner confirms */ }
    }
    return this.flush(accountId);
  }
  async flush(accountId) {
    const account = await this.store.load(accountId);
    const body = JSON.stringify(mirror(account));
    try {
      const ticket = await this.signer({ sub: accountId, leg: 'service', digest: hash(body) }, 60);
      const res = await fetch(`${this.cellOrigin}/cell/events`, { method: 'POST', headers: { authorization: `Bearer ${ticket}`, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(2500) });
      if (!res.ok) { await this.store.sent(accountId, account.revision, Date.now() + 5000); return false; }
      const pending = Object.values(account.grants).some(g => Object.values(g.redemptions).some(r => r.state === 'REVOKING'));
      const expiries = Object.values(account.grants).filter(g => g.desired === 'active').map(g => Date.parse(g.expiresAt));
      await this.store.sent(accountId, account.revision, pending ? Date.now() + 5000 : expiries.length ? Math.min(...expiries) : undefined);
      return true;
    } catch { await this.store.sent(accountId, account.revision, Date.now() + 5000); return false; }
  }
  async drain() {
    const deadline = Date.now() + 40_000;
    for (const item of await this.store.pending()) {
      await this.reconcile(item.id);
      if (Date.now() >= deadline) break;
    }
  }
  ticket(accountId, leg, deviceId) { return this.signer({ sub: accountId, leg, ...(deviceId ? { dev: deviceId } : {}) }); }
}
