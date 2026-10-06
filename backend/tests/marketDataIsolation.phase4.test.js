const test = require('node:test');
const assert = require('node:assert/strict');
const marketDataRouter = require('../services/marketDataService');
const accountContext = require('../services/accountContext');

function context(userId, brokerAccountId, sessionId, sessionGeneration = 1) {
  return accountContext.mint({
    userId, _id: brokerAccountId, brokerClientId: `client-${userId}`,
    sessionGeneration, ownerGeneration: 1
  }, sessionId);
}

function makeService(ctx) {
  const service = new marketDataRouter.AccountMarketDataService(ctx);
  service.autoInitSession = async () => {};
  service.requestPython = async () => ({ response: { ok: true }, data: { items: [] } });
  return service;
}

test('Phase 4: identical tokens are isolated by account and exchange key', async () => {
  const a = makeService(context('user-a', 'account-a', 'session-a'));
  const b = makeService(context('user-b', 'account-b', 'session-b'));
  await Promise.all([
    a.subscribe('NFO', '12345', 'ONE_MINUTE', null, { tradingsymbol: 'A-OPT' }),
    b.subscribe('NFO', '12345', 'ONE_MINUTE', null, { tradingsymbol: 'B-OPT' })
  ]);
  assert.notEqual(a.smartStream, b.smartStream);
  assert.deepEqual([...a.smartStream.subscribedTokens.keys()], ['2:12345']);
  assert.deepEqual([...b.smartStream.subscribedTokens.keys()], ['2:12345']);
  a.handleTick({ token: '12345', exchangeType: 2, ltp: 101, timestamp: 1000 });
  assert.equal(a.getLtp('NFO', '12345'), 101);
  assert.equal(b.getLtp('NFO', '12345'), null);
  b.handleTick({ token: '12345', exchangeType: 2, ltp: 202, timestamp: 1000 });
  assert.equal(b.getLtp('NFO', '12345'), 202);
  assert.equal(a.getLtp('NFO', '12345'), 101);
  a.resetAccountSession('account-a');
  b.handleTick({ token: '12345', exchangeType: 2, ltp: 203, timestamp: 2000 });
  assert.equal(b.getLtp('NFO', '12345'), 203);
  b.resetAccountSession('account-b');
});

test('Phase 4: scanner and held-position references unsubscribe independently', async () => {
  const service = makeService(context('user-c', 'account-c', 'session-c'));
  const calls = [];
  service.smartStream.subscribe = entries => calls.push(['subscribe', entries]);
  service.smartStream.unsubscribe = entries => calls.push(['unsubscribe', entries]);
  await service.subscribe('NFO', '77', 'FIVE_MINUTE', null, { role: 'scanner', tradingsymbol: 'SCANNER' });
  await service.subscribe('NFO', '77', 'ONE_MINUTE', null, { role: 'position', tradingsymbol: 'HELD' });
  service.unsubscribe('NFO', '77', 'FIVE_MINUTE', 'scanner');
  assert.equal(service.streamSubscribers.get('2:77').refCount, 1);
  assert.deepEqual(calls.map(call => call[0]), ['subscribe']);
  service.unsubscribe('NFO', '77', 'ONE_MINUTE', 'position');
  assert.deepEqual(calls.map(call => call[0]), ['subscribe', 'unsubscribe']);
  service.resetAccountSession('account-c');
});

test('Phase 4: fallback is bounded, uses the account instrument, and does not leak a rate limit', async () => {
  const a = makeService(context('user-d', 'account-d', 'session-d'));
  const b = makeService(context('user-e', 'account-e', 'session-e'));
  await a.subscribe('NFO', '88', 'ONE_MINUTE', null, { tradingsymbol: 'ACCOUNT-D-OPT' });
  await b.subscribe('NFO', '88', 'ONE_MINUTE', null, { tradingsymbol: 'ACCOUNT-E-OPT' });
  const urlsA = [];
  const urlsB = [];
  a.requestPython = async path => {
    urlsA.push(path);
    const error = new Error('rate limited'); error.status = 429; throw error;
  };
  b.requestPython = async path => {
    urlsB.push(path);
    return { response: { ok: true }, data: { ltp: 321 } };
  };
  await Promise.all([a.pollRestLtpFallback(), b.pollRestLtpFallback()]);
  assert.match(urlsA[0], /tradingsymbol=ACCOUNT-D-OPT/);
  assert.match(urlsB[0], /tradingsymbol=ACCOUNT-E-OPT/);
  assert.match(urlsB[0], /symboltoken=88/);
  assert.equal(a.getLtp('NFO', '88'), null);
  assert.equal(b.getLtp('NFO', '88'), 321);
  a.resetAccountSession('account-d');
  b.resetAccountSession('account-e');
});

