function validateCloudUrl(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid cloud address');
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid cloud address'); }
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an HTTPS cloud address');
  return url.origin;
}

async function request(base, route, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json', Origin: base };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  if (raw.length > 16 * 1024 * 1024) throw new Error('Cloud response too large');
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('Invalid cloud response'); }
  if (!response.ok && response.status !== 202) {
    const error = new Error(result.error || `Cloud HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function beginDevice(base) {
  const result = await request(base, '/api/device/start', { method: 'POST', body: {} });
  if (!/^[A-Z2-9]{8}$/.test(result.code || '') || !/^[A-Za-z0-9_-]{40,100}$/.test(result.deviceToken || '') ||
      result.verificationUrl !== `${base}/device?code=${result.code}`) throw new Error('Invalid cloud device response');
  return result;
}
async function pollDevice(base, deviceToken) { return request(base, '/api/device/poll', { method: 'POST', body: { deviceToken } }); }
async function cloudUser(base, token) { return request(base, '/api/me', { token }); }
async function cloudExchange(base, token, payload) {
  if (payload.op === 'get') return request(base, `/api/snapshot?knownRevision=${payload.knownRevision}`, { token });
  if (payload.op === 'put') return request(base, '/api/snapshot', { method: 'POST', body: { revision: payload.revision, state: payload.state }, token });
  throw new Error('Invalid cloud sync operation');
}
async function revokeCloudToken(base, token) { return request(base, '/api/device/revoke', { method: 'POST', body: {}, token }); }

module.exports = { validateCloudUrl, beginDevice, pollDevice, cloudUser, cloudExchange, revokeCloudToken };
