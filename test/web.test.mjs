import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Store } from '../web/store.mjs';
import { verifyTelegram, verifyGoogleIdToken } from '../web/auth.mjs';
import { createInitialState, updateState } from '../src/model.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SyncService } = require('../src/sync_service.cjs');

test('cloud accounts are isolated and snapshots reject stale writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lokan-web-'));
  const store = new Store(path.join(directory, 'db.sqlite3'));
  try {
    const alice = store.account({ provider: 'google', subject: 'alice', name: 'Alice' });
    const bob = store.account({ provider: 'telegram', subject: '42', name: 'Bob' });
    assert.equal(store.read(alice.id).state, null);
    const first = store.action(alice.id, { type: 'card.add', title: 'Private task', actor: 'Mallory' });
    assert.equal(first.state.boards[0].cards[0].updatedBy, 'Alice');
    assert.equal(store.read(bob.id).state, null);
    assert.equal(store.read(alice.id).revision, 1);
    const snapshot = { version: 1, boards: first.state.boards };
    assert.deepEqual(store.put(alice.id, 0, snapshot), { conflict: true, revision: 1 });
    assert.deepEqual(store.put(alice.id, 1, snapshot), { revision: 2 });
    const token = randomUUID();
    store.session(token, alice.id, Date.now() + 10000);
    assert.equal(store.user(token).id, alice.id);
    store.deleteSession(token);
    assert.equal(store.user(token), null);
    const device = randomUUID();
    store.startDevice(device, 'ABCDEFGH', Date.now() + 10000);
    assert.equal(store.takeDevice(device), null);
    assert.equal(store.approveDevice('ABCDEFGH', bob.id), true);
    assert.equal(store.takeDevice(device), bob.id);
    assert.equal(store.takeDevice(device), null);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Telegram website and Mini App signatures must be valid and fresh', () => {
  const token = '123456:sample-bot-token', date = String(Math.floor(Date.now() / 1000));
  const login = { id: '12345', first_name: 'Alex', auth_date: date };
  const sorted = Object.entries(login).sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => `${key}=${value}`).join('\n');
  const loginKey = createHash('sha256').update(token).digest();
  const signed = { ...login, hash: createHmac('sha256', loginKey).update(sorted).digest('hex') };
  assert.deepEqual(verifyTelegram(signed, token), { provider: 'telegram', subject: '12345', name: 'Alex' });
  assert.throws(() => verifyTelegram({ ...signed, id: '999' }, token), /signature/);
  assert.throws(() => verifyTelegram(signed, token, 'login', Date.now() + 600000), /Expired/);
  const mini = new URLSearchParams({ auth_date: date, user: JSON.stringify({ id: 987, first_name: 'Nina' }) });
  const miniKey = createHmac('sha256', 'WebAppData').update(token).digest();
  mini.set('hash', createHmac('sha256', miniKey).update([...mini].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n')).digest('hex'));
  assert.equal(verifyTelegram(mini.toString(), token, 'mini').subject, '987');
  mini.append('user', '{}');
  assert.throws(() => verifyTelegram(mini.toString(), token, 'mini'), /Duplicate/);
});

test('Google ID token checks signature, audience, nonce and expiry', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
  const fetcher = async () => ({ ok: true, headers: new Headers({ 'cache-control': 'max-age=60' }), json: async () => ({ keys: [jwk] }) });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const claims = { iss: 'https://accounts.google.com', aud: 'lokan-test', nonce: 'random-nonce', sub: 'stable-user-id', name: 'Alex',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 };
  const makeToken = value => {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    const content = `${header}.${payload}`;
    return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
  };
  const options = { clientId: 'lokan-test', nonce: 'random-nonce', fetcher };
  assert.equal((await verifyGoogleIdToken(makeToken(claims), options)).subject, 'stable-user-id');
  await assert.rejects(verifyGoogleIdToken(makeToken({ ...claims, aud: 'attacker' }), options), /claims/);
  await assert.rejects(verifyGoogleIdToken(makeToken({ ...claims, nonce: 'other' }), options), /claims/);
  await assert.rejects(verifyGoogleIdToken(makeToken({ ...claims, exp: 1 }), options), /claims/);
});

