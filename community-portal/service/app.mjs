import { nanocodeRoute } from './nanocode.mjs';
import { isDeepStrictEqual } from 'node:util';
import { PerksService, mirror } from './perks.mjs';
import { HttpError, equal, fail, hash, json, publicDeviceKey, random, verifyDeviceProof } from './security.mjs';
import { SetupService } from './setup.mjs';
import { wrappingKey } from '../protocol/install-envelope.mjs';
import { currentSession, workosTokens } from './session.mjs';
import { activate, enabledChoice } from './activation.mjs';

const cookieValues = request => Object.fromEntries((request.headers.get('cookie') || '').split(';').map(c => c.trim().split(/=(.*)/s)).filter(c => c[0]));
export function createApp(config) {
  const service = new PerksService(config), { store, identity, origin, demo = false, workos = {} } = config;
  const setup = new SetupService(service, identity);
  const returnPath = value => /^\/\?setup=[\w-]{32}$/.test(value || '') ? value : '/';
  if (demo && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('Demo authentication is allowed only on loopback.');
  const secure = new URL(origin).protocol === 'https:';
  const sessionCookie = secure ? '__Host-nc_session' : 'nc_session';
  const cookie = (name, value, maxAge) => `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  async function session(request, write = false) {
    const value = cookieValues(request)[sessionCookie];
    const data = value && await currentSession(store, `SESSION#${hash(value)}`, workos);
    if (!data) fail(401, 'sign_in_required', 'Sign in to your NanoClaw account.');
    if (identity.active) await identity.active(data.accountId);
    if (write && (request.headers.get('origin') !== origin || !equal(request.headers.get('x-csrf-token'), data.csrf))) fail(403, 'csrf', 'Reload the portal before trying again.');
    return data;
  }
  async function startSession(user, next = '/', tokens = {}) {
    const value = random(32), csrf = random();
    const expires = Date.now() + 7 * 86400_000;
    await store.putOnce(`SESSION#${hash(value)}`, { ...user, csrf, ...tokens, expires, authenticatedAt: Date.now() }, expires);
    await service.initialize(user.accountId, user.name);
    await service.refreshIncluded(user.accountId);
    await service.flush(user.accountId);
    return new Response(null, { status: 303, headers: { location: returnPath(next), 'set-cookie': cookie(sessionCookie, value, 7 * 86400), 'cache-control': 'no-store' } });
  }
  async function install(request) {
    const header = request.headers.get('authorization') || '';
    if (!header.startsWith('Bearer ')) fail(401, 'invalid_token', 'An install token is required.');
    return identity.token(header.slice(7));
  }
  async function device(request, raw) {
    const principal = await install(request);
    const deviceId = `dev_${hash(principal.installId).slice(0, 24)}`;
    const account = await store.load(principal.accountId), item = account.devices[deviceId];
    if (!item || item.forgottenAt) fail(403, 'installation_required', 'Continue setup in the browser to sign in this installation.');
    await verifyDeviceProof(request, raw, item.publicKey, store, deviceId);
    return { ...principal, deviceId };
  }
  const handler = async request => {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/healthz') return json({ ok: true, service: 'community-perks' });
    if (path === '/api/v1/catalog' && method === 'GET') return json({ items: config.catalog, mode: config.catalog[0]?.mode, authentication: demo ? 'demo' : 'workos' });
    if (path === '/api/v1/auth/demo' && method === 'GET') {
      if (!demo) fail(404, 'not_found', 'This route does not exist.');
      return startSession(await identity.user(), url.searchParams.get('returnTo'));
    }
    if (path === '/api/v1/auth/start' && method === 'GET') {
      const next = returnPath(url.searchParams.get('returnTo'));
      if (demo) return new Response(null, { status: 303, headers: { location: `/api/v1/auth/demo?returnTo=${encodeURIComponent(next)}` } });
      if (!workos.clientId || !workos.apiKey) fail(503, 'auth_unconfigured', 'Account sign-in has not been configured.');
      const state = random(32), browser = random(32), verifier = random(48);
      await store.putOnce(`OAUTH#${hash(state)}`, { browserHash: hash(browser), verifier, next }, Date.now() + 600_000);
      const authorize = new URL('https://api.workos.com/user_management/authorize');
      authorize.search = new URLSearchParams({ client_id: workos.clientId, provider: 'authkit', response_type: 'code', redirect_uri: `${origin}/api/v1/auth/callback`, state, code_challenge: Buffer.from(hash(verifier), 'hex').toString('base64url'), code_challenge_method: 'S256' });
      return new Response(null, { status: 303, headers: { location: authorize.href, 'set-cookie': cookie('nc_oauth', browser, 600) } });
    }
    if (path === '/api/v1/auth/callback' && method === 'GET') {
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      const intent = state && await store.get(`OAUTH#${hash(state)}`);
      if (!intent || !code || !equal(intent.browserHash, hash(cookieValues(request).nc_oauth || ''))) fail(401, 'invalid_state', 'Restart sign-in from the portal.');
      if (!await store.take(`OAUTH#${hash(state)}`)) fail(401, 'used_state', 'Restart sign-in from the portal.');
      const response = await fetch('https://api.workos.com/user_management/authenticate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: workos.clientId, client_secret: workos.apiKey, grant_type: 'authorization_code', code, code_verifier: intent.verifier }), signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) fail(401, 'sign_in_failed', 'Sign-in could not be completed. Please try again.');
      const result = await response.json();
      return startSession(await identity.user(result.user), intent.next, workosTokens(result));
    }
    let raw = '';
    if (!['GET', 'HEAD'].includes(method)) {
      raw = await request.text();
      if (Buffer.byteLength(raw) > 16384) fail(413, 'too_large', 'This request is too large.');
    }
    let body = {};
    if (raw) { try { body = JSON.parse(raw); } catch { fail(400, 'invalid_json', 'Provide a JSON request.'); } }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json', 'Provide a JSON object.');
    const codeResponse = await nanocodeRoute({ path, method, body, request, raw, session, device, service, origin });
    if (codeResponse) return codeResponse;
    const activation = path.match(/^\/api\/v1\/activations\/(echo|slack|tavily|dial)$/);
    if (activation && method === 'POST') {
      const user = await session(request, true);
      if (body.accepted !== true) fail(400, 'consent_required', 'Choose Activate to enable this perk.');
      let binding;
      if (body.setupCode) {
        binding = await setup.binding(body.setupCode);
        if (binding.accountId && binding.accountId !== user.accountId) fail(403, 'wrong_account', 'This setup belongs to another account.');
        const current = await setup.read(binding);
        if (['pending', 'authorizing', 'browsing'].includes(current.status)) await setup.approve(binding, { accepted: true }, user, { browsing: true });
      }
      await activate(service, user.accountId, activation[1], body, user.actor);
      if (binding) await setup.continueWhenReady(binding, user);
      await service.reconcile(user.accountId);
      return json(mirror(await store.load(user.accountId)));
    }
    const slackMatch = path.match(/^\/api\/v1\/slack\/(connect|disconnect|revoke|install-url|approve-demo)$/);
    if (slackMatch && method === 'POST') {
      const user = await session(request, true), operation = slackMatch[1];
      if (!config.slackManage || (operation === 'approve-demo' && !demo)) fail(503, 'slack_unconfigured', 'Slack management is not configured.');
      if (['connect', 'disconnect', 'revoke', 'approve-demo'].includes(operation) && body.accepted !== true) fail(400, 'consent_required', 'Confirm this action in the browser.');
      if (['disconnect'].includes(operation) && !/^[A-Z0-9]{1,32}$/.test(body.teamId || '')) fail(400, 'invalid_workspace', 'Select a workspace.');
      if (['revoke', 'install-url', 'approve-demo'].includes(operation) && !/^[A-Z0-9]{1,32}$/.test(body.appId || '')) fail(400, 'invalid_app', 'Select an agent.');
      const result = await config.slackManage(user.accountId, operation, { teamId: body.teamId, appId: body.appId });
      await service.refreshIncluded(user.accountId, true); await service.flush(user.accountId); return json(result);
    }
    if (path === '/api/v1/setup/start' && method === 'POST') {
      if (['tavily', 'dial', 'perks'].includes(body.stage) && !config.catalog.some(p => p.kind !== 'account' && p.enabled && (body.stage === 'perks' || p.id === body.stage))) fail(503, 'partner_unconfigured', 'This perk is coming soon. Continue NanoClaw setup.');
      const principal = request.headers.has('authorization') ? await install(request) : { installId: body.installId };
      if (!/^[\w-]{1,64}$/.test(principal.installId || '')) fail(400, 'invalid_install', 'Provide an installation identifier.');
      const key = publicDeviceKey(body.publicKey);
      let wrapping; try { wrapping = wrappingKey(body.wrappingKey); } catch { fail(400, 'invalid_key', 'Provide an installation wrapping key.'); }
      await verifyDeviceProof(request, raw, key, store, `dev_${hash(principal.installId).slice(0, 24)}`);
      let reuseChoice;
      if (body.reuseEnabled === true) {
        if (!principal.accountId) fail(401, 'invalid_token', 'Sign in to this installation first.');
        const account = await store.load(principal.accountId), registered = account.devices[`dev_${hash(principal.installId).slice(0, 24)}`];
        if (!registered || registered.forgottenAt || !isDeepStrictEqual(registered.publicKey, key)) fail(403, 'installation_required', 'Sign in to this installation first.');
        await service.refreshIncluded(principal.accountId, true);
        reuseChoice = enabledChoice(await store.load(principal.accountId), body.stage, body.name);
        if (!reuseChoice) fail(409, 'perk_not_enabled', 'This perk has not been enabled yet.');
      }
      const window = Math.floor(Date.now() / 600_000), expires = Date.now() + 1200_000;
      if (!await store.limit(`SETUP_LIMIT#${window}#global`, 1000, expires) || !await store.limit(`SETUP_LIMIT#${window}#${hash(request.clientIp || 'unknown')}`, 30, expires)) fail(429, 'setup_limit', 'Too many setup requests. Try again shortly.');
      const result = await setup.start(principal, body, key, wrapping);
      if (reuseChoice) await setup.approve(await setup.binding(result.code), { accepted: true, ...reuseChoice }, { accountId: principal.accountId, actor: 'installation' });
      return json({ ...result, url: `${origin}/?setup=${result.code}` });
    }
    const setupMatch = path.match(/^\/api\/v1\/setup\/([\w-]{32})(?:\/(approve|authorize|return|complete|demo-slack))?$/);
    if (setupMatch) {
      const [, code, action] = setupMatch, binding = await setup.binding(code);
      const isDevice = request.headers.has('x-device-proof') || request.headers.has('authorization');
      let user;
      if (isDevice) {
        if (request.headers.has('authorization')) {
          const principal = await install(request);
          if ((binding.accountId && principal.accountId !== binding.accountId) || principal.installId !== binding.installId) fail(403, 'wrong_account', 'This setup belongs to another device.');
        } else if (!binding.enroll) fail(401, 'invalid_token', 'An install token is required.');
        await verifyDeviceProof(request, raw, binding.publicKey, store, binding.deviceId);
      } else {
        user = await session(request, method !== 'GET');
        if (binding.accountId && user.accountId !== binding.accountId) fail(403, 'wrong_account', 'Sign in with the NanoClaw account used by this CLI.');
      }
      if (!action && method === 'GET') {
        const result = isDevice ? await setup.delivery(binding, !request.headers.has('authorization')) : await setup.read(binding);
        if (binding.accountId && isDevice) await service.flush(binding.accountId);
        return json(result);
      }
      if (action === 'demo-slack' && method === 'POST' && isDevice && demo && config.demoSlackCreate) {
        await install(request);
        if ((await store.load(binding.accountId)).devices[binding.deviceId]?.forgottenAt) fail(401, 'installation_revoked', 'Restart setup to sign in again.');
        const current = await setup.read(binding);
        if (current.stage !== 'slack' || current.status !== 'approved') fail(409, 'setup_not_approved', 'Approve Slack setup in the browser.');
        return json(await config.demoSlackCreate(binding.accountId, current));
      }
      if (action === 'approve' && method === 'POST' && !isDevice) {
        const result = await setup.approve(binding, body, user); await service.flush(binding.accountId); return json(result);
      }
      if (action === 'authorize' && method === 'POST' && !isDevice) {
        const result = await setup.approve(binding, body, user, { browsing: true }); await service.flush(binding.accountId); return json(result);
      }
      if (action === 'return' && method === 'POST' && !isDevice) {
        const result = await setup.returnToTerminal(binding, user, { skip: body.skip === true }); await service.flush(binding.accountId); return json(result);
      }
      if (action === 'complete' && method === 'POST' && isDevice) {
        if (!binding.accountId) fail(409, 'setup_not_approved', 'Continue setup in the browser.');
        await install(request);
        const result = await setup.complete(binding, body); await service.refreshIncluded(binding.accountId, true); await service.flush(binding.accountId); return json(result);
      }
      fail(403, 'wrong_setup_leg', 'Approve in the browser and complete on the original device.');
    }
    if (path === '/api/v1/me' && method === 'GET') {
      const user = await session(request);
      await service.refreshIncluded(user.accountId);
      await service.reconcile(user.accountId);
      return json({ ...mirror(await store.load(user.accountId)), csrf: user.csrf, demo });
    }
    if (path === '/api/v1/included/refresh' && method === 'POST') {
      const user = await session(request, true);
      await service.refreshIncluded(user.accountId, true);
      await service.reconcile(user.accountId);
      return json(mirror(await store.load(user.accountId)));
    }
    if (path === '/api/v1/auth/logout' && method === 'POST') {
      await session(request, true);
      await store.delete(`SESSION#${hash(cookieValues(request)[sessionCookie])}`);
      return json({ ok: true }, 200, { 'set-cookie': cookie(sessionCookie, '', 0) });
    }
    if (path === '/api/v1/cell-ticket' && method === 'POST') {
      const bearer = request.headers.has('authorization');
      const principal = bearer ? await device(request, raw) : await session(request, true);
      await service.reconcile(principal.accountId);
      const ticket = await service.ticket(principal.accountId, bearer ? 'device' : 'browser', principal.deviceId);
      return json({ ticket, expiresIn: 900, socketUrl: `${origin.replace(/^http/, 'ws')}/cell/link` });
    }
    if (path === '/api/v1/device/state' && method === 'GET') {
      const principal = await device(request, raw);
      await service.refreshIncluded(principal.accountId);
      return json(mirror(await store.load(principal.accountId)));
    }
    if (path === '/api/v1/device/slack' && method === 'POST') {
      const principal = await device(request, raw);
      if (!/^[A-Z0-9]{1,32}$/.test(body.appId || '') || !['awaiting_approval', 'installing', 'complete', 'failed', 'expired'].includes(body.status)) fail(400, 'invalid_slack_progress', 'Invalid Slack installation progress.');
      await service.refreshIncluded(principal.accountId, true);
      await service.change(principal.accountId, a => {
        const item = a.devices[principal.deviceId], flow = a.setups?.[body.setupId];
        if (!item || item.forgottenAt) fail(401, 'installation_revoked', 'Sign in again.');
        if (item.slack?.appId !== body.appId && (!flow || flow.deviceId !== principal.deviceId || flow.stage !== 'slack' || !['approved', 'awaiting_approval', 'complete'].includes(flow.status))) fail(409, 'setup_not_approved', 'Start Slack from the portal first.');
        if (!a.included?.slack?.apps?.some(app => app.id === body.appId && app.status !== 'deleted')) fail(409, 'app_unavailable', 'The Slack app is not available.');
        item.slack = { appId: body.appId, setupId: body.setupId || item.slack?.setupId, status: body.status, updatedAt: new Date().toISOString() };
        if (flow && flow.deviceId === principal.deviceId) { flow.appId = body.appId; flow.status = body.status === 'installing' ? 'awaiting_approval' : body.status === 'expired' ? 'failed' : body.status; }
        return { type: 'slack.progress', detail: { deviceId: principal.deviceId, appId: body.appId, status: body.status } };
      });
      await service.flush(principal.accountId);
      return json({ ok: true });
    }
    const grantMatch = path.match(/^\/api\/v1\/grants\/(tavily|dial)(?:\/(redeem|ack))?$/);
    if (grantMatch) {
      const [, perkId, action] = grantMatch;
      if (action && method === 'POST') {
        const principal = await device(request, raw);
        const result = action === 'redeem'
          ? await service.redeem(principal.accountId, principal.deviceId, perkId, body.idempotencyKey)
          : await service.ack(principal.accountId, principal.deviceId, perkId, body);
        await service.flush(principal.accountId);
        return json(action === 'redeem' ? result : { ok: true });
      }
      if (!action && ['POST', 'DELETE'].includes(method)) {
        const user = await session(request, true);
        if (method === 'POST') await service.claim(user.accountId, perkId, body, user.actor);
        else await service.withdraw(user.accountId, perkId, user.actor);
        await service.reconcile(user.accountId);
        return json(mirror(await store.load(user.accountId)));
      }
    }
    const forget = path.match(/^\/api\/v1\/devices\/(dev_[a-f0-9]{24})$/);
    if (forget && method === 'DELETE') {
      const user = await session(request, true);
      const installation = (await store.load(user.accountId)).devices[forget[1]];
      if (!installation) fail(404, 'not_found', 'This installation does not exist.');
      if (!installation.installId) fail(409, 'installation_unknown', 'Restart setup for this installation before signing it out.');
      await identity.revoke(user.accountId, installation.installId, user.actor);
      await service.forget(user.accountId, forget[1]); await service.reconcile(user.accountId);
      return json(mirror(await store.load(user.accountId)));
    }
    fail(404, 'not_found', 'This route does not exist.');
  };
  return { service, async fetch(request) {
    try { return await handler(request); }
    catch (error) {
      if (!(error instanceof HttpError)) console.error(JSON.stringify({ event: 'request.failed', error: error?.name || 'Error' }));
      return json({ error: error.code || 'internal', message: error instanceof HttpError ? error.message : 'The request could not be completed. Please retry.' }, error.status || 500);
    }
  } };
}
