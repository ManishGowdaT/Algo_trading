const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/executionFixture');
const gateway = require('../services/executionGateway');
const { forRunner } = require('../services/positionExecution');
const proxy = require('../controllers/brokerProxyController');
const waitBook = () => new Promise(resolve => setTimeout(resolve, 1010));
const bodyFor = (f, quantity = 10) => ({ ...f.contract, quantity, transactiontype: 'SELL', producttype: 'CARRYFORWARD', ordertype: 'MARKET' });

test('Phase 5 production proxy: manual partial exit uses persisted instrument and reprotects remaining exposure', async t => {
  const f = await fixture(t); const runner = await f.runner(); await runner.executeEntry(f.contract, 100, 'BULLISH');
  const req = { method: 'POST', query: {}, body: bodyFor(f, 4), user: { _id: f.rows[0].userId }, accountContext: f.contexts[0] };
  let status, data;
  const res = { status(code) { status = code; return this; }, json(value) { data = value; return this; } };
  await f.accounts.run(f.contexts[0], () => proxy.forwardPost('/angel/orders/simple')(req, res));
  assert.equal(status, 200); assert.equal(data.item.response.status, true);
  assert.equal(f.stores.Position[0].remainingQuantity, 6); assert.equal(f.stores.Position[0].status, 'PROTECTED');
  assert.equal(f.stores.Trade[0].exitPrice, undefined);
  const last = f.state.calls.filter(call => call.body?.ordertype === 'SL').at(-1);
  assert.equal(last.body.quantity, 6); assert.equal(last.body.tradingsymbol, 'HELD-CE');
  await runner.manualExit(); assert.equal(f.stores.Trade[0].qty, 10); assert.equal(f.stores.Trade[0].pnl, 200);
});

