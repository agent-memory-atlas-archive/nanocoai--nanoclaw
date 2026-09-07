import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function startPartners({ port = 0, filename = ':memory:', keys }) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY, provider TEXT, name TEXT, token_hash TEXT, status TEXT, credits INTEGER, used INTEGER, expires_at TEXT, body TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS active_name ON resources(provider,name) WHERE status='active';
    CREATE TABLE IF NOT EXISTS revoked_names(provider TEXT, name TEXT, PRIMARY KEY(provider,name));`);
  const faults = {};
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url, 'http://localhost'), [, provider, route] = url.pathname.split('/');
      if (!['tavily', 'dial'].includes(provider)) return send(404, {});
      const bearer = request.headers.authorization?.replace(/^Bearer /, '');
      if (route === 'use') {
        const row = db.prepare('SELECT * FROM resources WHERE provider=? AND token_hash=?').get(provider, hash(bearer || ''));
        if (!row || row.status !== 'active' || Date.parse(row.expires_at) <= Date.now()) return send(401, { error: 'invalid_credential' });
        if (row.used >= row.credits) return send(429, { error: 'quota_exhausted' });
        db.prepare('UPDATE resources SET used=used+1 WHERE id=?').run(row.id);
        return send(200, { simulated: true, provider, resource: JSON.parse(row.body).resource, result: provider === 'dial' ? 'The test phone credential is valid. No call was placed.' : 'The test search credential is valid. No live search was made.' });
      }
      if (bearer !== keys[provider]) return send(401, { error: 'unauthorized' });
      const raw = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 16384) return send(413, {}); raw.push(chunk); }
      const body = raw.length ? JSON.parse(Buffer.concat(raw).toString()) : {};
      const fault = faults[provider] || {};
      if (route === 'resources') {
        const row = db.prepare("SELECT * FROM resources WHERE provider=? AND name=? ORDER BY status='active' DESC, rowid DESC LIMIT 1").get(provider, url.searchParams.get('name'));
        return row ? send(200, { ...JSON.parse(row.body), status: row.status, used: row.used }) : send(404, {});
      }
      if (route === 'revoke') {
        if (fault.revokeUnavailable) return send(503, { error: 'unavailable' });
        if (body.terminal) db.prepare('INSERT OR IGNORE INTO revoked_names VALUES(?,?)').run(provider, body.name);
        db.prepare("UPDATE resources SET status='revoked' WHERE provider=? AND name=?").run(provider, body.name);
        return send(200, { status: 'revoked' });
      }
      if (route === 'provision') {
        if (fault.issueUnavailable) return send(503, { error: 'unavailable' });
        if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
        if (db.prepare('SELECT name FROM revoked_names WHERE provider=? AND name=?').get(provider, body.name)) return send(409, { error: 'grant_revoked' });
        if (db.prepare("SELECT id FROM resources WHERE provider=? AND name=? AND status='active'").get(provider, body.name)) return send(409, { error: 'name_exists' });
        const id = randomUUID(), secret = `demo_${provider}_${randomBytes(24).toString('base64url')}`;
        const index = db.prepare('SELECT count(*) AS n FROM resources WHERE provider=?').get(provider).n;
        const phoneNumber = `+120255501${String(index % 100).padStart(2, '0')}`;
        const result = { id, prefix: secret.slice(0, 14), expiresAt: body.expiresAt, resource: provider === 'dial' ? { kind: 'phone-number', label: phoneNumber, phoneNumber } : { kind: 'search-key', label: `${body.credits.toLocaleString()} test search credits` } };
        db.prepare('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?)').run(id, provider, body.name, hash(secret), 'active', body.credits, 0, body.expiresAt, JSON.stringify(result));
        if (fault.dropNextIssue) { fault.dropNextIssue = false; response.destroy(); return; }
        return send(201, { ...result, secret });
      }
      return send(404, {});
    } catch { send(500, { error: 'simulator_error' }); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, db, faults, origin: `http://127.0.0.1:${server.address().port}`, async close() { await new Promise(resolve => server.close(resolve)); db.close(); } };
}
