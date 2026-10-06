const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/executionFixture');
const { forRunner } = require('../services/positionExecution');
const mutations = state => state.calls.filter(call => call.path === '/angel/orders/simple');

for (const timestamp of [null, 'stale', 'future']) test(`Held monitor rejects ${timestamp || 'missing'} exchange timestamp and resumes on fresh data`, async t => {
  const f = await fixture(t, { readyFeed: true });
  const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  f.state.quote = 125;
  f.state.quoteTimestamp = () => timestamp === 'stale' ? Date.now()-60000 : timestamp === 'future' ? Date.now()+60000 : undefined;
  t.mock.timers.tick(1000); await new Promise(resolve => setTimeout(resolve, 80));
  assert.notEqual(f.stores.Position[0].status, 'CLOSED');
  assert.equal(runner.lastQuoteReceivedAt, undefined);
  assert.match(runner.message, /degraded/);
  f.state.quoteTimestamp = () => Date.now();
  t.mock.timers.tick(1000);
  for (let i = 0; i < 100 && f.stores.Position[0].status !== 'CLOSED'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.stores.Position[0].status, 'CLOSED');
  assert.equal(f.stores.Trade[0].exitReason, 'Target');
});

for (const live of [false, true]) test(`Partial ${live ? 'LIVE' : 'PAPER'} exit preserves next entry configuration`, async t => {
  const f = await fixture(t, { readyFeed: false });
  const runner = await f.runner(0, 'HeikenAshi', live);
  const execution = forRunner(runner);
  const config = structuredClone(runner.config);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  await execution.exit('Manual', 120, 4);
  assert.equal(runner.remainingQuantity, 6);
  await execution.exit('Manual', 120);
  assert.deepEqual(runner.config, config);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  const entries = f.stores.OrderIntent.filter(intent => intent.purpose === 'ENTRY');
  assert.deepEqual(entries.map(intent => intent.requestedQuantity), [10, 10]);
});

test('Phase 5 production: durable PAPER entry/exit preserves quantities, thresholds and cooldown without broker mutations', async t => {
  const f = await fixture(t); const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  assert.equal(f.stores.Position[0].remainingQuantity, 10);
  assert.equal(runner.protectiveStopPrice, 70); assert.equal(runner.target, 120);
  await runner.executeExit(f.contract, 120, 'Target');
  assert.equal(f.stores.Trade[0].exitPrice, 120); assert.equal(f.stores.Trade[0].pnl, 200);
  assert.equal(f.stores.Position[0].status, 'CLOSED'); assert.equal(runner.state, 'COOLDOWN');
  assert.equal(mutations(f.state).length, 0);
});

test('Phase 5 production: double entry, manual-v-auto exit and double exit submit only one BUY and one SELL', async t => {
  const f = await fixture(t); const runner = await f.runner();
  await Promise.all([runner.executeEntry(f.contract, 100, 'BULLISH'), runner.executeEntry(f.contract, 100, 'BULLISH')]);
  runner.currentLtp = 120;
  await Promise.all([runner.manualExit(), runner.executeExit(f.contract, 120, 'Target')]);
  const market = mutations(f.state).filter(call => call.body.ordertype === 'MARKET');
  assert.deepEqual(market.map(call => call.body.transactiontype), ['BUY', 'SELL']);
  assert.equal(f.stores.Trade[0].positionState, 'CLOSED'); assert.equal(runner.activeTradeId, null);
});

test('Phase 5 production: unknown BUY blocks another BUY and never synthesizes a position from similar broker orders', async t => {
  const f = await fixture(t); const runner = await f.runner();
  f.state.onPlace = async ({ body, req }) => { if (body.transactiontype === 'BUY') { req.socket.destroy(); return true; } return false; };
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.stores.OrderIntent[0].status, 'UNKNOWN');
  await assert.rejects(forRunner(runner).reconcile(), { code: 'RECONCILIATION_REQUIRED' });
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  assert.equal(mutations(f.state).length, 1); assert.equal(f.stores.Position.length, 0);
  runner.stop(); assert.equal(forRunner(runner).hasExposure(), true); assert.ok(forRunner(runner).timer);
});

