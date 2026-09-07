import { WebSocket } from 'ws';

// Notifications wake local reconciliation. SSH frames enter a separately
// authorized, fixed loopback transport; no cell frame supplies a shell command.
export class CellConnection {
  constructor({ origin, getTicket, onChange = () => {}, onMessage = () => {}, onDisconnect = () => {}, log = () => {}, heartbeatMs = 20_000, timeoutMs = 60_000, retryMs = 1000, maxRetryMs = 30_000 }) {
    Object.assign(this, { origin, getTicket, onChange, onMessage, onDisconnect, log, heartbeatMs, timeoutMs, retryMs, maxRetryMs });
    this.stopped = true;
    this.connected = false;
    this.attempt = 0;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.heartbeat = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > this.timeoutMs) { socket.terminate(); return; }
      socket.send('ping');
    }, this.heartbeatMs);
    void this.connect();
  }
  async connect() {
    if (this.stopped || this.connecting || this.socket) return;
    this.connecting = true;
    try {
      const { ticket, socketUrl, expiresIn = 900 } = await this.getTicket(this.abort.signal);
      if (this.stopped) return;
      const url = new URL(socketUrl);
      if (url.origin !== this.origin.replace(/^http/, 'ws') || url.pathname !== '/cell/link' || url.search || url.hash || url.username || url.password) throw new Error('invalid_cell_url');
      const socket = this.socket = new WebSocket(url, ['nc-cell', `ticket.${ticket}`], { handshakeTimeout: 10_000, maxPayload: 512_000, followRedirects: false });
      socket.on('open', () => {
        if (this.stopped) { socket.terminate(); return; }
        this.connected = true; this.attempt = 0; this.lastPong = Date.now();
        this.log({ event: 'connected' });
        this.onChange();
        this.renewTimer = setInterval(() => void this.renew(), Math.max(500, (expiresIn - Math.min(60, expiresIn / 2)) * 1000));
      });
      socket.on('message', raw => {
        try {
          const message = JSON.parse(String(raw));
          if (message.type === 'pong') this.lastPong = Date.now();
          else if (['snapshot', 'perks.changed'].includes(message.type)) this.onChange();
          else if (message.type?.startsWith('ssh.')) this.onMessage(message);
        } catch { /* malformed notifications cannot change local work */ }
      });
      socket.on('error', () => {});
      socket.once('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined; clearInterval(this.renewTimer); this.onDisconnect();
        if (this.connected) this.log({ event: 'disconnected' });
        this.connected = false;
        this.retry();
      });
    } catch (error) {
      if (!this.stopped) { this.log({ event: 'connection_retry', code: error.code || 'unavailable' }); this.retry(); }
    } finally { this.connecting = false; }
  }
  send(frame) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame)); }
  async renew() {
    if (this.renewing || this.stopped) return;
    this.renewing = true; const socket = this.socket;
    try { const { ticket } = await this.getTicket(this.abort.signal); if (this.socket === socket) this.send({ type: 'auth.renew', ticket }); }
    catch { socket?.terminate(); }
    finally { this.renewing = false; }
  }
  retry() {
    if (this.stopped) return;
    clearTimeout(this.reconnect);
    const delay = Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(this.attempt++, 5));
    this.reconnect = setTimeout(() => void this.connect(), delay + Math.random() * delay / 4);
  }
  stop() {
    this.stopped = true;
    this.abort?.abort();
    clearInterval(this.heartbeat); clearInterval(this.renewTimer); clearTimeout(this.reconnect); this.onDisconnect();
    this.socket?.terminate();
    this.socket = undefined;
    this.connected = false;
  }
}
