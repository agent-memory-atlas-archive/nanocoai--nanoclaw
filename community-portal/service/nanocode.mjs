import { createHash } from 'node:crypto';
import { fail, json, random } from './security.mjs';

// Only public Ed25519 SSH keys cross this boundary. Private SSH keys, device
// signing keys and registry credentials remain three separate trust roles.
export function sshKey(value) {
  if (typeof value !== 'string' || value.length > 200) fail(400, 'invalid_ssh_key', 'Provide an Ed25519 SSH public key.');
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(value.trim());
  if (!match) fail(400, 'invalid_ssh_key', 'Provide an Ed25519 SSH public key without options or a comment.');
  const wire = Buffer.from(match[1], 'base64');
  if (wire.length !== 51 || wire.readUInt32BE(0) !== 11 || wire.subarray(4, 15).toString() !== 'ssh-ed25519' || wire.readUInt32BE(15) !== 32 || wire.toString('base64') !== match[1]) fail(400, 'invalid_ssh_key', 'The SSH key is malformed.');
  return { publicKey: `ssh-ed25519 ${match[1]}`, fingerprint: `SHA256:${createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}` };
}

export function codeModeState(account) {
  return {
    keys: Object.values(account.codeKeys || {}).filter(k => !k.revokedAt && !account.devices[k.deviceId]?.forgottenAt && account.devices[k.deviceId]),
    devices: Object.values(account.devices).filter(d => !d.forgottenAt && d.nanocode).map(d => ({ id: d.id, label: d.label, ...d.nanocode })),
  };
}

export function registerCodeKey(account, binding, actor) {
  if (binding.stage !== 'nanocode') return;
  if (typeof actor !== 'string' || !actor) fail(403, 'identity_required', 'Browser sign-in must establish the key owner.');
  const key = sshKey(binding.sshPublicKey);
  account.codeKeys ??= {};
  account.codeKeys[key.fingerprint] = { ...key, deviceId: binding.deviceId, actor, createdAt: new Date().toISOString() };
}

export async function nanocodeRoute({ path, method, body, request, raw, session, device, service, origin }) {
  if (!path.startsWith('/api/v1/nanocode/')) return;
  const browser = !request.headers.has('authorization');
  const principal = browser ? await session(request, method !== 'GET') : await device(request, raw);
  const { accountId } = principal;
  if (path === '/api/v1/nanocode/state' && method === 'GET') return json(codeModeState(await service.store.load(accountId)));
  if (path === '/api/v1/nanocode/host' && method === 'POST' && !browser) {
    const key = sshKey(body.hostKey);
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(body.user || '')) fail(400, 'invalid_ssh_user', 'Provide the local SSH account.');
    if (typeof body.enabled !== 'boolean') fail(400, 'invalid_state', 'Choose whether to enable code mode access.');
    await service.change(accountId, a => {
      const d = a.devices[principal.deviceId];
      if (d.nanocode?.hostKey && d.nanocode.hostKey !== key.publicKey) fail(409, 'host_key_changed', 'Sign out this installation before replacing its SSH host key.');
      d.nanocode = { user: body.user, hostKey: key.publicKey, fingerprint: key.fingerprint, enabled: body.enabled, updatedAt: new Date().toISOString() };
      return { type: 'nanocode.host', detail: { deviceId: d.id } };
    });
    await service.flush(accountId);
    return json({ ok: true });
  }
  if (path === '/api/v1/nanocode/access' && method === 'POST' && browser) {
    if (typeof body.enabled !== 'boolean' || (body.enabled && body.accepted !== true)) fail(400, 'consent_required', 'Confirm remote code mode access.');
    await service.change(accountId, a => {
      const d = a.devices[body.deviceId];
      if (!d || d.forgottenAt || !d.nanocode) fail(404, 'host_unavailable', 'Enable code mode on this installation first.');
      d.nanocode.enabled = body.enabled;
      d.nanocode.updatedAt = new Date().toISOString();
      return { type: 'nanocode.access', detail: { deviceId: d.id, actor: principal.actor } };
    });
    await service.flush(accountId);
    return json(codeModeState(await service.store.load(accountId)));
  }
  if (path === '/api/v1/nanocode/key/revoke' && method === 'POST' && browser) {
    await service.change(accountId, a => {
      const k = a.codeKeys?.[body.fingerprint];
      if (!k) fail(404, 'unknown_key', 'This key is not registered to your account.');
      k.revokedAt = new Date().toISOString();
      return { type: 'nanocode.key_revoked', detail: { deviceId: k.deviceId, actor: principal.actor } };
    });
    await service.flush(accountId);
    return json({ ok: true });
  }
  if (path === '/api/v1/nanocode/ticket' && method === 'POST' && !browser) {
    const account = await service.store.load(accountId);
    const target = account.devices[body.deviceId];
    const key = account.codeKeys?.[body.fingerprint];
    if (!target || target.forgottenAt || !target.nanocode?.enabled) fail(403, 'host_unavailable', 'This installation has not enabled code mode access.');
    if (!key || key.revokedAt || key.deviceId !== principal.deviceId) fail(403, 'key_not_authorized', 'Authorize this terminal key through portal sign-in.');
    const ticket = await service.signer({ sub: accountId, leg: 'ssh', dev: target.id, client: principal.deviceId, fingerprint: key.fingerprint, jti: random(16) }, 900);
    return json({ ticket, expiresIn: 900, hostKey: target.nanocode.hostKey, socketUrl: `${origin.replace(/^http/, 'ws')}/cell/ssh` });
  }
  fail(403, 'wrong_code_mode_leg', 'This action is not available to this credential.');
}
