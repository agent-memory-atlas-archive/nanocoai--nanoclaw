import { SshRelay, MAX_STREAMS } from './ssh-relay.mjs';
import { connectionDeadline, livePresence } from './presence.mjs';

const reply = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const decode = value => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('invalid encoding');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
};
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), x => x.toString(16).padStart(2, '0')).join('');
let cachedKey, cachedConfig;
async function verifyTicket(request, env) {
  const protocols = (request.headers.get('sec-websocket-protocol') || '').split(',').map(x => x.trim());
  const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '') || protocols.find(x => x.startsWith('ticket.'))?.slice(7);
  if (!token || token.length > 4096) throw new Error('invalid ticket');
  const [h, p, s, extra] = token.split('.');
  if (extra || !s) throw new Error('invalid ticket');
  const header = JSON.parse(new TextDecoder().decode(decode(h))), claims = JSON.parse(new TextDecoder().decode(decode(p)));
  const now = Date.now() / 1000;
  if (header.alg !== 'ES256' || claims.iss !== 'nanoclaw-perks' || claims.aud !== 'nanoclaw-cell' || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp <= now || claims.iat > now + 30 || claims.exp - claims.iat > 900 || !/^[\w:-]{1,128}$/.test(claims.sub || '') || !['service', 'browser', 'device', 'ssh'].includes(claims.leg)) throw new Error('invalid ticket');
  const keyConfig = env.GRANT_PUBLIC_KEY_SPKI || env.GRANT_PUBLIC_KEY_JWK;
  if (!cachedKey || keyConfig !== cachedConfig) {
    try {
      cachedKey = env.GRANT_PUBLIC_KEY_SPKI
        ? await crypto.subtle.importKey('spki', Uint8Array.from(atob(env.GRANT_PUBLIC_KEY_SPKI), c => c.charCodeAt(0)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
        : await crypto.subtle.importKey('jwk', JSON.parse(env.GRANT_PUBLIC_KEY_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    }
    catch { throw new Error('public_key_import_failed'); }
    cachedConfig = keyConfig;
  }
  let verified;
  try { verified = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, cachedKey, decode(s), new TextEncoder().encode(`${h}.${p}`)); }
  catch { throw new Error('signature_verification_failed'); }
  if (!verified) throw new Error('signature_mismatch');
  if (claims.leg === 'ssh' && (!/^dev_[a-f0-9]{24}$/.test(claims.dev || '') || !/^dev_[a-f0-9]{24}$/.test(claims.client || '') || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(claims.fingerprint || '') || !/^[\w-]{22}$/.test(claims.jti || ''))) throw new Error('invalid ticket');
  return claims;
}

export class AccountCell {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.ssh = new SshRelay(this);
    this.perks = ctx.facets.get('perks', () => ({ class: env.LOADER.get('perks-mirror-v1', () => ({
      compatibilityDate: '2026-01-01', mainModule: 'perks.mjs', modules: { 'perks.mjs': PERKS_FACET_SOURCE },
    })).getDurableObjectClass('PerksMirror') }));
  }
  sockets() { return this.ctx.getWebSockets(); }
  send(ws, data) { try { ws.send(JSON.stringify(data)); } catch { /* reconnecting clients read a full snapshot */ } }
  broadcast(data) { for (const ws of this.sockets()) if (ws.deserializeAttachment()?.leg !== 'ssh') this.send(ws, data); }
  presence() {
    return livePresence(this.sockets().map(ws => ws.deserializeAttachment()));
  }
  async expire() {
    let earliest = Infinity;
    for (const ws of this.sockets()) {
      const attachment = ws.deserializeAttachment();
      const deadline = connectionDeadline(attachment);
      if (deadline <= Date.now()) { this.ssh.close(ws, 'connection expired'); try { ws.close(4401, 'connection expired'); } catch {} }
      else earliest = Math.min(earliest, deadline);
    }
    if (Number.isFinite(earliest)) await this.ctx.storage.setAlarm(earliest);
    else await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    const claims = JSON.parse(request.headers.get('x-cell-claims'));
    const path = new URL(request.url).pathname;
    if (path === '/cell/events' && request.method === 'POST' && claims.leg === 'service') {
      const snapshot = await request.json();
      if (snapshot.account?.id !== claims.sub || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.devices) || !Array.isArray(snapshot.grants) || !Array.isArray(snapshot.events)) return reply({ error: 'invalid_snapshot' }, 400);
      const applied = await this.perks.update(snapshot);
      if (applied) {
        this.ssh.revoke(snapshot);
        const devices = new Set(snapshot.devices.map(d => d.id));
        for (const ws of this.sockets()) {
          const a = ws.deserializeAttachment();
          if (a?.leg === 'device' && !devices.has(a.dev)) { try { ws.close(4403, 'device forgotten'); } catch {} }
        }
        this.broadcast({ type: 'perks.changed', snapshot, presence: this.presence() });
      }
      return reply({ ok: true, applied });
    }
    if (claims.leg === 'service') return reply({ error: 'forbidden' }, 403);
    const snapshot = await this.perks.read();
    if (!snapshot) return reply({ error: 'initializing' }, 503);
    if (claims.leg === 'device' && !snapshot.devices.some(d => d.id === claims.dev)) return reply({ error: 'device_forgotten' }, 403);
    if (claims.leg === 'ssh') {
      if (path !== '/cell/ssh' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return reply({ error: 'forbidden' }, 403);
      await this.expire();
      if (!this.ssh.allowed(snapshot, claims)) return reply({ error: 'access_revoked' }, 403);
      if (!this.ssh.host(claims.dev)) return reply({ error: 'host_offline' }, 409);
      if (this.ssh.peers().length >= MAX_STREAMS) return reply({ error: 'stream_limit' }, 429);
      const pair = new WebSocketPair(), [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server); this.ssh.open(server, claims); await this.expire();
      return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'nc-cell' } });
    }
    if (path === '/cell/state' && request.method === 'GET') return reply({ snapshot, presence: this.presence() });
    if (path !== '/cell/link' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return reply({ error: 'not_found' }, 404);
    await this.expire();
    const peers = this.sockets().filter(ws => { const a = ws.deserializeAttachment(); return a?.leg === claims.leg && connectionDeadline(a) > Date.now(); });
    if (peers.length >= (claims.leg === 'browser' ? 8 : 10)) return reply({ error: 'connection_limit' }, 429);
    if (claims.leg === 'device' && peers.some(ws => ws.deserializeAttachment().dev === claims.dev)) return reply({ error: 'device_connected' }, 409);
    const pair = new WebSocketPair(), [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sub: claims.sub, leg: claims.leg, dev: claims.dev, exp: claims.exp, lastSeen: Date.now() });
    this.send(server, { type: 'snapshot', snapshot, presence: this.presence() });
    this.broadcast({ type: 'presence.changed', presence: this.presence() });
    await this.expire();
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'nc-cell' } });
  }
  async webSocketMessage(ws, message) {
    const attachment = ws.deserializeAttachment();
    if (connectionDeadline(attachment) <= Date.now()) { ws.close(4401, 'connection expired'); return; }
    if (typeof message !== 'string' || message.length > 24_000) { ws.close(1009, 'message too large'); return; }
    if (message.startsWith('{')) {
      try {
        const frame = JSON.parse(message);
        if (frame.type === 'auth.renew') {
          const fresh = await verifyTicket(new Request('https://cell/', { headers: { authorization: `Bearer ${frame.ticket}` } }), this.env);
          if (fresh.sub !== attachment.sub || fresh.leg !== attachment.leg || fresh.dev !== attachment.dev || fresh.client !== attachment.client || fresh.fingerprint !== attachment.fingerprint) throw new Error('identity_changed');
          if (fresh.leg === 'ssh' && !this.ssh.allowed(await this.perks.read(), fresh)) throw new Error('access_revoked');
          ws.serializeAttachment({ ...ws.deserializeAttachment(), exp: fresh.exp, lastSeen: Date.now() }); await this.expire(); return;
        }
        if (frame.type?.startsWith('ssh.')) { this.ssh.message(ws, frame); return; }
      } catch { this.ssh.close(ws, 'invalid frame'); ws.close(4403, 'invalid frame'); return; }
    }
    // Ordinary notifications cannot mutate grants or route commands.
    if (message === 'ping') {
      ws.serializeAttachment({ ...attachment, lastSeen: Date.now() });
      this.send(ws, { type: 'pong' });
      if (attachment.leg === 'device') await this.expire();
    }
    else this.send(ws, { type: 'error', error: 'read_only' });
  }
  async webSocketClose(ws) { this.ssh.close(ws); try { ws.close(1000); } catch {} this.broadcast({ type: 'presence.changed', presence: this.presence() }); }
  async webSocketError(ws) { this.ssh.close(ws); try { ws.close(1011); } catch {} }
  async alarm() { await this.expire(); this.broadcast({ type: 'presence.changed', presence: this.presence() }); }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/healthz') return reply({ ok: true, app: 'nanoclaw-community-cell', keyConfigured: Boolean(env.GRANT_PUBLIC_KEY_JWK || env.GRANT_PUBLIC_KEY_SPKI) });
    if (!path.startsWith('/cell/')) {
      if (!env.ASSETS) return reply({ error: 'not_found' }, 404);
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      headers.set('x-content-type-options', 'nosniff'); headers.set('referrer-policy', 'no-referrer');
      return new Response(response.body, { status: response.status, headers });
    }
    let claims;
    try { claims = await verifyTicket(request, env); }
    catch (error) { const reason = ['public_key_import_failed', 'signature_verification_failed', 'signature_mismatch'].includes(error.message) ? error.message : 'invalid_ticket'; return reply({ error: 'invalid_ticket', reason }, 401); }
    if (path === '/cell/events') {
      if (request.method !== 'POST' || claims.leg !== 'service') return reply({ error: 'forbidden' }, 403);
      const text = await request.clone().text();
      if (text.length > 250_000 || await digest(text) !== claims.digest) return reply({ error: 'invalid_snapshot' }, 400);
    }
    const headers = new Headers(request.headers); headers.set('x-cell-claims', JSON.stringify(claims));
    // Never trust an incoming x-cell-claims header; the verified ticket replaces it.
    const id = env.ACCOUNTS.idFromName(`tenant:${claims.sub}`);
    try { return await env.ACCOUNTS.get(id).fetch(new Request(request, { headers })); }
    catch { return reply({ error: 'cell_unavailable', retryAfter: 2 }, 503); }
  },
};
import { PERKS_FACET_SOURCE } from './facet.mjs';
