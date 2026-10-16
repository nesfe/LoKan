import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createInitialState, normalizeState, updateState } from '../src/model.mjs';
import { tokenHash } from './auth.mjs';

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, UNIQUE(provider, subject));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (hash TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, account_id TEXT, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_tokens (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }
  transaction(task) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = task(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  account(identity) {
    return this.transaction(() => {
      let row = this.db.prepare('SELECT * FROM accounts WHERE provider = ? AND subject = ?').get(identity.provider, identity.subject);
      if (!row) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO accounts (id, provider, subject, name, state) VALUES (?, ?, ?, ?, ?)').run(id, identity.provider, identity.subject, identity.name, 'null');
        row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      } else if (row.name !== identity.name) this.db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(identity.name, row.id);
      return { id: row.id, provider: row.provider, name: identity.name };
    });
  }
  session(token, accountId, expires) { this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash(token), accountId, expires); }
  user(token, now = Date.now()) {
    if (!token) return null;
    return this.db.prepare('SELECT a.id, a.provider, a.name FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.hash = ? AND s.expires > ?').get(tokenHash(token), now) || null;
  }
  deleteSession(token) { if (token) this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(tokenHash(token)); }
  saveOAuth(state, nonce, verifier, expires) { this.db.prepare('INSERT INTO oauth_states VALUES (?, ?, ?, ?)').run(tokenHash(state), nonce, verifier, expires); }
  takeOAuth(state, now = Date.now()) {
    return this.transaction(() => {
      const key = tokenHash(state);
      const row = this.db.prepare('SELECT * FROM oauth_states WHERE hash = ? AND expires > ?').get(key, now);
      this.db.prepare('DELETE FROM oauth_states WHERE hash = ?').run(key);
      return row;
    });
  }
  read(accountId, knownRevision = -1) {
    const row = this.db.prepare('SELECT state, revision FROM accounts WHERE id = ?').get(accountId);
    if (!row) throw new Error('Account not found');
    return { revision: row.revision, ...(row.revision !== knownRevision ? { state: JSON.parse(row.state) } : {}) };
  }
  action(accountId, action) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state, revision, name FROM accounts WHERE id = ?').get(accountId);
      if (!row) throw new Error('Account not found');
      const saved = JSON.parse(row.state);
      const state = saved ? normalizeState(saved) : createInitialState();
      const next = normalizeState(updateState(state, { ...action, actor: row.name }));
      const encoded = JSON.stringify(next);
      if (Buffer.byteLength(encoded) > 12 * 1024 * 1024) throw new Error('Board data is too large');
      const revision = row.revision + 1;
      this.db.prepare('UPDATE accounts SET state = ?, revision = ? WHERE id = ?').run(encoded, revision, accountId);
      return { state: next, sequence: revision };
    });
  }
  put(accountId, revision, shared) {
    if (!Number.isInteger(revision) || revision < 0 || !shared || shared.version !== 1 || !Array.isArray(shared.boards)) throw new Error('Invalid snapshot');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT state, revision FROM accounts WHERE id = ?').get(accountId);
      if (!row) throw new Error('Account not found');
      if (revision !== row.revision) return { conflict: true, revision: row.revision };
      const current = JSON.parse(row.state) || createInitialState();
      const state = normalizeState({ ...current, boards: shared.boards });
      const encoded = JSON.stringify(state);
      if (Buffer.byteLength(encoded) > 12 * 1024 * 1024) throw new Error('Board data is too large');
      this.db.prepare('UPDATE accounts SET state = ?, revision = ? WHERE id = ?').run(encoded, revision + 1, accountId);
      return { revision: revision + 1 };
    });
  }
  replace(accountId, raw) {
    const state = normalizeState(raw);
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > 12 * 1024 * 1024) throw new Error('Board data is too large');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT revision FROM accounts WHERE id = ?').get(accountId);
      if (!row) throw new Error('Account not found');
      const revision = row.revision + 1;
      this.db.prepare('UPDATE accounts SET state = ?, revision = ? WHERE id = ?').run(encoded, revision, accountId);
      return { state, sequence: revision };
    });
  }
  startDevice(token, code, expires) { this.db.prepare('INSERT INTO devices (hash, code, expires) VALUES (?, ?, ?)').run(tokenHash(token), code, expires); }
  approveDevice(code, accountId, now = Date.now()) {
    const result = this.db.prepare('UPDATE devices SET account_id = ? WHERE code = ? AND expires > ? AND account_id IS NULL').run(accountId, code, now);
    return result.changes === 1;
  }
  takeDevice(token, now = Date.now()) {
    return this.transaction(() => {
      const key = tokenHash(token);
      const row = this.db.prepare('SELECT account_id FROM devices WHERE hash = ? AND expires > ?').get(key, now);
      if (row?.account_id) this.db.prepare('DELETE FROM devices WHERE hash = ?').run(key);
      return row?.account_id || null;
    });
  }
  createDeviceToken(token, accountId, expires) { this.db.prepare('INSERT INTO device_tokens VALUES (?, ?, ?)').run(tokenHash(token), accountId, expires); }
  deviceUser(token, now = Date.now()) {
    if (!token) return null;
    return this.db.prepare('SELECT a.id, a.provider, a.name FROM device_tokens d JOIN accounts a ON a.id = d.account_id WHERE d.hash = ? AND d.expires > ?').get(tokenHash(token), now) || null;
  }
  revokeDeviceToken(token) { if (token) this.db.prepare('DELETE FROM device_tokens WHERE hash = ?').run(tokenHash(token)); }
  purge(now = Date.now()) {
    for (const table of ['sessions', 'oauth_states', 'devices', 'device_tokens']) this.db.prepare(`DELETE FROM ${table} WHERE expires <= ?`).run(now);
  }
}
