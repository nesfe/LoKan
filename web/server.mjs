import { createServer } from 'node:http';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { verifyGoogleIdToken, verifyTelegram } from './auth.mjs';
import { normalizeState, createInitialState } from '../src/model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const random = size => randomBytes(size).toString('base64url');
const origin = new URL(process.env.LOKAN_PUBLIC_URL || 'http://127.0.0.1:8787');
if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('LOKAN_PUBLIC_URL must use HTTPS');
if (origin.pathname !== '/' || origin.search || origin.hash) throw new Error('LOKAN_PUBLIC_URL must be an origin');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const dataDir = path.resolve(process.env.LOKAN_DATA_DIR || path.join(root, '.web-data'));
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await chmod(dataDir, 0o700);
const databaseFile = path.join(dataDir, 'lokan.sqlite3');
const store = new Store(databaseFile);
await chmod(databaseFile, 0o600);
const googleId = process.env.GOOGLE_CLIENT_ID || '';
const googleSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const telegramBot = process.env.TELEGRAM_BOT_USERNAME || '';
if ((!googleId || !googleSecret) && (!telegramToken || !telegramBot)) console.warn('No sign-in provider configured; set Google or Telegram credentials.');
const secure = origin.protocol === 'https:' ? '; Secure' : '';
const now = () => Date.now();
const limits = new Map();
function rate(key, count, windowMs) {
  const prior = limits.get(key);
  const current = prior && prior.until > now() ? prior : { used: 0, until: now() + windowMs };
  current.used++;
  limits.set(key, current);
  if (current.used > count) throw Object.assign(new Error('Too many attempts; try again later'), { status: 429 });
}
setInterval(() => { store.purge(); for (const [key, value] of limits) if (value.until < now()) limits.delete(key); }, 3600000).unref();

