import { CHUNK, WINDOW, dataSize } from '../worker/src/ssh-relay.mjs';

// Credit is returned only after the local destination has accepted the bytes.
// Neither a slow terminal nor a slow sshd can create an unbounded relay queue.
export class SshStream {
  constructor({ readable, writable, send, close }) {
    Object.assign(this, { readable, writable, send, close });
    this.sent = this.acked = this.received = this.delivered = 0;
    this.done = false;
    this.pump = () => {
      if (this.done) return;
      while (readable.readableLength && this.sent - this.acked < WINDOW) {
        const bytes = readable.read(Math.min(readable.readableLength, CHUNK, WINDOW - this.sent + this.acked));
        if (!bytes) break;
        send({ type: 'ssh.data', seq: this.sent, data: bytes.toString('base64') });
        this.sent += bytes.length;
      }
      // Reading the final buffered chunk does not itself emit EOF in paused
      // mode. Ask the stream to complete after the buffer has drained.
      if (!readable.readableLength) readable.read(0);
    };
    readable.on('readable', this.pump);
    this.end = () => { this.ended = true; if (this.sent === this.acked) close(); };
    readable.once('end', this.end);
    this.error = () => close();
    readable.on('error', this.error); writable.on('error', this.error);
    this.pump();
  }
  message(message) {
    if (this.done) return;
    if (message.type === 'ssh.ack') {
      if (!Number.isSafeInteger(message.seq) || message.seq < this.acked || message.seq > this.sent) throw new Error('invalid_ack');
      this.acked = message.seq; this.pump();
      if (this.ended && this.sent === this.acked) this.close();
    } else if (message.type === 'ssh.data') {
      const size = dataSize(message.data);
      if (message.seq !== this.received || this.received + size - this.delivered > WINDOW) throw new Error('flow_control');
      this.received += size;
      const ack = this.received;
      this.writable.write(Buffer.from(message.data, 'base64'), error => {
        if (error) this.close();
        else if (!this.done) { this.delivered = ack; this.send({ type: 'ssh.ack', seq: ack }); }
      });
    }
  }
  stop() {
    if (this.done) return;
    this.done = true;
    this.readable.off('readable', this.pump); this.readable.off('end', this.end);
    this.readable.off('error', this.error); this.writable.off('error', this.error);
  }
}