test('Phase 5 production: unknown SELL cannot cause duplicate sale or false close', async t => {
  const f = await fixture(t); const runner = await f.runner();
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  f.state.onPlace = async ({ body, req }) => { if (body.transactiontype === 'SELL' && body.ordertype === 'MARKET') { req.socket.destroy(); return true; } return false; };
  await assert.rejects(runner.executeExit(f.contract, 120, 'Target'), { code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(runner.manualExit(), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(mutations(f.state).filter(call => call.body.ordertype === 'MARKET' && call.body.transactiontype === 'SELL').length, 1);
  assert.equal(f.stores.Trade[0].exitPrice, undefined); assert.ok(runner.activeTradeId);
});

test('Phase 5 production: partial BUY remains durable and later fills resize only held exposure', async t => {
  const f = await fixture(t); const runner = await f.runner();
  f.state.onPlace = async ({ body, order }) => { if (body.transactiontype === 'BUY') { order.orderstatus = 'open'; order.filledshares = 4; } return false; };
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.stores.Position[0].remainingQuantity, 4); assert.equal(f.stores.Position[0].pendingEntryQuantity, 6);
  const order = f.orders.get(String(f.rows[0]._id))[0]; order.filledshares = 10; order.orderstatus = 'complete';
  await new Promise(resolve => setTimeout(resolve, 1010)); await forRunner(runner).reconcile();
  assert.equal(f.stores.Position[0].remainingQuantity, 10); assert.equal(f.stores.Position[0].pendingEntryQuantity, 0);
  assert.equal(mutations(f.state).find(call => call.body.ordertype === 'SL').body.quantity, 10);
});

test('Phase 5 production: partial SELL, duplicate and late events cannot double count fills', async t => {
  const f = await fixture(t); const runner = await f.runner();
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  f.state.onPlace = async ({ body, order }) => { if (body.transactiontype === 'SELL' && body.ordertype === 'MARKET') { order.orderstatus = 'open'; order.filledshares = 4; } return false; };
  await assert.rejects(runner.executeExit(f.contract, 120, 'Target'), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.stores.Position[0].remainingQuantity, 6); assert.equal(f.stores.Position[0].filledExitQuantity, 4);
  const service = await f.accounts.run(f.contexts[0], () => f.feeds.getOrderUpdateService());
  const event = { orderid: 'unowned-event', status: 'complete', filledshares: 10, averageprice: 999 };
  service.emit('order:update', event, { ...f.contexts[1] }); service.emit('order:update', event, { ...f.contexts[0] });
  await forRunner(runner).reconcile(); assert.equal(f.stores.Position[0].filledExitQuantity, 4);
  const order = f.orders.get(String(f.rows[0]._id)).find(item => item.transactiontype === 'SELL' && item.ordertype === 'MARKET');
  order.filledshares = 10; order.orderstatus = 'complete';
  await new Promise(resolve => setTimeout(resolve, 1010)); await forRunner(runner).reconcile();
  await forRunner(runner).reconcile();
  assert.equal(f.stores.Position[0].filledExitQuantity, 10); assert.equal(f.stores.Position[0].status, 'CLOSED');
  assert.equal(f.stores.Trade[0].pnl, 200);
});

test('Phase 5 production: protection rejection leaves exposure open and visible', async t => {
  const f = await fixture(t); const runner = await f.runner();
  f.state.onPlace = async ({ body, order, respond }) => {
    if (body.ordertype === 'SL') { order.orderstatus = 'rejected'; respond({ item: { response: { status: false, errorcode: 'REJECTED' } } }); return true; }
    return false;
  };
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.stores.Position[0].status, 'UNPROTECTED'); assert.ok(runner.activeTradeId);
  assert.equal(f.stores.Trade[0].exitPrice, undefined);
});

test('Phase 5 production: protective cancel/fill race consumes fill evidence instead of submitting a second SELL', async t => {
  const f = await fixture(t); const runner = await f.runner(); await runner.executeEntry(f.contract, 100, 'BULLISH');
  f.state.onCancel = async ({ order, respond }) => {
    order.orderstatus = 'complete'; order.filledshares = order.quantity; order.averageprice = 70;
    respond({ status: true, data: { orderid: order.orderid } }); return true;
  };
  await runner.manualExit();
  assert.equal(mutations(f.state).filter(call => call.body.ordertype === 'MARKET' && call.body.transactiontype === 'SELL').length, 0);
  assert.equal(f.stores.Trade[0].exitPrice, 70); assert.equal(f.stores.Trade[0].exitReason, 'SL');
});

test('Phase 5 production: strike rotation cannot change the persisted manual exit instrument', async t => {
  const f = await fixture(t); const runner = await f.runner(); await runner.executeEntry(f.contract, 100, 'BULLISH');
  runner.ceContract = { exchange: 'NFO', symboltoken: '999', tradingsymbol: 'NEW-CE' };
  runner.peContract = { exchange: 'NFO', symboltoken: '998', tradingsymbol: 'NEW-PE' };
  await runner.manualExit();
  const sell = mutations(f.state).find(call => call.body.ordertype === 'MARKET' && call.body.transactiontype === 'SELL');
  assert.equal(sell.body.symboltoken, '77'); assert.equal(sell.body.tradingsymbol, 'HELD-CE');
});

test('Phase 5 production: intent persistence failure prevents mutation; completion persistence failure retains pending ownership', async t => {
  const f = await fixture(t); const runner = await f.runner();
  f.stores.OrderIntentControl.fail = 'database unavailable';
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), /database unavailable/);
  assert.equal(mutations(f.state).length, 0); f.stores.OrderIntentControl.fail = null;
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  f.stores.TradeControl.fail = write => write.$set?.positionState === 'CLOSED' ? 'trade write unavailable' : null;
  await assert.rejects(runner.manualExit(), /trade write unavailable/);
  assert.ok(runner.activeTradeId); assert.equal(f.stores.Trade[0].exitPrice, undefined);
  assert.equal(f.stores.Position[0].completionPending, true); assert.notEqual(f.stores.Position[0].status, 'CLOSED');
  f.stores.TradeControl.fail = null; await forRunner(runner).reconcile();
  assert.equal(f.stores.Position[0].status, 'CLOSED'); assert.equal(runner.activeTradeId, null);
  assert.equal(mutations(f.state).filter(call => call.body.ordertype === 'MARKET' && call.body.transactiontype === 'SELL').length, 1);
});

test('Phase 5 production: Stop retains held monitoring and settings while concurrent users cannot interfere', async t => {
  const f = await fixture(t); const [a, b] = await Promise.all([f.runner(0), f.runner(1)]);
  await Promise.all([a.executeEntry(f.contract, 100, 'BULLISH'), b.executeEntry(f.contract, 100, 'BULLISH')]);
  const held = a.activeTradeId; a.stop();
  assert.equal(a.activeTradeId, held); assert.ok(a.monitorInterval); assert.equal(b.isRunning, true);
  await a.executeEntry(f.contract, 100, 'BULLISH');
  await assert.rejects(f.accounts.run(f.contexts[0], () => f.engine.startStrategy(a.userId, 'HeikenAshi', { liveTradingConsent: false })), /cannot change/);
  await Promise.all([a.manualExit(), b.manualExit()]);
  assert.equal(f.stores.Position.filter(position => position.status === 'CLOSED').length, 2);
  for (const call of mutations(f.state)) assert.equal(call.headers['x-active-user-id'], call.account === String(f.rows[0]._id) ? String(f.rows[0].userId) : String(f.rows[1].userId));
});
