import { randomBytes, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { HttpError, hash } from '../../service/security.mjs';

const conditional = error => error.name === 'ConditionalCheckFailedException' ||
  (error.name === 'TransactionCanceledException' && error.CancellationReasons?.some(r => r.Code === 'ConditionalCheckFailed'));

// Hosted test providers. No partner transport, account or live credential exists
// here. Only token hashes are persisted, in a dedicated simulator table.
export class DynamoSimulator {
  constructor({ id, table, client }) {
    if (!['tavily', 'dial'].includes(id)) throw new Error('Unknown simulated provider');
    if (!table?.endsWith('-partner-simulators')) throw new Error('Use a dedicated partner simulator table');
    Object.assign(this, { id, table, client: client || DynamoDBDocumentClient.from(new DynamoDBClient({})) });
  }
  key(name) { return { pk: `SIM#${this.id}#${hash(name)}`, sk: 'RESOURCE' }; }
  tokenKey(secret) { return { pk: `TOKEN#${this.id}#${hash(secret)}`, sk: 'SIMULATOR' }; }
  async row(Key) {
    return (await this.client.send(new GetCommand({ TableName: this.table, Key, ConsistentRead: true }))).Item;
  }
  async lookup(name) {
    const row = await this.row(this.key(name));
    return row?.id ? { id: row.id, status: row.status, used: row.used } : null;
  }
  async issue({ name, credits, expiresAt, resourceType }) {
    const expiry = Date.parse(expiresAt);
    if (typeof name !== 'string' || !name.length || name.length > 256 || !Number.isSafeInteger(credits) || credits < 1 || credits > 10000 ||
      !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 31 * 86400_000 ||
      resourceType !== (this.id === 'dial' ? 'phone-number' : 'search-key')) throw new HttpError(400, 'invalid_simulation', 'Invalid test resource request.');
    const id = randomUUID(), secret = `nc_sim_${this.id}_${randomBytes(32).toString('base64url')}`;
    // The reserved fictional range intentionally repeats; no real number is reserved.
    const phoneNumber = `+120255501${String(randomBytes(2).readUInt16BE() % 100).padStart(2, '0')}`;
    const resource = this.id === 'dial' ? { kind: resourceType, label: phoneNumber, phoneNumber } : { kind: resourceType, label: 'Test search credential' };
    const Key = this.key(name), expires = Math.ceil(expiry / 1000) + 90 * 86400;
    const result = { id, prefix: secret.slice(0, 14), resource, expiresAt: new Date(expiry).toISOString() };
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: { ...Key, ...result, tokenHash: hash(secret), credits, used: 0, status: 'active', terminal: false, expires },
          ConditionExpression: 'attribute_not_exists(pk) OR (#status = :revoked AND terminal = :no)',
          ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':revoked': 'revoked', ':no': false } } },
        { Put: { TableName: this.table, Item: { ...this.tokenKey(secret), resourceKey: Key, expires }, ConditionExpression: 'attribute_not_exists(pk)' } },
      ] }));
    } catch (error) {
      if (conditional(error)) throw new HttpError(409, 'partner_exists', 'The test resource already exists or was revoked. Retry to recover it.');
      throw error;
    }
    return { ...result, secret };
  }
  async revoke(name, { terminal = false } = {}) {
    await this.client.send(new UpdateCommand({ TableName: this.table, Key: this.key(name),
      UpdateExpression: `SET #status = :revoked, terminal = ${terminal ? ':terminal' : 'if_not_exists(terminal, :terminal)'}`,
      ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':revoked': 'revoked', ':terminal': terminal },
    }));
    return { status: 'revoked' };
  }
  async use(secret) {
    if (typeof secret !== 'string' || !secret.startsWith(`nc_sim_${this.id}_`) || secret.length > 128) throw new HttpError(401, 'invalid_credential', 'Provide the delivered test credential.');
    const token = await this.row(this.tokenKey(secret));
    const row = token && await this.row(token.resourceKey);
    if (!row || row.tokenHash !== hash(secret) || row.status !== 'active' || Date.parse(row.expiresAt) <= Date.now()) throw new HttpError(401, 'invalid_credential', 'This test credential has expired or was revoked.');
    if (row.used >= row.credits) throw new HttpError(429, 'quota_exhausted', 'The test allowance is exhausted.');
    try {
      await this.client.send(new UpdateCommand({ TableName: this.table, Key: token.resourceKey,
        UpdateExpression: 'SET used = used + :one',
        ConditionExpression: '#status = :active AND tokenHash = :hash AND expiresAt > :now AND used < credits',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':one': 1, ':active': 'active', ':hash': hash(secret), ':now': new Date().toISOString() },
      }));
    } catch (error) {
      if (conditional(error)) throw new HttpError(409, 'simulation_changed', 'The test credential changed or its allowance was exhausted.');
      throw error;
    }
    return { simulated: true, provider: this.id, resource: row.resource,
      result: this.id === 'dial' ? 'The test phone credential is valid. No call was placed.' : 'The test search credential is valid. No live search was made.' };
  }
}
