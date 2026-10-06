const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const BrokerAccount = require('../models/BrokerAccount');
const OrderIntent = require('../models/OrderIntent');
const Position = require('../models/Position');
const Strategy = require('../models/Strategy');
const StrategySettings = require('../models/StrategySettings');
const Trade = require('../models/Trade');
const accountRepository = require('../services/accountRepository');

const newId = () => new mongoose.Types.ObjectId();
const ids = { user: newId(), account: newId(), strategy: newId(), trade: newId(), position: newId(), intent: newId() };

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = key.split('.').reduce((value, part) => value?.[part], doc);
    if (expected && typeof expected === 'object' && '$exists' in expected) return (actual !== undefined) === expected.$exists;
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.some(value => String(value) === String(actual));
    if (expected && typeof expected === 'object' && '$ne' in expected) return String(actual) !== String(expected.$ne);
    if (expected && typeof expected === 'object' && !mongoose.isValidObjectId(expected)) return false;
    return String(actual) === String(expected);
  });
}

function stubCollection(t, Model, seed = []) {
  const collection = Model.collection;
  const original = {
    findOne: collection.findOne,
    findOneAndUpdate: collection.findOneAndUpdate,
    findOneAndDelete: collection.findOneAndDelete,
  };
  const records = seed;
  const writes = [];
  collection.findOne = async (filter) => records.find(record => matches(record, filter)) || null;
  collection.findOneAndUpdate = async (filter, update) => {
    writes.push({ kind: 'update', filter, update });
    const record = records.find(item => matches(item, filter));
    if (!record) return null;
    for (const [field, value] of Object.entries(update.$set || {})) {
      const keys = field.split('.');
      let target = record;
      while (keys.length > 1) target = target[keys.shift()];
      target[keys[0]] = value;
    }
    for (const [field, amount] of Object.entries(update.$inc || {})) record[field] = (record[field] || 0) + amount;
    return { ...record };
  };
  collection.findOneAndDelete = async (filter) => {
    writes.push({ kind: 'delete', filter });
    const index = records.findIndex(record => matches(record, filter));
    return index < 0 ? null : records.splice(index, 1)[0];
  };
  t.after(() => {
    collection.findOne = original.findOne;
    collection.findOneAndUpdate = original.findOneAndUpdate;
    collection.findOneAndDelete = original.findOneAndDelete;
  });
  return { records, writes };
}

function positionRecord(overrides = {}) {
  return {
    _id: ids.position, userId: ids.user, brokerAccountId: ids.account, strategyId: ids.strategy, tradeId: ids.trade,
    status: 'PROTECTED', executionSnapshot: {
      executionMode: 'LIVE', quantity: 10, underlying: 'NIFTY', exchange: 'NFO',
      tradingsymbol: 'NIFTY-OPT-CE', symboltoken: '123', entryPrice: 100,
    }, remainingQuantity: 10, filledExitQuantity: 0, version: 0, intentRevision: 0,
    ...overrides,
  };
}

function intentRecord(overrides = {}) {
  return {
    _id: ids.intent, intentId: 'intent-1', idempotencyKey: 'idem-1',
    userId: ids.user, brokerAccountId: ids.account, strategyId: ids.strategy,
    requestSnapshot: { action: 'BUY', exchange: 'NFO', tradingsymbol: 'NIFTY-OPT-CE', symboltoken: '123', ordertype: 'MARKET', producttype: 'INTRADAY', quantity: 10 },
    status: 'SUBMITTING', requestedQuantity: 10, filledQuantity: 0, remainingQuantity: 10,
    version: 0, ...overrides,
  };
}

function fakeSession(t) {
  const session = {
    async withTransaction(callback) { return callback(); },
    async endSession() {},
  };
  const original = Position.db.startSession;
  Position.db.startSession = async () => session;
  t.after(() => { Position.db.startSession = original; });
  return session;
}

test('Mongoose findOneAndUpdate rejects closing a position that still has exposure', async (t) => {
  const persistence = stubCollection(t, Position, [positionRecord()]);
  await assert.rejects(Position.findOneAndUpdate(
    { _id: ids.position, userId: ids.user, version: 0 },
    { $set: { status: 'CLOSED', remainingQuantity: 10, filledExitQuantity: 0 } },
    { new: true, runValidators: true },
  ).exec(), /closed only after all entry quantity has exited/);
  assert.equal(persistence.writes.length, 0, 'invalid state never reaches the driver update');
});

