import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dynamoAccountPerks } from '../service/account-perks.mjs';
import { dynamoStore, newAccount, nextAccount, eventFor, Conflict } from '../service/store.mjs';
import { PerksService } from '../service/perks.mjs';
import { catalog } from './fixtures/catalog.mjs';
import { createAdapters } from '../service/partners.mjs';
import { startPartners } from '../scripts/partner-simulator.mjs';
import { random } from '../service/security.mjs';

test('DynamoDB: atomic consent/outbox, CAS, quota, nonce, lifecycle and due scheduling', { skip: !process.env.DYNAMODB_LOCAL_ENDPOINT }, async t => {
  const endpoint = new URL(process.env.DYNAMODB_LOCAL_ENDPOINT);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'test must use local DynamoDB');
  const client = new DynamoDBClient({ endpoint: endpoint.href, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const table = `nc_perks_test_${Date.now()}`;
  await client.send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], AttributeDefinitions: ['pk', 'sk', 'work', 'due'].map(name => ({ AttributeName: name, AttributeType: name === 'due' ? 'N' : 'S' })), GlobalSecondaryIndexes: [{ IndexName: 'work', KeySchema: [{ AttributeName: 'work', KeyType: 'HASH' }, { AttributeName: 'due', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }] }));
  t.after(async () => { await client.send(new DeleteTableCommand({ TableName: table })); client.destroy(); });
  const db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } }), store = await dynamoStore(table, db);
  const a = newAccount('acct_cas'), event = eventFor(a, 'account.ready'), next = nextAccount(a, event);
  const commits = await Promise.allSettled([store.commit(next, 0, { event }), store.commit(next, 0, { event })]);
  assert.equal(commits.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(commits.find(r => r.status === 'rejected').reason instanceof Conflict);
  assert.equal((await store.pending()).length, 1);
  await store.sent(a.id, 0); assert.equal((await store.pending()).length, 1);
  await store.sent(a.id, 1, Date.now() + 3600_000); assert.equal((await store.pending()).length, 0);
  assert.equal(await store.putOnce('NONCE#test', { used: true }, Date.now() + 60000), true);
  assert.equal(await store.putOnce('NONCE#test', {}, Date.now() + 60000), false);
  assert.deepEqual(await store.take('NONCE#test'), { used: true }); assert.equal(await store.take('NONCE#test'), null);
  const keys = { tavily: random(), dial: random() }, partners = await startPartners({ keys }); t.after(() => partners.close());
  const service = new PerksService({ store, catalog: catalog(), adapters: createAdapters(Object.fromEntries(Object.keys(keys).map(id => [id, { baseUrl: `${partners.origin}/${id}`, serviceKey: keys[id], allowLoopback: true }]))), globalDailyLimit: 1 });
  service.flush = async () => true;
  await service.initialize('acct_lifecycle', 'DynamoDB tester');
  await service.registerDevice('acct_lifecycle', { id: 'dev_first', label: 'Device one' });
  await service.registerDevice('acct_lifecycle', { id: 'dev_second', label: 'Device two' });
  for (const perk of ['tavily', 'dial']) {
    await service.claim('acct_lifecycle', perk, { accepted: true, termsVersion: 'demo-2026-09-05' }, 'tester');
    const result = await service.redeem('acct_lifecycle', 'dev_first', perk, random());
    await service.ack('acct_lifecycle', 'dev_first', perk, result);
    await assert.rejects(service.redeem('acct_lifecycle', 'dev_second', perk, random()), e => e.status === 429);
    assert.equal((await store.load('acct_lifecycle')).grants[perk].redemptions.dev_second, undefined, 'quota rejection rolls back account state');
    await service.withdraw('acct_lifecycle', perk, 'tester'); await service.reconcile('acct_lifecycle');
    assert.equal((await store.load('acct_lifecycle')).grants[perk].redemptions.dev_first.state, 'REVOKED');
    const rows = await db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'ACCT#acct_lifecycle' } }));
    assert.equal(JSON.stringify(rows.Items).includes(result.secret), false);
    assert.ok(rows.Items.some(row => row.body.termsHash));
  }
});

test('DynamoDB: existing Echo/Slack metadata is scoped, projected and bounded', { skip: !process.env.DYNAMODB_LOCAL_ENDPOINT }, async t => {
  const endpoint = new URL(process.env.DYNAMODB_LOCAL_ENDPOINT);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname));
  const client = new DynamoDBClient({ endpoint: endpoint.href, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const table = `nc_existing_test_${Date.now()}`;
  await client.send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], AttributeDefinitions: ['pk', 'sk', 'gsi1pk', 'gsi1sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })), GlobalSecondaryIndexes: [{ IndexName: 'gsi1', KeySchema: [{ AttributeName: 'gsi1pk', KeyType: 'HASH' }, { AttributeName: 'gsi1sk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } }] }));
  t.after(async () => { await client.send(new DeleteTableCommand({ TableName: table })); client.destroy(); });
  const db = DynamoDBDocumentClient.from(client);
  const rows = [
    { pk: 'ACCT#acct_one', sk: 'PERK#agent-image', perk: 'agent-image', status: 'granted', granted_at: '2026-09-05T00:00:00.000Z', secret: 'registry-private' },
    { pk: 'CONN#T1', sk: 'ACCT#acct_one', gsi1pk: 'ACCT#acct_one', gsi1sk: 'CONN#T1', team_id: 'T1', team_name: 'Own workspace', status: 'active', token_ciphertext: 'private-ciphertext' },
    { pk: 'CONN#T2', sk: 'ACCT#acct_two', gsi1pk: 'ACCT#acct_two', gsi1sk: 'CONN#T2', team_id: 'T2', team_name: 'Other workspace', status: 'active' },
    ...Array.from({ length: 201 }, (_, i) => ({ pk: `APP#A${i}`, sk: 'META', gsi1pk: 'ACCT#acct_one', gsi1sk: `APP#${String(i).padStart(3, '0')}`, account_id: 'acct_one', app_id: `A${i}`, team_id: 'T1', name: `Agent ${i}`, status: 'installed', token_ciphertext: 'private-ciphertext' })),
  ];
  for (let i = 0; i < rows.length; i += 25) await db.send(new BatchWriteCommand({ RequestItems: { [table]: rows.slice(i, i + 25).map(Item => ({ PutRequest: { Item } })) } }));
  const reads = [];
  const sources = dynamoAccountPerks({ registryTable: table, slackTable: table, client: { async send(command, options) { const response = await db.send(command, options); reads.push(response); return response; } } });
  assert.equal((await sources.echo('acct_one')).status, 'active'); assert.equal((await sources.echo('acct_two')).status, 'not_granted');
  const slack = await sources.slack('acct_one');
  assert.equal(slack.workspaces.length, 1); assert.equal(slack.workspaces[0].id, 'T1'); assert.equal(slack.apps.length, 200); assert.equal(slack.truncated, true);
  assert.ok(!JSON.stringify(reads).includes('private-ciphertext')); assert.ok(!JSON.stringify(reads).includes('registry-private'));
  assert.equal((await sources.slack('acct_two')).apps.length, 0);
});
