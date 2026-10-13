const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpstoxOAuthService, AUTHORIZATION_URL, TOKEN_URL, defaultExpiry } = require('../services/upstoxOAuthService');

const config = { clientId: 'app-client-id', clientSecret: 'app-client-secret', redirectUri: 'http://localhost:5000/api/v1/spreads/upstox/callback' };

test('obsolete standalone callback configuration is rejected before redirecting to Upstox', () => {
  for (const redirectUri of [
    'http://127.0.0.1:8001/auth/callback',
    'http://localhost:8001/api/v1/spreads/upstox/callback',
    'http://localhost:5000/auth/callback',
    'not-a-url',
  ]) {
    const service = createUpstoxOAuthService({ getConfig: () => ({ ...config, redirectUri }) });
    assert.throws(() => service.begin('user-a'), error => {
      assert.equal(error.status, 422);
      assert.match(error.message, /integrated Node callback/);
      return true;
    });
    assert.equal(service.pending.size, 0);
  }
});

test('integrated callback accepts local and deployed Node endpoints', () => {
  for (const redirectUri of [config.redirectUri, 'http://127.0.0.1:5000/api/v1/spreads/upstox/callback', 'https://trading.example.com/api/v1/spreads/upstox/callback']) {
    const service = createUpstoxOAuthService({ getConfig: () => ({ ...config, redirectUri }) });
    assert.equal(new URL(service.begin('user-a').authorizationUrl).searchParams.get('redirect_uri'), redirectUri);
  }
});

test('diagnostics expose the failed stage to its owner and logs never expose login secrets', async () => {
  const logs = [];
  const service = createUpstoxOAuthService({
    getConfig: () => config, createState: () => 'PRIVATE-STATE', logger: { info: entry => logs.push(entry) },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ errorCode: 'UDAPI100058', message: 'PRIVATE-PROVIDER-BODY' }] }) }),
  });
  service.begin('owner');
  await assert.rejects(service.complete('owner', { state: 'PRIVATE-STATE', code: 'PRIVATE-CODE' }));
  const result = service.status('owner');
  assert.equal(result.connected, false);
  assert.equal(result.lastAttempt.stage, 'failed');
  assert.equal(result.lastAttempt.httpStatus, 401);
  assert.match(result.lastAttempt.message, /no active trading segments/);
  assert.equal(service.status('other-user').lastAttempt, undefined);
  const serialized = JSON.stringify({ logs, result });
  for (const secret of ['PRIVATE-STATE', 'PRIVATE-CODE', 'PRIVATE-PROVIDER-BODY', config.clientSecret, config.clientId]) assert.equal(serialized.includes(secret), false);
  assert.ok(logs.some(entry => entry.includes('token_exchange_started')));
  service.disconnect('owner');
  assert.equal(service.status('owner').lastAttempt, undefined);
});

test('OAuth state is user-bound, single-use and authorization URL uses the registered callback', async () => {
  let clock = 1_800_000_000_000;
  const service = createUpstoxOAuthService({ getConfig: () => config, now: () => clock, createState: () => 'state-one', fetchImpl: async () => { throw new Error('network should not be required in this test'); } });
  const result = service.begin('user-a');
  const authorize = new URL(result.authorizationUrl);
  assert.equal(authorize.origin + authorize.pathname, AUTHORIZATION_URL);
  assert.equal(authorize.searchParams.get('client_id'), config.clientId);
  assert.equal(authorize.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(authorize.searchParams.get('state'), 'state-one');
  await assert.rejects(service.complete('user-b', { state: 'state-one', code: 'auth-code' }), { status: 400 });
  assert.equal(service.pending.has('state-one'), true, 'foreign callback cannot consume the owner state');
  await assert.rejects(service.complete('user-a', { state: 'state-one', code: 'auth-code' }), { status: 502 });
  await assert.rejects(service.complete('user-a', { state: 'state-one', code: 'auth-code' }), { status: 400 }, 'callback state is one-use');
  clock += 11 * 60 * 1000;
  assert.equal(service.status('user-a').connected, false);
});

test('token exchange sends standard form body and stores token only for its app user', async () => {
  let clock = 1_800_000_000_000;
  let request;
  const service = createUpstoxOAuthService({
    getConfig: () => config, now: () => clock, createState: () => 'owner-state',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ access_token: 'server-only-token' }) };
    },
  });
  service.begin('user-a');
  const connected = await service.complete('user-a', { state: 'owner-state', code: 'one-time-code' });
  const body = new URLSearchParams(request.options.body);
  assert.equal(request.url, TOKEN_URL);
  assert.equal(request.options.method, 'POST');
  assert.match(request.options.headers['Content-Type'], /application\/x-www-form-urlencoded/);
  assert.equal(body.get('client_id'), config.clientId);
  assert.equal(body.get('client_secret'), config.clientSecret);
  assert.equal(body.get('redirect_uri'), config.redirectUri);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'one-time-code');
  assert.equal(service.status('user-a').connected, true);
  assert.equal(service.status('user-a').expiresAt, defaultExpiry(clock));
  assert.equal(service.status('user-b').connected, false);
  assert.equal(service.accessToken('user-a'), 'server-only-token');
  assert.equal(JSON.stringify(connected).includes('server-only-token'), false);
  service.disconnect('user-a');
  assert.equal(service.accessToken('user-a'), null);
});

test('provider errors remain actionable without returning raw provider payloads', async () => {
  const service = createUpstoxOAuthService({
    getConfig: () => config, createState: () => 'inactive-state',
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ errors: [{ errorCode: 'UDAPI100058', message: 'sensitive provider text' }] }) }),
  });
  service.begin('user-a');
  await assert.rejects(service.complete('user-a', { state: 'inactive-state', code: 'code' }), error => {
    assert.equal(error.status, 401);
    assert.match(error.message, /no active trading segments/i);
    assert.doesNotMatch(error.message, /sensitive provider text/);
    return true;
  });
  assert.equal(service.accessToken('user-a'), null);
});

test('OAuth fails closed when server configuration is absent and expired sessions are removed', async () => {
  const unconfigured = createUpstoxOAuthService({ getConfig: () => ({ clientId: '', clientSecret: '', redirectUri: '' }) });
  assert.throws(() => unconfigured.begin('user-a'), { status: 503 });
  let clock = 1_800_000_000_000;
  const service = createUpstoxOAuthService({ getConfig: () => config, now: () => clock, createState: () => 'expiry-state', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'expired-soon', expires_in: 2 }) }) });
  service.begin('user-a');
  await service.complete('user-a', { state: 'expiry-state', code: 'code' });
  clock += 2_001;
  assert.equal(service.status('user-a').connected, false);
  assert.equal(service.status('user-a').expiresAt, null);
  assert.equal(service.status('user-a').lastAttempt.stage, 'expired');
  assert.equal(service.accessToken('user-a'), null);
});
