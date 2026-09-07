// A bounded retry window begins at the interruption, not when a terminal
// originally connected. Permanent identity/key failures never enter this loop.
export function transient(error) {
  return !error?.status || error.status === 408 || error.status === 429 || error.status >= 500;
}
export class ReconnectBudget {
  constructor({ now = Date.now, random = Math.random, budgetMs = 120_000 } = {}) {
    Object.assign(this, { now, random, budgetMs }); this.deadline = 0; this.attempt = 0;
  }
  interrupted(sessionMs = 0) {
    // The SSH handshake is separately bounded to 15s. A connection that lived
    // beyond an entire retry window is a new interruption, even hours later.
    if (!this.deadline || sessionMs > this.budgetMs) { this.deadline = this.now() + this.budgetMs; this.attempt = 0; }
  }
  delay() {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) return null;
    return Math.min(remaining, 100 + this.random() * Math.min(10_000, 500 * 2 ** Math.min(this.attempt++, 5)));
  }
}

export function retryAttachExit(code, diagnostic = '') {
  if (code === 0 || [126, 127].includes(code)) return false;
  return !/Permission denied \(|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Bad configuration option|no matching (host key|key exchange)|no sandbox ['"]|not in code mode|not a code.mode|usage: ncl sandboxes/i.test(diagnostic);
}
