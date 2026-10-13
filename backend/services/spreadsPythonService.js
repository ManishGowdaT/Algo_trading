const config = require('../config');

const ENDPOINTS = Object.freeze({
  expiries: { path: '/spreads/nifty/expiries', method: 'GET' },
  scan: { path: '/spreads/nifty/scan', method: 'POST' },
  multiScan: { path: '/spreads/scan', method: 'POST' },
  trending: { path: '/spreads/trending', method: 'GET', discovery: true },
  discover: { path: '/spreads/discover', method: 'POST', discovery: true },
});

function normalizeSymbol(symbol) {
  const value = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9&._-]{1,30}$/.test(value)) {
    throw Object.assign(new Error('Enter a valid NSE underlying symbol.'), { status: 422 });
  }
  return value;
}

function createSpreadsPythonService({
  baseUrl = config.API.ANGEL_ONE_API_BASE,
  internalKey = config.API.INTERNAL_SERVICE_KEY,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.SPREADS_PYTHON_TIMEOUT_MS) || 60_000,
  getMode = () => (process.env.SPREADS_DATA_MODE || 'fixtures').trim().toLowerCase(),
  isProduction = () => process.env.NODE_ENV === 'production',
  privateNetwork = config.API.ANGEL_ONE_PRIVATE_NETWORK,
} = {}) {
  async function call(endpointName, { body, accessToken, userId } = {}) {
    const endpoint = typeof endpointName === 'string' ? ENDPOINTS[endpointName] : endpointName;
    if (!endpoint) throw Object.assign(new Error('Unsupported private spreads request.'), { status: 403 });
    const mode = getMode();
    if (!['fixtures', 'upstox'].includes(mode)) throw Object.assign(new Error('Spread market-data mode is not configured.'), { status: 503 });
    if (!internalKey) throw Object.assign(new Error('Private Python service authentication is not configured.'), { status: 503 });
    if (mode === 'upstox' && (!accessToken || typeof accessToken !== 'string')) {
      throw Object.assign(new Error('Connect Upstox to continue.'), { status: 401 });
    }
    if (mode === 'upstox' && isProduction()) {
      let target;
      try { target = new URL(baseUrl); } catch {
        throw Object.assign(new Error('Private Python service URL is invalid.'), { status: 503 });
      }
      if (target.protocol !== 'https:' && !privateNetwork) {
        throw Object.assign(new Error('Upstox token transport must use HTTPS or an explicitly isolated private network.'), { status: 503 });
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint.discovery ? Math.max(timeoutMs, 190_000) : endpoint.method === 'POST' ? Math.max(timeoutMs, 210_000) : timeoutMs);
    try {
      const headers = { 'X-Internal-Service-Key': internalKey, Accept: 'application/json' };
      if (endpoint.discovery) {
        if (!userId || typeof userId !== 'string' || userId.length > 128) throw Object.assign(new Error('Discovery user context is required.'), { status: 422 });
        headers['X-Spreads-User-Id'] = userId;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (mode === 'upstox') headers['X-Upstox-Access-Token'] = accessToken;
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${endpoint.path}`, {
        method: endpoint.method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: 'error',
      });
      let data = null;
      try { data = await response.json(); } catch { /* handled as invalid response below */ }
      if (!response.ok) {
        const detail = data?.detail;
        const rejection = Array.isArray(detail)
          ? detail.map(item => {
            const field = Array.isArray(item?.loc) ? item.loc.filter(part => part !== 'body').join('.') : '';
            const message = typeof item?.msg === 'string' ? item.msg : 'Invalid value';
            return field ? `${field}: ${message}` : message;
          }).join('; ')
          : typeof detail === 'string' ? detail : typeof data?.message === 'string' ? data.message : 'Spread request was rejected.';
        const error = new Error(response.status >= 500
        ? 'Spread Terminal service is unavailable.'
        : rejection);
        error.status = response.status;
        throw error;
      }
      if (!data || typeof data !== 'object') {
        throw Object.assign(new Error('Spread Terminal returned an invalid response.'), { status: 502 });
      }
      if (data.data_mode && data.data_mode !== mode) {
        throw Object.assign(new Error('Spread data modes differ. Set SPREADS_DATA_MODE identically in Node and Python.'), { status: 503 });
      }
      return data;
    } catch (error) {
      if (error.status) throw error;
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        throw Object.assign(new Error('Spread scan timed out while loading market data.'), { status: 504 });
      }
      throw Object.assign(new Error('Spread Terminal service is unavailable.'), { status: 502 });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    getDiscovery: options => call('trending', options),
    discover: options => call('discover', options),
    getExpiries: options => call('expiries', options),
    scanNifty: (body, options = {}) => call('scan', { ...options, body }),
    scanMultiple: (body, options = {}) => call('multiScan', { ...options, body }),
    getUnderlyingExpiries: (symbol, options) => call({
      path: `/spreads/underlyings/${encodeURIComponent(normalizeSymbol(symbol))}/expiries`, method: 'GET',
    }, options),
    scanUnderlying: (symbol, body, options = {}) => call({
      path: `/spreads/underlyings/${encodeURIComponent(normalizeSymbol(symbol))}/scan`, method: 'POST',
    }, { ...options, body }),
  };
}

module.exports = { createSpreadsPythonService, ENDPOINTS, normalizeSymbol };
