import { fail } from './security.mjs';

export const ACTIVATION_PERKS = ['echo', 'slack', 'tavily', 'dial'];
export function activationState(account) {
  const echo = account.included?.echo, slack = account.included?.slack;
  const workspaces = slack?.freshness === 'current' ? slack.workspaces.filter(w => w.status === 'active') : [];
  const selected = workspaces.find(w => w.id === account.preferences?.slackWorkspaceId) || (workspaces.length === 1 ? workspaces[0] : undefined);
  return {
    echo: { enabled: account.preferences?.echo === true && echo?.status === 'active' && echo.freshness === 'current' },
    slack: { enabled: workspaces.length > 0, workspaceId: selected?.id },
    ...Object.fromEntries(['tavily', 'dial'].map(id => [id, { enabled: account.grants[id]?.desired === 'active' && Date.parse(account.grants[id].expiresAt) > Date.now() }])),
  };
}
export function enabledChoice(account, stage, name = 'Nano') {
  const states = activationState(account);
  if (stage === 'echo') return states.echo.enabled ? { imageSource: 'hardened' } : undefined;
  if (stage === 'slack') return states.slack.workspaceId ? { workspaceId: states.slack.workspaceId, name } : undefined;
  if (stage === 'perks') return states.tavily.enabled && states.dial.enabled ? {} : undefined;
  return states[stage]?.enabled ? {} : undefined;
}
export async function activate(service, accountId, perkId, body, actor) {
  if (!ACTIVATION_PERKS.includes(perkId)) fail(404, 'unknown_perk', 'This perk does not exist.');
  if (body.accepted !== true) fail(400, 'consent_required', 'Choose Activate to enable this perk.');
  if (['tavily', 'dial'].includes(perkId)) return service.claim(accountId, perkId, body, actor);
  await service.refreshIncluded(accountId, true);
  const a = await service.store.load(accountId);
  if (perkId === 'echo' && (a.included?.echo?.status !== 'active' || a.included.echo.freshness !== 'current')) fail(409, 'image_access_required', 'Echo image access is not available for this account.');
  if (perkId === 'slack' && (a.included?.slack?.freshness !== 'current' || !a.included.slack.workspaces.some(w => w.status === 'active' && w.id === body.workspaceId))) fail(409, 'workspace_required', 'Connect a Slack workspace first.');
  return service.change(accountId, account => {
    account.preferences ??= {};
    if (perkId === 'echo') { if (account.preferences.echo === true) return; account.preferences.echo = true; }
    else { if (account.preferences.slackWorkspaceId === body.workspaceId) return; account.preferences.slackWorkspaceId = body.workspaceId; }
    return { type: 'perk.activated', detail: { perk: perkId, actor } };
  });
}
