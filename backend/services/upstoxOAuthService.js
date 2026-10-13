const { randomBytes } = require('node:crypto');

const AUTHORIZATION_URL = 'https://api.upstox.com/v2/login/authorization/dialog';
const TOKEN_URL = 'https://api.upstox.com/v2/login/authorization/token';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_USER = 5;
const CALLBACK_PATH = '/api/v1/spreads/upstox/callback';

function defaultExpiry(now) {
  // Upstox access tokens expire at 03:30 IST on the next calendar day.
  const ist = new Date(now + 330 * 60 * 1000);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 3, 30) - 330 * 60 * 1000;
}

function safeProviderMessage(payload, status) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : payload?.errors ? [payload.errors] : [];
  const all = [payload, ...errors].filter(value => value && typeof value === 'object');
  for (const error of all) {
    const code = error.errorCode || error.error_code;
    if (code === 'UDAPI100058') return 'Upstox reports no active trading segments. Activate or reactivate the required segments with Upstox, then reconnect.';
    if (code === 'UDAPI100069' || error.error === 'invalid_client') return 'Upstox rejected the API key or secret. Check that both values belong to the same developer app.';
    if (code === 'UDAPI100070') return 'The redirect URL does not match the URL registered in your Upstox developer app.';
    if (code === 'UDAPI100057' || error.error === 'invalid_grant') return 'The Upstox login code is invalid or already used. Start a fresh connection.';
    if (code === 'UDAPI100099') return 'Upstox rate limit reached. Wait briefly, then start a fresh connection.';
    if (code === 'UDAPI100101') return 'Upstox token exchange requires an individual developer app.';
  }
  return `Upstox token exchange failed (HTTP ${status}). Check the developer app credentials and registered redirect URL, then retry.`;
}

