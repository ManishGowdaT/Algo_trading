const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/executionFixture');
const { forRunner } = require('../services/positionExecution');
const recovery = require('../services/startupRecovery');
const leases = require('../services/executionLeaseService');
const ExecutionLease = require('../models/ExecutionLease');

test('Recovered held candles execute the original reversal exit without starting entries', async t => {
  const f = await fixture(t, { readyFeed: true });
  const original = await f.runner(0, 'HeikenAshi', false);
  await original.executeEntry(f.contract, 100, 'BULLISH');
  forRunner(original).suspendForRecovery(); f.engine.runners.clear();
  await recovery.recoverAccount(f.contexts[0]);
  const runner = f.engine.getRunner(`${f.contexts[0].userId}_HeikenAshi`);
  assert.ok(runner.candleListener);
  assert.equal(runner.isRunning, false);
  assert.equal(runner.contractInterval, null);
  runner.currentLtp = 100;
  const service = await f.accounts.run(f.contexts[0], () => f.feeds.ensureReady());
  const builder = [...service.candleBuilders.values()].find(item => item.key.startsWith('position:') && item.interval === runner.getBaseTimeframe());
  assert.ok(builder);
  builder.candles = [110, 100, 90].map((open, i) => ({ time: Date.now() - (3-i)*300000, open, high: open, low: open-10, close: open-10 }));
  service.emit('candle:closed', { ...f.contexts[0], symboltoken: f.contract.symboltoken });
  for (let i = 0; i < 100 && f.stores.Position[0].status !== 'CLOSED'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.stores.Position[0].status, 'CLOSED');
  assert.equal(f.stores.Trade[0].exitReason, 'Reversal');
  assert.equal(f.stores.OrderIntent.filter(item => item.purpose === 'ENTRY').length, 1);
});

for (const secondStatus of ['open', 'cancelled']) test(`Recovery checks every standalone intent when second is ${secondStatus}`, async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  const execution = forRunner(runner);
  await execution.run(async () => {
    for (let i = 0; i < 2; i++) {
      const request = { action: 'BUY', ...f.contract, quantity: 1, ordertype: 'MARKET', producttype: 'CARRYFORWARD' };
      const intent = await execution.intent('MANUAL', request);
      intent.status = 'SUBMITTING'; await execution.saveIntent(intent);
      intent.brokerOrderId = `ORPHAN-${i}`; intent.status = 'ACKNOWLEDGED'; await execution.saveIntent(intent);
      f.orders.get(f.contexts[0].brokerAccountId).push({ ...request, orderid: intent.brokerOrderId,
        transactiontype: 'BUY', filledshares: 0, orderstatus: i ? secondStatus : 'rejected' });
    }
  });
  execution.suspendForRecovery(); f.engine.runners.clear();
  await recovery.initialize();
  const state = recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId);
  assert.equal(state.status, secondStatus === 'open' ? 'DEGRADED' : 'READY');
  assert.equal(f.stores.OrderIntent[0].status, 'REJECTED');
  assert.equal(f.stores.OrderIntent[1].status, secondStatus === 'open' ? 'ACKNOWLEDGED' : 'CANCELLED');
  if (secondStatus === 'open') await assert.rejects(recovery.assertStrategyStartAllowed(f.contexts[0]), { code: 'RECOVERY_REQUIRED' });
  await recovery.assertStrategyStartAllowed(f.contexts[1]);
});

