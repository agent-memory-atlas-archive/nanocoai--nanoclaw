import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { harness } from './harness.mjs';
import { dynamoStore } from '../service/store.mjs';
import { hash, publicDeviceKey } from '../service/security.mjs';
import { SetupClient } from '../device/setup-client.mjs';

async function localDynamo(t) {
  const endpoint = new URL(process.env.DYNAMODB_LOCAL_ENDPOINT);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'test must use local DynamoDB');
  const client = new DynamoDBClient({ endpoint: endpoint.href, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const table = `nc_setup_key_${randomUUID()}`;
  await client.send(new CreateTableCommand({ TableName: table, BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], AttributeDefinitions: ['pk', 'sk'].map(AttributeName => ({ AttributeName, AttributeType: 'S' })) }));
  t.after(async () => { await client.send(new DeleteTableCommand({ TableName: table })); client.destroy(); });
  return dynamoStore(table, DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } }));
}

function reorderReads(store) {
  // Reproduce the live failure deterministically: DynamoDB maps do not promise
  // the insertion order SQLite preserves, even across records of the same key.
  const load = store.load.bind(store), get = store.get.bind(store);
  store.load = async id => {
    const account = await load(id);
    for (const device of Object.values(account.devices)) {
      const { x, y, kty, crv } = device.publicKey;
      device.publicKey = { x, y, kty, crv };
    }
    for (const setup of Object.values(account.setups ?? {})) {
      if (setup.choice) setup.choice = Object.fromEntries(Object.entries(setup.choice).reverse());
    }
    return account;
  };
  store.get = async id => {
    const value = await get(id);
    if (id.startsWith('SETUP#') && value?.publicKey) {
      const { crv, kty, y, x } = value.publicKey;
      value.publicKey = { crv, kty, y, x };
    }
    return value;
  };
}

for (const backend of ['SQLite with reordered maps', 'DynamoDB']) {
  test(`${backend}: Echo → Slack keeps one installation; retries and enabled perks accept the same key`, { skip: backend === 'DynamoDB' && !process.env.DYNAMODB_LOCAL_ENDPOINT }, async t => {
    const store = backend === 'DynamoDB' ? await localDynamo(t) : undefined;
    const h = await harness({ withCell: false, store }); t.after(() => h.close());
    if (!store) reorderReads(h.store);
    const client = await new SetupClient({ origin: h.origin, file: path.join(h.dir, 'same-installation.json') }).initialize();
    t.after(() => client.stop());
    const post = async (route, body = {}) => {
      const response = await h.browser(route, { method: 'POST', body });
      assert.equal(response.status, 200, JSON.stringify(response.data));
      return response.data;
    };

    const echo = await client.start('echo');
    await post('/activations/echo', { accepted: true, setupCode: echo.code });
    await post(`/setup/${echo.code}/return`);
    assert.deepEqual((await client.wait()).choice, { imageSource: 'hardened' });
    await client.complete();
    const token = client.token, deviceId = client.local.deviceId, key = publicDeviceKey(client.local.publicKey);
    assert.ok(token);

    const slack = await client.start('slack', 'Nova');
    const registered = (await h.store.load('acct_demo')).devices[deviceId];
    const binding = await h.store.get(`SETUP#${hash(slack.code)}`);
    assert.deepEqual(registered.publicKey, binding.publicKey);
    if (!store) assert.notEqual(JSON.stringify(registered.publicKey), JSON.stringify(binding.publicKey));
    await post(`/setup/${slack.code}/authorize`, { accepted: true });
    await post(`/setup/${slack.code}/authorize`, { accepted: true });
    await post('/slack/connect', { accepted: true });
    await post('/activations/slack', { accepted: true, setupCode: slack.code, workspaceId: 'TDEMO' });
    await post(`/setup/${slack.code}/return`);
    assert.deepEqual((await client.wait()).choice, { workspaceId: 'TDEMO', name: 'Nova' });
    await client.complete();

    // Lost approval responses can be retried even when a stored choice's map
    // order changes. A different choice still cannot replace an approved one.
    const retry = await client.start('slack', 'Nova');
    const choice = { accepted: true, workspaceId: 'TDEMO', name: 'Nova' };
    await post(`/setup/${retry.code}/approve`, choice);
    await post(`/setup/${retry.code}/approve`, choice);
    const changedChoice = await h.browser(`/setup/${retry.code}/approve`, { method: 'POST', body: { ...choice, name: 'Different' } });
    assert.equal(changedChoice.status, 409); assert.equal(changedChoice.data.error, 'setup_already_decided');
    await client.wait(); await client.complete();

    for (const stage of ['echo', 'slack']) {
      assert.equal(await client.resumeEnabled(stage, 'Nova'), true, `${stage} should reuse the signed-in installation`);
      await client.wait(); await client.complete();
    }
    await h.app.service.registerDevice('acct_demo', { id: deviceId, publicKey: key });
    assert.equal(client.token, token, 'later stages must retain the original credential');
    assert.equal(client.local.deviceId, deviceId);
    assert.equal((await post('/included/refresh')).devices.length, 1);

    // A new key with the same valid installation token remains blocked. The
    // original device stays signed in and usable after that rejection.
    const replacement = await new SetupClient({ origin: h.origin, token, file: path.join(h.dir, 'different-key.json') }).initialize();
    t.after(() => replacement.stop());
    await assert.rejects(h.app.service.registerDevice('acct_demo', { id: deviceId, publicKey: publicDeviceKey(replacement.local.publicKey) }), e => e.code === 'device_pinned');
    assert.equal(await replacement.resumeEnabled('slack'), false);
    const attempted = await replacement.start('slack');
    const rejected = await h.browser(`/setup/${attempted.code}/authorize`, { method: 'POST', body: { accepted: true } });
    assert.equal(rejected.status, 409); assert.equal(rejected.data.error, 'device_pinned');
    assert.deepEqual((await h.store.load('acct_demo')).devices[deviceId].publicKey, key);
    assert.equal((await client.request('GET', '/api/v1/device/state')).devices.length, 1);
  });
}