test('Mongoose findOneAndUpdate rejects FILLED order intents with missing fills', async (t) => {
  const persistence = stubCollection(t, OrderIntent, [intentRecord()]);
  await assert.rejects(OrderIntent.findOneAndUpdate(
    { _id: ids.intent, userId: ids.user, version: 0 },
    { $set: { status: 'FILLED', filledQuantity: 0, remainingQuantity: 10 } },
    { new: true, runValidators: true },
  ).exec(), /filled order intent must have all requested quantity filled/);
  assert.equal(persistence.writes.length, 0);
});

test('Mongoose query and document writes reject nested execution snapshot changes', async (t) => {
  const positionStore = stubCollection(t, Position, [positionRecord()]);
  const orderStore = stubCollection(t, OrderIntent, [intentRecord()]);
  const tradeStore = stubCollection(t, Trade, [{ _id: ids.trade, userId: ids.user, strategyId: ids.strategy, executionSnapshot: { quantity: 10, executionMode: 'LIVE' } }]);

  await assert.rejects(Position.findOneAndUpdate({ _id: ids.position }, { $set: { 'executionSnapshot.quantity': 99 } }).exec(), /execution snapshots are immutable/);
  await assert.rejects(Position.findOneAndUpdate({ _id: ids.position }, { $rename: { status: 'executionSnapshot.status' } }).exec(), /execution snapshots are immutable/);
  await assert.rejects(Position.findOneAndUpdate({ _id: ids.position }, { $set: { brokerAccountId: newId() } }).exec(), /ownership field is immutable/);
  await assert.rejects(OrderIntent.findOneAndUpdate({ _id: ids.intent }, { $set: { 'requestSnapshot.quantity': 99 } }).exec(), /request snapshots are immutable/);
  await assert.rejects(OrderIntent.findOneAndUpdate({ _id: ids.intent }, { $rename: { status: 'requestSnapshot.status' } }).exec(), /request snapshots are immutable/);
  await assert.rejects(OrderIntent.findOneAndUpdate({ _id: ids.intent }, { $set: { requestedQuantity: 99 } }).exec(), /request snapshots are immutable/);
  await assert.rejects(OrderIntent.findOneAndUpdate({ _id: ids.intent }, { $set: { userId: newId() } }).exec(), /ownership field is immutable/);
  await assert.rejects(Trade.findOneAndUpdate({ _id: ids.trade }, { $set: { 'executionSnapshot.quantity': 99 } }).exec(), /execution snapshots are immutable/);
  assert.deepEqual([positionStore.writes.length, orderStore.writes.length, tradeStore.writes.length], [0, 0, 0]);

  const position = new Position(positionRecord());
  position.$isNew = false;
  position.executionSnapshot.quantity = 9;
  await assert.rejects(position.validate(), /execution snapshots are immutable/);
  const intent = new OrderIntent(intentRecord());
  intent.$isNew = false;
  intent.requestSnapshot.quantity = 9;
  await assert.rejects(intent.validate(), /snapshots and established links are immutable/);
  const trade = new Trade({ userId: ids.user, strategyId: ids.strategy, index: 'NIFTY', premium: 'CE', qty: 10, buyPrice: 100, executionSnapshot: { quantity: 10 } });
  trade.$isNew = false;
  trade.executionSnapshot.quantity = 9;
  await assert.rejects(trade.validate(), /execution snapshots are immutable/);
});

test('position deletion refuses open exposure and refuses any linked order intent', async (t) => {
  fakeSession(t);
  const openPosition = stubCollection(t, Position, [positionRecord({ status: 'CLOSED', remainingQuantity: 2, filledExitQuantity: 8 })]);
  const openIntent = stubCollection(t, OrderIntent, [intentRecord({ positionId: ids.position, status: 'UNKNOWN' })]);
  assert.equal(await accountRepository.deleteClosedPosition({ userId: ids.user, brokerAccountId: ids.account, positionId: ids.position }), null);
  assert.equal(openPosition.writes.filter(write => write.kind === 'delete').length, 0);

  openPosition.records[0] = positionRecord({ status: 'CLOSED', remainingQuantity: 0, filledExitQuantity: 10 });
  assert.equal(await accountRepository.deleteClosedPosition({ userId: ids.user, brokerAccountId: ids.account, positionId: ids.position }), null);
  assert.equal(openPosition.writes.filter(write => write.kind === 'delete').length, 0);
  assert.equal(openIntent.records.length, 1);
});