test('Phase 6 restart: persisted held position recovers its exact snapshot and monitoring without restarting entries', async t => {
  const f = await fixture(t, { readyFeed: false });
  const original = await f.runner(0, 'HeikenAshi', false);
  await original.executeEntry(f.contract, 100, 'BULLISH');
  const persisted = f.stores.Position[0];
  persisted.activeTrailingSl = 91;
  persisted.protectiveStopPrice = 91;
  await require('../models/Position').findOneAndUpdate({ _id: persisted._id, userId: persisted.userId, brokerAccountId: persisted.brokerAccountId },
    { $set: { activeTrailingSl: 91, protectiveStopPrice: 91 } }, { returnDocument: 'after' });
  const tradeId = String(persisted.tradeId);
  const manager = forRunner(original);
  manager.suspendForRecovery();
  f.engine.runners.clear(); // Simulate loss of all process-local runner state.

  await recovery.initialize();
  const restored = f.engine.getRunner(`${f.contexts[0].userId}_HeikenAshi`);
  assert.equal(restored.isRunning, false, 'recovery must not enable new strategy entries');
  assert.equal(restored.activeTradeId, tradeId);
  assert.equal(restored.activeTradeContract.tradingsymbol, persisted.executionSnapshot.tradingsymbol);
  assert.equal(restored.config.liveTradingConsent, false);
  assert.equal(restored.remainingQuantity, 10);
  assert.equal(restored.stopLoss, persisted.executionSnapshot.stopLoss);
  assert.equal(restored.target, persisted.executionSnapshot.target);
  assert.equal(restored.activeTrailingSl, 91);
  assert.equal(restored.protectiveStopPrice, 91);
  assert.equal(restored.brokerReady, true, 'successful broker reconciliation restores the monitor readiness gate');
  assert.ok(restored.monitorInterval, 'held-position monitor is restored');
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'READY');
  await recovery.assertStrategyStartAllowed(f.contexts[0]);
});

test('Phase 6 ready-feed recovery: restored position executes its price monitor without a new session-restored event', async t => {
  const f = await fixture(t, { readyFeed: true });
  const original = await f.runner(0, 'HeikenAshi', false);
  await original.executeEntry(f.contract, 100, 'BULLISH');
  forRunner(original).suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();
  const restored = f.engine.getRunner(`${f.contexts[0].userId}_HeikenAshi`);
  assert.equal(restored.brokerReady, true);
  f.state.quote = 125;
  t.mock.timers.tick(1000);
  await new Promise(resolve => setTimeout(resolve, 40));

  assert.ok(f.state.calls.some(call => call.path === '/market/ltp'), 'price monitor queried the held instrument');
  assert.equal(f.stores.Position[0].status, 'CLOSED', 'target exit ran from the restored monitor');
});

test('Phase 6 standalone intent recovery: unresolved manual intent is reconciled before account becomes READY', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  const execution = forRunner(runner);
  let manual;
  await execution.run(async () => {
    manual = await execution.intent('MANUAL', { action: 'BUY', exchange: f.contract.exchange,
      symboltoken: f.contract.symboltoken, tradingsymbol: f.contract.tradingsymbol,
      quantity: 1, ordertype: 'MARKET', producttype: 'CARRYFORWARD' });
    manual.status = 'SUBMITTING'; await execution.saveIntent(manual);
    manual.brokerOrderId = 'ORPHAN-MANUAL'; manual.status = 'UNKNOWN'; await execution.saveIntent(manual);
  });
  f.orders.get(String(f.rows[0]._id)).push({ orderid: 'ORPHAN-MANUAL', exchange: f.contract.exchange,
    symboltoken: f.contract.symboltoken, tradingsymbol: f.contract.tradingsymbol,
    quantity: 1, transactiontype: 'BUY', ordertype: 'MARKET', producttype: 'CARRYFORWARD',
    filledshares: 0, orderstatus: 'open' });
  execution.suspendForRecovery(); f.engine.runners.clear();

  await recovery.initialize();

  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'DEGRADED');
  assert.equal(f.stores.OrderIntent.find(row => String(row._id) === String(manual._id)).status, 'ACKNOWLEDGED');
  assert.ok(f.state.calls.some(call => call.path === '/angel/orderbook'), 'orphan intent was checked against broker evidence');
  await assert.rejects(recovery.assertExecutionAllowed(f.contexts[0]), { code: 'RECOVERY_REQUIRED' });
});

