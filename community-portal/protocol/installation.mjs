// Installation epochs fence credentials issued before sign-out.
export const installKey = (accountId, installId) => `INSTALL#${accountId}#${installId}`;
export const installTokenLive = (token, installation) => !installation?.revoked && (token.install_epoch || 'legacy') === (installation?.epoch || 'legacy');
