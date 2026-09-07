import { registerCodeKey, sshKey } from './nanocode.mjs';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fail, hash, random } from './security.mjs';
import { activationState, enabledChoice } from './activation.mjs';

export const SETUP_STAGES = ['echo', 'slack', 'perks', 'tavily', 'dial', 'nanocode'];
export function publicSetup(s) {
  return { id: s.id, stage: s.stage, deviceId: s.deviceId, label: s.label, name: s.name, status: s.status, autoContinue: s.autoContinue === true, createdAt: s.createdAt, expiresAt: s.expiresAt, choice: s.choice, sshPublicKey: s.sshPublicKey, appId: s.appId, error: s.error };
}

export class SetupService {
  constructor(service, identity) { this.service = service; this.store = service.store; this.identity = identity; }
  async start(principal, body, publicKey, wrappingKey) {
    if (!SETUP_STAGES.includes(body.stage)) fail(400, 'invalid_stage', 'Choose echo, slack, tavily, dial, or perks.');
    const code = random(24), id = randomUUID(), deviceId = `dev_${hash(principal.installId).slice(0, 24)}`;
    const expires = Date.now() + 30 * 60_000;
    const binding = { ...principal, id, deviceId, publicKey, wrappingKey, expires, enroll: !principal.accountId,
      stage: body.stage, ...(body.stage === 'nanocode' ? { sshPublicKey: sshKey(body.sshPublicKey).publicKey } : {}), autoContinue: body.autoContinue === true, label: String(body.label || 'NanoClaw device').slice(0, 60), name: String(body.name || 'Nano').slice(0, 35),
      status: 'pending', createdAt: new Date().toISOString(), expiresAt: new Date(expires).toISOString() };
    await this.store.putOnce(`SETUP#${hash(code)}`, binding, expires);
    return { code, id, installId: principal.installId, expiresAt: binding.expiresAt };
  }
  async binding(code) {
    const binding = typeof code === 'string' && await this.store.get(`SETUP#${hash(code)}`);
    if (!binding) fail(410, 'setup_expired', 'This setup link expired. Restart this step in the CLI.');
    const owner = await this.store.get(`SETUP_OWNER#${binding.id}`);
    return { ...binding, ...(owner ? { accountId: owner.accountId } : {}) };
  }
  async read(binding) {
    const a = binding.accountId && await this.store.load(binding.accountId);
    return publicSetup(a?.setups?.[binding.id] || binding);
  }
  async approve(binding, choice, user, { browsing = false } = {}) {
    if (choice.accepted !== true) fail(400, 'consent_required', 'Confirm this setup in the browser.');
    if (binding.accountId && binding.accountId !== user.accountId) fail(403, 'wrong_account', 'Sign in with the NanoClaw account used by this CLI.');
    let approved;
    if (browsing) approved = {};
    else if (binding.stage === 'echo') {
      if (!['hardened', 'local'].includes(choice.imageSource)) fail(400, 'invalid_image_source', 'Choose an image source.');
      await this.service.refreshIncluded(user.accountId, true);
      const echo = (await this.store.load(user.accountId)).included?.echo;
      if (choice.imageSource === 'hardened' && (echo?.status !== 'active' || echo.freshness !== 'current')) fail(409, 'image_access_required', 'Current Echo image access is required to use the hardened image.');
      approved = { imageSource: choice.imageSource };
    } else if (binding.stage === 'slack') {
      await this.service.refreshIncluded(user.accountId, true);
      const slack = (await this.store.load(user.accountId)).included?.slack;
      if (slack?.freshness !== 'current' || !slack.workspaces.some(w => w.id === choice.workspaceId && w.status === 'active')) fail(409, 'workspace_required', 'Connect and select an active workspace.');
      if (typeof choice.name !== 'string' || !choice.name.trim() || choice.name.trim().length > 35 || /[\r\n\x00-\x1f]/.test(choice.name)) fail(400, 'invalid_name', 'Use an agent name of 1–35 characters.');
      approved = { workspaceId: choice.workspaceId, name: choice.name.trim() };
    } else approved = {};
    // GET never authorizes an installation. The normal, CSRF-protected setup
    // choice claims this request for exactly one signed-in account.
    await this.store.putOnce(`SETUP_OWNER#${binding.id}`, { accountId: user.accountId }, binding.expires);
    const owner = await this.store.get(`SETUP_OWNER#${binding.id}`);
    if (owner.accountId !== user.accountId) fail(403, 'wrong_account', 'This setup belongs to another account.');
    binding.accountId = user.accountId;
    await this.service.change(binding.accountId, account => {
      account.setups ??= {};
      const existing = account.setups[binding.id];
      if (existing) {
        if (!isDeepStrictEqual(existing.choice, approved) || !['authorizing', 'approved', 'browsing'].includes(existing.status)) fail(409, 'setup_already_decided', 'This setup request has already been decided.');
        return;
      }
      const old = account.devices[binding.deviceId];
      // DynamoDB maps can return the same JWK in a different property order.
      if (old && !old.forgottenAt && !isDeepStrictEqual(old.publicKey, binding.publicKey)) fail(409, 'device_pinned', 'Sign out the previous installation before replacing its key.');
      if ((!old || old.forgottenAt) && Object.values(account.devices).filter(d => !d.forgottenAt).length >= 10) fail(409, 'device_limit', 'This account already has ten signed-in installations.');
      account.setups = Object.fromEntries(Object.entries(account.setups).filter(([, s]) => Date.parse(s.expiresAt) > Date.now()).slice(-19));
      account.setups[binding.id] = { ...publicSetup(binding), choice: approved, browsing, status: 'authorizing', actor: user.actor };
      return { type: 'setup.authorized', detail: { deviceId: binding.deviceId } };
    });
    return this.finish(binding);
  }
  async finish(binding) {
    if (!binding.accountId) return this.read(binding);
    const s = (await this.store.load(binding.accountId)).setups?.[binding.id];
    if (s?.status !== 'authorizing') return this.read(binding);
    // A retry after a lost response replays the registry's atomic encrypted
    // receipt. No token is minted or exposed through account/cell state.
    if (binding.enroll) await this.identity.enroll(binding, s.actor);
    await this.service.change(binding.accountId, account => {
      const current = account.setups?.[binding.id];
      if (current?.status !== 'authorizing') return;
      const old = account.devices[binding.deviceId];
      if (old?.forgottenAt && Date.parse(old.forgottenAt) >= Date.parse(s.createdAt)) fail(401, 'installation_revoked', 'Restart setup to sign in again.');
      if (old && !old.forgottenAt && !isDeepStrictEqual(old.publicKey, binding.publicKey)) fail(409, 'device_pinned', 'Sign out the previous installation before replacing its key.');
      if ((!old || old.forgottenAt) && Object.values(account.devices).filter(d => !d.forgottenAt).length >= 10) fail(409, 'device_limit', 'This account already has ten signed-in installations.');
      account.devices[binding.deviceId] = { ...(old && !old.forgottenAt ? old : {}), id: binding.deviceId, installId: binding.installId, label: s.label, publicKey: binding.publicKey, createdAt: old?.createdAt || new Date().toISOString() };
      registerCodeKey(account, binding, current.actor);
      current.status = current.browsing ? 'browsing' : 'approved';
      return { type: 'setup.approved', detail: { deviceId: binding.deviceId } };
    });
    return this.read(binding);
  }
  async delivery(binding, needsCredential = true) {
    const current = await this.finish(binding);
    if (needsCredential && binding.enroll && ['approved', 'awaiting_approval', 'complete', 'skipped'].includes(current.status)) {
      const a = await this.store.load(binding.accountId), s = a.setups[binding.id];
      if (!a.devices[binding.deviceId]) return current;
      if (a.devices[binding.deviceId]?.forgottenAt) fail(401, 'installation_revoked', 'Restart setup to sign in again.');
      return { ...current, ...(await this.identity.enroll(binding, s.actor)) };
    }
    return current;
  }
  async continueWhenReady(binding, user) {
    if (!binding.autoContinue) return;
    const account = await this.store.load(user.accountId);
    const enabled = activationState(account);
    if (enabledChoice(account, binding.stage, binding.name) || (binding.stage === 'perks' && (enabled.tavily.enabled || enabled.dial.enabled))) await this.returnToTerminal(binding, user);
  }
  async returnToTerminal(binding, user, { skip = false } = {}) {
    if (binding.accountId && binding.accountId !== user.accountId) fail(403, 'wrong_account', 'This setup belongs to another account.');
    await this.store.putOnce(`SETUP_OWNER#${binding.id}`, { accountId: user.accountId }, binding.expires);
    if ((await this.store.get(`SETUP_OWNER#${binding.id}`)).accountId !== user.accountId) fail(403, 'wrong_account', 'This setup belongs to another account.');
    binding.accountId = user.accountId;
    await this.finish(binding);
    await this.service.refreshIncluded(user.accountId, true);
    await this.service.change(user.accountId, account => {
      account.setups ??= {};
      const current = account.setups[binding.id];
      if (current && !['browsing', 'pending'].includes(current.status)) return;
      // Dismissing every activation does not enroll an installation. The CLI
      // resumes with an explicit skipped result and can offer a perk later.
      let choice = !skip && current && enabledChoice(account, binding.stage, binding.name);
      if (!skip && current && binding.stage === 'perks') {
        const enabled = activationState(account);
        if (enabled.tavily.enabled || enabled.dial.enabled) choice = {};
      }
      if (!current) account.setups = Object.fromEntries(Object.entries(account.setups).filter(([, s]) => Date.parse(s.expiresAt) > Date.now()).slice(-19));
      account.setups[binding.id] = { ...publicSetup(binding), ...current, choice: choice || {}, status: choice ? 'approved' : 'skipped' };
      return { type: 'setup.returned', detail: { deviceId: binding.deviceId } };
    });
    return this.read(binding);
  }
  async complete(binding, body) {
    if (!['complete', 'failed', 'awaiting_approval'].includes(body.status)) fail(400, 'invalid_status', 'Invalid setup result.');
    await this.service.change(binding.accountId, a => {
      const s = a.setups?.[binding.id];
      if (!s || !['approved', 'awaiting_approval', 'complete'].includes(s.status) || a.devices[binding.deviceId]?.forgottenAt) fail(409, 'setup_not_approved', 'This setup is not approved.');
      if (s.status === 'complete') return;
      if (s.stage === 'slack' && body.appId && !/^[A-Z0-9]{1,32}$/.test(body.appId)) fail(400, 'invalid_app', 'Invalid Slack app.');
      s.status = body.status;
      if (s.stage === 'slack' && body.appId) s.appId = body.appId;
      if (body.status === 'failed') s.error = 'The CLI could not finish. Check the terminal and restart this step.';
      if (s.stage === 'echo' && body.status === 'complete') a.devices[binding.deviceId].imageSource = s.choice.imageSource;
      return { type: `setup.${body.status}`, detail: { deviceId: binding.deviceId } };
    });
    return this.read(binding);
  }
}
