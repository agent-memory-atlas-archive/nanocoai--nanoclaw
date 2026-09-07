import { fail, random } from './security.mjs';
import { demoAccountPerks } from './account-perks.mjs';

export function lambdaSlack(functionName, client) {
  let sdk;
  return async (accountId, operation, body = {}) => {
    sdk ??= await import('@aws-sdk/client-lambda');
    client ??= new sdk.LambdaClient({ maxAttempts: 1 });
    const result = await client.send(new sdk.InvokeCommand({ FunctionName: functionName, InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify({ source: 'nanoclaw-community-portal', accountId, operation, body })),
    }), { abortSignal: AbortSignal.timeout(20_000) });
    if (result.FunctionError) fail(502, 'slack_unavailable', 'Slack could not complete this request. Refresh its status before retrying.');
    const response = JSON.parse(Buffer.from(result.Payload).toString()), data = JSON.parse(response.body);
    if (response.statusCode >= 400) fail(response.statusCode, data.error || 'slack_error', data.message || 'Slack could not complete this request.');
    // Only these public management results can cross the browser boundary.
    if (operation === 'connect' || operation === 'install-url') {
      const url = new URL(data.url);
      if (url.origin !== 'https://slack.com' || url.pathname !== '/oauth/v2/authorize') fail(502, 'invalid_slack_url', 'Slack returned an unexpected authorization link.');
      return { url: url.href };
    }
    return { ok: true };
  };
}

// Local counterpart of the existing Slack service. Credentials from create()
// return only to the device and are never included in this stored metadata.
export function demoSlack(service, readScenario = async () => 'connected') {
  const fixtures = demoAccountPerks(readScenario);
  const read = async accountId => {
    // Read the source first so an outage stays visible after a demo mutation.
    const source = await fixtures.slack(accountId);
    return (await service.store.load(accountId)).demoSlack ?? source;
  };
  async function change(accountId, fn) {
    const initial = await read(accountId);
    await service.change(accountId, a => { a.demoSlack ??= initial; fn(a.demoSlack); return { type: 'slack.changed' }; });
  }
  return {
    read,
    async manage(accountId, operation, body) {
      if (operation === 'connect') await change(accountId, s => {
        const old = s.workspaces.find(w => w.id === 'TDEMO');
        if (old) old.status = 'active';
        else s.workspaces.push({ id: 'TDEMO', name: 'NanoClaw demo workspace', status: 'active', connectedAt: new Date().toISOString() });
        s.status = 'connected';
      });
      else if (operation === 'disconnect') await change(accountId, s => { const w = s.workspaces.find(w => w.id === body.teamId); if (!w) fail(404, 'not_found', 'Workspace not found.'); w.status = 'disconnected'; s.status = s.workspaces.some(w => w.status === 'active') ? 'connected' : 'not_connected'; });
      else if (operation === 'revoke') await change(accountId, s => { const a = s.apps.find(a => a.id === body.appId); if (!a) fail(404, 'not_found', 'Agent not found.'); a.status = 'deleted'; });
      else if (operation === 'install-url') return { demoApproval: body.appId };
      else if (operation === 'approve-demo') await change(accountId, s => { const a = s.apps.find(a => a.id === body.appId); if (!a) fail(404, 'not_found', 'Agent not found.'); a.status = 'installed'; });
      else fail(404, 'not_found', 'Unknown Slack action.');
      return { ok: true };
    },
    async create(accountId, setup) {
      let app;
      await change(accountId, s => {
        if (s.apps.some(a => a.operationId === setup.id)) fail(409, 'already_created', 'This agent was already created. Check the CLI before retrying.');
        if (!s.workspaces.some(w => w.id === setup.choice.workspaceId && w.status === 'active')) fail(409, 'workspace_required', 'Reconnect this workspace.');
        app = { id: `ADEMO${random(8).replace(/[^a-z0-9]/gi, '').toUpperCase()}`, teamId: setup.choice.workspaceId, name: setup.choice.name, status: 'installed', createdAt: new Date().toISOString(), operationId: setup.id };
        s.apps.push(app);
      });
      return { appId: app.id, teamId: app.teamId, name: app.name, botToken: `xoxb-demo-${random(24)}`, appToken: `xapp-demo-${random(24)}` };
    },
  };
}
