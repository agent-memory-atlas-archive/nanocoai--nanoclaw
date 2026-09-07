const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const params = new URLSearchParams(location.search);
let catalog = [], me = null, tab = ['echo', 'slack', 'devices', 'activity', 'nanocode'].includes(params.get('tab')) ? params.get('tab') : 'perks', presence = [], connected = false, socket, reconnectTimer, revokePerk, toastTimer, signingOut = false;
let setupCode = params.get('setup') || sessionStorage.getItem('nc_setup'), setupFlow, setupError, slackAction, activationPerk, lastActivation, activationSuccess, slackRedirecting = false, activationClosing = false;
if (!/^[\w-]{32}$/.test(setupCode || '')) setupCode = null;
if (setupCode) sessionStorage.setItem('nc_setup', setupCode);
const signInUrl = () => `/api/v1/auth/start${setupCode ? `?returnTo=${encodeURIComponent(`/?setup=${setupCode}`)}` : ''}`;
function notice(message, signIn = false) {
  $('#notice').textContent = message;
  if (signIn) { const link = document.createElement('a'); link.href = signInUrl(); link.textContent = 'Sign in again'; link.className = 'reauth-link'; $('#notice').append(link); }
  $('#notice').hidden = false; clearTimeout(toastTimer);
  if (!signIn) toastTimer = setTimeout(() => { $('#notice').hidden = true; }, 6000);
}
async function api(route, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/v1${route}`, { method, headers: { 'content-type': 'application/json', ...(me?.csrf ? { 'x-csrf-token': me.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && me) signedOut(); const e = new Error(result.message || result.error); e.status = response.status; e.code = result.error; throw e; }
  return result;
}
function signedOut() {
  me = null; presence = []; connected = false; signingOut = true;
  clearTimeout(reconnectTimer); socket?.close();
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  render();
}
function liveDevice(id) { return presence.some(p => p.deviceId === id && p.connected); }
function mergeSnapshot(snapshot) {
  if (!me || snapshot.account?.id !== me.account.id) return;
  if (snapshot.revision >= me.revision) me = { ...me, ...snapshot };
  if (setupFlow) setupFlow = me.setups?.find(s => s.id === setupFlow.id) || setupFlow;
  const visit = pendingSlackVisit();
  const device = me.devices?.find(d => d.slack?.setupId === (setupFlow?.id || (visit?.accountId === me.account.id ? visit.setupId : null)));
  if (device) {
    setupFlow = { ...setupFlow, id: device.slack.setupId, stage: 'slack', deviceId: device.id, label: device.label, appId: device.slack.appId, status: device.slack.status === 'installing' ? 'awaiting_approval' : device.slack.status === 'expired' ? 'failed' : device.slack.status };
    setupError = null;
  }
}
const terminalStates = ['approved', 'awaiting_approval', 'complete', 'failed', 'cancelled', 'skipped'];
function renderSetup() {
  const panel = $('#setup-panel'); panel.hidden = !me || (!setupFlow && !setupError);
  if (panel.hidden) return;
  if (setupError) { panel.innerHTML = `<h2>Setup needs your attention</h2><p>${escape(setupError)}</p>`; return; }
  const flow = setupFlow;
  if (flow.stage === 'nanocode') {
    const approved = ['approved', 'complete'].includes(flow.status);
    const revoked = approved && !me.nanocode?.keys.some(k => k.deviceId === flow.deviceId && k.publicKey === flow.sshPublicKey);
    panel.innerHTML = `<div class="setup-kicker">${escape(flow.label)}</div><h2>${revoked ? 'Terminal access revoked' : approved ? 'Terminal authorized' : ['cancelled', 'skipped', 'failed'].includes(flow.status) ? 'Terminal access cancelled' : 'Connect your terminal'}</h2><p>${revoked ? 'This terminal key no longer has access. Sign in from the terminal again if you want to authorize it.' : approved ? 'Return to your terminal to connect. Your agent keeps running when you disconnect.' : ['cancelled', 'skipped', 'failed'].includes(flow.status) ? 'No terminal access was granted. You can close this page.' : 'Authorize this terminal to create, list and attach to all coding sandboxes on installations where you enable remote access. The private SSH key stays on your machine.'}</p>${flow.status === 'pending' ? '<button class="primary" data-code-authorize>Authorize terminal</button><button class="secondary" data-code-cancel>Cancel</button>' : ''}`;
    return;
  }
  if (terminalStates.includes(flow.status)) {
    const installing = flow.stage === 'slack' && me.devices?.some(d => d.slack?.setupId === flow.id && d.slack.status === 'installing');
    const messages = { approved: 'Setup is continuing in the background. You can keep exploring your perks.', complete: flow.stage === 'slack' ? 'Your agent is connected to Slack. Its welcome DM should arrive shortly.' : 'Your choices are saved. NanoClaw has finished this step.', skipped: 'You can enable more perks at any time. Setup is continuing.', failed: flow.error || 'Slack setup needs attention. Return to the terminal and run the Slack setup step to resume.', cancelled: 'Open the newest link from your CLI.', awaiting_approval: installing ? 'Slack has approved your app. NanoClaw is finishing the installation in the background.' : 'Finish the approval request in Slack. Once approved, NanoClaw will finish connecting your agent and start its welcome DM automatically. Keep your machine online.' };
    panel.innerHTML = `<div class="setup-kicker">${escape(flow.label)}</div><h2>${flow.status === 'awaiting_approval' ? installing ? 'Finishing Slack installation' : 'Waiting for Slack approval' : flow.status === 'failed' ? 'Setup needs attention' : flow.status === 'complete' ? 'All set' : 'Setup is continuing'}</h2><p>${escape(messages[flow.status])}</p>${flow.status === 'awaiting_approval' ? '<button class="secondary" data-tab="slack">View Slack setup</button>' : ''}`;
    if (['complete', 'skipped', 'failed', 'cancelled'].includes(flow.status)) sessionStorage.removeItem('nc_setup');
    return;
  }
  panel.innerHTML = `<div class="setup-kicker">Setting up ${escape(flow.label)}</div><h2>${lastActivation ? `${escape(lastActivation)} is enabled` : 'A little more for your agent'}</h2><p>${lastActivation ? 'Enable another perk below, or head back to finish setup.' : 'Choose what you’d like to enable, then return to your terminal.'}</p><div class="handoff-actions"><button class="secondary" data-explore>Explore other perks</button><button class="primary" data-return>Return to terminal <span aria-hidden="true">↗</span></button></div>`;
}
function openActivation(id) {
  activationSuccess = null;
  activationPerk = catalog.find(p => p.id === id);
  if (!me || !activationPerk || (activationPerk.kind !== 'account' && !activationPerk.enabled)) return;
  const perk = activationPerk, dialog = $('#activation-dialog');
  const workspaces = id === 'slack' ? included('slack').workspaces.filter(w => w.status === 'active') : [];
  const available = perk.kind !== 'account' ? perk.enabled : id === 'echo' ? included('echo').status === 'active' && included('echo').freshness === 'current' : included('slack').freshness === 'current';
  const copy = { echo: 'Opt in to Echo’s hardened image. NanoClaw will use it when it sets up your agent.', slack: workspaces.length ? 'Choose where your NanoClaw agent will live. We’ll take you straight to Slack if installation needs your approval.' : 'Connect your workspace. Slack will show the permissions and ask you to approve access.', tavily: 'Give your agent web search. Activate once and your signed-in installations will receive their own credentials.', dial: 'Give your agent a phone number for calls and messages.' }[id];
  const consent = setupFlow && !terminalStates.includes(setupFlow.status) ? ` Enabling also signs in the installation on ${escape(setupFlow.label)}.` : '';
  dialog.innerHTML = `<div class="dialog-heading">${provider(perk)}<button type="button" class="icon-button" data-close aria-label="Close activation">×</button></div><h2 id="activation-title">${id === 'slack' && !workspaces.length ? 'Connect' : 'Activate'} ${escape(perk.name)}</h2><p class="activation-copy">${escape(copy)}</p><div class="activation-allowance">${escape(perk.allowance)}</div>${id === 'slack' && workspaces.length ? `<label class="activation-workspace">Workspace<select id="activation-workspace">${workspaces.map(w => `<option value="${escape(w.id)}" ${w.id === me.activations?.slack.workspaceId ? 'selected' : ''}>${escape(w.name)}</option>`).join('')}</select></label><button class="text-button" data-connect-workspace>Connect another workspace</button>` : ''}${perk.termsText ? `<p class="activation-terms">By activating, you accept these terms: ${escape(perk.termsText)}${consent}</p>` : `<p class="activation-terms">${consent}</p>`}${!available ? '<p class="source-warning">This perk is not available for this account yet.</p>' : ''}<p id="activation-error" class="source-warning" role="alert" hidden></p><div class="dialog-actions"><button class="text-button" data-close>Maybe later</button><button class="primary" id="activate-perk" ${available ? 'autofocus' : 'disabled'}>${id === 'slack' && !workspaces.length ? 'Connect Slack' : `Activate ${escape(perk.name)}`}</button></div>`;
  if (!dialog.open) dialog.showModal();
  $('#activate-perk')?.focus();
}
function pendingSlackVisit() {
  try { return JSON.parse(sessionStorage.getItem('nc_slack_install')); } catch { return null; }
}
async function dismissActivation() {
  if (activationClosing) return;
  activationClosing = true;
  const dialog = $('#activation-dialog');
  const buttons = [...dialog.querySelectorAll('button')];
  const disabled = buttons.map(button => button.disabled);
  buttons.forEach(button => { button.disabled = true; });
  try {
    if (!activationSuccess && setupCode && setupFlow && !terminalStates.includes(setupFlow.status)) {
      setupFlow = await api(`/setup/${setupCode}/return`, { method: 'POST', body: { skip: true } });
      notice(setupFlow.status === 'skipped' ? 'Skipped for now. Setup is continuing in your terminal.' : 'Setup is continuing in the background.');
    }
    const visit = pendingSlackVisit();
    if (activationSuccess && visit?.accountId === me?.account.id) sessionStorage.setItem('nc_slack_install', JSON.stringify({ ...visit, dismissed: true, attempted: true }));
    dialog.close(); activationSuccess = null; render();
  } catch (error) {
    const field = $('#activation-error');
    if (field) { field.textContent = error.message; field.hidden = false; }
    else notice(error.message);
  } finally {
    buttons.forEach((button, index) => { button.disabled = disabled[index]; });
    activationClosing = false;
  }
}
$('#activation-dialog').addEventListener('cancel', event => { event.preventDefault(); void dismissActivation(); });
function currentSlackApp() {
  const visit = pendingSlackVisit();
  const device = me?.devices.find(d => d.id === setupFlow?.deviceId);
  const appId = setupFlow?.appId || device?.slack?.appId || (visit?.accountId === me?.account.id ? visit.appId : null);
  return included('slack').apps.find(app => app.id === appId);
}
function renderActivationSuccess() {
  const dialog = $('#activation-dialog');
  if (!me || !activationSuccess || !dialog.open) return;
  const perk = catalog.find(p => p.id === activationSuccess.id), app = perk.id === 'slack' ? currentSlackApp() : null;
  const slackSetup = perk.id === 'slack' && (setupFlow?.stage === 'slack' || pendingSlackVisit()?.accountId === me.account.id);
  const job = me.devices?.find(d => d.slack?.appId === app?.id)?.slack;
  const ready = job?.status === 'complete';
  const stopped = ['failed', 'expired'].includes(job?.status);
  const title = perk.id === 'slack' ? ready ? `${app.name} is ready in Slack` : stopped ? 'Slack setup needs attention' : 'Slack is connected' : `${perk.name} is enabled`;
  let copy = setupFlow ? 'Setup is continuing in the background. Head back to your terminal or explore a few more perks.' : 'Your perk is ready. Explore what else you can enable for your agent.';
  let progress = '';
  if (slackSetup && !ready) {
    copy = stopped ? 'Your app has been saved. Return to the terminal and run the Slack setup step to resume.' : app?.status === 'installed' ? 'Slack has approved your app. NanoClaw is finishing the installation in the background.' : app ? 'After Slack approval, NanoClaw will finish the installation and your agent will DM you. Keep your machine online; you can close this browser and the terminal.' : 'We’re setting up your agent. We’ll open Slack here if installation needs your approval.';
    const label = stopped ? 'Setup paused' : app?.status === 'installed' ? 'Finishing installation' : app ? 'Waiting for Slack approval' : `Setting up ${setupFlow?.name || 'your agent'}`;
    progress = `<div class="activation-progress" role="status"><span class="progress-dot" aria-hidden="true"></span>${escape(label)}</div>${app?.status === 'pending_install' && !stopped ? `<button class="secondary" data-slack="install-url" data-app="${escape(app.id)}" data-name="${escape(app.name)}">Continue in Slack</button>` : ''}`;
  } else if (ready) copy = 'Your agent is connected to Slack. Its welcome DM should arrive shortly.';
  else if (perk.id === 'slack' && !slackSetup) copy = 'Your workspace is connected. Choose Slack during NanoClaw setup to add your agent.';
  const markup = `<div class="dialog-heading">${provider(perk)}<button type="button" class="icon-button" data-close aria-label="Close activation">×</button></div><div class="activation-success-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg></div><h2 id="activation-title">${escape(title)}</h2><p class="activation-copy">${escape(copy)}</p>${progress}<p id="activation-error" class="source-warning" role="alert" ${activationSuccess.error ? '' : 'hidden'}>${escape(activationSuccess.error)}</p><div class="success-actions"><button class="primary" data-success-return>Return to terminal</button><button class="secondary" data-success-browse>Browse other perks</button></div>`;
  if (dialog.dataset.successView !== markup) { dialog.innerHTML = markup; dialog.dataset.successView = markup; }
}
function showActivationSuccess(id) {
  activationPerk = catalog.find(perk => perk.id === id);
  activationSuccess = { id };
  const dialog = $('#activation-dialog'); delete dialog.dataset.successView;
  if (!dialog.open) dialog.showModal();
  renderActivationSuccess(); $('[data-success-return]')?.focus();
}
async function openSlackInstall(appId) {
  const visit = { accountId: me.account.id, setupId: setupFlow?.id, appId, attempted: true };
  sessionStorage.setItem('nc_slack_install', JSON.stringify(visit));
  const result = await api('/slack/install-url', { method: 'POST', body: { appId } });
  if (!result.url) throw new Error('Slack could not provide an approval link. Refresh its status and try again.');
  location.assign(result.url);
}
async function continueSlackInstall() {
  if (!me || signingOut || slackRedirecting) return;
  const visit = pendingSlackVisit();
  if (!visit || visit.accountId !== me.account.id || visit.setupId !== setupFlow?.id || visit.attempted) return;
  const app = currentSlackApp();
  if (app?.status !== 'pending_install') return;
  slackRedirecting = true;
  try { await openSlackInstall(app.id); }
  catch (error) {
    if (activationSuccess?.id === 'slack') { activationSuccess.error = error.message; renderActivationSuccess(); }
    else notice(error.message);
  } finally { slackRedirecting = false; }
}
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div'); layer.className = 'confetti'; layer.setAttribute('aria-hidden', 'true');
  const colors = ['#1FB8B0', '#0F756D', '#F2EBD7', '#1A1612'];
  for (let i = 0; i < 42; i++) {
    const piece = document.createElement('i');
    piece.style.cssText = `--x:${Math.random() * 100}vw;--drift:${Math.random() * 160 - 80}px;--spin:${Math.random() * 720}deg;--delay:${Math.random() * .3}s;background:${colors[i % colors.length]}`;
    layer.append(piece);
  }
  ($('#activation-dialog').open ? $('#activation-dialog') : document.body).append(layer); setTimeout(() => layer.remove(), 2400);
}
async function finishActivation(id, workspaceId) {
  const perk = catalog.find(p => p.id === id);
  mergeSnapshot(await api(`/activations/${id}`, { method: 'POST', body: { accepted: true, termsVersion: perk.termsVersion, workspaceId, ...(setupCode && !terminalStates.includes(setupFlow?.status) ? { setupCode } : {}) } }));
  sessionStorage.removeItem('nc_activation');
  // Older CLI versions also start work immediately from this browser flow.
  // Return to terminal and Browse are navigation choices, not approval gates.
  if (setupCode && setupFlow?.stage === id && setupFlow.status === 'browsing') setupFlow = await api(`/setup/${setupCode}/return`, { method: 'POST', body: {} });
  if (id === 'slack' && setupFlow?.stage === 'slack') sessionStorage.setItem('nc_slack_install', JSON.stringify({ accountId: me.account.id, setupId: setupFlow.id, attempted: false }));
  lastActivation = perk.name; tab = 'perks'; showActivationSuccess(id); render(); confetti();
}
const activeSetupCode = () => setupCode && !terminalStates.includes(setupFlow?.status) ? setupCode : null;
async function connectSlack() {
  if (setupCode && ['pending', 'authorizing'].includes(setupFlow?.status)) setupFlow = await api(`/setup/${setupCode}/authorize`, { method: 'POST', body: { accepted: true } });
  sessionStorage.setItem('nc_activation', JSON.stringify({ id: 'slack', setupCode: activeSetupCode(), previous: included('slack').workspaces.filter(w => w.status === 'active').map(w => w.id) }));
  const result = await api('/slack/connect', { method: 'POST', body: { accepted: true } });
  if (result.url) { location.assign(result.url); return; }
  mergeSnapshot(await api('/me')); await resumeSlackActivation();
}
async function resumeSlackActivation() {
  let pending; try { pending = JSON.parse(sessionStorage.getItem('nc_activation')); } catch { sessionStorage.removeItem('nc_activation'); }
  if (pending?.id !== 'slack' || pending.setupCode !== activeSetupCode()) return false;
  sessionStorage.removeItem('nc_activation');
  const outcome = params.get('slack'), workspaceId = params.get('workspace');
  params.delete('slack'); params.delete('workspace');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  if (['cancelled', 'failed'].includes(outcome)) {
    openActivation('slack'); $('#activation-error').textContent = outcome === 'cancelled' ? 'Slack connection cancelled. Try again or enable it later.' : 'Slack could not finish connecting. Try again or enable it later.'; $('#activation-error').hidden = false; return true;
  }
  try {
    // OAuth writes happen outside this service's cache. Refresh before deciding
    // whether to activate, allowing the workspace index a moment to catch up.
    for (let attempt = 0; attempt < 3; attempt++) {
      mergeSnapshot(await api('/included/refresh', { method: 'POST', body: {} }));
      const workspaces = included('slack').freshness === 'current' ? included('slack').workspaces.filter(w => w.status === 'active') : [];
      const added = workspaces.filter(w => !pending.previous.includes(w.id));
      const selected = outcome === 'connected' ? workspaces.find(w => w.id === workspaceId) : added.length === 1 ? added[0] : undefined;
      // A URL alone cannot establish activation: the workspace must be present
      // in this account's fresh source data, and the API validates it again.
      if (selected) { await finishActivation('slack', selected.id); return true; }
      if (outcome !== 'connected') break;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    openActivation('slack');
    if (!$('#activation-workspace')) { $('#activation-error').textContent = 'Slack is not connected yet. Refresh its status or try again in a moment.'; $('#activation-error').hidden = false; }
  } catch (error) {
    openActivation('slack'); $('#activation-error').textContent = error.message; $('#activation-error').hidden = false;
  }
  return true;
}
function included(id) { return me.included?.find(p => p.id === id) || { status: 'unknown', freshness: 'unconfigured', workspaces: [], apps: [] }; }
function accountStatus(id) {
  const p = included(id);
  if (p.freshness === 'stale') return 'Status out of date';
  if (p.freshness !== 'current') return 'Status unavailable';
  if (id === 'echo' && me.activations?.echo.enabled) return 'Enabled';
  if (id === 'echo') return ({ active: 'Included with your account', not_granted: 'No image access', revoked: 'Access revoked' })[p.status] || 'Status unknown';
  const count = p.workspaces.filter(w => w.status === 'active').length;
  return count ? `${count} workspace${count > 1 ? 's' : ''} connected` : p.status === 'not_connected' ? 'Not connected' : 'Status unknown';
}
function freshness(p) {
  const checked = p.checkedAt ? new Date(p.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null;
  const updated = p.updatedAt ? new Date(p.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null;
  if (p.freshness === 'stale') return `<p class="source-warning">We couldn’t refresh this status. Showing the last successful check${updated ? ` from ${escape(updated)}` : ''}.</p>`;
  if (p.freshness !== 'current') return '<p class="source-warning">We couldn’t load this account’s status. Try refreshing in a moment.</p>';
  return `<p class="source-time">Checked ${escape(checked)}${p.id === 'slack' ? ' · Recent Slack changes may take a moment to appear.' : ''}</p>`;
}

function provider(perk) { return `<div class="provider"><img class="provider-logo ${perk.id}" src="/logos/${perk.id}.svg" alt="" width="112" height="36"><h3 class="${['echo', 'tavily'].includes(perk.id) ? 'sr-only' : ''}">${escape(perk.name)}</h3></div>`; }
function perkState(grant) {
  if (!grant) return '';
  if (grant.desired === 'withdrawn') return grant.redemptions.some(r => r.state !== 'REVOKED') ? 'Revoking resources…' : '';
  const delivered = grant.redemptions.filter(r => r.state === 'DELIVERED').length;
  if (delivered) return `Ready on ${delivered} device${delivered > 1 ? 's' : ''}`;
  if (grant.redemptions.some(r => r.state === 'UNCERTAIN')) return 'Recovering delivery…';
  return 'Waiting for a device';
}
function perkCard(perk) {
  if (perk.kind === 'account') {
    const p = included(perk.id), ready = p.freshness === 'current' && ['active', 'connected'].includes(p.status);
    const agents = perk.id === 'slack' ? p.apps.filter(a => a.status !== 'deleted').length : 0;
    return `<article class="perk account-perk" aria-label="${escape(perk.name)} perk"><div class="perk-body"><div class="perk-heading">${provider(perk)}<span class="category">${escape(perk.category)}</span></div><p class="perk-headline">${escape(perk.headline)}</p><p class="perk-description">${escape(perk.description)}</p><div class="allowance">${escape(perk.allowance)}${agents ? `<span>${agents} agents</span>` : ''}</div><p class="perk-state ${ready ? '' : 'muted'}">${escape(accountStatus(perk.id))}</p><div class="perk-actions">${me.activations?.[perk.id]?.enabled ? `<button class="secondary" data-tab="${perk.id}">View ${escape(perk.name)} details</button>` : `<button class="primary" data-activate="${perk.id}">Enable ${escape(perk.name)}</button>`}<span class="muted perk-note">Your NanoClaw account</span></div></div></article>`;
  }
  if (!perk.enabled) return `<article class="perk" aria-label="${escape(perk.name)} perk"><div class="perk-body"><div class="perk-heading">${provider(perk)}<span class="category">${escape(perk.category)}</span></div><p class="perk-headline">${escape(perk.headline)}</p><p class="perk-description">${escape(perk.description)}</p><div class="allowance">${escape(perk.allowance)}</div><p class="coming-soon">Coming soon</p></div></article>`;
  const grant = me.grants.find(g => g.perk === perk.id), active = grant?.desired === 'active', state = perkState(grant);
  const pendingRevoke = grant?.desired === 'withdrawn' && state;
  const delivered = active ? grant.redemptions.filter(r => r.state === 'DELIVERED') : [];
  return `<article class="perk" aria-label="${escape(perk.name)} perk"><div class="perk-body"><div class="perk-heading">${provider(perk)}<span class="category">${escape(perk.category)}</span></div><p class="perk-headline">${escape(perk.headline)}</p><p class="perk-description">${escape(perk.description)}</p><div class="allowance">${escape(perk.allowance)}<span>Up to ${perk.deviceCap} devices</span></div>${state ? `<p class="perk-state">${escape(state)}</p>` : ''}${delivered.map(r => `<div class="detail-row"><span>${escape(me.devices.find(d => d.id === r.deviceId)?.label || 'Device')}</span><strong>${escape(perk.id === 'dial' ? r.resource?.phoneNumber : 'Credential delivered')}</strong></div>`).join('')}<div class="perk-actions">${active ? `<button class="secondary" data-tab="devices">View devices</button><button class="text-button" data-revoke="${perk.id}">Remove perk</button>` : `<button class="primary" data-activate="${perk.id}" ${pendingRevoke || !perk.enabled ? 'disabled' : ''}>${pendingRevoke ? 'Revoking…' : perk.enabled ? `Activate ${escape(perk.name)}` : 'Coming soon'}</button>`}</div></div></article>`;
}
function accountDetails(id) {
  const p = included(id), perk = catalog.find(item => item.id === id);
  let content;
  if (id === 'echo') {
    content = `<section class="detail-panel"><h2>Your hardened agent image</h2><div class="access-summary"><img class="provider-logo echo" src="/logos/echo.svg" alt="Echo" width="78" height="28"><div><strong>${escape(accountStatus(id))}</strong><p>Echo image access belongs to your NanoClaw account.</p></div></div>${p.grantedAt ? `<p class="source-time">Access granted ${escape(new Date(p.grantedAt).toLocaleDateString())}</p>` : ''}<p>Choose the image in this portal when NanoClaw setup opens it. Your CLI applies the choice on the machine running your agents.</p>${me.devices.filter(d => d.imageSource).map(d => `<div class="detail-row"><span>${escape(d.label)}</span><strong>${d.imageSource === 'hardened' ? 'Echo hardened image selected' : 'Local build selected'}</strong></div>`).join('')}<div class="guidance"><h3>Change the image for an existing install</h3><p>Open the image setup step from that NanoClaw checkout. It brings you back here to choose the image for that machine.</p><pre>pnpm exec tsx setup/portal.ts --stage echo</pre></div></section>`;
  } else {
    const apps = p.apps.filter(a => a.status !== 'deleted');
    const labels = { active: 'Connected', disconnected: 'Disconnected', revoked: 'Connection revoked', installed: 'Installed', pending_install: 'Awaiting installation approval', unknown: 'Status unknown' };
    const appLabel = a => { const job = me.devices?.find(d => d.slack?.appId === a.id)?.slack; return job ? ({ awaiting_approval: 'Waiting for Slack approval', installing: 'Finishing installation', complete: 'Ready in Slack', failed: 'Setup needs attention — resume in the terminal', expired: 'Approval window expired — resume in the terminal' }[job.status] || labels[a.status]) : labels[a.status]; };
    const appRow = a => `<div class="list-row"><span class="agent-avatar" aria-hidden="true">${escape(a.name.charAt(0) || 'A')}</span><div class="row-copy"><strong>${escape(a.name)}</strong><p>${escape(appLabel(a) || 'Status unknown')}</p></div>${a.status === 'pending_install' ? `<button class="secondary" data-slack="install-url" data-app="${escape(a.id)}" data-name="${escape(a.name)}">Finish approval</button>` : ''}<button class="text-button" data-slack="revoke" data-app="${escape(a.id)}" data-name="${escape(a.name)}">Revoke agent</button></div>`;
    content = p.workspaces.length ? p.workspaces.map(w => `<section class="detail-panel workspace-panel"><div class="workspace-heading"><div><h2>${escape(w.name || w.id)}</h2><p>${escape(labels[w.status] || 'Status unknown')}</p></div>${w.status === 'active' ? `<button class="text-button" data-slack="disconnect" data-team="${escape(w.id)}" data-name="${escape(w.name)}">Disconnect workspace</button>` : '<button class="secondary" data-slack="connect">Reconnect workspace</button>'}</div>${w.status !== 'active' ? '<p class="source-warning">This workspace connection is no longer active. Existing agents may keep running with their own Slack tokens.</p>' : ''}<div class="workspace-agents">${apps.filter(a => a.teamId === w.id).map(appRow).join('') || '<p class="empty">No managed agents in this workspace yet.</p>'}</div></section>`).join('') : `<section class="detail-panel"><h2>${p.freshness === 'current' ? 'Connect your first workspace' : 'Workspace status unavailable'}</h2><p>Connect Slack here to let NanoClaw provision and manage your agents.</p><button class="primary" data-slack="connect">Connect Slack</button></section>`;
    const orphaned = apps.filter(a => !p.workspaces.some(w => w.id === a.teamId));
    if (orphaned.length) content += `<section class="detail-panel"><h2>Other recorded agents</h2><p>Workspace connection details are not currently available for these apps.</p>${orphaned.map(appRow).join('')}</section>`;
    if (p.truncated) content += '<p class="source-warning">Showing the first 200 workspace and agent records. Use NanoClaw’s Slack tools to see the full account.</p>';
    content += `<section class="detail-panel guidance"><h2>Create an agent on your machine</h2><p>Choose Slack during NanoClaw setup. Connect a workspace and approve the installation here. NanoClaw finishes connecting your agent in the background, then starts its welcome DM. Keep this machine online while approval is pending.</p><p>Each new agent app may need its own workspace approval. Setup watches for up to seven days. If the machine restarts or the job stops, rerun this command to resume the saved installation.</p><pre>pnpm exec tsx setup/portal.ts --stage slack</pre><button class="secondary" data-slack="connect">Connect another workspace</button></section>`;
  }
  return `<button class="text-button back-button" data-tab="perks">← All perks</button><header class="page-head"><div><h1>${escape(perk.name)}</h1><p>${escape(perk.headline)}</p></div><button class="secondary" data-refresh>Refresh status</button></header>${freshness(p)}${content}`;
}
function render() {
  renderSetup();
  renderActivationSuccess();
  void continueSlackInstall();
  const navTab = ['echo', 'slack'].includes(tab) ? 'perks' : tab;
  document.querySelectorAll('nav [data-tab]').forEach(button => { button.classList.toggle('selected', button.dataset.tab === navTab); button.setAttribute('aria-current', button.dataset.tab === navTab ? 'page' : 'false'); });
  document.body.classList.toggle('signed-out', !me);
  $('.sidebar').hidden = !me; $('#public-header').hidden = Boolean(me);
  if (!me) {
    $('#member').textContent = 'NanoClaw account'; $('#connection').textContent = 'Not signed in'; $('#logout').hidden = true;
    $('#main').innerHTML = `<div class="intro"><h1>A few good things<br>for your agent</h1><p>Your Echo image access, Slack agents, and partner perks, together in one NanoClaw account.</p><a class="primary" href="${signInUrl()}">Sign in to NanoClaw</a><div class="intro-partners">${catalog.map(p => `<div class="intro-partner">${provider(p)}${p.kind !== 'account' && !p.enabled ? '<span class="coming-soon">Coming soon</span>' : ''}</div>`).join('')}</div></div>`;
    return;
  }
  $('#member').textContent = me.account.name; $('#connection').textContent = connected ? 'Account connected' : 'Reconnecting…'; $('#logout').hidden = false;
  const status = `<span class="status-pill ${connected ? '' : 'offline'}"><i></i>${connected ? 'Live updates connected' : 'Reconnecting…'}</span>`;
  if (tab === 'perks') {
    const online = me.devices.filter(d => liveDevice(d.id)).length;
    $('#main').innerHTML = `<header class="page-head"><div><h1>Perks for your agent</h1><p>Enable the tools you want for your agent.<br>Your perks, all in one place.</p></div>${status}</header><div class="section-title"><h2>Your perks</h2><button class="text-button" data-refresh>Refresh status</button></div><div class="perk-grid">${catalog.map(perkCard).join('')}</div><div class="device-strip"><span class="device-icon" aria-hidden="true">▣</span><div><p>${online ? `${online} installation${online > 1 ? 's' : ''} connected` : 'Sign in from NanoClaw setup to receive perks'}</p><small>${online ? 'Your choices are saved to your NanoClaw account.' : 'Setup opens this portal and connects your installation automatically.'}</small></div><button class="secondary" data-tab="devices">Manage devices</button></div>`;
  } else if (['echo', 'slack'].includes(tab)) {
    $('#main').innerHTML = accountDetails(tab);
  } else if (tab === 'nanocode') {
    const hosts = me.nanocode?.devices || [], keys = me.nanocode?.keys || [];
    $('#main').innerHTML = `<header class="page-head"><div><h1>Code mode</h1><p>Connect to your coding agents from any terminal. Your machine connects outward through this portal.</p></div></header><p><a href="/downloads/nanocode.mjs" download="nanocode.mjs">Download the terminal helper</a> to the computer you’re connecting from. It needs Node 22.13 or later and OpenSSH. Run the commands below from its download folder; your existing portal sign-in authorizes this terminal.</p><div class="list">${hosts.length ? hosts.map(d => `<div class="list-row"><span class="online-dot ${liveDevice(d.id) && d.enabled ? 'on' : ''}" aria-hidden="true"></span><div class="row-copy"><strong>${escape(d.label)}</strong><p>${!d.enabled ? 'Remote access disabled' : liveDevice(d.id) ? 'Machine online · access enabled' : 'Machine offline'}</p><code>node nanocode.mjs connect ${escape(d.id)} list</code><p>Create: <code>node nanocode.mjs connect ${escape(d.id)} new</code><br>Reattach: <code>node nanocode.mjs connect ${escape(d.id)} attach &lt;sandbox&gt;</code></p></div><button class="secondary" data-code-access="${escape(d.id)}" data-enabled="${!d.enabled}">${d.enabled ? 'Disable access' : 'Enable access'}</button></div>`).join('') : '<p class="empty">On your NanoClaw machine, run <code>node setup/nanocode.mjs enable</code> to opt in. Then return here to connect.</p>'}</div><h2>Authorized terminals</h2><div class="list">${keys.map(k => `<div class="list-row"><div class="row-copy"><strong>${escape(me.devices.find(d => d.id === k.deviceId)?.label || 'Terminal')}</strong><p>${escape(k.fingerprint)}</p></div><button class="text-button" data-code-revoke="${escape(k.fingerprint)}">Revoke</button></div>`).join('') || '<p class="empty">Your terminal will reuse portal sign-in when you first connect.</p>'}</div>`;
  } else if (tab === 'devices') {
    $('#main').innerHTML = `<header class="page-head"><div><h1>Your devices</h1><p>Your signed-in NanoClaw installations. Sign out a device to revoke its access.</p></div></header><div class="list">${me.devices.length ? me.devices.map(d => { const perks = me.grants.filter(g => g.desired === 'active' && g.redemptions.some(r => r.deviceId === d.id && r.state === 'DELIVERED')).map(g => catalog.find(p => p.id === g.perk)?.name); return `<div class="list-row"><span class="online-dot ${liveDevice(d.id) ? 'on' : ''}" aria-hidden="true"></span><div class="row-copy"><strong>${escape(d.label)}</strong><p>${liveDevice(d.id) ? 'Connected' : 'Offline'}${perks.length ? ` · ${escape(perks.join(', '))}` : ''}</p></div><button class="text-button" data-forget="${escape(d.id)}">Sign out device</button></div>`; }).join('') : '<p class="empty">Start NanoClaw setup on your machine. Your signed-in installation will appear here.</p>'}</div>`;
  } else {
    const labels = { 'account.ready': 'Account ready', 'account.perks_updated': 'Echo and Slack status updated', 'slack.changed': 'Slack updated', 'setup.started': 'Browser setup opened', 'setup.approved': 'Setup choice confirmed', 'setup.complete': 'Device setup complete', 'setup.failed': 'Device setup needs attention', 'setup.awaiting_approval': 'Slack installation approval needed', 'device.registered': 'Installation signed in', 'setup.authorized': 'Installation authorized', 'device.forgotten': 'Device removed', 'perk.claimed': 'Perk activated', 'perk.activated': 'Perk enabled', 'setup.returned': 'Returned to terminal', 'perk.withdrawn': 'Perk removed', 'redemption.usage_accounted': 'Usage carried forward', 'redemption.started': 'Delivery started', 'redemption.minted': 'Credential prepared', 'redemption.delivered': 'Delivered to device', 'redemption.uncertain': 'Delivery recovery scheduled', 'redemption.revoked': 'Resource revoked' };
    $('#main').innerHTML = `<header class="page-head"><div><h1>Account activity</h1><p>Claims, deliveries, and changes to your devices, as they happen.</p></div>${status}</header><div class="list">${me.events.length ? [...me.events].reverse().map(e => `<div class="list-row"><span class="event-icon" aria-hidden="true">${e.type === 'redemption.delivered' ? '✓' : '◷'}</span><div class="row-copy"><strong>${escape(labels[e.type] || e.type)}</strong><p>${escape([catalog.find(p => p.id === e.perk)?.name, me.devices.find(d => d.id === e.deviceId)?.label].filter(Boolean).join(' · ') || 'Your NanoClaw account')}</p></div><time class="event-time" datetime="${escape(e.at)}">${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('') : '<p class="empty">Your first claim will appear here.</p>'}</div>`;
  }
}
async function connect() {
  if (!me || signingOut) return;
  try {
    const result = await api('/cell-ticket', { method: 'POST', body: {} });
    if (!me || signingOut) return;
    socket = new WebSocket(result.socketUrl, ['nc-cell', `ticket.${result.ticket}`]);
    socket.onopen = () => { connected = true; render(); };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.snapshot) mergeSnapshot(message.snapshot);
      if (message.presence) presence = message.presence;
      if (message.type !== 'pong') render();
    };
    socket.onclose = () => { connected = false; render(); if (me && !signingOut) reconnectTimer = setTimeout(connect, 2000); };
  } catch (error) { connected = false; render(); if (me && !signingOut) reconnectTimer = setTimeout(connect, 5000); }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.tab) { tab = button.dataset.tab; render(); return; }
  if (button.hasAttribute('data-close')) {
    if (button.closest('dialog').id === 'activation-dialog') await dismissActivation();
    else button.closest('dialog').close();
    return;
  }
  try {
    if (button.hasAttribute('data-code-authorize')) {
      setupFlow = await api(`/setup/${setupCode}/approve`, { method: 'POST', body: { accepted: true } });
      mergeSnapshot(await api('/me')); tab = 'nanocode'; render();
    } else if (button.hasAttribute('data-code-cancel')) {
      setupFlow = await api(`/setup/${setupCode}/return`, { method: 'POST', body: { skip: true } }); render();
    } else if (button.dataset.codeAccess) {
      await api('/nanocode/access', { method: 'POST', body: { deviceId: button.dataset.codeAccess, enabled: button.dataset.enabled === 'true', accepted: true } });
      mergeSnapshot(await api('/me')); render();
    } else if (button.dataset.codeRevoke) {
      await api('/nanocode/key/revoke', { method: 'POST', body: { fingerprint: button.dataset.codeRevoke } });
      mergeSnapshot(await api('/me')); render();
    } else if (button.dataset.activate) {
      openActivation(button.dataset.activate);
    } else if (button.hasAttribute('data-success-return') || button.hasAttribute('data-success-browse')) {
      const visit = pendingSlackVisit();
      if (visit?.accountId === me?.account.id) sessionStorage.setItem('nc_slack_install', JSON.stringify({ ...visit, dismissed: true, attempted: true }));
      $('#activation-dialog').close(); activationSuccess = null;
      tab = 'perks'; render();
      if (button.hasAttribute('data-success-browse')) { $('#main').focus(); $('#main').scrollIntoView({ behavior: 'smooth' }); }
      else notice('Setup is continuing. You can switch back to your terminal.');
    } else if (button.id === 'activate-perk') {
      button.disabled = true; $('#activation-error').hidden = true;
      const id = activationPerk.id;
      if (id === 'slack' && !$('#activation-workspace')) await connectSlack();
      else await finishActivation(id, $('#activation-workspace')?.value);
    } else if (button.hasAttribute('data-connect-workspace')) {
      button.disabled = true; await connectSlack();
    } else if (button.hasAttribute('data-return')) {
      button.disabled = true;
      setupFlow = await api(`/setup/${setupCode}/return`, { method: 'POST', body: {} }); render();
      notice('Continue setup in your terminal.');
    } else if (button.hasAttribute('data-explore')) {
      tab = 'perks'; render(); $('#main').focus(); $('#main').scrollIntoView({ behavior: 'smooth' });
    } else if (button.dataset.slack === 'connect') {
      openActivation('slack');
    } else if (button.dataset.slack) {
      slackAction = { operation: button.dataset.slack, appId: button.dataset.app, teamId: button.dataset.team, name: button.dataset.name };
      if (slackAction.operation === 'install-url') {
        await openSlackInstall(slackAction.appId); return;
      }
      const copy = {
        connect: ['Connect Slack', 'Authorize NanoClaw to configure and install managed agent apps in your chosen Slack workspace. Slack will show the permissions before you approve.'],
        disconnect: [`Disconnect ${slackAction.name}?`, 'This removes NanoClaw’s ability to manage this workspace. Existing agents keep running on their own tokens. Revoke any agents you want to stop before disconnecting.'],
        revoke: [`Revoke ${slackAction.name}?`, 'This deletes the managed Slack app and stops this agent’s Slack access. Its local NanoClaw data is kept.'],
      }[slackAction.operation];
      $('#slack-title').textContent = copy[0]; $('#slack-description').textContent = copy[1]; $('#slack-confirm').textContent = slackAction.operation === 'revoke' ? 'Revoke agent' : 'Continue'; $('#slack-dialog').showModal();
    } else if (button.id === 'slack-confirm') {
      button.disabled = true;
      const result = await api(`/slack/${slackAction.operation}`, { method: 'POST', body: { ...slackAction, accepted: true } });
      if (result.url) { location.assign(result.url); return; }
      $('#slack-dialog').close(); mergeSnapshot(await api('/me')); render(); notice('Slack status updated.');
    } else if (button.hasAttribute('data-refresh')) {
      button.disabled = true; button.textContent = 'Checking…';
      mergeSnapshot(await api('/included/refresh', { method: 'POST', body: {} })); render();
      notice(me.included.some(p => p.freshness !== 'current') ? 'Some account status could not be refreshed. See the perk details.' : 'Account status refreshed.');
    } else if (button.dataset.revoke) {
      revokePerk = button.dataset.revoke; $('#revoke-title').textContent = `Remove ${catalog.find(p => p.id === revokePerk).name}?`; $('#revoke-description').textContent = 'This removes the perk from all of your devices.'; $('#revoke-dialog').showModal();
    } else if (button.id === 'confirm-revoke') {
      button.disabled = true; const result = await api(`/grants/${revokePerk}`, { method: 'DELETE' }); mergeSnapshot(result); $('#revoke-dialog').close(); render(); notice('Perk removed. Device credentials are being cleaned up.');
    } else if (button.dataset.forget) {
      if (!window.confirm('Sign out this installation and revoke its partner credentials?')) return;
      button.disabled = true; const result = await api(`/devices/${button.dataset.forget}`, { method: 'DELETE' }); mergeSnapshot(result); render(); notice('Device removed.');
    }
  } catch (error) { if (error.status === 401) document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); if ($('#activation-dialog').open) { $('#activation-error').textContent = error.message; $('#activation-error').hidden = false; } else notice(error.message, error.status === 401); } finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); signedOut(); sessionStorage.removeItem('nc_setup'); sessionStorage.removeItem('nc_activation'); sessionStorage.removeItem('nc_slack_install'); history.replaceState(null, '', '/'); clearTimeout(reconnectTimer); socket?.close(); location.reload(); } catch (error) { notice(error.message); } });
setInterval(() => { if (socket?.readyState === 1) socket.send('ping'); }, 20000);
setInterval(async () => {
  if (!me || signingOut || document.hidden) return;
  try { mergeSnapshot(await api('/me')); render(); } catch { /* manual refresh reports source failures */ }
}, 60_000);
setInterval(async () => {
  if (!setupCode || !me || signingOut || setupFlow && Date.parse(setupFlow.expiresAt) <= Date.now() || ['complete', 'skipped', 'failed', 'cancelled'].includes(setupFlow?.status)) return;
  try { const next = await api(`/setup/${setupCode}`); const changed = setupError || JSON.stringify(next) !== JSON.stringify(setupFlow); setupError = null; setupFlow = next; if (changed) render(); }
  catch (error) { setupError = error.message; if (error.status === 410) { sessionStorage.removeItem('nc_setup'); setupCode = null; } renderSetup(); }
}, 1500);
try {
  const catalogResponse = await api('/catalog');
  catalog = catalogResponse.items;
  try { me = await api('/me'); } catch (error) { if (error.status !== 401) notice(error.message); else if (setupCode) location.replace(signInUrl()); }
  if (setupCode && me) {
    try { setupFlow = await api(`/setup/${setupCode}`); if (!params.has('tab')) tab = 'perks'; }
    catch (error) { setupError = error.message; if (error.status === 410) { sessionStorage.removeItem('nc_setup'); setupCode = null; } }
  }
  if (me) mergeSnapshot(me);
  render();
  if (me) {
    const resumed = await resumeSlackActivation();
    const visit = pendingSlackVisit();
    if (!resumed && !visit?.dismissed && visit?.accountId === me.account.id && (!setupFlow || visit.setupId === setupFlow.id)) showActivationSuccess('slack');
    if (!resumed && setupFlow?.status === 'pending' && sessionStorage.getItem('nc_modal_seen') !== setupCode) {
      sessionStorage.setItem('nc_modal_seen', setupCode);
      openActivation(setupFlow.stage === 'perks' ? catalog.find(p => p.kind !== 'account' && p.enabled)?.id : setupFlow.stage);
    }
    if (params.get('slack') === 'install-cancelled') { tab = 'slack'; render(); notice('Slack installation cancelled. Choose Finish approval when you are ready.'); }
    void connect();
  }
} catch (error) { $('#main').innerHTML = '<h1>We couldn’t open your account.</h1><p class="muted">Please reload this page to try again.</p>'; notice(error.message); }
