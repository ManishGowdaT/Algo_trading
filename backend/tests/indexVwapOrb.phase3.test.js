const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { fixture } = require('./helpers/executionFixture');
const { collections } = require('./helpers/mongooseMemory');
const Session = require('../models/StrategySession');
const Availability = require('../models/StrategyAvailability');
const Settings = require('../models/StrategySettings');
const sessions = require('../services/indexVwapOrbSession');
const availability = require('../services/indexVwapOrbAvailability');
const { validateStrategyConfig } = require('../utils/inputValidation');
const { RULE_VERSION } = require('../trading/strategies/indexVwapOrb');
const NOW = Date.parse('2026-10-16T10:00:00+05:30');
const config = { underlying: 'NIFTY', quantity: 10 };
function signal(n = 1, underlying = 'NIFTY', now = NOW) {
  return { strategyId: 'IndexVwapOrb', ruleVersion: RULE_VERSION, isEntry: true, underlying, direction: 'LONG',
    setupId: `setup-${n}`, signalId: `signal-${n}`, signalClosedAt: now, entryPrice: 100, stopLoss: 90, takeProfit: 120, riskPoints: 10 };
}
const contract = { exchange: 'NFO', underlying: 'NIFTY', expiry: '2026-10-30', strike: 25000,
  option_type: 'CE', symboltoken: '77', tradingsymbol: 'NIFTY-CE', lotSize: 10 };
async function setup(t) {
  const f = await fixture(t, { readyFeed: false });
  f.extra = collections(t, [Session, Availability, Settings]);
  // Driver-boundary fixture: BSON serialization normally removes Mongoose
  // document-array parent references before the database sees the update.
  const plain = value => {
    if (!value || typeof value !== 'object' || value instanceof Date || value instanceof mongoose.Types.ObjectId) return value;
    if (value.$__ && value.toObject) return plain(value.toObject());
    if (Array.isArray(value)) return Array.from(value, plain);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  };
  const original = Session.collection.findOneAndUpdate;
  Session.collection.findOneAndUpdate = (filter, mutation) => original(filter, plain(mutation));
  await availability.provision(f.contexts[0]);
  await Session.createIndexes();
  return f;
}
async function prepare(f, n = 1, options = {}) {
  return sessions.prepareEntry(f.contexts[0], { signal: signal(n), config, contract, now: NOW, ...options });
}
async function closeFilled(f, intent, fill = 10) {
  await f.models.OrderIntent.collection.updateOne({ _id: intent._id }, { $set: {
    status: 'FILLED', filledQuantity: fill, remainingQuantity: 0, positionId: intent.resultPositionId,
  } });
  f.stores.Position.push({ _id: intent.resultPositionId, userId: intent.userId, brokerAccountId: intent.brokerAccountId,
    strategyId: intent.strategyId, entryIntentId: intent._id, status: 'CLOSED', remainingQuantity: 0 });
}

