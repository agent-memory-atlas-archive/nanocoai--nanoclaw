import { HttpError } from './security.mjs';

// This is our adapter contract, not a claim about either partner's live API.
// All external calls are bounded and use configured, provider-specific origins.
export class PartnerAdapter {
  constructor({ id, baseUrl, serviceKey, allowLoopback = false }) {
    this.id = id; this.baseUrl = baseUrl; this.serviceKey = serviceKey;
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (url.username || url.password || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Partner origin must use HTTPS.');
    }
  }
  async call(path, body) {
    if (!this.baseUrl || !this.serviceKey) throw new HttpError(503, 'partner_unconfigured', `${this.id} is awaiting its integration contract.`);
    let response;
    try { response = await fetch(`${this.baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${this.serviceKey}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) }); }
    catch { throw new HttpError(503, 'partner_uncertain', 'The provider has not confirmed the result. Retry to recover safely.'); }
    if (response.status === 404) return null;
    if (response.status === 409) throw new HttpError(409, 'partner_exists', 'The provider already has this resource. Retry to recover it.');
    if (!response.ok) throw new HttpError(503, 'partner_unavailable', 'The provider is unavailable. Your request is saved.');
    const text = await response.text();
    if (text.length > 16_384) throw new HttpError(503, 'partner_invalid', 'The provider returned an invalid response.');
    let data; try { data = JSON.parse(text); } catch { throw new HttpError(503, 'partner_invalid', 'The provider returned an invalid response.'); }
    return data;
  }
  async lookup(name) {
    const result = await this.call(`/resources?name=${encodeURIComponent(name)}`);
    if (!result) return null;
    if (!/^[\w-]{1,128}$/.test(result.id || '') || !['active', 'revoked'].includes(result.status) || !Number.isSafeInteger(result.used) || result.used < 0) throw new HttpError(503, 'partner_invalid', 'The provider did not confirm existing usage.');
    return { id: result.id, status: result.status, used: result.used };
  }
  async revoke(name, { terminal = false } = {}) {
    const result = await this.call('/revoke', { name, terminal });
    if (result?.status !== 'revoked') throw new HttpError(503, 'partner_uncertain', 'The provider has not confirmed revocation.');
    return result;
  }
  async issue(input) {
    const result = await this.call('/provision', input);
    if (!/^[\w-]{1,128}$/.test(result?.id || '') || typeof result.secret !== 'string' || result.secret.length < 24 || result.secret.length > 4096 || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) > Date.parse(input.expiresAt) || !result.resource || typeof result.prefix !== 'string' || result.prefix.length > 16 || typeof result.resource.label !== 'string' || result.resource.label.length > 100 || result.resource.kind !== input.resourceType) throw new HttpError(503, 'partner_invalid', 'The provider did not return a usable credential.');
    if (Date.parse(result.expiresAt) <= Date.now()) throw new HttpError(503, 'partner_invalid', 'The provider returned an expired resource.');
    const resource = { kind: result.resource.kind, label: 'Test search credential' };
    if (resource.kind === 'phone-number') {
      if (!/^\+[1-9]\d{6,14}$/.test(result.resource.phoneNumber || '')) throw new HttpError(503, 'partner_invalid', 'The provider did not return a phone number.');
      resource.phoneNumber = result.resource.phoneNumber;
      resource.label = result.resource.phoneNumber;
    }
    return { id: result.id, secret: result.secret, prefix: result.prefix, resource, expiresAt: result.expiresAt };
  }
}
export const createAdapters = (configs = {}) => Object.fromEntries(['tavily', 'dial'].map(id => [id, new PartnerAdapter({ id, ...configs[id] })]));
