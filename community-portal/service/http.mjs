import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

export function listen(app, { port, host = '127.0.0.1', origin, cellOrigin }) {
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 250_000) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}) });
      request.clientIp = req.socket.remoteAddress;
      let response;
      if (req.url.startsWith('/api/')) response = await app.fetch(request);
      else response = await fetch(`${cellOrigin}${req.url}`, { method: req.method, headers: req.headers, ...(body.length ? { body } : {}), redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const headers = Object.fromEntries(response.headers);
      delete headers['content-encoding']; delete headers['content-length'];
      headers['x-content-type-options'] = 'nosniff'; headers['referrer-policy'] = 'no-referrer';
      const cookies = response.headers.getSetCookie(); if (cookies.length) headers['set-cookie'] = cookies;
      res.writeHead(response.status, headers); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unavailable', message: 'The local cell is restarting. Please retry.' })); }
  });
  const wss = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('nc-cell') ? 'nc-cell' : false });
  const upstreams = new Set();
  const closeHttp = server.closeAllConnections.bind(server);
  server.closeAllConnections = () => { for (const ws of wss.clients) ws.terminate(); for (const ws of upstreams) ws.terminate(); closeHttp(); };
  server.on('upgrade', (req, socket, head) => {
    if (!['/cell/link', '/cell/ssh'].includes(req.url)) { socket.destroy(); return; }
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim()).filter(Boolean);
    const upstream = new WebSocket(`${cellOrigin.replace(/^http/, 'ws')}${req.url}`, protocols);
    upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', () => socket.destroy());
    upstream.once('open', () => wss.handleUpgrade(req, socket, head, downstream => {
      downstream.on('message', (data, binary) => { if (upstream.readyState === 1) upstream.send(data, { binary }); });
      upstream.on('message', (data, binary) => { if (downstream.readyState === 1) downstream.send(data, { binary }); });
      downstream.on('close', () => upstream.close());
      upstream.on('close', code => downstream.close(code === 1006 ? 1012 : code));
      downstream.on('error', () => upstream.close());
    }));
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server)); });
}
