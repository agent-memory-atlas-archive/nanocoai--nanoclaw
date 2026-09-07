import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.argv[2];
const command = process.env.SSH_ORIGINAL_COMMAND || 'list';
const args = command.trim().split(/\s+/);
if (!root || /[\r\n\0]/.test(command) || !['new', 'list', 'attach'].includes(args[0]) || args.some(a => /^--?(owner|as|door[-_])/i.test(a))) {
  console.error('nanocode: use new, list, or attach; identity comes from portal login.');
  process.exit(2);
}
const child = spawn(process.execPath, [path.join(root, 'dist/cli/client.js'), 'sandboxes', ...args], { cwd: root, stdio: 'inherit' });
const reset = () => { if (process.stdout.isTTY) process.stdout.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'); };
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => { reset(); child.kill(sig); });
child.on('error', () => { reset(); process.exit(1); });
child.on('exit', code => { reset(); process.exit(code ?? 1); });