test('validated settings preserve fixed rules, require valid quantities and support all indices', () => {
  for (const underlying of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
    const result = validateStrategyConfig('IndexVwapOrb', { ...config, underlying });
    assert.deepEqual(result.retestTolerancePointsByUnderlying, { NIFTY: 10, BANKNIFTY: 20, SENSEX: 30 });
    assert.equal(result.liveTradingConsent, false);
  }
  for (const change of [{ underlying: 'CRUDEOILM' }, { quantity: 0 }, { quantity: 2.1 }, { targetPoints: 99 },
    { riskReward: 4 }, { premiumMin: 50, premiumMax: 20 }, { strikeDepth: 0 }, { liveTradingConsent: null },
    { retestTolerancePointsByUnderlying: { NIFTY: -1 } }]) {
    assert.throws(() => validateStrategyConfig('IndexVwapOrb', { ...config, ...change }));
  }
});
test('explicit account provisioning is idempotent, new-user safe and never enables another account', async t => {
  const f = await setup(t);
  await availability.provision(f.contexts[0]);
  assert.equal(f.extra.StrategyAvailability.length, 1);
  assert.equal(f.stores.Strategy.filter(s => s.name === 'IndexVwapOrb').length, 1);
  assert.equal(await availability.enabled(f.contexts[1]), false);
  await assert.rejects(sessions.restore(f.contexts[1], NOW), { code: 'STRATEGY_ACCOUNT_DISABLED' });
  const manifests = [{ id: 'HeikenAshi' }, { id: 'IndexVwapOrb' }];
  assert.equal((await availability.manifestsForUser(manifests, f.contexts[0].userId)).length, 2);
  assert.equal((await availability.manifestsForUser(manifests, f.contexts[1].userId)).length, 1);
});
test('account settings are isolated, reloadable and do not reset daily state', async t => {
  const f = await setup(t);const service = require('../services/strategySettingsService');
  const saved = await service.save(f.contexts[0], 'IndexVwapOrb', config);
  assert.equal((await service.get(f.contexts[0], 'IndexVwapOrb')).config.quantity, 10);
  await assert.rejects(service.get(f.contexts[1], 'IndexVwapOrb'), { code: 'STRATEGY_ACCOUNT_DISABLED' });
  await assert.rejects(service.save(f.contexts[1], 'IndexVwapOrb', config), { code: 'STRATEGY_ACCOUNT_DISABLED' });
  assert.equal(String(saved.brokerAccountId), f.contexts[0].brokerAccountId);
  await prepare(f);
  await assert.rejects(service.save(f.contexts[0], 'IndexVwapOrb', { ...config, quantity: 20 }), { code: 'STRATEGY_SETTINGS_LOCKED' });
  assert.equal((await service.get(f.contexts[0], 'IndexVwapOrb')).config.quantity, 10);
});
test('reservation and entry request are durable before intent creation; duplicates/races produce one intent', async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([prepare(f), prepare(f), prepare(f, 2)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.stores.OrderIntent.length, 1);assert.equal(f.extra.StrategySession[0].entries.length, 1);
  assert.equal(f.extra.StrategySession[0].entries[0].state, 'INTENT_PREPARED');
  const restored = await sessions.restore(f.contexts[0], NOW);
  assert.equal(restored.entriesReserved, 1);assert.equal(restored.entriesFilled, 0);assert.equal(restored.blocked, true);
  assert.equal(f.state.calls.filter(c => c.path === '/angel/orders/simple').length, 0);
});
test('first partial fill counts once; restart/reconnect/index changes cannot allow a third entry', async t => {
  const f = await setup(t);const first = await prepare(f);
  await f.models.OrderIntent.collection.updateOne({ _id: first._id }, { $set: { status: 'PARTIALLY_FILLED', filledQuantity: 2, remainingQuantity: 8 } });
  assert.equal((await sessions.restore(f.contexts[0], NOW)).entriesFilled, 1);
  await f.models.OrderIntent.collection.updateOne({ _id: first._id }, { $set: { filledQuantity: 5, remainingQuantity: 5 } });
  assert.equal((await sessions.restore(f.contexts[0], NOW)).entriesFilled, 1);
  await closeFilled(f, first);const second = await prepare(f, 2, { config: { ...config, underlying: 'BANKNIFTY' },
    signal: signal(2, 'BANKNIFTY'), contract: { ...contract, underlying: 'BANKNIFTY' } });
  await closeFilled(f, second);
  const restored = await sessions.restore(f.contexts[0], NOW);
  assert.equal(restored.entriesFilled, 2);assert.equal(restored.entriesReserved, 0);
  const settled = await Promise.allSettled([prepare(f, 3), prepare(f, 4)]);
  assert.ok(settled.every(r => r.status === 'rejected' && r.reason.code === 'DAILY_ENTRY_LIMIT'));
  assert.equal(f.stores.OrderIntent.length, 2);
  // Rebuild service and execution lease state, then reconnect with a new session generation.
  require('../services/executionLeaseService').releaseLocal(f.contexts[0]);
  const modulePath = require.resolve('../services/indexVwapOrbSession');
  delete require.cache[modulePath];const restarted = require(modulePath);
  assert.equal((await restarted.restore(f.contexts[0], NOW)).entriesFilled, 2);
  await f.models.BrokerAccount.collection.updateOne({ _id: f.rows[0]._id }, { $set: { sessionGeneration: 2 } });
  require('../services/activeAccountService').setActiveAccount({ userId: f.contexts[0].userId,
    brokerAccountId: f.contexts[0].brokerAccountId, clientCode: 'CLIENT-A', sessionId: 'reconnected', sessionGeneration: 2, ownerGeneration: 0 });
  const reconnected = await f.accounts.resolve(f.contexts[0].userId, f.contexts[0].brokerAccountId);
  await assert.rejects(restarted.prepareEntry(reconnected, { signal: signal(5), config, contract, now: NOW }), { code: 'DAILY_ENTRY_LIMIT' });
});
test('unknown submission and orphan reservation retain capacity across days and fresh service load', async t => {
  const f = await setup(t);f.stores.OrderIntentControl.fail = 'Intent write unavailable';
  await assert.rejects(prepare(f), /Intent write unavailable/);
  f.stores.OrderIntentControl.fail = null;
  assert.equal(f.extra.StrategySession[0].entries[0].state, 'RESERVED');
  assert.equal((await sessions.restore(f.contexts[0], NOW)).blocked, true);
  assert.equal((await sessions.restore(f.contexts[0], NOW + 86400000)).blocked, true);
  await assert.rejects(prepare(f, 2), { code: 'ENTRY_OR_EXPOSURE_UNRESOLVED' });
});
test('confirmed unfilled rejection releases quota but never reuses the same setup', async t => {
  const f = await setup(t);const first = await prepare(f);
  await f.models.OrderIntent.collection.updateOne({ _id: first._id }, { $set: { status: 'UNKNOWN' } });
  assert.equal((await sessions.restore(f.contexts[0], NOW)).entriesReserved, 1);
  await f.models.OrderIntent.collection.updateOne({ _id: first._id }, { $set: { status: 'REJECTED', remainingQuantity: 0 } });
  const restored = await sessions.restore(f.contexts[0], NOW);
  assert.equal(restored.entriesReserved, 0);assert.equal(restored.entriesFilled, 0);assert.equal(restored.blocked, false);
  await assert.rejects(prepare(f), { code: 'DUPLICATE_ENTRY_SIGNAL' });
  await prepare(f, 2);assert.equal(f.stores.OrderIntent.length, 2);
});
test('missing indexes, invalid contract/lot, stale signal and live consent fail before reservation', async t => {
  const f = await setup(t);
  await assert.rejects(prepare(f, 1, { config: { ...config, liveTradingConsent: true } }), { code: 'INDEX_ORB_EXECUTION_NOT_READY' });
  await assert.rejects(prepare(f, 1, { contract: { ...contract, lotSize: 3 } }), { code: 'INVALID_RESOLVED_OPTION_CONTRACT' });
  await assert.rejects(prepare(f, 1, { now: NOW + 5001 }), { code: 'INVALID_OR_EXPIRED_ENTRY_SIGNAL' });
  const original = Session.collection.indexes;Session.collection.indexes = async () => [];
  t.after(() => { Session.collection.indexes = original; });
  await assert.rejects(prepare(f), { code: 'STRATEGY_SESSION_INDEX_MISSING' });
  assert.equal(f.stores.OrderIntent.length, 0);
});
test('checkpoints persist per underlying and reject older callbacks and foreign contexts', async t => {
  const f = await setup(t);
  await sessions.checkpoint(f.contexts[0], 'NIFTY', { asOf: NOW, state: 'WAITING_RETEST', processedClose: NOW }, NOW);
  await sessions.checkpoint(f.contexts[0], 'BANKNIFTY', { asOf: NOW, state: 'WAITING_BREAKOUT' }, NOW);
  const row = (await sessions.restore(f.contexts[0], NOW)).day;
  assert.equal(row.checkpoints.NIFTY.state, 'WAITING_RETEST');assert.equal(row.checkpoints.BANKNIFTY.state, 'WAITING_BREAKOUT');
  await assert.rejects(sessions.checkpoint(f.contexts[0], 'NIFTY', { asOf: NOW - 1 }, NOW), { code: 'STALE_CHECKPOINT' });
  await assert.rejects(sessions.checkpoint(f.contexts[0], 'NIFTY', { asOf: NOW + 1, processedClose: NOW - 60000 }, NOW), { code: 'STALE_CHECKPOINT' });
  await assert.rejects(sessions.checkpoint(f.contexts[1], 'NIFTY', { asOf: NOW }, NOW), { code: 'STRATEGY_ACCOUNT_DISABLED' });
});
test('session CAS conflict prevents an order intent, and stale owner cannot mutate admission', async t => {
  const f = await setup(t);await sessions.restore(f.contexts[0], NOW);
  const original = Session.collection.findOneAndUpdate;
  Session.collection.findOneAndUpdate = async () => null;
  t.after(() => { Session.collection.findOneAndUpdate = original; });
  await assert.rejects(prepare(f), { code: 'STRATEGY_SESSION_VERSION_CONFLICT' });
  assert.equal(f.stores.OrderIntent.length, 0);
  await f.models.BrokerAccount.collection.updateOne({ _id: f.rows[0]._id }, { $set: { sessionGeneration: 2 } });
  await assert.rejects(prepare(f, 2), /Stale broker account context/);
});
test('a failed intent after submit is not sufficient proof to free its reservation', async t => {
  const f = await setup(t);const intent = await prepare(f);
  await f.models.OrderIntent.collection.updateOne({ _id: intent._id }, { $set: { status: 'FAILED', attemptCount: 1,
    submittedAt: new Date(), remainingQuantity: 0 } });
  const result = await sessions.restore(f.contexts[0], NOW);
  assert.equal(result.blocked, true);assert.equal(result.entriesReserved, 1);
});
test('Phase 3 runner and generic position entry reject live execution before any broker order', async t => {
  const f = await setup(t);const runner = await f.runner(0, 'IndexVwapOrb', false);
  await assert.rejects(f.accounts.run(f.contexts[0], () => runner.start({ ...config, liveTradingConsent: true }, f.contexts[0].userId)),
    { code: 'INDEX_ORB_EXECUTION_NOT_READY' });
  await assert.rejects(require('../services/positionExecution').forRunner(runner).entry(contract, 100, 'BULLISH'), /reference-aware risk integration/);
  assert.equal(f.state.calls.filter(c => c.path === '/angel/orders/simple').length, 0);
});
