const { Client } = require('ssh2');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SERVER_COMMAND = 'python3 "$HOME/.local/share/lokan-sync/server.py"';
const MAX_OUTPUT = 16 * 1024 * 1024;

const fingerprint = key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

function validateConnection(config) {
  if (!config || typeof config.host !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(config.host)) throw new Error('Invalid server address');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid SSH port');
  if (typeof config.username !== 'string' || !/^[a-z_][a-z0-9_.-]{0,31}$/.test(config.username)) throw new Error('Invalid SSH username');
}

function connect(config, verify) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };
    client.once('ready', () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });
    client.once('error', fail);
    try {
      client.connect({
        host: config.host, port: config.port, username: config.username,
        readyTimeout: 12000, keepaliveInterval: 20000, keepaliveCountMax: 3,
        hostVerifier: key => verify(fingerprint(key)),
        ...(config.authMode === 'key'
          ? { privateKey: config.privateKey, passphrase: config.passphrase || undefined }
          : { password: config.password })
      });
    } catch (error) { fail(error); }
  });
}

async function probe(config) {
  validateConnection(config);
  let found;
  try {
    const client = await connect({ ...config, authMode: 'password', password: '' }, value => { found = value; return false; });
    client.end();
  } catch (error) {
    if (!found) throw error;
  }
  if (!found) throw new Error('Could not read SSH host key');
  return found;
}

async function authenticate(config) {
  validateConnection(config);
  if (typeof config.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(config.fingerprint)) throw new Error('Verify the server fingerprint first');
  if (config.authMode === 'key') {
    if (typeof config.keyPath !== 'string' || !path.isAbsolute(config.keyPath)) throw new Error('Select a private key file');
    const stat = await fs.stat(config.keyPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid private key file');
    config = { ...config, privateKey: await fs.readFile(config.keyPath) };
  } else if (config.authMode !== 'password' || typeof config.password !== 'string' || !config.password) {
    throw new Error('Enter an SSH password');
  }
  return connect(config, value => value === config.fingerprint);
}

function execute(client, command, input = '') {
  return new Promise((resolve, reject) => {
    client.exec(command, { pty: false }, (error, stream) => {
      if (error) return reject(error);
      let output = '';
      let errors = '';
      let ended = false;
      const timer = setTimeout(() => {
        if (!ended) { ended = true; stream.close(); reject(new Error('SSH command timed out')); }
      }, 20000);
      stream.on('data', data => {
        output += data.toString('utf8');
        if (output.length > MAX_OUTPUT && !ended) { ended = true; stream.close(); clearTimeout(timer); reject(new Error('Server response too large')); }
      });
      stream.stderr.on('data', data => { errors = (errors + data.toString('utf8')).slice(-4096); });
      stream.on('close', code => {
        clearTimeout(timer);
        if (ended) return;
        ended = true;
        if (code === 0) resolve(output);
        else reject(new Error(errors.trim() || `SSH command failed (${code})`));
      });
      stream.end(input);
    });
  });
}

async function installServer(client) {
  const script = await fs.readFile(path.join(__dirname, 'sync_server.py'));
  const encoded = script.toString('base64');
  const source = `import base64,pathlib,os; p=pathlib.Path.home()/".local"/"share"/"lokan-sync"; p.mkdir(parents=True,exist_ok=True,mode=0o700); p.chmod(0o700); f=p/"server.py"; t=p/"server.py.tmp"; t.write_bytes(base64.b64decode("${encoded}")); t.chmod(0o600); t.replace(f)`;
  await execute(client, `python3 -c '${source}'`);
}

async function exchange(client, request) {
  const response = await execute(client, SERVER_COMMAND, JSON.stringify(request));
  let parsed;
  try { parsed = JSON.parse(response); } catch { throw new Error('Invalid sync server response'); }
  if (!parsed || !Number.isInteger(parsed.revision) || parsed.revision < 0) throw new Error('Invalid sync server response');
  return parsed;
}

module.exports = { probe, authenticate, execute, installServer, exchange, fingerprint, validateConnection };
