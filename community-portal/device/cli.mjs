import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DeviceClient, readJson } from './client.mjs';
import { SetupClient } from './setup-client.mjs';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), command = args.shift() || 'run';
const option = name => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const demo = args.includes('--demo');
const setupDevice = command === 'setup' || args.includes('--setup-device');
const config = demo ? await readJson(path.join(root, '.runtime/demo.json')) : {};
if (demo && !config) throw new Error('Start npm run dev first.');
const account = demo ? {} : await readJson(path.join(os.homedir(), '.config/nanoclaw/account.json'), {});
const token = demo ? config.installs[setupDevice ? 2 : 1].token : process.env.NANOCLAW_REGISTRY_TOKEN || account.token;

const origin = option('origin') || config.origin || 'https://portal.nanoclaw.dev';
const file = option('file') || path.join(root, '.runtime/devices', demo ? setupDevice ? 'setup-device.json' : 'second-device.json' : 'device.json');
const Client = command === 'setup' ? SetupClient : DeviceClient;
const client = await new Client({ origin, token: command === 'setup' ? undefined : (await readJson(file))?.registryAccount?.token || token, file, exclusive: true, label: option('name') || (command === 'setup' ? 'Setup device' : 'Second test device'), log: event => console.log(JSON.stringify(event)) }).initialize();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void client.stop().then(() => process.exit(0)));
if (command === 'setup') {
  const stage = option('stage') || 'perks';
  const name = option('agent-name') || 'Nova';
  if (!await client.resumeEnabled(stage, name)) {
    if (!args.includes('--no-open')) {
      if (!process.stdin.isTTY) { await client.stop(); throw new Error('Browser opening requires confirmation. Run interactively, or use --no-open for a link.'); }
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(`Enable ${stage === 'perks' ? 'partner perks' : stage}? Open the dashboard in your browser? [Y/n] `); prompt.close();
      if (!['', 'y', 'yes'].includes(answer.trim().toLowerCase())) { console.log('Skipped for now. You can enable it later.'); await client.stop(); process.exit(0); }
    }
    const flow = await client.start(stage, name);
    console.log(`Activate your perk in the dashboard:\n${flow.url}\nChoose Return to terminal when you are done exploring.`);
    if (!args.includes('--no-open')) {
      const opener = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [flow.url], { stdio: 'ignore' }); opener.on('error', () => {}); opener.unref();
    }
  } else console.log(`${stage} already enabled. Continuing without opening the browser.`);
  const approved = await client.wait();
  try {
    if (client.token) await client.reconcile();
    if (approved.status === 'skipped') { console.log('Skipped for now. Continuing in the terminal.'); await client.stop(); process.exit(0); }
    if (stage === 'echo') { client.local.imageSource = approved.choice.imageSource; await client.save(); }
    if (stage === 'slack') {
      if (!demo) throw new Error('Use the NanoClaw setup integration for real Slack provisioning. This receiver supports simulated Slack only.');
      const app = await client.request('POST', `/api/v1/setup/${client.flow.code}/demo-slack`, {}); client.local.slack ??= {}; client.local.slack[app.appId] = app; await client.save();
      await client.complete('complete', { appId: app.appId });
    } else {
      if (['perks', 'tavily', 'dial'].includes(stage)) await client.reconcile();
      await client.complete();
    }
    console.log(`${stage} setup complete. The result is visible in the browser.`);
  } catch (error) { await client.complete('failed').catch(() => {}); throw error; }
  process.exit(0);
}
if (command === 'inspect') {
  console.log(JSON.stringify(Object.entries(client.local.credentials).map(([perk, credential]) => ({ perk, keyId: credential.keyId, resource: credential.resource, expiresAt: credential.expiresAt })), null, 2));
} else {
  if (!client.local.deviceId) throw new Error('Run the setup command to sign in this installation first.');
  await client.run();
}
