import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

function processIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return `${boot}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined;
  } catch { return undefined; }
}
function ownerAlive(owner) {
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; }
  const current = processIdentity(owner.pid);
  return !current || !owner.started || current === owner.started;
}
export function processLockOwner(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const owner = db.prepare('SELECT pid, nonce, started FROM owner WHERE id = 1').get();
    return owner && ownerAlive(owner) ? owner : undefined;
  } catch { return undefined; } finally { db?.close(); }
}

// Acquisition and stale-owner recovery are one transaction. Process birth
// (including Linux boot identity) prevents PID reuse from wedging recovery.
export async function processLock(file) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = await open(file, 'a', 0o600); await fd.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  const owner = { pid: process.pid, nonce: randomUUID(), started: processIdentity(process.pid) || '' };
  try {
    db.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, nonce TEXT NOT NULL, started TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    const previous = db.prepare('SELECT pid, nonce, started FROM owner WHERE id = 1').get();
    if (previous && ownerAlive(previous)) { db.exec('COMMIT'); db.close(); return null; }
    db.prepare('INSERT OR REPLACE INTO owner VALUES (1, ?, ?, ?)').run(owner.pid, owner.nonce, owner.started);
    db.exec('COMMIT');
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { db.prepare('DELETE FROM owner WHERE id = 1 AND pid = ? AND nonce = ?').run(owner.pid, owner.nonce); }
      finally { db.close(); process.removeListener('exit', release); }
    };
    process.once('exit', release);
    return release;
  } catch (error) { db.close(); throw error; }
}