test('Phase 5 gateway: unmanaged unknown mutation is durable and cannot be blindly repeated', async t => {
  const f = await fixture(t);
  f.state.onPlace = async ({ req }) => { req.socket.destroy(); return true; };
  const request = { ...bodyFor(f), transactiontype: 'BUY' };
  await assert.rejects(gateway.dispatch('/angel/orders/simple', request, f.contexts[0]), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.stores.OrderIntent[0].purpose, 'MANUAL'); assert.equal(f.stores.OrderIntent[0].status, 'UNKNOWN');
  await assert.rejects(gateway.dispatch('/angel/orders/simple', request, f.contexts[0]), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple').length, 1);
  assert.equal(f.stores.Position.length, 0); assert.equal(f.stores.Trade.length, 0);
});

test('Phase 5 gateway: B cannot cancel A and conflicting BUY cannot bypass managed exposure', async t => {
  const f = await fixture(t); const runner = await f.runner(); await runner.executeEntry(f.contract, 100, 'BULLISH');
  const order = f.orders.get(String(f.rows[0]._id)).find(item => item.ordertype === 'SL');
  await assert.rejects(gateway.dispatch(`/angel/orders/${order.orderid}/cancel`, { variety: 'NORMAL' }, f.contexts[1]), { status: 404 });
  await assert.rejects(gateway.dispatch('/angel/orders/simple', { ...bodyFor(f), transactiontype: 'BUY' }, f.contexts[0]), { code: 'RECONCILIATION_REQUIRED' });
  assert.equal(f.state.calls.filter(call => call.path.endsWith('/cancel')).length, 0);
  assert.equal(f.stores.Position[0].remainingQuantity, 10);
});

test('Phase 5 persistence: lifecycle increments, unsets and negative balancing quantities are rejected by Mongoose', async t => {
  const f = await fixture(t); const runner = await f.runner(0, 'HeikenAshi', false); await runner.executeEntry(f.contract, 100, 'BULLISH');
  const filter = { _id: f.stores.Position[0]._id, userId: f.rows[0].userId, brokerAccountId: f.rows[0]._id };
  for (const field of ['pendingEntryQuantity', 'abandonedEntryQuantity', 'completionPending']) {
    await assert.rejects(f.models.Position.updateOne(filter, { $inc: { [field]: 1 } }), /lifecycle increment/);
    await assert.rejects(f.models.Position.findOneAndUpdate(filter, { $unset: { [field]: 1 } }), /Cannot unset/);
  }
  await assert.rejects(f.models.Position.updateOne(filter, { $set: { remainingQuantity: 11, pendingEntryQuantity: -1 } }), /nonnegative integers/);
  assert.equal(f.stores.Position[0].remainingQuantity, 10);
});

test('Phase 5 protection: disappearance/expiry is visible without fabricated closure or resubmission', async t => {
  const f = await fixture(t); const runner = await f.runner(); await runner.executeEntry(f.contract, 100, 'BULLISH');
  const order = f.orders.get(String(f.rows[0]._id)).find(item => item.ordertype === 'SL'); order.orderstatus = 'expired';
  await waitBook(); await forRunner(runner).reconcile();
  assert.equal(f.stores.Position[0].status, 'UNPROTECTED'); assert.equal(f.stores.Trade[0].exitPrice, undefined);
  assert.equal(f.state.calls.filter(call => call.body?.ordertype === 'SL').length, 1);
});

test('Phase 5 trailing: replacement preserves thresholds and protective fill keeps trailing cooldown', async t => {
  const f = await fixture(t); const runner = await f.runner(0, 'ModifiedHeikenAshi');
  runner.config = { ...runner.config, exitStrategy: 'TRAILING_SL', initialSlPoints: 30, trailingStopPoints: 20, finalTargetPoints: 100 };
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  await forRunner(runner).trailing(90); assert.equal(runner.activeTrailingSl, 90);
  const order = f.orders.get(String(f.rows[0]._id)).filter(item => item.ordertype === 'SL').at(-1);
  order.orderstatus = 'complete'; order.filledshares = 10; order.averageprice = 90;
  await waitBook(); const at = Date.now(); await forRunner(runner).reconcile();
  assert.equal(f.stores.Trade[0].exitReason, 'Trailing SL'); assert.equal(f.stores.Trade[0].pnl, -100);
  assert.ok(runner.cooldownUntil >= at + 120000 && runner.cooldownUntil < Date.now() + 121000);
});

for (const name of ['HeikenAshi', 'ModifiedHeikenAshi', '5minBreakout']) for (const live of [false, true]) {
  test(`Phase 5 verified workflow: ${name} ${live ? 'LIVE' : 'PAPER'} preserves target, SL, intended quantity and cooldown`, async t => {
    const f = await fixture(t); const runner = await f.runner(0, name, live); runner.stopLoss = 70;
    await runner.executeEntry(f.contract, 100, 'BULLISH');
    assert.equal(runner.target, 120); assert.equal(runner.stopLoss, 70); assert.equal(runner.config.quantity, 10);
    assert.equal(f.stores.Trade[0].executionMode, live ? 'LIVE' : 'PAPER');
    await runner.executeExit(f.contract, 120, 'Target');
    assert.equal(f.stores.Trade[0].pnl, 200); assert.equal(f.stores.Position[0].status, 'CLOSED');
    const remaining = runner.cooldownUntil - Date.now(); const minutes = name === '5minBreakout' ? 1 : 2;
    assert.ok(remaining > minutes * 60000 - 1000 && remaining <= minutes * 60000);
    if (!live) assert.equal(f.state.calls.filter(call => call.path.endsWith('/simple')).length, 0);
  });
}

test('Phase 5 Stop: actual background monitor exits PAPER held exposure after Stop', async t => {
  const f = await fixture(t); const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH'); runner.stop(); f.state.quote = 120;
  t.mock.timers.tick(1000);
  const deadline = Date.now() + 5000;
  while (f.stores.Position[0].status !== 'CLOSED' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.stores.Position[0].status, 'CLOSED'); assert.equal(f.stores.Trade[0].exitReason, 'Target');
  assert.equal(runner.isRunning, false); assert.equal(runner.state, 'STOPPED');
});

test('Phase 5 partial BUY: manual exit cancels remaining BUY and closes only verified filled quantity', async t => {
  const f = await fixture(t); const runner = await f.runner();
  f.state.onPlace = async ({ body, order }) => { if (body.transactiontype === 'BUY') { order.filledshares = 4; order.orderstatus = 'open'; } return false; };
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), { code: 'RECONCILIATION_REQUIRED' });
  await runner.manualExit();
  assert.equal(f.stores.Position[0].abandonedEntryQuantity, 6); assert.equal(f.stores.Position[0].status, 'CLOSED');
  assert.equal(f.stores.Trade[0].qty, 4); assert.equal(f.stores.Trade[0].pnl, 80);
  assert.equal(f.state.calls.find(call => call.body?.transactiontype === 'SELL' && call.body.ordertype === 'MARKET').body.quantity, 4);
});