test('Phase 6 degraded recovery admission: manual broker request completes without reacquiring its held execution lock', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  forRunner(runner).suspendForRecovery(); f.engine.runners.clear();
  f.state.bookFailure = true;
  await recovery.initialize();
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'DEGRADED');
  f.state.bookFailure = false;

  const gateway = require('../services/executionGateway');
  const dispatch = gateway.dispatch('/angel/positions/exit', { exchange: f.contract.exchange,
    symboltoken: f.contract.symboltoken, tradingsymbol: f.contract.tradingsymbol,
    transactiontype: 'SELL', quantity: 10, ordertype: 'MARKET', producttype: 'CARRYFORWARD' }, f.contexts[0]);
  let watchdog;
  const outcome = await Promise.race([dispatch.then(value => ({ value }), error => ({ error })),
    new Promise(resolve => { watchdog = setTimeout(() => resolve({ timeout: true }), 8000); })]);
  clearTimeout(watchdog);

  assert.equal(outcome.timeout, undefined, 'gateway must not deadlock while recovery takes the account lock');
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(f.stores.Position[0].status, 'CLOSED');
});

test('Phase 6 snapshot authority: later reconciliation retains persisted stop, target and trailing thresholds', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  const position = f.stores.Position[0];
  position.executionSnapshot.stopLoss = 64;
  position.executionSnapshot.target = 147;
  position.activeTrailingSl = 88;
  forRunner(runner).suspendForRecovery(); f.engine.runners.clear();

  await recovery.initialize();
  const restored = f.engine.getRunner(`${f.contexts[0].userId}_HeikenAshi`);
  assert.equal(restored.stopLoss, 64);
  assert.equal(restored.target, 147);
  assert.equal(restored.activeTrailingSl, 88);
  await forRunner(restored).reconcile();
  assert.equal(restored.stopLoss, 64);
  assert.equal(restored.target, 147);
  assert.equal(restored.activeTrailingSl, 88);
});

test('Phase 6 lease renewal: renewed expiry replaces the cached token', async t => {
  const f = await fixture(t, { readyFeed: false });
  const token = await leases.acquire(f.contexts[0]);
  const renewed = await leases.renew(token);
  assert.equal(leases.current(f.contexts[0]).leaseUntil.getTime(), renewed.leaseUntil.getTime());
  assert.equal((await leases.executionContext(f.contexts[0])).leaseUntil.getTime(), renewed.leaseUntil.getTime());
});

test('Phase 6 restart after protective order: fresh broker evidence restores the same protection without duplicate orders', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  const position = f.stores.Position[0];
  const protectiveOrderId = position.protectiveOrderId;
  const stopCount = f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.ordertype === 'SL').length;
  assert.equal(position.status, 'PROTECTED');
  assert.ok(protectiveOrderId);
  forRunner(runner).suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();

  const restored = f.engine.getRunner(`${f.contexts[0].userId}_HeikenAshi`);
  assert.equal(restored.isRunning, false);
  assert.equal(f.stores.Position[0].status, 'PROTECTED');
  assert.equal(f.stores.Position[0].protectiveOrderId, protectiveOrderId);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.ordertype === 'SL').length, stopCount);
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'READY');
});

test('Phase 6 restart during trailing protection replacement: unresolved replacement is fenced without duplicate stops', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'ModifiedHeikenAshi', true);
  runner.config.exitStrategy = 'TRAILING_SL';
  runner.config.initialSlPoints = 30;
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  const execution = forRunner(runner);
  await execution.run(async () => {
    const position = await execution.ownedPosition();
    position.activeTrailingSl = 105;
    position.protectiveStopPrice = 105;
    await execution.savePosition(position);
    await execution.intent('PROTECT', { action: 'SELL', exchange: f.contract.exchange,
      symboltoken: f.contract.symboltoken, tradingsymbol: f.contract.tradingsymbol, quantity: position.remainingQuantity,
      ordertype: 'STOPLOSS_LIMIT', producttype: 'CARRYFORWARD', price: 104, triggerprice: 105 },
    position, null, { replacementForPrice: 70, trailingStopPrice: 105 });
  });
  const stopCount = f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.ordertype === 'SL').length;
  execution.suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();

  assert.equal(f.stores.Position[0].activeTrailingSl, 105);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.ordertype === 'SL').length, stopCount);
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'DEGRADED');
  await assert.rejects(recovery.assertStrategyStartAllowed(f.contexts[0]), { code: 'RECOVERY_REQUIRED' });
});

