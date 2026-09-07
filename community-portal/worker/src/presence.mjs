export const DEVICE_IDLE_MS = 65_000;

export function connectionDeadline(attachment) {
  if (!attachment) return 0;
  const expiry = attachment.exp * 1000;
  // Older connections keep their ticket deadline until their next heartbeat.
  return ['device', 'ssh'].includes(attachment.leg) && Number.isFinite(attachment.lastSeen)
    ? Math.min(expiry, attachment.lastSeen + DEVICE_IDLE_MS)
    : expiry;
}

export function livePresence(attachments, now = Date.now()) {
  return attachments.filter(a => a?.leg === 'device' && connectionDeadline(a) > now)
    .map(a => ({ deviceId: a.dev, connected: true }));
}
