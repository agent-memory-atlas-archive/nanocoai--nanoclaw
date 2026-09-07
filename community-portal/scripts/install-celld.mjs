import { createHash } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const releases = {
  'darwin-arm64': ['celld-aarch64-apple-darwin.gz', '95c689769f66c08fd0d191fbfc731adb4c8340b49678b11979698ecf2e73393d'],
  'linux-arm64': ['celld-aarch64-unknown-linux-gnu.gz', '5cc2281493a896b2cc7c7b6c46b2188753832d6b028457338c8eea774a1dd9a1'],
  'linux-x64': ['celld-x86_64-unknown-linux-gnu.gz', '7b42a410e340bca4dbadd08ecb7f8983854aa855aa7467c29ab0e08b8b7f2007'],
};
const release = releases[`${process.platform}-${process.arch}`];
if (!release) throw new Error('This platform has no pinned celld binary.');
const response = await fetch(`https://github.com/denoland/celld/releases/download/v0.4.1/${release[0]}`);
if (!response.ok) throw new Error(`Download failed: ${response.status}`);
const compressed = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(compressed).digest('hex') !== release[1]) throw new Error('celld checksum mismatch');
const dir = new URL('../.runtime/bin/', import.meta.url); await mkdir(dir, { recursive: true });
const target = new URL('celld', dir); await writeFile(target, gunzipSync(compressed), { mode: 0o755 }); await chmod(target, 0o755);
console.log(`Installed checksum-verified celld 0.4.1 at ${fileURLToPath(target)}`);