test('position deletion of flat, unlinked records is version and intent-revision guarded', async (t) => {
  fakeSession(t);
  const positionStore = stubCollection(t, Position, [positionRecord({ status: 'CLOSED', remainingQuantity: 0, filledExitQuantity: 10 })]);
  stubCollection(t, OrderIntent, []);
  await accountRepository.deleteClosedPosition({ userId: ids.user, brokerAccountId: ids.account, positionId: ids.position });
  const deletion = positionStore.writes.find(write => write.kind === 'delete');
  assert.ok(deletion);
  assert.equal(deletion.filter.version, 0);
  assert.equal(deletion.filter.intentRevision, 0);
  assert.equal(deletion.filter.remainingQuantity, 0);
  assert.equal(deletion.filter.filledExitQuantity, 10);
});

test('same-status position metadata updates pass through Mongoose with owner and CAS filters', async (t) => {
  const positionStore = stubCollection(t, Position, [positionRecord()]);
  const updated = await accountRepository.transitionPosition({
    userId: ids.user, brokerAccountId: ids.account, positionId: ids.position,
    expectedVersion: 0, expectedStatus: 'PROTECTED', status: 'PROTECTED',
    changes: { protectiveStopPrice: 111, lastQuoteAt: new Date('2026-10-05T10:00:00Z') },
  });
  assert.equal(updated.protectiveStopPrice, 111);
  const write = positionStore.writes.find(item => item.kind === 'update');
  assert.equal(write.filter.userId.toString(), ids.user.toString());
  assert.equal(write.filter.brokerAccountId.toString(), ids.account.toString());
  assert.equal(write.filter.version, 0);
  assert.equal(write.filter.remainingQuantity, 10);
  assert.equal(write.filter.filledExitQuantity, 0);
});

test('entry intent can be bound once to an owned resulting position and trade', async (t) => {
  fakeSession(t);
  stubCollection(t, BrokerAccount, [{ _id: ids.account, userId: ids.user }]);
  stubCollection(t, Strategy, [{ _id: ids.strategy, userId: ids.user }]);
  stubCollection(t, Trade, [{ _id: ids.trade, userId: ids.user, brokerAccountId: ids.account, strategyId: ids.strategy }]);
  const positionStore = stubCollection(t, Position, [positionRecord()]);
  const intentStore = stubCollection(t, OrderIntent, [intentRecord({ status: 'FILLED', filledQuantity: 10, remainingQuantity: 0 })]);

  const linked = await accountRepository.linkOrderIntent({
    userId: ids.user, brokerAccountId: ids.account, strategyId: ids.strategy,
    intentRecordId: ids.intent, positionId: ids.position, tradeId: ids.trade, expectedVersion: 0,
  });
  assert.equal(linked.positionId.toString(), ids.position.toString());
  assert.equal(linked.tradeId.toString(), ids.trade.toString());
  assert.equal(positionStore.records[0].intentRevision, 1);
  assert.ok(positionStore.writes.some(write => write.kind === 'update' && write.filter.intentRevision === 0));
  assert.ok(intentStore.writes.some(write => write.kind === 'update' && write.filter.positionId?.$exists === false));
  const writesAfterInitialLink = intentStore.writes.length;
  assert.equal(await accountRepository.linkOrderIntent({
    userId: ids.user, brokerAccountId: ids.account, strategyId: ids.strategy,
    intentRecordId: ids.intent, positionId: newId(), tradeId: newId(), expectedVersion: 1,
  }), null, 'an established intent link cannot be rebound');
  await assert.rejects(OrderIntent.findOneAndUpdate(
    { _id: ids.intent, userId: ids.user, brokerAccountId: ids.account, version: 1 },
    { $set: { positionId: newId(), tradeId: newId() } },
  ).exec(), /links can only be established once/);
  assert.equal(intentStore.writes.length, writesAfterInitialLink, 'relink attempts never reach the driver');
});
