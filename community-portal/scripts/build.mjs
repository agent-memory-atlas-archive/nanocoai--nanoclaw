import { build } from 'esbuild';
import { buildNanocode } from './build-host.mjs';
import { mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
await mkdir(path.join(dist, 'lambda'), { recursive: true });
await build({ entryPoints: [path.join(root, 'service/lambda.mjs')], outfile: path.join(dist, 'lambda/index.mjs'), bundle: true, platform: 'node', target: 'node22', format: 'esm', sourcemap: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await rm(path.join(dist, 'service.zip'), { force: true });
execFileSync('python3', ['-c', "import sys,zipfile; info=zipfile.ZipInfo('index.mjs',date_time=(2026,1,1,0,0,0)); info.external_attr=0o100644<<16; info.compress_type=zipfile.ZIP_DEFLATED; z=zipfile.ZipFile(sys.argv[2],'w'); z.writestr(info,open(sys.argv[1],'rb').read(),compresslevel=9); z.close()", path.join(dist, 'lambda/index.mjs'), path.join(dist, 'service.zip')]);
for (const item of ['worker', 'web', 'wrangler.jsonc']) await cp(path.join(root, item), path.join(dist, 'cell', item), { recursive: true });
await buildNanocode(path.join(dist, 'cell/web/downloads/nanocode.mjs'));
await writeFile(path.join(dist, 'build.json'), JSON.stringify({ runtime: 'nodejs22.x', celld: '0.4.1', partners: { tavily: 'coming-soon', dial: 'coming-soon' } }) + '\n');
console.log('Built dist/service.zip and dist/cell (live partner adapters disabled).');
