import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sharedState } from '../src/sync_merge.mjs';
import { createInitialState, updateState } from '../src/model.mjs';

const require = createRequire(import.meta.url);
const { Server, utils: { parseKey } } = require('ssh2');
const { probe, authenticate, installServer, exchange, execute } = require('../src/sync_ssh.cjs');
const { SyncService } = require('../src/sync_service.cjs');

test('SSH host pinning, password and key auth, and remote storage work together', { timeout: 60000, skip: process.platform !== 'linux' }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'lokan-ssh-'));
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const userKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const parsedUserKey = parseKey(userKey);
  const keyPath = path.join(home, 'id_rsa');
  await writeFile(keyPath, userKey, { mode: 0o600 });
  const server = new Server({ hostKeys: [hostKey] }, client => {
    let memberId = '';
    client.on('error', () => {}); // A rejected pinned host key closes the test connection.
    client.on('authentication', ctx => {
      if (ctx.username !== 'lokan') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'test-password') return ctx.accept();
      if (ctx.method === 'publickey' && ctx.key.data.equals(parsedUserKey.getPublicSSH()) &&
          (!ctx.signature || parsedUserKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
      if (ctx.method === 'publickey') {
        const file = path.join(home, '.ssh', 'authorized_keys');
        const keyData = ctx.key.data.toString('base64');
        const line = existsSync(file) && readFileSync(file, 'utf8').split('\n').find(value => value.includes(` ${ctx.key.algo} ${keyData} lokan-invite:`));
        const publicKey = line && parseKey(`${ctx.key.algo} ${keyData}`);
        if (publicKey && !(publicKey instanceof Error) && (!ctx.signature || publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) {
          memberId = line.match(/lokan-invite:([0-9a-f-]{36}):/)?.[1] || '';
          return ctx.accept();
        }
      }
      ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const command = memberId ? `python3 "$HOME/.local/share/lokan-sync/server.py" ${memberId}` : info.command;
        const child = spawn('sh', ['-c', command], { env: { ...process.env, HOME: home } });
        stream.on('data', data => child.stdin.write(data));
        stream.on('end', () => child.stdin.end());
        child.stdout.on('data', data => stream.write(data));
        child.stderr.on('data', data => stream.stderr.write(data));
        child.on('close', code => { stream.exit(code); stream.end(); });
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { host: '127.0.0.1', port: server.address().port, username: 'lokan' };
  let passwordClient;
  let keyClient;
  const services = [];
  try {
    const fingerprint = await probe(options);
    assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    await assert.rejects(authenticate({ ...options, authMode: 'password', password: 'test-password', fingerprint: `SHA256:${'A'.repeat(43)}` }));
    passwordClient = await authenticate({ ...options, authMode: 'password', password: 'test-password', fingerprint });
    await installServer(passwordClient);
    await mkdir(path.join(home, '.ssh'), { mode: 0o700 });
    await writeFile(path.join(home, '.ssh', 'authorized_keys'), `${parsedUserKey.type} ${parsedUserKey.getPublicSSH().toString('base64')} existing-owner\n`, { mode: 0o600 });
    const state = sharedState(createInitialState());
    assert.deepEqual(await exchange(passwordClient, { op: 'get', knownRevision: -1 }), { revision: 0, state: null });
    assert.deepEqual(await exchange(passwordClient, { op: 'put', revision: 0, state }), { revision: 1 });
    keyClient = await authenticate({ ...options, authMode: 'key', keyPath, fingerprint });
    const response = await exchange(keyClient, { op: 'get', knownRevision: -1 });
    assert.equal(response.revision, 1);
    assert.equal(response.state.boards.length, 1);

    const makeService = async (name, connect = true, safeStorage = { isEncryptionAvailable: () => false }) => {
      let local = createInitialState();
      let queue = Promise.resolve();
      const userData = path.join(home, name);
      const service = new SyncService({
        userData, safeStorage,
        readLocal: async () => ({ state: local }),
        writeLocal: async state => { local = state; },
        enqueueTask: action => { queue = queue.catch(() => {}).then(action); return queue; },
        notify: () => {}
      });
      services.push(service);
      if (connect) {
        await service.configure({ ...options, displayName: name, authMode: 'password', password: 'test-password', fingerprint });
        await service.run();
      }
      return { service, get: () => local, set: state => { local = state; } };
    };
    const first = await makeService('first');
    const second = await makeService('second');
    const settings = await readFile(path.join(home, 'first', 'sync.json'), 'utf8');
    assert.equal(settings.includes('test-password'), false);
    assert.equal((await stat(path.join(home, '.local/share/lokan-sync/boards.sqlite3'))).mode & 0o777, 0o600);
    assert.equal(first.get().boards[0].id, second.get().boards[0].id);
    const columnId = first.get().boards[0].columns[0].id;
    first.set(updateState(first.get(), { type: 'card.add', newId: 'team-a', columnId, title: 'From A' }));
    second.set(updateState(second.get(), { type: 'card.add', newId: 'team-b', columnId, title: 'From B' }));
    await first.service.run();
    await second.service.run();
    await first.service.run();
    const cards = first.get().boards[0].cards;
    assert.deepEqual(new Set(cards.map(card => card.title)), new Set(['From A', 'From B']));
    assert.deepEqual(new Set(cards.map(card => card.number)), new Set([1, 2]));
    const invitation = await first.service.createInvite('Colleague');
    assert.match(invitation, /^LoKanInvite:/);
    assert.equal(Buffer.from(invitation.slice(12), 'base64url').toString('utf8').includes('test-password'), false);
    assert.deepEqual((await first.service.listInvites()).map(item => item.name), ['Colleague']);
    const member = await makeService('temporary', false);
    await member.service.joinInvite(invitation, 'Colleague');
    assert.equal(member.service.publicStatus().role, 'member');
    assert.equal(member.get().boards[0].id, first.get().boards[0].id);
    const memberConfig = await readFile(path.join(home, 'temporary', 'sync.json'), 'utf8');
    assert.equal(memberConfig.includes('PRIVATE KEY'), false);
    assert.equal((await stat(path.join(home, 'temporary', `invite-${member.service.config.inviteId}.pem`))).mode & 0o777, 0o600);
    const authorizedKeys = await readFile(path.join(home, '.ssh', 'authorized_keys'), 'utf8');
    assert.match(authorizedKeys, /restrict,command="python3 \$HOME\/\.local\/share\/lokan-sync\/server\.py /);
    assert.equal((await stat(path.join(home, '.ssh', 'authorized_keys'))).mode & 0o777, 0o600);
    let restartedLocal = member.get();
    let restartedQueue = Promise.resolve();
    const restarted = new SyncService({ userData: path.join(home, 'temporary'), safeStorage: { isEncryptionAvailable: () => false },
      readLocal: async () => ({ state: restartedLocal }), writeLocal: async state => { restartedLocal = state; },
      enqueueTask: action => { restartedQueue = restartedQueue.catch(() => {}).then(action); return restartedQueue; }, notify: () => {} });
    services.push(restarted);
    await restarted.start();
    assert.equal(restarted.publicStatus().role, 'member');
    await restarted.run();
    await assert.rejects(execute(member.service.client, 'printf unrestricted'));
    await first.service.revokeInvite(member.service.config.inviteId);
    await assert.rejects(member.service.run(), /Invite revoked/);
    assert.deepEqual(await first.service.listInvites(), []);
    assert.match(await readFile(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), /existing-owner/);
    const safeStorage = {
      isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test',
      encryptString: value => Buffer.from(`encrypted:${value}`),
      decryptString: value => value.toString().slice('encrypted:'.length)
    };
    const secureMember = await makeService('encrypted', false, safeStorage);
    await secureMember.service.joinInvite(await first.service.createInvite('Secure colleague'), 'Secure colleague');
    const secureConfig = await readFile(path.join(home, 'encrypted', 'sync.json'), 'utf8');
    assert.equal(secureConfig.includes('PRIVATE KEY'), false);
    assert.equal(secureMember.service.config.keyPath, '');
    const restartedSecure = new SyncService({ userData: path.join(home, 'encrypted'), safeStorage,
      readLocal: async () => ({ state: secureMember.get() }), writeLocal: async () => {},
      enqueueTask: action => Promise.resolve().then(action), notify: () => {} });
    services.push(restartedSecure);
    await restartedSecure.start();
    assert.equal(restartedSecure.publicStatus().role, 'member');
    await restartedSecure.run();
  } finally {
    for (const service of services) { clearInterval(service.timer); service.client?.end(); }
    passwordClient?.end(); keyClient?.end();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});
