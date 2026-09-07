import { catalog } from './catalog.mjs';
import { DynamoSimulator } from './simulator.mjs';

// Explicit test mode changes only the partner adapters. Browser/device identity,
// Echo and Slack always retain their real production service boundaries.
export function hostedPartners(env, client) {
  const mode = env.PARTNER_MODE || 'unconfigured';
  if (mode === 'unconfigured') return { catalog: catalog('unconfigured'), adapters: {}, globalDailyLimit: 0 };
  if (mode !== 'simulated') throw new Error('Only unconfigured or simulated partners are supported');
  if (!env.SIMULATOR_TABLE || [env.PERKS_TABLE, env.REGISTRY_TABLE, env.SLACK_TABLE].includes(env.SIMULATOR_TABLE)) throw new Error('Partner simulations require a separate table');
  const adapters = Object.fromEntries(['tavily', 'dial'].map(id => [id, new DynamoSimulator({ id, table: env.SIMULATOR_TABLE, client })]));
  return { catalog: catalog('simulated', { accountMode: 'existing' }), adapters, globalDailyLimit: 100, partnerTest: true };
}
