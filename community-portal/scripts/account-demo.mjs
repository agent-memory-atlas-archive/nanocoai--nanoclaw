import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from '../device/client.mjs';

const scenario = process.argv[2];
if (!['connected', 'disconnected', 'empty', 'unavailable', 'slack-unavailable'].includes(scenario)) {
  console.error('Usage: npm run demo:account -- connected|disconnected|empty|unavailable|slack-unavailable'); process.exit(1);
}
await writePrivate(path.join(path.dirname(fileURLToPath(import.meta.url)), '../.runtime/account-scenario.json'), { scenario });
console.log(`Demo account: ${scenario}. Click Refresh status in the portal. No external account was changed.`);
