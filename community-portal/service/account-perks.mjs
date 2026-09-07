import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export const ACCOUNT_PERKS = ['echo', 'slack'];
const text = (value, max = 120) => typeof value === 'string' ? value.slice(0, max) : '';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const status = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;

// Apply this allowlist at both ingestion and publication. Neither registry
// credentials nor Slack token ciphertext belongs in the service/cell mirror.
export function publicAccountPerk(id, value = {}) {
  const common = {
    id, source: id === 'echo' ? 'registry' : 'slack',
    freshness: status(value.freshness, ['current', 'stale', 'unavailable', 'unconfigured'], 'unconfigured'),
    checkedAt: date(value.checkedAt), updatedAt: date(value.updatedAt),
  };
  if (id === 'echo') return { ...common, entitlement: 'agent-image', status: status(value.status, ['active', 'not_granted', 'revoked']), grantedAt: date(value.grantedAt) };
  return {
    ...common, status: status(value.status, ['connected', 'not_connected']), truncated: value.truncated === true,
    workspaces: (Array.isArray(value.workspaces) ? value.workspaces : []).slice(0, 200).map(w => ({ id: text(w.id), name: text(w.name), status: status(w.status, ['active', 'disconnected', 'revoked']), connectedAt: date(w.connectedAt) })),
    apps: (Array.isArray(value.apps) ? value.apps : []).slice(0, 200).map(a => ({ id: text(a.id), teamId: text(a.teamId), name: text(a.name), status: status(a.status, ['installed', 'pending_install', 'deleted']), createdAt: date(a.createdAt) })),
  };
}

export function dynamoAccountPerks({ registryTable, slackTable, client }) {
  const db = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 2 }));
  // This same attribute list is enforced by the portal's IAM policy. In
  // particular, the existing Slack GSI projects ALL, including ciphertext.
  const attributes = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'account_id', 'team_id', 'team_name', 'app_id', 'name', 'status', 'created_at'];
  const names = Object.fromEntries(attributes.map((name, i) => [`#f${i}`, name]));
  async function rows(accountId, prefix) {
    const items = []; let cursor;
    do {
      const page = await db.send(new QueryCommand({
        TableName: slackTable, IndexName: 'gsi1',
        KeyConditionExpression: '#f2 = :account AND begins_with(#f3, :prefix)',
        ExpressionAttributeValues: { ':account': `ACCT#${accountId}`, ':prefix': prefix },
        ExpressionAttributeNames: names, ProjectionExpression: Object.keys(names).join(', '), Select: 'SPECIFIC_ATTRIBUTES',
        Limit: 200 - items.length, ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }), { abortSignal: AbortSignal.timeout(4000) });
      items.push(...(page.Items ?? [])); cursor = page.LastEvaluatedKey;
    } while (cursor && items.length < 200);
    return { items, truncated: !!cursor };
  }
  return {
    async echo(accountId) {
      const { Item: row } = await db.send(new GetCommand({ TableName: registryTable, Key: { pk: `ACCT#${accountId}`, sk: 'PERK#agent-image' }, ConsistentRead: true,
        ProjectionExpression: 'pk, sk, perk, #status, granted_at', ExpressionAttributeNames: { '#status': 'status' },
      }), { abortSignal: AbortSignal.timeout(4000) });
      if (row && (row.pk !== `ACCT#${accountId}` || row.sk !== 'PERK#agent-image' || row.perk !== 'agent-image')) throw new Error('Invalid registry entitlement');
      return { status: !row ? 'not_granted' : row.status === 'granted' ? 'active' : row.status === 'revoked' ? 'revoked' : 'unknown', grantedAt: row?.granted_at };
    },
    async slack(accountId) {
      if (!slackTable) throw new Error('Slack metadata source is unconfigured');
      const [connections, apps] = await Promise.all([rows(accountId, 'CONN#'), rows(accountId, 'APP#')]);
      const owns = row => row.gsi1pk === `ACCT#${accountId}`;
      const workspaces = connections.items.filter(row => owns(row) && row.sk === `ACCT#${accountId}` && row.pk === `CONN#${row.team_id}`).map(row => ({ id: row.team_id, name: row.team_name, status: row.status, connectedAt: row.created_at }));
      return {
        status: workspaces.some(w => w.status === 'active') ? 'connected' : 'not_connected', workspaces,
        apps: apps.items.filter(row => owns(row) && row.account_id === accountId && row.sk === 'META' && row.pk === `APP#${row.app_id}`).map(row => ({ id: row.app_id, teamId: row.team_id, name: row.name, status: row.status, createdAt: row.created_at })),
        truncated: connections.truncated || apps.truncated,
      };
    },
  };
}

export function demoAccountPerks(readScenario = async () => 'connected') {
  const at = '2026-09-05T09:00:00.000Z';
  return {
    async echo(accountId) {
      const scenario = await readScenario();
      if (scenario === 'unavailable') throw new Error('Demo source unavailable');
      return accountId === 'acct_demo' && scenario !== 'empty' ? { status: 'active', grantedAt: at } : { status: 'not_granted' };
    },
    async slack(accountId) {
      const scenario = await readScenario();
      if (scenario === 'unavailable' || scenario === 'slack-unavailable') throw new Error('Demo source unavailable');
      if (accountId !== 'acct_demo' || scenario === 'empty') return { status: 'not_connected', workspaces: [], apps: [] };
      const disconnected = scenario === 'disconnected';
      return {
        status: disconnected ? 'not_connected' : 'connected',
        workspaces: [{ id: 'TDEMO', name: 'NanoClaw demo workspace', status: disconnected ? 'disconnected' : 'active', connectedAt: at }],
        apps: [{ id: 'ADEMO1', teamId: 'TDEMO', name: 'Nano', status: 'installed', createdAt: at }, { id: 'ADEMO2', teamId: 'TDEMO', name: 'Scout', status: 'pending_install', createdAt: at }],
      };
    },
  };
}
