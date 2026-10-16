const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { fixture } = require('./helpers/executionFixture');
const { collections } = require('./helpers/mongooseMemory');
const Session = require('../models/StrategySession');
const Availability = require('../models/StrategyAvailability');
const availability = require('../services/indexVwapOrbAvailability');
const sessions = require('../services/indexVwapOrbSession');
const { forRunner } = require('../services/positionExecution');
const risk = require('../services/referenceRisk');
const { RULE_VERSION } = require('../trading/strategies/indexVwapOrb');
const NOW = Date.parse('2026-10-16T10:00:00+05:30');
async function setup(t, direction = 'LONG', live = false, partial = false) {
  const f = await fixture(t);f.extra = collections(t, [Session, Availability]);
  const original = Session.collection.findOneAndUpdate;
  const plain = v => !v || typeof v !== 'object' || v instanceof Date || v instanceof mongoose.Types.ObjectId ? v
    : v.$__ && v.toObject ? plain(v.toObject()) : Array.isArray(v) ? Array.from(v, plain)
      : Object.fromEntries(Object.entries(v).map(([k,x]) => [k,plain(x)]));
  Session.collection.findOneAndUpdate = (query, update) => original(query, plain(update));
  await availability.provision(f.contexts[0]);await Session.createIndexes();
  if (live) await Availability.collection.updateOne({ userId: f.contexts[0].userId }, { $set: { liveExecutionEnabled: true } });
  const originalNow = Date.now;Date.now = () => NOW;t.after(() => { Date.now = originalNow; });
  const runner = await f.runner(0, 'IndexVwapOrb', false);
  runner.config = { underlying: 'NIFTY', quantity: 10, strikeMode: 'ATM', strikeDepth: 1, premiumMin: 0, premiumMax: 1000, liveTradingConsent: live };
  const signal = { strategyId: 'IndexVwapOrb', ruleVersion: RULE_VERSION, isEntry: true, underlying: 'NIFTY', direction,
    setupId: 'setup', signalId: 'signal', signalClosedAt: NOW,
    entryPrice: 25000, stopLoss: direction === 'LONG' ? 24990 : 25010, takeProfit: direction === 'LONG' ? 25020 : 24980, riskPoints: 10 };
  const contract = { ...f.contract, underlying: 'NIFTY', expiry: '2026-10-30', strike: 25000, lot_size: 10, option_type: direction === 'LONG' ? 'CE' : 'PE' };
  const intent = await sessions.prepareEntry(f.contexts[0], { signal, contract, config: runner.config, now: NOW });
  const execution = forRunner(runner, { feed: f.feeds });
  if (partial) f.state.onPlace = async ({ body, order }) => {
    if (body.transactiontype === 'BUY') { order.orderstatus = 'open'; order.filledshares = '4'; order.unfilledshares = '6'; }
    return false;
  };
  if (live) execution.referenceEntryMargin = async () => {}; // fixture has no margin endpoint; tested separately below
  await execution.executePreparedReferenceEntry(intent._id);
  return { ...f, runner, execution, signal, contract, intent };
}
for (const direction of ['LONG', 'SHORT']) test(`${direction} index risk persists separately from actual option fill and paper exit P&L`, async t => {
  const f = await setup(t, direction);const position = f.stores.Position[0];
  assert.equal(position.averageEntryPrice, 100);assert.equal(position.executionSnapshot.entryPrice, 100);
  assert.equal(position.executionSnapshot.referenceRisk.entry, 25000);
  assert.equal(position.executionSnapshot.stopLoss, undefined);assert.equal(position.status, 'UNPROTECTED');
  assert.equal(f.stores.OrderIntent.filter(x => x.purpose === 'PROTECT').length, 0);
  const snapshot = position.executionSnapshot;
  const quote = { exchange: 'NSE', symboltoken: '99926000', ltp: direction === 'LONG' ? 25020 : 24980, quoteTimestamp: NOW };
  assert.equal(risk.reason(snapshot, quote, NOW), 'Target');
  assert.equal(risk.reason(snapshot, { ...quote, ltp: direction === 'LONG' ? 24990 : 25010 }, NOW), 'SL');
  f.state.quote = 115;
  await f.execution.exit('Target', 25020);
  assert.equal(f.stores.Trade[0].exitPrice, 115);assert.equal(f.stores.Trade[0].pnl, 150);
  assert.equal((await sessions.restore(f.contexts[0], NOW)).entriesFilled, 1);
  assert.equal(f.state.calls.filter(c => c.path === '/angel/orders/simple').length, 0);
});
test('persisted EOD exits at 15:20 with unavailable spot, even when scanner stopped', async t => {
  const f = await setup(t);const stop = f.runner.stop.bind(f.runner);
  f.accounts.run(f.contexts[0], stop);assert.equal(f.runner.isRunning, false);
  Date.now = () => Date.parse('2026-10-16T15:20:00+05:30');
  f.state.quote = 90;
  await f.execution.monitorReferenceRisk();
  assert.equal(f.stores.Position[0].status, 'CLOSED');assert.equal(f.stores.Trade[0].exitReason, 'EOD');
  assert.equal(f.stores.Position[0].referenceTrigger.indexPrice, null);
  assert.equal(f.stores.Trade[0].exitPrice, 90);
});
test('stale or mismatched spot never triggers a threshold exit; EOD does not require spot', async t => {
  const f = await setup(t);const snapshot = f.stores.Position[0].executionSnapshot;
  for (const quote of [null, { exchange: 'NSE', symboltoken: '99926000', ltp: 25100, quoteTimestamp: NOW - 6000 },
    { exchange: 'NFO', symboltoken: '99926000', ltp: 25100, quoteTimestamp: NOW }]) {
    assert.throws(() => risk.reason(snapshot, quote, NOW), /stale/);
  }
  assert.equal(risk.reason(snapshot, null, snapshot.referenceRisk.squareOffAt), 'EOD');
});
test('competing manual/EOD exits produce one sell intent and no option/index price mixing', async t => {
  const f = await setup(t);Date.now = () => Date.parse('2026-10-16T15:20:01+05:30');
  const results = await Promise.allSettled([f.execution.exit('Manual', 25000), f.execution.monitorReferenceRisk()]);
  assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.equal(f.stores.OrderIntent.filter(x => x.purpose === 'EXIT').length, 1);
  assert.equal(f.stores.Position[0].remainingQuantity, 0);
});
test('recovery restores immutable reference risk and manages a stopped runner', async t => {
  const f = await setup(t);const persisted = structuredClone(f.stores.Position[0].executionSnapshot.referenceRisk);
  f.execution.suspendForRecovery();
  const runner = f.engine.replaceForRecovery(f.contexts[0].userId, 'IndexVwapOrb');
  runner.accountContext = f.contexts[0];runner.userId = f.contexts[0].userId;runner.isRunning = false;
  const execution = forRunner(runner, { feed: f.feeds });
  await execution.resume();assert.deepEqual(runner.referenceRisk, persisted);
  Date.now = () => Date.parse('2026-10-17T09:15:00+05:30');
  await execution.monitorReferenceRisk();assert.equal(f.stores.Trade[0].exitReason, 'EOD');
});
test('explicitly gated mocked LIVE entry uses one prepared buy and never submits an index-priced stop', async t => {
  const f = await setup(t, 'SHORT', true);
  assert.equal(f.stores.Position[0].executionSnapshot.executionMode, 'LIVE');
  assert.equal(f.stores.OrderIntent.filter(x => x.purpose === 'ENTRY').length, 1);
  assert.equal(f.state.calls.filter(c => c.path === '/angel/orders/simple' && c.body.transactiontype === 'BUY').length, 1);
  assert.equal(f.stores.OrderIntent.filter(x => x.purpose === 'PROTECT').length, 0);
  Date.now = () => Date.parse('2026-10-16T15:20:00+05:30');
  await f.execution.monitorReferenceRisk();
  assert.equal(f.stores.Trade[0].exitReason, 'EOD');
  assert.equal(f.state.calls.filter(c => c.path === '/angel/orders/simple' && c.body.transactiontype === 'SELL').length, 1);
});
test('missing broker margin response fails closed', async t => {
  const f = await setup(t);
  await assert.rejects(f.execution.referenceEntryMargin(f.intent), /margin|funds/);
});
test('EOD cancels partially filled reference buy and sells only verified filled quantity', async t => {
  const f = await setup(t, 'LONG', true, true);
  assert.equal(f.stores.Position[0].remainingQuantity, 4);assert.equal(f.stores.Position[0].pendingEntryQuantity, 6);
  Date.now = () => Date.parse('2026-10-16T15:20:00+05:30');
  await f.execution.monitorReferenceRisk();
  const sells = f.state.calls.filter(c => c.path === '/angel/orders/simple' && c.body.transactiontype === 'SELL');
  assert.equal(sells.length, 1);assert.equal(Number(sells[0].body.quantity), 4);
  assert.equal(f.stores.Position[0].status, 'CLOSED');assert.equal(f.stores.Trade[0].qty, 4);
});
test('startup account recovery accepts reference thresholds without premium stop fields and leaves scanning off', async t => {
  const f = await setup(t);
  f.runner.isRunning = false;
  const recovery = require('../services/startupRecovery');
  const result = await recovery.recoverAccount(f.contexts[0]);
  assert.equal(result.status, 'READY');assert.equal(f.runner.isRunning, false);
  assert.equal(f.runner.stopLoss, 24990);assert.equal(f.runner.target, 25020);
  assert.equal(f.runner.monitorInterval, null);
});