test('Phase 5 entry: missing uniqueness index fails closed before persistence or broker submission', async t => {
  const f = await fixture(t); const runner = await f.runner();
  t.mock.method(f.models.OrderIntent.collection, 'indexes', async () => []);
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), /uniqueness index/);
  assert.equal(f.stores.OrderIntent.length, 0); assert.equal(f.state.calls.filter(call => call.path.endsWith('/simple')).length, 0);
});

test('Phase 5 submitted BUY: Stop keeps the eventual fill owned and monitored without enabling entries', async t => {
  const f = await fixture(t); const runner = await f.runner();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  f.state.onPlace = async ({ body }) => { if (body.transactiontype === 'BUY') { entered(); await gate; } return false; };
  const entry = runner.executeEntry(f.contract, 100, 'BULLISH'); await ready;
  runner.stop(); assert.equal(forRunner(runner).hasExposure(), true); release(); await entry;
  assert.equal(runner.isRunning, false); assert.ok(runner.monitorInterval); assert.equal(f.stores.Position[0].status, 'PROTECTED');
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  assert.equal(f.state.calls.filter(call => call.body?.transactiontype === 'BUY').length, 1);
});

test('Phase 5 real order feed: stale/foreign events are rejected and duplicate owned events reconcile REST evidence once', async t => {
  const f = await fixture(t); const runner = await f.runner(); await runner.executeEntry(f.contract, 100, 'BULLISH');
  const service = await f.accounts.run(f.contexts[0], () => f.feeds.getOrderUpdateService());
  await forRunner(runner).eventsPromise;
  const order = f.orders.get(String(f.rows[0]._id)).find(item => item.ordertype === 'SL');
  const event = JSON.stringify({ orderData: { orderid: order.orderid, orderstatus: 'complete', filledshares: 10, averageprice: 999 } });
  service.handleMessage(event, { ...service.accountIdentity, sessionGeneration: 0 });
  service.handleMessage(event, { ...service.accountIdentity, brokerAccountId: f.contexts[1].brokerAccountId });
  assert.equal(f.stores.Trade[0].exitPrice, undefined);
  order.orderstatus = 'complete'; order.filledshares = 10; order.averageprice = 70; await waitBook();
  service.ws.onmessage({ data: event }); service.ws.onmessage({ data: event });
  const deadline = Date.now() + 5000;
  while (f.stores.Position[0].status !== 'CLOSED' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.stores.Trade[0].exitPrice, 70); assert.equal(f.stores.Position[0].filledExitQuantity, 10);
  assert.equal(f.state.calls.filter(call => call.body?.transactiontype === 'SELL' && call.body.ordertype === 'MARKET').length, 0);
});

test('Phase 5 held candles: reversal after strike rotation and Stop exits exact held instrument through real plugin', async t => {
  const f = await fixture(t); const runner = await f.runner(0, 'HeikenAshi', false);
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  await runner.startScanLoop(); runner.ceContract = { ...f.contract, symboltoken: '88', tradingsymbol: 'ROTATED-CE' }; runner.stop();
  const service = [...f.feeds.accounts.values()].find(item => item.sessionIdentity.brokerAccountId === f.contexts[0].brokerAccountId);
  const builder = service.candleBuilders.get('position:NFO_77_FIVE_MINUTE');
  builder.candles = [
    { time: 1, open: 120, high: 122, low: 108, close: 110 },
    { time: 2, open: 110, high: 111, low: 98, close: 100 },
    { time: 3, open: 100, high: 101, low: 88, close: 90 },
  ];
  runner.currentLtp = 90;
  service.emit('candle:closed', { ...service.sessionIdentity, exchange: 'NFO', symboltoken: '77', interval: 'FIVE_MINUTE' });
  const deadline = Date.now() + 5000;
  while (f.stores.Position[0].status !== 'CLOSED' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.stores.Trade[0].exitReason, 'Reversal'); assert.equal(f.stores.Trade[0].premium, 'HELD-CE');
  assert.equal(runner.isRunning, false); assert.equal(f.stores.Trade[0].pnl, -100);
});

test('Phase 5 partial BUY: target monitoring continues while the remaining BUY is pending, including after Stop', async t => {
  const f = await fixture(t); const runner = await f.runner();
  f.state.onPlace = async ({ body, order }) => { if (body.transactiontype === 'BUY') { order.filledshares = 4; order.orderstatus = 'open'; } return false; };
  await assert.rejects(runner.executeEntry(f.contract, 100, 'BULLISH'), { code: 'RECONCILIATION_REQUIRED' });
  runner.stop(); f.state.quote = 120; t.mock.timers.tick(1000);
  const deadline = Date.now() + 7000;
  while (f.stores.Position[0].status !== 'CLOSED' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.stores.Position[0].status, 'CLOSED'); assert.equal(f.stores.Trade[0].exitReason, 'Target');
  assert.equal(f.stores.Trade[0].qty, 4); assert.equal(f.stores.Trade[0].pnl, 80);
  assert.equal(f.state.calls.find(call => call.body?.transactiontype === 'SELL' && call.body.ordertype === 'MARKET').body.quantity, 4);
});