test('Phase 6 restart before BUY transport: durable PREPARED intent blocks a duplicate entry', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  const execution = forRunner(runner);
  await execution.run(async () => {
    const intent = await execution.intent('ENTRY', { action: 'BUY', exchange: f.contract.exchange,
      symboltoken: f.contract.symboltoken, tradingsymbol: f.contract.tradingsymbol, quantity: 10,
      ordertype: 'MARKET', producttype: 'CARRYFORWARD' }, null, null,
    { config: runner.config, strategyName: 'HeikenAshi', signalPrice: 100, trendSide: 'BULLISH', stopLoss: 70, warmupCandles: [] });
    execution.entryIntentId = intent._id;
  });
  execution.suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();

  assert.equal(f.stores.OrderIntent.filter(intent => intent.purpose === 'ENTRY').length, 1);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.transactiontype === 'BUY').length, 0);
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'DEGRADED');
  await assert.rejects(recovery.assertExecutionAllowed(f.contexts[0]), { code: 'RECOVERY_REQUIRED' });
});

test('Phase 6 restart after BUY submit: recovered broker fill materializes once and does not resend BUY', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  f.state.onPlace = async ({ body, order, respond }) => {
    if (body.transactiontype === 'BUY') {
      order.orderstatus = 'open';
      order.filledshares = 0;
      respond({ item: { request: body, response: { status: true, data: { orderid: order.orderid } } } });
      return true;
    }
    return false;
  };
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), { code: 'RECONCILIATION_REQUIRED' });
  const entry = f.stores.OrderIntent.find(intent => intent.purpose === 'ENTRY');
  const brokerOrder = f.orders.get(String(f.rows[0]._id)).find(order => order.orderid === entry.brokerOrderId);
  assert.ok(brokerOrder);
  brokerOrder.filledshares = 10;
  brokerOrder.averageprice = 100;
  brokerOrder.orderstatus = 'complete';
  const buyCount = f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.transactiontype === 'BUY').length;
  forRunner(runner).suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();

  assert.equal(f.stores.Position.length, 1);
  assert.equal(f.stores.Position[0].remainingQuantity, 10);
  assert.equal(f.stores.Position[0].executionSnapshot.tradingsymbol, f.contract.tradingsymbol);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.transactiontype === 'BUY').length, buyCount);
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'READY');
});

test('Phase 6 restart after partial BUY fill: preserves filled and pending quantities and blocks duplicate entry', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  f.state.onPlace = async ({ body, order, respond }) => {
    if (body.transactiontype === 'BUY') {
      order.orderstatus = 'open';
      order.filledshares = 4;
      respond({ item: { request: body, response: { status: true, data: { orderid: order.orderid } } } });
      return true;
    }
    return false;
  };
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), { code: 'RECONCILIATION_REQUIRED' });
  const buyCount = f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.transactiontype === 'BUY').length;
  forRunner(runner).suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();

  assert.equal(f.stores.Position.length, 1);
  assert.equal(f.stores.Position[0].remainingQuantity, 4);
  assert.equal(f.stores.Position[0].pendingEntryQuantity, 6);
  assert.equal(f.stores.Position[0].status, 'RECONCILIATION_REQUIRED');
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.transactiontype === 'BUY').length, buyCount);
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'DEGRADED');
});

