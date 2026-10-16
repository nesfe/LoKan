const fs = require('node:fs/promises');
const path = require('node:path');
const { probe, authenticate, installServer, exchange } = require('./sync_ssh.cjs');

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class SyncService {
  constructor({ userData, safeStorage, readLocal, writeLocal, enqueueTask, notify }) {
    Object.assign(this, { userData, safeStorage, readLocal, writeLocal, enqueueTask, notify });
    this.configFile = path.join(userData, 'sync.json');
    this.status = 'local';
    this.error = '';
    this.lastSync = '';
    this.client = null;
    this.credentials = null;
    this.config = null;
    this.running = null;
    this.reconfiguring = false;
    this.timer = null;
    this.debounce = null;
  }

  publicStatus() {
    const { host = '', port = 22, username = '', displayName = '', authMode = 'password', keyPath = '', fingerprint = '' } = this.config || {};
    return { host, port, username, displayName, authMode, keyPath, fingerprint, status: this.status, error: this.error, lastSync: this.lastSync };
  }

  setStatus(status, error = '') {
    this.status = status;
    this.error = error;
    this.notify('sync:status', this.publicStatus());
  }

  canEncrypt() {
    try {
      return this.safeStorage.isEncryptionAvailable() && this.safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  encrypt(value) {
    if (!value || !this.canEncrypt()) return '';
    return this.safeStorage.encryptString(value).toString('base64');
  }

  decrypt(value) {
    if (!value || !this.canEncrypt()) return '';
    try { return this.safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
  }

  async saveConfig() {
    if (!this.config) return;
    const directory = path.dirname(this.configFile);
    await fs.mkdir(directory, { recursive: true });
    const temp = `${this.configFile}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.config), { mode: 0o600 });
    await fs.rename(temp, this.configFile);
  }

  async start() {
    try {
      this.config = JSON.parse(await fs.readFile(this.configFile, 'utf8'));
      const secret = this.decrypt(this.config.encryptedSecret);
      this.credentials = this.config.authMode === 'password' ? (secret ? { password: secret } : null) :
        (this.config.encryptedSecret && !secret ? null : { passphrase: secret });
      this.setStatus(this.credentials ? 'offline' : 'needsAuth');
    } catch (error) {
      if (error.code !== 'ENOENT') this.setStatus('error', 'Could not read sync settings');
    }
    this.timer = setInterval(() => this.run().catch(() => {}), 3000);
    if (this.config && this.credentials) this.run().catch(() => {});
  }

  async probe(options) { return probe(options); }

  async chooseKey(window, dialog) {
    const result = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'SSH private key', extensions: ['pem', 'key', '*'] }] });
    return result.canceled ? '' : result.filePaths[0] || '';
  }

  async configure(options) {
    this.reconfiguring = true;
    try {
      if (this.running) await this.running.catch(() => {});
      const input = {
        host: options.host?.trim(), port: Number(options.port), username: options.username?.trim(),
        displayName: options.displayName?.trim(), authMode: options.authMode, keyPath: options.keyPath || '', fingerprint: options.fingerprint
      };
      if (!input.displayName || input.displayName.length > 80) throw new Error('Enter a team display name (up to 80 characters)');
      const secrets = options.authMode === 'key' ? { passphrase: options.passphrase || '' } : { password: options.password || '' };
      const client = await authenticate({ ...input, ...secrets });
      try { await installServer(client); } catch (error) { client.end(); throw error; }
      this.client?.end();
      this.client = client;
      this.credentials = secrets;
      const previous = this.config;
      const sameServer = previous && ['host', 'port', 'username', 'fingerprint'].every(key => previous[key] === input[key]);
      const secret = input.authMode === 'key' ? secrets.passphrase : secrets.password;
      this.config = {
        ...input, revision: sameServer ? previous.revision : -1,
        base: sameServer ? previous.base : null,
        encryptedSecret: this.encrypt(secret)
      };
      await this.saveConfig();
      this.setStatus('connected');
      this.reconfiguring = false;
      return await this.run();
    } finally { this.reconfiguring = false; }
  }

  async disconnect() {
    this.reconfiguring = true;
    try {
      if (this.running) await this.running.catch(() => {});
      this.config = null;
      this.credentials = null;
      this.client?.end();
      this.client = null;
      clearTimeout(this.debounce);
      try { await fs.unlink(this.configFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.setStatus('local');
      return this.publicStatus();
    } finally { this.reconfiguring = false; }
  }

  changed() {
    if (!this.config) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.run().catch(() => {}), 350);
  }

  async ensureClient() {
    if (this.client) return this.client;
    if (!this.credentials) throw new Error('SSH credentials required');
    const client = await authenticate({ ...this.config, ...this.credentials });
    try { await installServer(client); } catch (error) { client.end(); throw error; }
    this.client = client;
    return client;
  }

  async run() {
    if (this.reconfiguring || !this.config || !this.credentials) return this.publicStatus();
    if (this.running) return this.running;
    this.running = this.enqueueTask(async () => {
      this.setStatus('syncing');
      try {
        await this.syncOnce();
        this.lastSync = new Date().toISOString();
        this.setStatus('connected');
      } catch (error) {
        this.client?.end();
        this.client = null;
        this.setStatus('offline', error.message);
        throw error;
      }
      return this.publicStatus();
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async syncOnce() {
    const { normalizeState } = await import('./model.mjs');
    const { sharedState, mergeShared, isPristineState } = await import('./sync_merge.mjs');
    const client = await this.ensureClient();
    const local = (await this.readLocal()).state;
    const base = this.config.base;
    let revision = this.config.revision ?? -1;
    let current = await exchange(client, { op: 'get', knownRevision: revision });
    for (let attempt = 0; attempt < 6; attempt++) {
      let remote;
      if (Object.hasOwn(current, 'state')) {
        remote = current.state === null ? null : sharedState(normalizeState(current.state));
      } else {
        remote = base;
      }
      if (current.revision > 0 && !remote) throw new Error('Missing sync baseline; reconnect to this server');
      const effectiveBase = current.revision === 0 ? null : base;
      const mine = !effectiveBase && remote && isPristineState(local) ? { version: 1, boards: [] } : sharedState(local);
      const merged = mergeShared(effectiveBase, mine, remote);
      if (!merged.boards.length) throw new Error('No board to synchronize');
      if (!equal(merged, remote)) {
        const put = await exchange(client, { op: 'put', revision: current.revision, state: merged });
        if (put.conflict) {
          current = await exchange(client, { op: 'get', knownRevision: -1 });
          continue;
        }
        revision = put.revision;
      } else {
        revision = current.revision;
      }
      const resolved = normalizeState({ ...local, boards: merged.boards });
      if (!equal(local, resolved)) {
        await this.writeLocal(resolved);
        this.notify('sync:state', resolved);
      }
      this.config.base = merged;
      this.config.revision = revision;
      await this.saveConfig();
      return;
    }
    throw new Error('Too many concurrent edits; retrying soon');
  }
}

module.exports = { SyncService };