test('Phase 5 held history: PE warm-up is captured durably and cannot be replaced by rotated scanner history', async t => {
  const f = await fixture(t); const runner = await f.runner(0, 'HeikenAshi', false);
  const old = { time: 1, open: 100, high: 110, low: 90, close: 105 };
  runner.previousDayCandles.pe = [old];
  await runner.executeEntry(f.contract, 100, 'BEARISH');
  runner.peContract = { ...f.contract, symboltoken: '99', tradingsymbol: 'ROTATED-PE' };
  runner.previousDayCandles.pe = [{ ...old, time: 2, close: 999 }]; runner.previousDayCandles.ce = [{ ...old, time: 3, close: 999 }];
  assert.equal(runner.heldSide, 'pe');
  assert.deepEqual(runner.getCalculationCandles(runner.activeTradeContract, [], 'ce'), [old]);
  assert.deepEqual(f.stores.OrderIntent.find(intent => intent.purpose === 'ENTRY').executionMetadata.warmupCandles, [old]);
  await forRunner(runner).reconcile(); assert.deepEqual(runner.heldWarmupCandles, [old]);
});

test('Phase 5 request budget: frontend/query reads share one bounded account orderbook request while B remains independent', async t => {
  const f = await fixture(t); const { requestPython } = require('../services/pythonApiClient');
  await Promise.all([
    requestPython('/angel/orderbook', { context: f.contexts[0] }),
    requestPython('/angel/orderbook?refresh=true', { context: f.contexts[0] }),
    requestPython('/angel/orderbook', { context: f.contexts[1] }),
  ]);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orderbook' && call.account === f.contexts[0].brokerAccountId).length, 1);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orderbook' && call.account === f.contexts[1].brokerAccountId).length, 1);
  await requestPython('/angel/orderbook?refresh=again', { context: f.contexts[0] });
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orderbook').length, 2);
});

test('Phase 5 manual API compatibility: original attempt ID/request/response are preserved and a working manual order remains cancellable', async t => {
  const f = await fixture(t);
  const request = { ...bodyFor(f, 2), ordertype: 'SL', triggerprice: 70 };
  const placed = await gateway.dispatch('/angel/orders/simple', request, f.contexts[0]);
  const intent = f.stores.OrderIntent[0];
  assert.equal(placed.data.item.id, intent.brokerResponse.item.id);
  assert.equal(placed.data.item.request.transactiontype, 'SELL');
  assert.deepEqual(placed.data.item.response, intent.brokerResponse.item.response);
  const cancelled = await gateway.dispatch(`/angel/orders/${intent.brokerOrderId}/cancel`, { variety: 'NORMAL' }, f.contexts[0]);
  assert.equal(cancelled.data.status, true); assert.equal(cancelled.data.data.orderid, intent.brokerOrderId);
  assert.equal(f.stores.OrderIntent.find(item => item.purpose === 'MANUAL').status, 'CANCELLED');
  assert.equal(f.stores.OrderIntent.find(item => item.purpose === 'CANCEL').status, 'CANCELLED');
});

test('Phase 5 rejected BUY: no-fill terminal evidence clears pending runtime and preserves ordinary Stop behaviour', async t => {
  const f = await fixture(t); const runner = await f.runner();
  f.state.onPlace = async ({ order, respond }) => {
    order.filledshares = 0; order.orderstatus = 'rejected'; respond({ item: { response: { status: false, errorcode: 'REJECTED' } } }); return true;
  };
  await runner.executeEntry(f.contract, 100, 'BULLISH');
  assert.equal(forRunner(runner).hasExposure(), false); assert.equal(runner.pendingEntryQuantity, 0);
  assert.equal(runner.positionState, 'NONE'); assert.equal(runner.state, 'SCANNING');
  assert.equal(f.stores.Position.length, 0); assert.equal(f.stores.Trade.length, 0);
  runner.stop(); assert.equal(runner.getStatus().pendingEntryQuantity, 0); assert.equal(runner.state, 'STOPPED');
});