test('Phase 4: fallback polling does not overlap for one account', async () => {
  const service = makeService(context('user-k', 'account-k', 'session-k'));
  await service.subscribe('NFO', '89', 'ONE_MINUTE', null, { tradingsymbol: 'K-OPT' });
  let release;
  let calls = 0;
  service.requestPython = () => {
    calls++;
    return new Promise(resolve => { release = () => resolve({ response: { ok: true }, data: { ltp: 41 } }); });
  };
  const first = service.pollRestLtpFallback();
  const second = service.pollRestLtpFallback();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(service.getLtp('NFO', '89'), 41);
  service.resetAccountSession('account-k');
});

test('Phase 4: stale session ticks and wrong-account order events are rejected', async () => {
  const ctxA = context('user-f', 'account-f', 'session-f', 3);
  const ctxOld = context('user-f', 'account-f', 'session-old', 2);
  const service = makeService(ctxA);
  service.smartStream.accountIdentity = { ...service.sessionIdentity };
  await service.subscribe('NFO', '99', 'ONE_MINUTE', null, { tradingsymbol: 'F-OPT' });
  assert.equal(service.handleTick({ token: '99', exchangeType: 2, ltp: 123, timestamp: 1 }, {
    userId: ctxOld.userId, brokerAccountId: ctxOld.brokerAccountId,
    sessionId: ctxOld.sessionId, sessionGeneration: ctxOld.sessionGeneration
  }), false);
  assert.equal(service.getLtp('NFO', '99'), null);
  let accepted = 0;
  const orderUpdates = service.getOrderUpdateService();
  orderUpdates.accountIdentity = { ...service.sessionIdentity };
  orderUpdates.on('order:update', (_data, identity) => {
    if (identity?.brokerAccountId === service.sessionIdentity.brokerAccountId
      && identity?.sessionGeneration === service.sessionIdentity.sessionGeneration) accepted++;
  });
  orderUpdates.handleMessage(JSON.stringify({ orderData: { orderid: 'x' } }), {
    userId: 'another-user', brokerAccountId: 'another-account', sessionId: 'other', sessionGeneration: 3
  });
  assert.equal(accepted, 0);
  service.resetAccountSession('account-f');
});

test('Phase 4: synchronous strategy LTP reads route by verified account context', async () => {
  const ctxA = context('user-g', 'account-g', 'session-g');
  const ctxB = context('user-h', 'account-h', 'session-h');
  const serviceA = makeService(ctxA);
  const serviceB = makeService(ctxB);
  serviceA.handleTick({ token: '55', exchangeType: 2, ltp: 55, timestamp: 1 });
  serviceB.handleTick({ token: '55', exchangeType: 2, ltp: 99, timestamp: 1 });
  marketDataRouter.accounts.set('user-g:account-g', serviceA);
  marketDataRouter.accounts.set('user-h:account-h', serviceB);
  assert.equal(accountContext.run(ctxA, () => marketDataRouter.getLtp('NFO', '55')), 55);
  assert.equal(accountContext.run(ctxB, () => marketDataRouter.getLtp('NFO', '55')), 99);
  marketDataRouter.accounts.delete('user-g:account-g');
  marketDataRouter.accounts.delete('user-h:account-h');
  serviceA.resetAccountSession('account-g');
  serviceB.resetAccountSession('account-h');
});

test('Phase 4: reconnect replaces only the old account session feed', async t => {
  const ctxA = context('user-i', 'account-i', 'session-i1', 1);
  const ctxA2 = context('user-i', 'account-i', 'session-i2', 2);
  const ctxB = context('user-j', 'account-j', 'session-j1', 1);
  const oldValidate = accountContext.validate;
  accountContext.validate = async value => value;
  const oldA = makeService(ctxA);
  const serviceB = makeService(ctxB);
  marketDataRouter.accounts.set('user-i:account-i', oldA);
  marketDataRouter.accounts.set('user-j:account-j', serviceB);
  t.after(() => {
    accountContext.validate = oldValidate;
    marketDataRouter.accounts.delete('user-i:account-i');
    marketDataRouter.accounts.delete('user-j:account-j');
    oldA.resetAccountSession('account-i');
    serviceB.resetAccountSession('account-j');
  });
  const nextA = await marketDataRouter._service(ctxA2);
  assert.notEqual(nextA, oldA);
  assert.equal(oldA.destroyed, true);
  assert.equal(marketDataRouter.accounts.get('user-j:account-j'), serviceB);
  assert.equal(serviceB.destroyed, false);
  nextA.resetAccountSession('account-i');
});
