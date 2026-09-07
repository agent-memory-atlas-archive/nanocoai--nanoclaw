import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoSimulator } from './fixtures/simulator.mjs';
import { hostedPartners } from './fixtures/hosted-partners.mjs';
import { createApp } from '../service/app.mjs';
import { PerksService } from '../service/perks.mjs';
import { harness } from './harness.mjs';

test('test fixtures preserve WorkOS and real account services; unsupported modes fail closed', async t => {
  const disabled = hostedPartners({});
  assert.equal(disabled.globalDailyLimit, 0);
  assert.ok(disabled.catalog.filter(p => p.kind !== 'account').every(p => !p.enabled));
  assert.throws(() => hostedPartners({ PARTNER_MODE: 'live' }), /Only/);
  assert.throws(() => hostedPartners({ PARTNER_MODE: 'simulated' }), /separate table/);
  assert.throws(() => hostedPartners({ PARTNER_MODE: 'simulated', SIMULATOR_TABLE: 'shared', PERKS_TABLE: 'shared' }), /separate table/);
  assert.throws(() => new DynamoSimulator({ id: 'tavily', table: 'registry' }), /dedicated/);
  const config = hostedPartners({ PARTNER_MODE: 'simulated', SIMULATOR_TABLE: 'test-partner-simulators' }, { send() { throw new Error('Unexpected DB access'); } });
  const h = await harness({ withCell: false }); t.after(() => h.close());
  const app = createApp({ store: h.store, identity: {}, origin: h.origin, demo: false,
    workos: { clientId: 'client_test', apiKey: 'test-placeholder' }, ...config });
  const response = await app.fetch(new Request(`${h.origin}/api/v1/catalog`)), data = await response.json();
  assert.equal(data.authentication, 'workos');
  assert.ok(data.items.filter(p => p.kind === 'account').every(p => p.mode === 'existing'));
  assert.ok(data.items.filter(p => p.kind !== 'account').every(p => p.mode === 'simulated' && p.enabled));
  assert.equal((await app.fetch(new Request(`${h.origin}/api/v1/auth/demo`))).status, 404);
  const auth = await app.fetch(new Request(`${h.origin}/api/v1/auth/start`));
  assert.equal(auth.status, 303); assert.equal(new URL(auth.headers.get('location')).hostname, 'api.workos.com');
  assert.equal((await app.fetch(new Request(`${h.origin}/api/v1/simulators/tavily/use`, { method: 'POST' }))).status, 404);
  assert.equal((await app.fetch(new Request(`${h.origin}/api/v1/activations/tavily`, { method: 'POST', body: '{"accepted":true}' }))).status, 401);
});

async function fixture(t) {
  const endpoint = new URL(process.env.DYNAMODB_LOCAL_ENDPOINT);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Never run against a cloud table');
  const client = new DynamoDBClient({ endpoint: endpoint.href, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const table = `nc-${randomUUID()}-partner-simulators`;
  await client.send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    AttributeDefinitions: ['pk', 'sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })),
  }));
  t.after(async () => { await client.send(new DeleteTableCommand({ TableName: table })); client.destroy(); });
  const db = DynamoDBDocumentClient.from(client), config = hostedPartners({ PARTNER_MODE: 'simulated', SIMULATOR_TABLE: table }, db);
  return { table, db, config };
}

test('DynamoDB simulators persist hash-only credentials, bound concurrent quota and prevent resurrection', { skip: !process.env.DYNAMODB_LOCAL_ENDPOINT }, async t => {
  const { table, db, config } = await fixture(t);
  for (const provider of ['tavily', 'dial']) {
    const adapter = config.adapters[provider], name = `test-${provider}`;
    const input = { name, credits: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), resourceType: provider === 'dial' ? 'phone-number' : 'search-key' };
    const issues = await Promise.allSettled([adapter.issue(input), adapter.issue(input)]);
    assert.equal(issues.filter(r => r.status === 'fulfilled').length, 1);
    const issued = issues.find(r => r.status === 'fulfilled').value;
    assert.equal(JSON.stringify((await db.send(new ScanCommand({ TableName: table }))).Items).includes(issued.secret), false);
    const restarted = new DynamoSimulator({ id: provider, table, client: db });
    const uses = await Promise.allSettled([restarted.use(issued.secret), restarted.use(issued.secret)]);
    assert.equal(uses.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await restarted.lookup(name)).used, 1);
    const other = config.adapters[provider === 'dial' ? 'tavily' : 'dial'];
    await assert.rejects(other.use(issued.secret), e => e.code === 'invalid_credential');
    await restarted.revoke(name, { terminal: true });
    await restarted.revoke(name); // A later ordinary revoke must not clear the tombstone.
    await assert.rejects(restarted.use(issued.secret), e => e.code === 'invalid_credential');
    await assert.rejects(restarted.issue(input), e => e.code === 'partner_exists');
    await restarted.revoke(`${name}-late`, { terminal: true });
    await assert.rejects(restarted.issue({ ...input, name: `${name}-late` }), e => e.code === 'partner_exists');
  }
});

test('hosted simulator redemption recovers lost delivery without replenishing credits, then revokes', { skip: !process.env.DYNAMODB_LOCAL_ENDPOINT }, async t => {
  const { config } = await fixture(t), h = await harness({ withCell: false }); t.after(() => h.close());
  const service = new PerksService({ store: h.store, ...config }); service.flush = async () => true;
  await service.initialize('acct_sim', 'Hosted test');
  await service.registerDevice('acct_sim', { id: 'dev_sim', label: 'Hosted test device' });
  for (const provider of ['tavily', 'dial']) {
    const adapter = config.adapters[provider], idempotency = randomUUID();
    await service.claim('acct_sim', provider, { accepted: true, termsVersion: 'demo-2026-09-05' }, 'tester');
    const first = await service.redeem('acct_sim', 'dev_sim', provider, idempotency);
    await adapter.use(first.secret);
    const second = await service.redeem('acct_sim', 'dev_sim', provider, idempotency);
    assert.notEqual(first.keyId, second.keyId);
    assert.equal((await h.store.load('acct_sim')).grants[provider].redemptions.dev_sim.spent, 1);
    await assert.rejects(adapter.use(first.secret), e => e.code === 'invalid_credential');
    assert.equal((await adapter.use(second.secret)).simulated, true);
    await service.ack('acct_sim', 'dev_sim', provider, second);
    await service.withdraw('acct_sim', provider); await service.reconcile('acct_sim');
    await assert.rejects(adapter.use(second.secret), e => e.code === 'invalid_credential');
    assert.equal((await h.store.load('acct_sim')).grants[provider].redemptions.dev_sim.state, 'REVOKED');
  }
});
