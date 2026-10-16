const fs = require('node:fs/promises');
const path = require('node:path');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { utils: { parseKey } } = require('ssh2');
const { probe, authenticate, installServer, exchange, manageInvites } = require('./sync_ssh.cjs');

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
    return { host, port, username, displayName, authMode, keyPath: authMode === 'invite' ? '' : keyPath, fingerprint,
      role: authMode === 'invite' ? 'member' : this.config ? 'owner' : '', status: this.status, error: this.error, lastSync: this.lastSync };
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
      if (this.config.authMode === 'invite') {
        let privateKey = secret;
        if (!privateKey && this.config.keyPath) {
          try { privateKey = await fs.readFile(this.config.keyPath, 'utf8'); } catch { /* Key missing: ask to rejoin. */ }
        }
        this.credentials = privateKey ? { privateKey } : null;
      } else {
        this.credentials = this.config.authMode === 'password' ? (secret ? { password: secret } : null) :
          (this.config.encryptedSecret && !secret ? null : { passphrase: secret });
      }
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
      if (!['password', 'key'].includes(options.authMode)) throw new Error('Choose password or SSH key');
      const input = {
        host: options.host?.trim(), port: Number(options.port), username: options.username?.trim(),
        displayName: options.displayName?.trim(), authMode: options.authMode, keyPath: options.keyPath || '', fingerprint: options.fingerprint
      };
      if (input.username === 'root') throw new Error('Use a non-root SSH account for LoKan');
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
        ...input, role: 'owner', revision: sameServer ? previous.revision : -1,
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
      const previous = this.config;
      this.config = null;
      this.credentials = null;
      this.client?.end();
      this.client = null;
      clearTimeout(this.debounce);
      try { await fs.unlink(this.configFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous?.authMode === 'invite' && previous.keyPath?.startsWith(path.join(this.userData, 'invite-'))) {
        await fs.unlink(previous.keyPath).catch(() => {});
      }
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
    if (this.config.authMode !== 'invite') {
      try { await installServer(client); } catch (error) { client.end(); throw error; }
    }
    this.client = client;
    return client;
  }

  async listInvites() {
    if (!this.config || this.config.authMode === 'invite') throw new Error('Only the server owner can manage invitations');
    return manageInvites(await this.ensureClient(), { op: 'list' });
  }

  async createInvite(name) {
    const displayName = typeof name === 'string' ? name.trim() : '';
    if (!displayName || displayName.length > 80) throw new Error('Enter a name for this invitation');
    if (!this.config || this.config.authMode === 'invite') throw new Error('Only the server owner can invite people');
    if (this.config.username === 'root') throw new Error('Invitations require a non-root SSH account');
    const client = await this.ensureClient();
    await installServer(client);
    const inviteId = randomUUID();
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privatePem = privateKey.export({ type: 'sec1', format: 'pem' });
    const parsed = parseKey(privatePem);
    if (parsed instanceof Error) throw parsed;
    await manageInvites(client, { op: 'add', id: inviteId, name: displayName, publicKey: parsed.getPublicSSH().toString('base64') });
    let restricted;
    try {
      restricted = await authenticate({ ...this.config, authMode: 'invite', privateKey: privatePem });
      await exchange(restricted, { op: 'get', knownRevision: -1 });
    } catch (error) {
      await manageInvites(client, { op: 'remove', id: inviteId }).catch(() => {});
      throw new Error(`Could not verify the invitation key: ${error.message}`);
    } finally { restricted?.end(); }
    const payload = { version: 1, id: inviteId, host: this.config.host, port: this.config.port,
      username: this.config.username, fingerprint: this.config.fingerprint, privateKey: privatePem };
    return `LoKanInvite:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  }

  async revokeInvite(inviteId) {
    if (!this.config || this.config.authMode === 'invite') throw new Error('Only the server owner can revoke access');
    return manageInvites(await this.ensureClient(), { op: 'remove', id: inviteId });
  }

  async joinInvite(code, displayName) {
    if (this.config) throw new Error('Disconnect from the current server first');
    const name = typeof displayName === 'string' ? displayName.trim() : '';
    if (!name || name.length > 80) throw new Error('Enter your name');
    if (typeof code !== 'string' || !code.startsWith('LoKanInvite:') || code.length > 10000) throw new Error('Invalid invitation code');
    let invite;
    try { invite = JSON.parse(Buffer.from(code.slice(12), 'base64url').toString('utf8')); } catch { throw new Error('Invalid invitation code'); }
    if (!invite || invite.version !== 1 || !/^[0-9a-f-]{36}$/.test(invite.id) || typeof invite.privateKey !== 'string' ||
        typeof invite.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(invite.fingerprint)) throw new Error('Invalid invitation code');
    const input = { host: invite.host, port: invite.port, username: invite.username, fingerprint: invite.fingerprint,
      displayName: name, authMode: 'invite', role: 'member', inviteId: invite.id };
    const client = await authenticate({ ...input, privateKey: invite.privateKey });
    try { await exchange(client, { op: 'get', knownRevision: -1 }); }
    catch (error) { client.end(); throw error; }
    const keyPath = this.canEncrypt() ? '' : path.join(this.userData, `invite-${invite.id}.pem`);
    if (keyPath) {
      await fs.mkdir(this.userData, { recursive: true });
      await fs.writeFile(keyPath, invite.privateKey, { mode: 0o600 });
      await fs.chmod(keyPath, 0o600).catch(() => {});
    }
    this.client = client;
    this.credentials = { privateKey: invite.privateKey };
    this.config = { ...input, keyPath, encryptedSecret: this.encrypt(invite.privateKey), revision: -1, base: null };
    await this.saveConfig();
    this.setStatus('connected');
    return this.run();
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