const cookies = request => Object.fromEntries((request.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key));
const cookie = (name, value, maxAge, httpOnly = true) => `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}${secure}`;
const setCookie = (response, ...values) => response.setHeader('Set-Cookie', values);
const sessionUser = request => store.user(cookies(request).lokan_session);
const deviceUser = request => {
  const bearer = /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(request.headers.authorization || '');
  return bearer ? store.deviceUser(bearer[1]) : null;
};
const json = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
};
const redirect = (response, where) => { response.writeHead(303, { Location: where, 'Cache-Control': 'no-store' }); response.end(); };
const fail = (response, status, message) => json(response, status, { error: message });
const requireOrigin = request => {
  if (request.headers.origin !== origin.origin) throw Object.assign(new Error('Invalid request origin'), { status: 403 });
};
async function body(request, limit = 65536) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
function signIn(response, identity, request) {
  const account = store.account(identity);
  const token = random(32);
  store.session(token, account.id, now() + 30 * 86400000);
  const next = cookies(request).lokan_device ? '/device' : '/';
  setCookie(response, cookie('lokan_session', token, 30 * 86400), cookie('lokan_oauth', '', 0), cookie('lokan_tg', '', 0));
  redirect(response, next);
}
const staticFiles = new Map([
  ['/renderer.mjs', ['src/renderer.mjs', 'text/javascript']], ['/model.mjs', ['src/model.mjs', 'text/javascript']],
  ['/i18n.mjs', ['src/i18n.mjs', 'text/javascript']], ['/style.css', ['src/style.css', 'text/css']],
  ['/web-bridge.mjs', ['web/bridge.mjs', 'text/javascript']], ['/login.mjs', ['web/login.mjs', 'text/javascript']],
  ['/device.mjs', ['web/device.mjs', 'text/javascript']], ['/mobile.css', ['web/mobile.css', 'text/css']],
  ['/login.css', ['web/login.css', 'text/css']],
  ['/assets/icon.svg', ['assets/icon.svg', 'image/svg+xml']], ['/assets/icon.png', ['assets/icon.png', 'image/png']]
]);
async function serveFile(response, filename, type, noStore = false) {
  const content = await readFile(path.join(root, filename));
  response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': noStore ? 'no-store' : 'public, max-age=3600' });
  response.end(content);
}
async function serveBoard(response) {
  let content = await readFile(path.join(root, 'src/index.html'), 'utf8');
  content = content.replace(/connect-src 'none'/, "connect-src 'self'")
    .replace(/\.\.\/assets\//g, '/assets/')
    .replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css"><link rel="stylesheet" href="/mobile.css">')
    .replace('<script type="module" src="renderer.mjs"></script>', '<script type="module" src="/web-bridge.mjs"></script><script type="module" src="renderer.mjs"></script>');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(content);
}

const server = createServer((request, response) => { (async () => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: https://telegram.org; connect-src 'self'; frame-src https://oauth.telegram.org; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  const url = new URL(request.url || '/', origin);
  if (url.origin !== origin.origin) return fail(response, 400, 'Invalid URL');
  const method = request.method || 'GET';
  const pathname = url.pathname;
  const user = sessionUser(request);
  const apiUser = user || deviceUser(request);
  if (method === 'GET' && staticFiles.has(pathname)) {
    const [file, type] = staticFiles.get(pathname); return serveFile(response, file, type);
  }
  if (method === 'GET' && pathname === '/') return user ? serveBoard(response) : serveFile(response, 'web/login.html', 'text/html', true);
  if (method === 'GET' && pathname === '/api/config') return json(response, 200, { google: Boolean(googleId && googleSecret), telegram: Boolean(telegramToken && telegramBot), bot: telegramBot });
  if (method === 'GET' && pathname === '/api/me') return apiUser ? json(response, 200, apiUser) : fail(response, 401, 'Sign in required');
  if (method === 'GET' && pathname === '/auth/google/start') {
    if (!googleId || !googleSecret) return fail(response, 503, 'Google sign-in is not configured');
    const state = random(32), nonce = random(32), verifier = random(32);
    store.saveOAuth(state, nonce, verifier, now() + 600000);
    setCookie(response, cookie('lokan_oauth', state, 600));
    const query = new URLSearchParams({ client_id: googleId, redirect_uri: `${origin.origin}/auth/google/callback`, response_type: 'code', scope: 'openid profile email', state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return redirect(response, `https://accounts.google.com/o/oauth2/v2/auth?${query}`);
  }
  if (method === 'GET' && pathname === '/auth/google/callback') {
    const state = url.searchParams.get('state') || '';
    if (!state || state !== cookies(request).lokan_oauth || !url.searchParams.get('code')) return fail(response, 403, 'Invalid sign-in attempt');
    const challenge = store.takeOAuth(state);
    if (!challenge) return fail(response, 403, 'Sign-in expired');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: googleId, client_secret: googleSecret,
        redirect_uri: `${origin.origin}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: challenge.verifier }) });
    if (!tokenResponse.ok) return fail(response, 401, 'Google sign-in failed');
    const tokens = await tokenResponse.json();
    const identity = await verifyGoogleIdToken(tokens.id_token, { clientId: googleId, nonce: challenge.nonce });
    return signIn(response, identity, request);
  }
  if (method === 'GET' && pathname === '/auth/telegram/setup') {
    if (!telegramToken || !telegramBot) return fail(response, 503, 'Telegram sign-in is not configured');
    const state = random(24);
    setCookie(response, cookie('lokan_tg', state, 600));
    return json(response, 200, { state, bot: telegramBot, url: `${origin.origin}/auth/telegram/callback?state=${state}` });
  }
  if (method === 'GET' && pathname === '/auth/telegram/callback') {
    const state = url.searchParams.get('state') || '';
    if (!state || state !== cookies(request).lokan_tg) return fail(response, 403, 'Invalid sign-in attempt');
    const values = new URLSearchParams(url.searchParams);
    values.delete('state');
    return signIn(response, verifyTelegram(values.toString(), telegramToken), request);
  }
  if (method === 'POST' && pathname === '/auth/telegram/mini') {
    requireOrigin(request);
    const payload = await body(request, 12000);
    const identity = verifyTelegram(payload.initData, telegramToken, 'mini');
    const account = store.account(identity), token = random(32);
    store.session(token, account.id, now() + 30 * 86400000);
    setCookie(response, cookie('lokan_session', token, 30 * 86400));
    return json(response, 200, { ok: true, next: cookies(request).lokan_device ? '/device' : '/' });
  }
  if (method === 'POST' && pathname === '/auth/logout') {
    requireOrigin(request); store.deleteSession(cookies(request).lokan_session);
    setCookie(response, cookie('lokan_session', '', 0)); return json(response, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/device') {
    const code = url.searchParams.get('code');
    if (code) {
      if (!/^[A-Z2-9]{8}$/.test(code)) return fail(response, 400, 'Invalid device code');
      setCookie(response, cookie('lokan_device', code, 600));
      return redirect(response, '/device');
    }
    if (!user) return redirect(response, '/');
    return serveFile(response, 'web/device.html', 'text/html', true);
  }
  if (method === 'GET' && pathname === '/api/device/info') return user ? json(response, 200, { code: cookies(request).lokan_device || '' }) : fail(response, 401, 'Sign in required');
  if (method === 'POST' && pathname === '/api/device/approve') {
    requireOrigin(request);
    if (!user || !cookies(request).lokan_device) return fail(response, 401, 'Sign in required');
    rate(`approve:${user.id}`, 10, 600000);
    if (!store.approveDevice(cookies(request).lokan_device, user.id)) return fail(response, 400, 'Device code expired');
    setCookie(response, cookie('lokan_device', '', 0)); return json(response, 200, { ok: true });
  }
  if (method === 'POST' && pathname === '/api/device/start') {
    requireOrigin(request);
    rate('device-start', 100, 60000);
    const token = random(32), alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = [...randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join('');
    store.startDevice(token, code, now() + 600000);
    return json(response, 200, { deviceToken: token, code, verificationUrl: `${origin.origin}/device?code=${code}`, expiresIn: 600 });
  }
  if (method === 'POST' && pathname === '/api/device/poll') {
    requireOrigin(request);
    const payload = await body(request);
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(payload.deviceToken || '')) return fail(response, 400, 'Invalid device token');
    const accountId = store.takeDevice(payload.deviceToken);
    if (!accountId) return json(response, 202, { pending: true });
    const token = random(32);
    store.createDeviceToken(token, accountId, now() + 90 * 86400000);
    return json(response, 200, { token });
  }
  if (method === 'POST' && pathname === '/api/device/revoke') {
    if (!deviceUser(request)) return fail(response, 401, 'Sign in required');
    store.revokeDeviceToken((request.headers.authorization || '').slice(7));
    return json(response, 200, { ok: true });
  }
  if (pathname.startsWith('/api/')) {
    if (!apiUser) return fail(response, 401, 'Sign in required');
    if (method === 'GET' && pathname === '/api/state') {
      const known = Number(url.searchParams.get('knownRevision') || -1);
      const result = store.read(apiUser.id, Number.isInteger(known) ? known : -1);
      return json(response, 200, { ...result, sequence: result.revision, ...(result.state === null ? { state: createInitialState() } : {}) });
    }
    if (method === 'POST' && pathname === '/api/action') {
      if (!user) return fail(response, 403, 'Browser session required');
      requireOrigin(request);
      const action = await body(request);
      if (!action || typeof action !== 'object' || Array.isArray(action) || JSON.stringify(action).length > 50000) return fail(response, 400, 'Invalid action');
      return json(response, 200, store.action(user.id, { ...action, actor: user.name }));
    }
    if (method === 'POST' && pathname === '/api/import') {
      if (!user) return fail(response, 403, 'Browser session required');
      requireOrigin(request);
      return json(response, 200, store.replace(user.id, await body(request, 12 * 1024 * 1024 + 1024)));
    }
    if (method === 'GET' && pathname === '/api/snapshot') {
      const known = Number(url.searchParams.get('knownRevision') || -1);
      const result = store.read(apiUser.id, Number.isInteger(known) ? known : -1);
      return json(response, 200, { revision: result.revision, ...(Object.hasOwn(result, 'state') ? { state: result.state ? { version: 1, boards: result.state.boards } : null } : {}) });
    }
    if (method === 'POST' && pathname === '/api/snapshot') {
      if (user) requireOrigin(request);
      const payload = await body(request, 12 * 1024 * 1024 + 1024);
      return json(response, 200, store.put(apiUser.id, payload.revision, payload.state));
    }
  }
  return fail(response, 404, 'Not found');
})().catch(error => {
  if (response.headersSent) return response.end();
  const status = error.status || 400;
  if (status >= 500) console.error(error);
  fail(response, status, status === 400 && /token|signature|claim/i.test(error.message) ? 'Invalid sign-in' : error.message);
}); });
server.listen(port, host, () => console.log(`LoKan web listening on ${host}:${port} for ${origin.origin}`));
process.on('SIGTERM', () => { server.close(); store.close(); });
