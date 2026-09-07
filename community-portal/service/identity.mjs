import { fail, hash } from './security.mjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { sealInstall } from '../protocol/install-envelope.mjs';
import { installKey, installTokenLive } from '../protocol/installation.mjs';

export async function registryIdentity(table, functionName) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const get = async pk => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk: 'META' }, ConsistentRead: true }))).Item;
  const active = async id => { const account = await get(`ACCT#${id}`); if (account?.status !== 'active') fail(403, 'account_unavailable', 'This NanoClaw account is not active.'); return account; };
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const lambda = new LambdaClient({ maxAttempts: 1 });
  const invoke = async (operation, body) => {
    if (!functionName) fail(503, 'auth_unconfigured', 'Registry sign-in is not configured.');
    const result = await lambda.send(new InvokeCommand({ FunctionName: functionName, Payload: Buffer.from(JSON.stringify({ source: 'nanoclaw-community-portal', operation, ...body })) }), { abortSignal: AbortSignal.timeout(20_000) });
    if (result.FunctionError) fail(503, 'registry_unavailable', 'Registry sign-in is temporarily unavailable.');
    const response = JSON.parse(Buffer.from(result.Payload).toString()), data = JSON.parse(response.body);
    if (response.statusCode !== 200) fail(response.statusCode, data.error, data.message);
    return data;
  };
  return {
    active,
    async token(value) {
      const record = await get(`TOKEN#${hash(value)}`);
      if (!record?.account_id || !record.install_id || !Number.isFinite(Number(record.expires_at)) || Number(record.expires_at) <= Math.floor(Date.now() / 1000)) fail(401, 'invalid_token', 'Sign in to NanoClaw again to renew this install token.');
      await active(record.account_id);
      if (!installTokenLive(record, await get(installKey(record.account_id, record.install_id)))) fail(401, 'installation_revoked', 'This installation was signed out. Continue setup in the browser to sign in again.');
      return { accountId: record.account_id, installId: record.install_id };
    },
    async user(user) {
      if (user.email_verified !== true) fail(403, 'email_unverified', 'Verify your email address before continuing.');
      const { accountId } = await invoke('account', { actor: user.id });
      await active(accountId);
      return { accountId, name: [user.first_name, user.last_name].filter(Boolean).join(' ') || 'NanoClaw member', actor: user.id };
    },
    enroll: (binding, actor) => invoke('enroll', { actor, accountId: binding.accountId, installId: binding.installId, requestId: binding.id, expires: binding.expires, wrappingKey: binding.wrappingKey, publicKey: binding.publicKey }),
    revoke: (accountId, installId, actor) => invoke('revoke', { actor, accountId, installId }),
  };
}

export function demoIdentity(tokens, store) {
  return {
    async token(value) {
      const record = tokens[hash(value)] || await store?.get(`DEMO_TOKEN#${hash(value)}`);
      if (!record) fail(401, 'invalid_token', 'Unknown demo install token.');
      const revoked = await store?.get(`DEMO_REVOKED#${record.accountId}#${record.installId}`);
      if (revoked && record.generation !== revoked.generation) fail(401, 'installation_revoked', 'This installation was signed out. Continue setup in the browser to sign in again.');
      return { accountId: record.accountId, installId: record.installId };
    },
    async user() { return { accountId: 'acct_demo', name: 'Demo member', actor: 'demo-member' }; },
    async enroll(binding) {
      const id = `DEMO_ENROLL#${binding.id}`;
      let receipt = await store.get(id);
      if (!receipt) {
        const token = randomBytes(32).toString('base64url');
        const revoked = await store.get(`DEMO_REVOKED#${binding.accountId}#${binding.installId}`);
        const principal = { accountId: binding.accountId, installId: binding.installId, generation: revoked?.generation };
        receipt = { principal, tokenHash: hash(token), envelope: sealInstall(binding.wrappingKey, `${binding.id}:${binding.installId}`, { token, account_id: binding.accountId, install_id: binding.installId, created_at: new Date().toISOString(), entitlements: ['agent-image'] }) };
        await store.putOnce(id, receipt, binding.expires); receipt = await store.get(id);
      }
      await store.putOnce(`DEMO_TOKEN#${receipt.tokenHash}`, receipt.principal, Date.now() + 365 * 86400_000);
      const revoked = await store.get(`DEMO_REVOKED#${binding.accountId}#${binding.installId}`);
      if (revoked && receipt.principal.generation !== revoked.generation) fail(401, 'installation_revoked', 'Restart setup to sign in again.');
      return { envelope: receipt.envelope };
    },
    async revoke(accountId, installId) {
      const id = `DEMO_REVOKED#${accountId}#${installId}`;
      const previous = await store.get(id), value = { generation: randomUUID() }, expires = Date.now() + 366 * 86400_000;
      if (previous) await store.compareSwap(id, previous, value, expires);
      else await store.putOnce(id, value, expires);
    },
  };
}
