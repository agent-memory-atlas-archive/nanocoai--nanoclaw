// The Host owns the write end of stdin. Even SIGKILL or a crashed Host closes
// that pipe, so its dedicated sshd cannot survive as an unowned listener.
import { spawn } from 'node:child_process';
const [sshd, config] = process.argv.slice(2);
if (!sshd || !config) throw new Error('Missing sshd configuration');
const child = spawn(sshd, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'inherit'] });
let stopping = false, deadline;
const stop = () => {
  if (stopping) return; stopping = true;
  child.kill('SIGTERM');
  deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
};
process.stdin.resume();
process.stdin.once('end', stop); process.stdin.once('error', stop);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
child.once('error', () => { clearTimeout(deadline); process.exit(1); });
child.once('exit', code => { clearTimeout(deadline); process.exit(stopping ? 0 : code ?? 1); });