test('Phase 6 ownership: an expired or superseded owner is fenced while another user retains independent ownership', async t => {
  const f = await fixture(t, { readyFeed: false });
  const first = await leases.acquire(f.contexts[0]);
  const second = await leases.acquire(f.contexts[1]);
  assert.notEqual(first.brokerAccountId, second.brokerAccountId);
  const record = f.stores.ExecutionLease.find(item => String(item.brokerAccountId) === first.brokerAccountId);
  record.ownerId = 'replacement-process';
  record.generation = first.generation + 1;
  record.leaseUntil = new Date(Date.now() + 60_000);
  await assert.rejects(leases.assertCurrent(first), { code: 'EXECUTION_LEASE_UNAVAILABLE' });
  await assert.rejects(leases.acquire(f.contexts[0]), { code: 'EXECUTION_LEASE_UNAVAILABLE' },
    'a replacement process must wait while the old process lease remains live');
  await leases.assertCurrent(second);
});

test('Phase 6 persistence fence: takeover advances durable position generation and rejects an old loaded document', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  const Position = require('../models/Position');
  const staleDocument = await Position.findOne({ _id: f.stores.Position[0]._id }).exec();
  const oldGeneration = f.stores.Position[0].executionOwnerGeneration;
  const lease = f.stores.ExecutionLease.find(item => String(item.brokerAccountId) === String(f.rows[0]._id));
  lease.leaseUntil = new Date(0);
  const execution = forRunner(runner);
  await assert.rejects(leases.assertCurrent(execution.leaseToken), { code: 'EXECUTION_LEASE_UNAVAILABLE' });
  await execution.prepareOwnership();
  assert.ok(f.stores.Position[0].executionOwnerGeneration > oldGeneration);
  staleDocument.activeTrailingSl = 99;
  await assert.rejects(staleDocument.save(), /VersionError|No matching document/);
});

test('Phase 6 database outage: lease renewal failure withholds subsequent broker ownership checks', async t => {
  const f = await fixture(t, { readyFeed: false });
  const token = await leases.acquire(f.contexts[0]);
  f.stores.ExecutionLeaseControl.fail = 'database unavailable';
  await assert.rejects(leases.renew(token), /database unavailable/);
  f.stores.ExecutionLeaseControl.fail = null;
  await assert.rejects(leases.assertCurrent({ ...token, generation: token.generation + 1 }), { code: 'EXECUTION_LEASE_UNAVAILABLE' });
});

test('Phase 6 database restoration: broker execution remains gated until a fresh recovery scan completes', async t => {
  const f = await fixture(t, { readyFeed: false });
  recovery.databaseUnavailable();
  await assert.rejects(recovery.assertExecutionAllowed(f.contexts[0]), { code: 'RECOVERY_NOT_READY' });
  await recovery.databaseRestored();
  await recovery.assertExecutionAllowed(f.contexts[0]);
  await recovery.assertStrategyStartAllowed(f.contexts[0]);
});

test('Phase 6 two-user recovery: each account restores only its own position and keeps scanner stopped', async t => {
  const f = await fixture(t, { readyFeed: false });
  const [runnerA, runnerB] = await Promise.all([f.runner(0, 'HeikenAshi', false), f.runner(1, 'HeikenAshi', false)]);
  await Promise.all([runnerA.executeEntry(f.contract, 100, 'BULLISH'), runnerB.executeEntry(f.contract, 100, 'BULLISH')]);
  const ids = f.stores.Position.map(position => String(position.tradeId));
  assert.equal(ids.length, 2);
  for (const runner of [runnerA, runnerB]) forRunner(runner).suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();
  const restoredA = f.engine.getRunner(`${f.contexts[0].userId}_HeikenAshi`);
  const restoredB = f.engine.getRunner(`${f.contexts[1].userId}_HeikenAshi`);
  assert.equal(restoredA.activeTradeId, ids.find(id => f.stores.Trade.some(trade => String(trade._id) === id && String(trade.userId) === f.contexts[0].userId)));
  assert.equal(restoredB.activeTradeId, ids.find(id => f.stores.Trade.some(trade => String(trade._id) === id && String(trade.userId) === f.contexts[1].userId)));
  assert.equal(restoredA.isRunning, false);
  assert.equal(restoredB.isRunning, false);
  assert.notEqual(restoredA.activeTradeId, restoredB.activeTradeId);
});

