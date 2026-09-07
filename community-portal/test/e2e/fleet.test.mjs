import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, open, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { S3Client, CreateBucketCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { PerksService } from '../../service/perks.mjs';
import { harness, root, until } from '../harness.mjs';

async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

test('two-node fleet: S3 CAS, peer routing, owner loss and cold facet restore', { skip: !process.env.CELLD_MINIO_ENDPOINT, timeout: 150_000 }, async t => {
  const endpoint = new URL(process.env.CELLD_MINIO_ENDPOINT);
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'fleet test must use local object storage');
  const bucket = `nc-perks-fleet-${Date.now()}`;
  const credentials = { accessKeyId: 'nanoclawtest', secretAccessKey: 'nanoclawtestlocal' };
  const s3 = new S3Client({ endpoint: endpoint.href, region: 'us-east-1', forcePathStyle: true, credentials });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  const h = await harness({ withCell: false });
  const children = [], handles = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
    await h.close(); for (const handle of handles) await handle.close();
    for (;;) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
      if (!page.Contents?.length) break;
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) } }));
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucket })); s3.destroy();
  });
  const cas = await Promise.allSettled([0, 1].map(i => s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'probe/race', Body: String(i), IfNoneMatch: '*' }))));
  assert.equal(cas.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(cas.find(r => r.status === 'rejected').reason.$metadata.httpStatusCode, 412);
  const etag = cas.find(r => r.status === 'fulfilled').value.ETag;
  const renew = await Promise.allSettled([0, 1].map(i => s3.send(new PutObjectCommand({ Bucket: bucket, Key: 'probe/race', Body: `renew-${i}`, IfMatch: etag }))));
  assert.equal(renew.filter(r => r.status === 'fulfilled').length, 1);
  const project = path.join(h.dir, 'fleet-project');
  for (const item of ['worker', 'web', 'wrangler.jsonc']) await cp(path.join(root, item), path.join(project, item), { recursive: true });
  const env = { ...process.env, AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_REGION: 'us-east-1', CELLD_ESBUILD: path.join(root, 'node_modules/.bin/esbuild'), CELLD_WORKER_LOADER: 'LOADER', CELLD_VAR_GRANT_PUBLIC_KEY_SPKI: createPublicKey({ key: h.publicJwk, format: 'jwk' }).export({ type: 'spki', format: 'der' }).toString('base64') };
  delete env.AWS_PROFILE; delete env.AWS_SESSION_TOKEN;
  const binary = path.join(root, '.runtime/bin/celld'), common = ['--bucket', `s3://${bucket}`, '--endpoint', endpoint.href, '--region', 'us-east-1'];
  const deployLog = execFileSync(binary, ['deploy', project, ...common, '--json'], { env, encoding: 'utf8' });
  assert.match(deployLog, /nanoclaw-community/);
  async function start(name, origin) {
    const peerPort = await port(), cache = path.join(h.dir, name); await mkdir(cache, { recursive: true });
    const log = await open(`${cache}.log`, 'a'); handles.push(log);
    const child = spawn(binary, [...common, '--listen', `127.0.0.1:${new URL(origin).port}`, '--internal-listen', `127.0.0.1:${peerPort}`, '--advertise', `127.0.0.1:${peerPort}`], { env: { ...env, CELLD_NODE: name, CELLD_WATCH: cache }, stdio: ['ignore', log.fd, log.fd] });
    children.push(child);
    await until(async () => { try { return (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 30000, `${name} startup (${cache}.log)`);
    return child;
  }
  const secondOrigin = `http://127.0.0.1:${await port()}`;
  const first = await start('fleet-one', h.cellOrigin), second = await start('fleet-two', secondOrigin);
  h.app.service.flush = PerksService.prototype.flush.bind(h.app.service);
  await h.app.service.reconcile('acct_demo');
  const device = await h.connectInstallation();
  for (const perk of ['tavily', 'dial']) {
    await h.browser(`/grants/${perk}`, { method: 'POST', body: { accepted: true, termsVersion: 'demo-2026-09-05' } });
    await device.reconcile();
  }
  const ticket = h.app.service.ticket('acct_demo', 'browser');
  const read = async origin => {
    try { const response = await fetch(`${origin}/cell/state`, { headers: { authorization: `Bearer ${ticket}` }, signal: AbortSignal.timeout(2000) }); return response.ok ? (await response.json()).snapshot : null; } catch { return null; }
  };
  const before = await until(() => read(h.cellOrigin));
  assert.deepEqual(await until(() => read(secondOrigin)), before, 'other node routes to the owner');
  const stoppedFirst = once(first, 'exit'); first.kill('SIGKILL'); await stoppedFirst;
  const failedOver = await until(() => read(secondOrigin), 40000, 'surviving node takes ownership');
  assert.deepEqual(failedOver, before);
  const stoppedSecond = once(second, 'exit'); second.kill('SIGKILL'); await stoppedSecond;
  await rm(path.join(h.dir, 'fleet-one'), { recursive: true, force: true });
  await rm(path.join(h.dir, 'fleet-two'), { recursive: true, force: true });
  await start('fleet-cold', secondOrigin);
  assert.deepEqual(await until(() => read(secondOrigin), 40000, 'cold restore from object storage'), before);
  t.diagnostic('Both partner grants and all delivery acknowledgments survived owner loss and removal of every node cache. Storage was local MinIO, not AWS S3.');
});
