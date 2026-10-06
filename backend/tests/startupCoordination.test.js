const test = require('node:test');
const assert = require('node:assert/strict');

process.env.INTERNAL_SERVICE_KEY = 'test-internal-key';
const marketDataService = require('../services/marketDataService');

test('concurrent broker session checks share one Python request', async (t) => {
  const originalFetch = global.fetch;
  let resolveFetch;
  let calls = 0;
  const accounts = require('../services/accountContext');
  const active = require('../services/activeAccountService');
  const originalResolve = accounts.resolve;
  const originalValidate = accounts.validate;
  const originalActive = active.getActiveAccount;
  active.getActiveAccount = () => ({ userId: 'test-user', brokerAccountId: 'test-account' });
  accounts.resolve = async () => accounts.mint({ userId: 'test-user', _id: 'test-account' });
  accounts.validate = async context => context;

  t.after(() => {
    global.fetch = originalFetch;
    marketDataService.sessionCheckPromise = null;
    accounts.resolve = originalResolve;
    accounts.validate = originalValidate;
    active.getActiveAccount = originalActive;
  });

  global.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };

  const first = marketDataService.autoInitSession();
  const second = marketDataService.autoInitSession();

  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);

  resolveFetch({ ok: false, status: 429, text: async () => JSON.stringify({ detail: 'rate limited' }) });
  await first;
  assert.equal(marketDataService.sessionCheckPromise, null);
});

test('multi-account background health polling checks each account and scopes transition events', async t => {
  const originalFetch = global.fetch;
  const accounts = require('../services/accountContext');
  const active = require('../services/activeAccountService');
  const originalResolve = accounts.resolve;
  const originalValidate = accounts.validate;
  const originalList = active.listActiveAccounts;
  const originalGet = active.getActiveAccount;
  const ownership = require('../services/brokerOwnership');
  const originalMutation = ownership.validateMutation;
  const healthA = { userId: 'user-a', brokerAccountId: 'account-a', brokerClientIdentity: 'CLIENT-A', ownerGeneration: 0, sessionGeneration: 3, sessionId: 'session-a' };
  const healthB = { userId: 'user-b', brokerAccountId: 'account-b', brokerClientIdentity: 'CLIENT-B', ownerGeneration: 0, sessionGeneration: 7, sessionId: 'session-b' };
  const health = new Map([['account-a', true], ['account-b', true]]);
  const lost = [];
  const restored = [];
  const onLost = event => lost.push(event);
  const onRestored = event => restored.push(event);
  marketDataService.on('session:lost', onLost);
  marketDataService.on('session:restored', onRestored);
  active.listActiveAccounts = () => [healthA, healthB];
  active.getActiveAccount = (userId, accountId) => [healthA, healthB].find(item => item.userId === userId && item.brokerAccountId === accountId) || null;
  accounts.resolve = async (userId, accountId) => {
    const item = active.getActiveAccount(userId, accountId);
    return accounts.mint({ ...item, _id: item.brokerAccountId, brokerClientId: item.brokerClientIdentity }, item.sessionId);
  };
  accounts.validate = async context => context;
  ownership.validateMutation = async () => {};
  global.fetch = async (_url, options) => {
    const id = options.headers['X-Broker-Account-Id'];
    return { ok: health.get(id), status: health.get(id) ? 200 : 401,
      text: async () => JSON.stringify({ connected: health.get(id), status: health.get(id) }) };
  };
  t.after(() => {
    global.fetch = originalFetch;
    accounts.resolve = originalResolve;
    accounts.validate = originalValidate;
    active.listActiveAccounts = originalList;
    active.getActiveAccount = originalGet;
    ownership.validateMutation = originalMutation;
    marketDataService.off('session:lost', onLost);
    marketDataService.off('session:restored', onRestored);
    marketDataService.accountSessionHealth.delete('user-a:account-a');
    marketDataService.accountSessionHealth.delete('user-b:account-b');
  });

  await marketDataService.performAutoInitSession();
  assert.equal(health.size, 2);
  health.set('account-a', false);
  await marketDataService.performAutoInitSession();
  assert.equal(lost.length, 1);
  assert.equal(lost[0].brokerAccountId, 'account-a');
  assert.equal(lost[0].userId, 'user-a');
  assert.equal(lost[0].sessionGeneration, 3);
  assert.equal(restored.length, 0);
});