test('Phase 6 recovery fail-closed: unavailable broker evidence blocks account start and does not affect another account', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  assert.equal(f.stores.Position[0].executionSnapshot.executionMode, 'LIVE', 'failure scenario must exercise LIVE broker reconciliation');
  f.state.bookFailure = true;
  forRunner(runner).suspendForRecovery();
  f.engine.runners.clear();
  await recovery.initialize();
  const status = recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId);
  assert.equal(status.status, 'DEGRADED');
  await assert.rejects(recovery.assertStrategyStartAllowed(f.contexts[0]), { code: 'RECOVERY_REQUIRED' });
  await recovery.assertStrategyStartAllowed(f.contexts[1]);
});

test('Phase 6 recovery fail-closed: incomplete persisted risk snapshot is never reconstructed from defaults', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  f.stores.Position[0].executionSnapshot.stopLoss = undefined;
  forRunner(runner).suspendForRecovery();
  f.engine.runners.clear();
  await recovery.initialize();
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'DEGRADED');
  assert.equal(f.engine.getRunner(`${f.contexts[0].userId}_HeikenAshi`).isRunning, false);
  await assert.rejects(recovery.assertStrategyStartAllowed(f.contexts[0]), { code: 'RECOVERY_REQUIRED' });
});

test('Phase 6 late callback fence: a suspended manager cannot reacquire execution after recovery begins', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  const execution = forRunner(runner);
  execution.suspendForRecovery();
  const callsBefore = f.state.calls.length;
  await assert.rejects(execution.reconcile(), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.state.calls.length, callsBefore, 'a retired callback must not dispatch broker reads or mutations');
});

test('Phase 6 restart during exit: recovered fill evidence closes once and never resubmits SELL', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', true);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  f.state.onPlace = async ({ body, order }) => {
    if (body.transactiontype === 'SELL' && body.ordertype === 'MARKET') { order.orderstatus = 'open'; order.filledshares = 4; }
    return false;
  };
  await assert.rejects(runner.executeExit(f.contract, 120, 'Target'), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.stores.Position[0].remainingQuantity, 6);
  const sell = f.orders.get(String(f.rows[0]._id)).find(order => order.transactiontype === 'SELL' && order.ordertype === 'MARKET');
  assert.ok(sell);
  sell.filledshares = 10; sell.orderstatus = 'complete';
  const sellCount = f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.transactiontype === 'SELL' && call.body?.ordertype === 'MARKET').length;
  forRunner(runner).suspendForRecovery();
  f.engine.runners.clear();

  await recovery.initialize();

  assert.equal(f.stores.Position[0].status, 'CLOSED');
  assert.equal(f.stores.Trade[0].pnl, 200);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple' && call.body?.transactiontype === 'SELL' && call.body?.ordertype === 'MARKET').length, sellCount);
});

test('Phase 6 session expiry: an unresolved account waits for its own reconnect while another account remains usable', async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  forRunner(runner).suspendForRecovery();
  require('../services/activeAccountService').clearActiveAccount(f.contexts[0].userId, f.contexts[0].brokerAccountId);
  await recovery.initialize();
  assert.equal(recovery.getState(f.contexts[0].userId, f.contexts[0].brokerAccountId).status, 'WAITING_FOR_BROKER_SESSION');
  await assert.rejects(recovery.assertStrategyStartAllowed(f.contexts[0]), { code: 'RECOVERY_SESSION_REQUIRED' });
  await recovery.assertStrategyStartAllowed(f.contexts[1]);
});

test('Phase 6 ownership quarantine: unresolved records without verified account links block adoption by every user', async t => {
  const f = await fixture(t, { readyFeed: false });
  f.stores.Trade.push({ _id: 'legacy-unscoped-live-trade', executionMode: 'LIVE', exitPrice: undefined });
  await recovery.initialize();
  await assert.rejects(recovery.assertStrategyStartAllowed(f.contexts[0]), { code: 'RECOVERY_REQUIRED' });
  await assert.rejects(recovery.assertExecutionAllowed(f.contexts[1]), { code: 'RECOVERY_REQUIRED' });
});
