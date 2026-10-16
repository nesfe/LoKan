import { createInitialState, normalizeLink } from '/model.mjs';

let sequence = -1;
let state = createInitialState();
let user = null;
let online = true;
const stateListeners = new Set();
const statusListeners = new Set();
const status = () => ({ role: 'cloud', authMode: 'cloud', status: online ? 'connected' : 'offline', displayName: user?.name || '', provider: user?.provider || '', host: location.hostname, port: Number(location.port) || 443, fingerprint: 'cloud', error: '' });

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (response.status === 401) { location.assign('/'); throw new Error('Sign in required'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
const post = (path, value) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function load() {
  user = await api('/api/me');
  const result = await api('/api/state');
  state = result.state || createInitialState();
  sequence = result.sequence;
  return { state, sequence };
}
async function apply(action) {
  const result = await post('/api/action', action);
  state = result.state;
  sequence = Math.max(sequence, result.sequence);
  return result;
}
async function refresh() {
  try {
    const result = await api(`/api/state?knownRevision=${sequence}`);
    if (!online) { online = true; for (const listener of statusListeners) listener(status()); }
    if (result.state && result.sequence > sequence) {
      state = result.state; sequence = result.sequence;
      for (const listener of stateListeners) listener({ state, sequence });
    }
    return status();
  } catch (error) {
    if (online) { online = false; for (const listener of statusListeners) listener(status()); }
    throw error;
  }
}
async function exportData() {
  await refresh();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `LoKan-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
async function importData() {
  const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.json,application/json';
  const file = await new Promise(resolve => { picker.onchange = () => resolve(picker.files?.[0] || null); picker.oncancel = () => resolve(null); picker.click(); });
  if (!file) return null;
  if (file.size > 12 * 1024 * 1024) throw new Error('File is too large');
  const result = await post('/api/import', JSON.parse(await file.text()));
  state = result.state; sequence = result.sequence;
  return state;
}

window.lokan = Object.freeze({
  isWeb: true, load, apply, export: exportData, import: importData,
  dataPath: async () => 'LoKan Cloud',
  openLink: async value => {
    const url = normalizeLink(value);
    if (url !== value) throw new Error('Invalid link');
    window.open(url, '_blank', 'noopener,noreferrer'); return true;
  },
  syncStatus: async () => { if (!user) user = await api('/api/me'); return status(); },
  syncNow: refresh,
  syncDisconnect: async () => { await post('/auth/logout', {}); location.assign('/'); return { status: 'local' }; },
  onSyncStatus: callback => { statusListeners.add(callback); },
  onSyncState: callback => { stateListeners.add(callback); },
  mcpStatus: async () => ({ enabled: false, running: false, port: 0, url: '' })
});

setInterval(() => { if (document.visibilityState === 'visible' && sequence >= 0) refresh().catch(() => {}); }, 3000);