function createUpstoxOAuthService({
  getConfig = () => ({
    clientId: process.env.UPSTOX_CLIENT_ID || '',
    clientSecret: process.env.UPSTOX_CLIENT_SECRET || '',
    redirectUri: process.env.UPSTOX_REDIRECT_URI || '',
  }),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  createState = () => randomBytes(32).toString('base64url'),
  logger = console,
} = {}) {
  const pending = new Map();
  const sessions = new Map();
  const attempts = new Map();

  function record(userId, stage, message, httpStatus) {
    const attempt = { stage, at: new Date(now()).toISOString(), message, ...(httpStatus ? { httpStatus } : {}) };
    attempts.delete(userId);
    attempts.set(userId, attempt);
    while (attempts.size > 256) attempts.delete(attempts.keys().next().value);
    // Only locally generated messages and numeric status. Never codes, tokens,
    // credentials, raw provider bodies, state values or callback URLs.
    logger.info(`[SpreadsOAuth] ${JSON.stringify(attempt)}`);
  }

  function prune() {
    const current = now();
    for (const [state, entry] of pending) if (entry.expiresAt <= current) pending.delete(state);
    for (const [userId, session] of sessions) if (session.expiresAt <= current) {
      sessions.delete(userId);
      record(userId, 'expired', 'Upstox access token expired. Reconnect Upstox.');
    }
  }

  function configuration() {
    const config = getConfig();
    if (!config.clientId || !config.clientSecret || !config.redirectUri) {
      const error = new Error('Upstox OAuth is not configured on the server. Set UPSTOX_CLIENT_ID, UPSTOX_CLIENT_SECRET and UPSTOX_REDIRECT_URI.');
      error.status = 503;
      throw error;
    }
    let callback;
    try { callback = new URL(config.redirectUri); } catch { /* rejected below */ }
    if (!callback || !['http:', 'https:'].includes(callback.protocol)
        || callback.username || callback.password || callback.search || callback.hash
        || callback.pathname !== CALLBACK_PATH
        || (['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
            && callback.port === '8001')) {
      const error = new Error(`UPSTOX_REDIRECT_URI must point to the integrated Node callback ${CALLBACK_PATH} (local default: http://localhost:5000${CALLBACK_PATH}). Register the identical URL in your Upstox developer app; the standalone port-8001 callback is not used.`);
      error.status = 422;
      throw error;
    }
    return config;
  }

  function begin(userId) {
    prune();
    const config = configuration();
    const owned = [...pending.entries()].filter(([, entry]) => entry.userId === userId);
    for (const [state] of owned.slice(0, Math.max(0, owned.length - MAX_PENDING_PER_USER + 1))) pending.delete(state);
    const state = createState();
    pending.set(state, { userId, expiresAt: now() + STATE_TTL_MS });
    record(userId, 'authorization_started', 'Authorization started. Waiting for the Upstox callback.');
    const url = new URL(AUTHORIZATION_URL);
    url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, state }).toString();
    return { authorizationUrl: url.toString() };
  }

  async function completeExchange(userId, { state, code, providerError } = {}) {
    prune();
    if (typeof state !== 'string' || state.length > 256) {
      const error = new Error('Upstox login was incomplete. Start a fresh connection.'); error.status = 400; throw error;
    }
    const pendingEntry = pending.get(state);
    if (!pendingEntry || pendingEntry.expiresAt <= now() || pendingEntry.userId !== userId) {
      const error = new Error('Upstox login state expired or belongs to another app user. Start a fresh connection.'); error.status = 400; throw error;
    }
    pending.delete(state);
    if (providerError) {
      const error = new Error(providerError === 'access_denied' ? 'Upstox connection was cancelled.' : 'Upstox authorization failed. Start a fresh connection.');
      error.status = 400; throw error;
    }
    if (typeof code !== 'string' || !code || code.length > 4096) {
      const error = new Error('Upstox login was incomplete. Start a fresh connection.'); error.status = 400; throw error;
    }

    const config = configuration();
    const body = new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' });
    record(userId, 'token_exchange_started', 'Callback state verified. Exchanging the login code with Upstox.');
    let response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      const error = new Error('Could not reach Upstox to complete login. Start a fresh connection when network access is available.');
      error.status = 502; throw error;
    }
    let payload;
    record(userId, 'token_exchange_response', 'Upstox token endpoint responded.', response.status);
    try { payload = await response.json(); } catch {
      const error = new Error('Upstox returned an invalid token response. Start a fresh connection.'); error.status = 502; throw error;
    }
    if (!response.ok || typeof payload?.access_token !== 'string' || !payload.access_token) {
      const error = new Error(safeProviderMessage(payload, response.status)); error.status = response.status >= 500 ? 502 : 401; throw error;
    }

    const issued = now();
    let expiresAt = defaultExpiry(issued);
    if (Number.isFinite(Number(payload.expires_in)) && Number(payload.expires_in) > 0) {
      expiresAt = issued + Number(payload.expires_in) * 1000;
    } else if (payload.expires_at) {
      const parsed = typeof payload.expires_at === 'number'
        ? (payload.expires_at < 1e12 ? payload.expires_at * 1000 : payload.expires_at)
        : Date.parse(payload.expires_at);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
    if (expiresAt <= issued) {
      const error = new Error('Upstox returned an expired access token. Start a fresh connection.'); error.status = 502; throw error;
    }
    sessions.set(userId, { accessToken: payload.access_token, connectedAt: issued, expiresAt });
    record(userId, 'connected', 'Upstox access token stored in this Node process.');
    return { connected: true, expiresAt };
  }

  async function complete(userId, input = {}) {
    record(userId, 'callback_received', 'Upstox callback received.');
    try { return await completeExchange(userId, input); }
    catch (error) {
      const message = Number.isInteger(error.status) ? error.message : 'Unexpected OAuth error. Start a fresh connection.';
      record(userId, 'failed', message, error.status);
      throw error;
    }
  }

  function status(userId) {
    prune();
    const session = sessions.get(userId);
    return { ...(session ? { connected: true, expiresAt: session.expiresAt } : { connected: false, expiresAt: null }),
      ...(attempts.has(userId) ? { lastAttempt: attempts.get(userId) } : {}) };
  }

  function accessToken(userId) {
    prune();
    return sessions.get(userId)?.accessToken || null;
  }

  function disconnect(userId) {
    sessions.delete(userId);
    for (const [state, entry] of pending) if (entry.userId === userId) pending.delete(state);
    attempts.delete(userId);
    return { connected: false, expiresAt: null };
  }

  return { begin, complete, status, accessToken, disconnect, pending, sessions };
}

module.exports = { createUpstoxOAuthService, defaultExpiry, safeProviderMessage, AUTHORIZATION_URL, TOKEN_URL };
