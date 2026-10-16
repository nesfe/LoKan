import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const sameHex = (a, b) => {
  if (!/^[0-9a-f]{64}$/i.test(a || '') || !/^[0-9a-f]{64}$/i.test(b || '')) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
};

export function verifyTelegram(input, botToken, kind = 'login', now = Date.now()) {
  if (!botToken || !['login', 'mini'].includes(kind)) throw new Error('Telegram is not configured');
  const pairs = typeof input === 'string' ? [...new URLSearchParams(input)] : Object.entries(input || {});
  if (!pairs.length || pairs.length > 30 || pairs.some(([key, value]) => typeof value !== 'string' || value.length > 4096 || !/^[a-z_]+$/.test(key))) throw new Error('Invalid Telegram data');
  const data = new Map(pairs);
  if (data.size !== pairs.length) throw new Error('Duplicate Telegram field');
  const received = data.get('hash');
  data.delete('hash');
  if (kind === 'mini') data.delete('signature');
  const message = [...data].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = kind === 'mini'
    ? createHmac('sha256', 'WebAppData').update(botToken).digest()
    : createHash('sha256').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(message).digest('hex');
  if (!sameHex(received, expected)) throw new Error('Invalid Telegram signature');
  const issued = Number(data.get('auth_date'));
  if (!Number.isSafeInteger(issued) || Math.abs(now / 1000 - issued) > 300) throw new Error('Expired Telegram sign-in');
  let user;
  if (kind === 'mini') {
    try { user = JSON.parse(data.get('user') || ''); } catch { throw new Error('Invalid Telegram user'); }
  } else user = { id: data.get('id'), first_name: data.get('first_name'), last_name: data.get('last_name') };
  if (!/^\d{1,20}$/.test(String(user?.id || ''))) throw new Error('Invalid Telegram user');
  return { provider: 'telegram', subject: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 80) || `Telegram ${user.id}` };
}

let keysCache = { until: 0, keys: [] };
export async function verifyGoogleIdToken(token, { clientId, nonce, fetcher = fetch, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 12000) throw new Error('Invalid Google token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid Google token');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { throw new Error('Invalid Google token'); }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported Google token');
  if (now >= keysCache.until || !keysCache.keys.some(key => key.kid === header.kid)) {
    const response = await fetcher('https://www.googleapis.com/oauth2/v3/certs');
    if (!response.ok) throw new Error('Could not verify Google token');
    const body = await response.json();
    if (!Array.isArray(body.keys)) throw new Error('Invalid Google keys');
    const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1] || 300);
    keysCache = { keys: body.keys, until: now + Math.min(Math.max(maxAge, 60), 86400) * 1000 };
  }
  const jwk = keysCache.keys.find(key => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig');
  if (!jwk || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid Google signature');
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== clientId || claims.nonce !== nonce ||
      !Number.isInteger(claims.exp) || claims.exp * 1000 <= now || !Number.isInteger(claims.iat) || claims.iat * 1000 > now + 60000 ||
      typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('Invalid Google claims');
  return { provider: 'google', subject: claims.sub, name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : 'Google user' };
}

export const tokenHash = hash;
