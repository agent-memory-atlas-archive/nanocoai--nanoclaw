import { randomUUID } from 'node:crypto';
import { HttpError } from './security.mjs';

export class Conflict extends Error {}
export const newAccount = (id, name = 'NanoClaw member') => ({ id, name, revision: 0, devices: {}, grants: {}, subjects: {}, events: [], daily: {} });
export function eventFor(account, type, detail = {}) {
  return { id: randomUUID(), type, at: new Date().toISOString(), ...detail };
}
export function nextAccount(account, event) {
  const next = structuredClone(account);
  next.revision++;
  if (event) next.events = [...next.events, event].slice(-40);
  return next;
}

// The same optimistic account transaction is used by SQLite and DynamoDB.
// Its outbox and immutable consent/audit record commit with the desired state.
export async function sqliteStore(filename) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, due INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ephemeral(id TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS quotas(id TEXT PRIMARY KEY, count INTEGER NOT NULL);`);
  return {
    db,
    async load(id) { const row = db.prepare('SELECT body FROM accounts WHERE id=?').get(id); return row ? JSON.parse(row.body) : newAccount(id); },
    async commit(account, expected, { event, quota } = {}) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT revision FROM accounts WHERE id=?').get(account.id);
        if ((row?.revision ?? 0) !== expected) throw new Conflict();
        if (quota) {
          const count = db.prepare('SELECT count FROM quotas WHERE id=?').get(quota.key)?.count ?? 0;
          if (count >= quota.limit) throw new HttpError(429, 'mint_limit', 'The daily provisioning limit has been reached. Try again tomorrow.');
          db.prepare('INSERT INTO quotas VALUES(?,1) ON CONFLICT(id) DO UPDATE SET count=count+1').run(quota.key);
        }
        db.prepare('INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(account.id, account.revision, JSON.stringify(account));
        if (event) db.prepare('INSERT INTO audit VALUES(?,?,?)').run(event.id, account.id, JSON.stringify(event));
        db.prepare('INSERT INTO outbox VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,due=0').run(account.id, account.revision);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    async pending() { return db.prepare('SELECT id,revision FROM outbox WHERE due<=? ORDER BY due LIMIT 100').all(Date.now()); },
    async sent(id, revision, due) {
      if (due !== undefined) db.prepare('UPDATE outbox SET due=? WHERE id=? AND revision=?').run(due, id, revision);
      else db.prepare('DELETE FROM outbox WHERE id=? AND revision=?').run(id, revision);
    },
    async putOnce(id, value, expires) {
      return db.prepare('INSERT INTO ephemeral VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires=excluded.expires WHERE ephemeral.expires<?').run(id, JSON.stringify(value), expires, Date.now()).changes === 1;
    },
    async get(id) { const row = db.prepare('SELECT * FROM ephemeral WHERE id=? AND expires>?').get(id, Date.now()); return row ? JSON.parse(row.body) : null; },
    async compareSwap(id, previous, value, expires) { return db.prepare('UPDATE ephemeral SET body=?,expires=? WHERE id=? AND body=? AND expires>?').run(JSON.stringify(value), expires, id, JSON.stringify(previous), Date.now()).changes === 1; },
    async limit(id, max, expires) {
      const result = db.prepare('INSERT INTO ephemeral VALUES(?,\'1\',?) ON CONFLICT(id) DO UPDATE SET body=CASE WHEN expires<=? THEN \'1\' ELSE CAST(body AS INTEGER)+1 END, expires=excluded.expires WHERE expires<=? OR CAST(body AS INTEGER)<?').run(id, expires, Date.now(), Date.now(), max);
      return result.changes === 1;
    },
    async take(id) { const row = db.prepare('DELETE FROM ephemeral WHERE id=? RETURNING *').get(id); return row && row.expires > Date.now() ? JSON.parse(row.body) : null; },
    async delete(id) { db.prepare('DELETE FROM ephemeral WHERE id=?').run(id); },
    close() { db.close(); },
  };
}

export async function dynamoStore(table, client) {
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, TransactWriteCommand } = await import('@aws-sdk/lib-dynamodb');
  const db = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const get = async (pk, sk = 'META') => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true }))).Item;
  return {
    async load(id) { return (await get(`ACCT#${id}`))?.body ?? newAccount(id); },
    async commit(account, expected, { event, quota } = {}) {
      const TransactItems = [
        { Put: { TableName: table, Item: { pk: `ACCT#${account.id}`, sk: 'META', revision: account.revision, body: account }, ConditionExpression: expected ? 'revision = :revision' : 'attribute_not_exists(pk)', ...(expected ? { ExpressionAttributeValues: { ':revision': expected } } : {}) } },
        { Put: { TableName: table, Item: { pk: `OUTBOX#${account.id}`, sk: 'META', id: account.id, revision: account.revision, work: 'pending', due: 0 } } },
      ];
      if (event) TransactItems.push({ Put: { TableName: table, Item: { pk: `ACCT#${account.id}`, sk: `EVENT#${event.at}#${event.id}`, body: event }, ConditionExpression: 'attribute_not_exists(pk)' } });
      if (quota) TransactItems.push({ Update: { TableName: table, Key: { pk: `QUOTA#${quota.key}`, sk: 'META' }, UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :one, expires = :expires', ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit', ExpressionAttributeNames: { '#n': 'count' }, ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':limit': quota.limit, ':expires': Math.floor(Date.now() / 1000) + 172800 } } });
      try { await db.send(new TransactWriteCommand({ TransactItems })); }
      catch (error) {
        if (error.name !== 'TransactionCanceledException') throw error;
        if (quota && error.CancellationReasons?.at(-1)?.Code === 'ConditionalCheckFailed') throw new HttpError(429, 'mint_limit', 'The daily provisioning limit has been reached. Try again tomorrow.');
        throw new Conflict();
      }
    },
    async pending() { return (await db.send(new QueryCommand({ TableName: table, IndexName: 'work', KeyConditionExpression: '#w = :w AND due <= :now', ExpressionAttributeNames: { '#w': 'work' }, ExpressionAttributeValues: { ':w': 'pending', ':now': Date.now() }, Limit: 100 }))).Items ?? []; },
    async sent(id, revision, due) {
      try {
        if (due !== undefined) await db.send(new PutCommand({ TableName: table, Item: { pk: `OUTBOX#${id}`, sk: 'META', id, revision, work: 'pending', due }, ConditionExpression: 'revision = :r', ExpressionAttributeValues: { ':r': revision } }));
        else await db.send(new DeleteCommand({ TableName: table, Key: { pk: `OUTBOX#${id}`, sk: 'META' }, ConditionExpression: 'revision = :r', ExpressionAttributeValues: { ':r': revision } }));
      }
      catch (error) { if (error.name !== 'ConditionalCheckFailedException') throw error; }
    },
    async putOnce(id, body, expires) {
      try { await db.send(new PutCommand({ TableName: table, Item: { pk: id, sk: 'META', body, expires: Math.floor(expires / 1000) }, ConditionExpression: 'attribute_not_exists(pk) OR expires < :now', ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) } })); return true; }
      catch (error) { if (error.name === 'ConditionalCheckFailedException') return false; throw error; }
    },
    async get(id) { const item = await get(id); return item?.expires > Date.now() / 1000 ? item.body : null; },
    async compareSwap(id, previous, body, expires) {
      try { await db.send(new PutCommand({ TableName: table, Item: { pk: id, sk: 'META', body, expires: Math.floor(expires / 1000) }, ConditionExpression: 'body = :previous AND expires > :now', ExpressionAttributeValues: { ':previous': previous, ':now': Math.floor(Date.now() / 1000) } })); return true; }
      catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
    },
    async limit(id, max, expires) {
      // The key includes the time window, so TTL cleanup can lag safely.
      try { await db.send(new UpdateCommand({ TableName: table, Key: { pk: id, sk: 'META' }, UpdateExpression: 'SET expires = :expires ADD #count :one', ConditionExpression: 'attribute_not_exists(#count) OR #count < :max', ExpressionAttributeNames: { '#count': 'count' }, ExpressionAttributeValues: { ':expires': Math.floor(expires / 1000), ':one': 1, ':max': max } })); return true; }
      catch (e) { if (e.name === 'ConditionalCheckFailedException') return false; throw e; }
    },
    async take(id) { const { Attributes: item } = await db.send(new DeleteCommand({ TableName: table, Key: { pk: id, sk: 'META' }, ReturnValues: 'ALL_OLD' })); return item?.expires > Date.now() / 1000 ? item.body : null; },
    async delete(id) { await db.send(new DeleteCommand({ TableName: table, Key: { pk: id, sk: 'META' } })); },
  };
}
