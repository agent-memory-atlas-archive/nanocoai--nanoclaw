import { build } from 'esbuild';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hostAddedFiles = [
  ...['portal.ts', 'portal-client.d.mts', 'portal.test.ts', 'portal-client.mjs', 'portal-client.LICENSE', 'slack-job.ts', 'slack-worker.ts', 'slack-worker.test.ts', 'verify-slack.test.ts', 'portal-runtime.ts', 'portal-runtime.d.mts', 'portal-runtime.mjs', 'nanocode.mjs', 'nanocode-session.mjs', 'nanocode-daemon.mjs'].map(f => `setup/${f}`),
  'src/modules/community-portal/index.ts', 'src/modules/community-portal/registration.test.ts',
];
export async function buildNanocode(output) {
  const license = await readFile(path.join(root, '../setup/portal-client.LICENSE'), 'utf8');
  await build({ absWorkingDir: root, entryPoints: [path.join(root, 'device/nanocode.mjs')], outfile: output, bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: `/* Bundled WebSocket dependency:\n${license}*/\nimport { createRequire as ncRequire } from "node:module"; const require = ncRequire(import.meta.url);` } });
}
export async function buildHost(output) {
  const source = path.resolve(root, '..');
  for (const file of hostAddedFiles.filter(f => !['setup/portal-client.mjs', 'setup/portal-runtime.mjs', 'setup/nanocode.mjs', 'setup/nanocode-session.mjs', 'setup/nanocode-daemon.mjs'].includes(f))) {
    await mkdir(path.dirname(path.join(output, file)), { recursive: true });
    if (path.resolve(source, file) !== path.resolve(output, file)) await cp(path.join(source, file), path.join(output, file));
  }
  await build({ absWorkingDir: root, entryPoints: [path.join(root, 'device/setup-client.mjs')], outfile: path.join(output, 'setup/portal-client.mjs'), bundle: true, platform: 'node', target: 'node22', format: 'esm',
    banner: { js: 'import { createRequire as portalCreateRequire } from "node:module"; const require = portalCreateRequire(import.meta.url);' },
  });
  await buildNanocode(path.join(output, 'setup/nanocode.mjs'));
  for (const name of ['nanocode-session', 'nanocode-daemon']) {
    await build({ absWorkingDir: root, entryPoints: [path.join(root, `device/${name}.mjs`)], outfile: path.join(output, `setup/${name}.mjs`), bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: 'import { createRequire as ncRequire } from "node:module"; const require = ncRequire(import.meta.url);' } });
  }
  await build({ absWorkingDir: root, entryPoints: [path.join(source, 'setup/portal-runtime.ts')], outfile: path.join(output, 'setup/portal-runtime.mjs'), bundle: true, platform: 'node', target: 'node22', format: 'esm', external: ['./portal-client.mjs'] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHost(path.resolve(process.argv[2] || path.join(root, '..')));
}
