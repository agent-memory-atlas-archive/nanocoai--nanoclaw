import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const suffix = randomUUID().slice(0, 8), containers = [];
function docker(args) { return execFileSync('docker', args, { encoding: 'utf8' }).trim(); }
function start(name, image, containerPort, args = [], env = []) {
  const id = `nc-perks-${name}-${suffix}`;
  docker(['run', '--detach', '--rm', '--name', id, '-p', `127.0.0.1::${containerPort}`, ...env.flatMap(v => ['-e', v]), image, ...args]); containers.push(id);
  return `http://${docker(['port', id, `${containerPort}/tcp`])}`;
}
try {
  const ddb = start('ddb', 'amazon/dynamodb-local:3.1.0', 8000, ['-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb']);
  const s3 = start('s3', 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z', 9000, ['server', '/data'], ['MINIO_ROOT_USER=nanoclawtest', 'MINIO_ROOT_PASSWORD=nanoclawtestlocal']);
  for (const url of [ddb, `${s3}/minio/health/live`]) {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(url, { signal: AbortSignal.timeout(500) }); ready = true; break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    if (!ready) throw new Error('Local integration dependency did not start');
  }
  const tests = ['test', 'test/e2e'].flatMap(dir => readdirSync(`${root}/${dir}`).filter(file => file.endsWith('.test.mjs')).map(file => `${dir}/${file}`));
  const run = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: root, env: { ...process.env, DYNAMODB_LOCAL_ENDPOINT: ddb, CELLD_MINIO_ENDPOINT: s3 }, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => { run.once('error', reject); run.once('exit', code => resolve(code ?? 1)); });
} finally {
  for (const name of containers) { try { docker(['stop', '-t', '1', name]); } catch { /* container already stopped */ } }
}
