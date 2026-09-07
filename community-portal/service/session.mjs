import { fail, random } from './security.mjs';

export function workosTokens(result) {
  let claims;
  try { claims = JSON.parse(Buffer.from(result.access_token.split('.')[1], 'base64url')); } catch {}
  if (!claims?.exp || !result.refresh_token) fail(502, 'invalid_session', 'Sign-in returned an incomplete session.');
  return { refreshToken: result.refresh_token, accessExpires: claims.exp * 1000 };
}

// Refresh tokens remain in private, expiring server session records, never in
// account mirrors or browser storage. CAS prevents a refresh reviving logout.
export async function currentSession(store, key, workos) {
  for (let i = 0; i < 55; i++) {
    const data = await store.get(key);
    if (!data) fail(401, 'sign_in_required', 'Sign in to your NanoClaw account.');
    if (!data.refreshToken || data.accessExpires > Date.now() + 30_000) return data;
    const lockKey = `${key}:refresh`, lock = { owner: random() };
    if (!await store.putOnce(lockKey, lock, Date.now() + 12_000)) { await new Promise(resolve => setTimeout(resolve, 200)); continue; }
    try {
      if (JSON.stringify(await store.get(key)) !== JSON.stringify(data)) continue;
      let response;
      try { response = await fetch('https://api.workos.com/user_management/authenticate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: workos.clientId, client_secret: workos.apiKey, grant_type: 'refresh_token', refresh_token: data.refreshToken }), signal: AbortSignal.timeout(8000), redirect: 'error' }); }
      catch { fail(503, 'auth_unavailable', 'Sign-in is temporarily unavailable. Please retry.'); }
      const result = await response.json();
      if (!response.ok) {
        if (result.error === 'invalid_grant') {
          await store.compareSwap(key, data, {}, Date.now());
          fail(401, 'sign_in_required', 'Sign in to your NanoClaw account.');
        }
        fail(503, 'auth_unavailable', 'Sign-in is temporarily unavailable. Please retry.');
      }
      const next = { ...data, ...workosTokens(result) };
      if (await store.compareSwap(key, data, next, data.expires)) return next;
    } finally {
      // Never delete a newer owner's lock if this invocation stalled.
      await store.compareSwap(lockKey, lock, {}, Date.now());
    }
  }
  fail(503, 'auth_busy', 'Sign-in is being refreshed. Please retry.');
}