test('desktop cloud connection synchronizes with browser storage and revokes device token', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lokan-cloud-'));
  const port = await new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const found = probe.address().port; probe.close(() => resolve(found)); }); });
  const base = `http://127.0.0.1:${port}`;
  const process = spawn(globalThis.process.execPath, ['web/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...globalThis.process.env, LOKAN_DATA_DIR: directory, PORT: String(port), LOKAN_PUBLIC_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
  const services = [];
  let store;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web server timed out')), 10000);
      process.stdout.on('data', data => { if (String(data).includes('LoKan web listening')) { clearTimeout(timer); resolve(); } });
      process.on('exit', code => { clearTimeout(timer); reject(new Error(`Web server exited ${code}`)); });
    });
    store = new Store(path.join(directory, 'lokan.sqlite3'));
    const account = store.account({ provider: 'google', subject: 'cloud-test', name: 'Cloud owner' });
    const makeService = name => {
      let local = createInitialState(), queue = Promise.resolve();
      const service = new SyncService({ userData: path.join(directory, name), cloudUrl: base, safeStorage: { isEncryptionAvailable: () => false },
        readLocal: async () => ({ state: local }), writeLocal: async next => { local = next; },
        enqueueTask: task => { queue = queue.catch(() => {}).then(task); return queue; }, notify: () => {} });
      services.push(service);
      return { service, get: () => local, set: next => { local = next; } };
    };
    const first = makeService('first');
    const connect = async service => {
      const pending = await service.beginCloud();
      assert.match(pending.code, /^[A-Z2-9]{8}$/);
      assert.equal(store.approveDevice(pending.code, account.id), true);
      assert.equal((await service.pollCloud()).pending, false);
      assert.equal(service.publicStatus().role, 'cloud');
    };
    await connect(first.service);
    assert.equal((await stat(path.join(directory, 'first/cloud-token.txt'))).mode & 0o777, 0o600);
    assert.equal((await readFile(path.join(directory, 'first/sync.json'), 'utf8')).includes(first.service.credentials.token), false);
    const second = makeService('second');
    await connect(second.service);
    assert.equal(first.get().boards[0].id, second.get().boards[0].id);
    store.action(account.id, { type: 'card.add', title: 'From web' });
    await first.service.run();
    assert.equal(first.get().boards[0].cards[0].title, 'From web');
    second.set(updateState(second.get(), { type: 'card.add', title: 'From desktop', newId: 'desktop-card' }));
    await second.service.run(); await first.service.run();
    assert.deepEqual(new Set(first.get().boards[0].cards.map(card => card.title)), new Set(['From web', 'From desktop']));
    const oldToken = first.service.credentials.token;
    await first.service.disconnect();
    assert.equal(store.deviceUser(oldToken), null);
  } finally {
    for (const service of services) clearInterval(service.timer);
    store?.close(); process.kill('SIGTERM');
    await new Promise(resolve => process.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram login, session cookies and browser writes work through HTTP', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lokan-login-'));
  const port = await new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const found = probe.address().port; probe.close(() => resolve(found)); }); });
  const base = `http://127.0.0.1:${port}`, token = '123456:integration-bot';
  const child = spawn(globalThis.process.execPath, ['web/server.mjs'], { cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...globalThis.process.env, LOKAN_DATA_DIR: directory, PORT: String(port), LOKAN_PUBLIC_URL: base,
      TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: 'integration_bot' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Web server timed out')), 10000);
      child.stdout.on('data', data => { if (String(data).includes('LoKan web listening')) { clearTimeout(timer); resolve(); } });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Web server exited ${code}`)); });
    });
    const setupResponse = await fetch(`${base}/auth/telegram/setup`);
    const setup = await setupResponse.json();
    assert.equal(setup.bot, 'integration_bot');
    const tgCookie = setupResponse.headers.get('set-cookie').split(';')[0];
    const data = { id: '12345', first_name: 'Integration', auth_date: String(Math.floor(Date.now() / 1000)) };
    const message = Object.entries(data).sort(([a], [b]) => a < b ? -1 : 1).map(([key, value]) => `${key}=${value}`).join('\n');
    const signature = createHmac('sha256', createHash('sha256').update(token).digest()).update(message).digest('hex');
    const callback = await fetch(`${setup.url}&${new URLSearchParams({ ...data, hash: signature })}`, { headers: { Cookie: tgCookie }, redirect: 'manual' });
    assert.equal(callback.status, 303);
    const session = callback.headers.get('set-cookie').match(/lokan_session=([^;]+)/)?.[1];
    assert.ok(session);
    const me = await fetch(`${base}/api/me`, { headers: { Cookie: `lokan_session=${session}` } });
    assert.equal((await me.json()).name, 'Integration');
    const rejected = await fetch(`${base}/api/action`, { method: 'POST', headers: { Cookie: `lokan_session=${session}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'card.add', title: 'No origin' }) });
    assert.equal(rejected.status, 403);
    const added = await fetch(`${base}/api/action`, { method: 'POST', headers: { Cookie: `lokan_session=${session}`, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'card.add', title: 'Browser task', actor: 'Fake' }) });
    assert.equal(added.status, 200);
    assert.equal((await added.json()).state.boards[0].cards[0].updatedBy, 'Integration');
    const badMini = await fetch(`${base}/auth/telegram/mini`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ initData: 'user=%7B%22id%22%3A999%7D&auth_date=1&hash=00' }) });
    assert.equal(badMini.status, 400);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
