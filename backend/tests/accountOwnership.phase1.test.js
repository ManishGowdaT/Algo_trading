const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const BrokerAccount = require('../models/BrokerAccount');
const StrategySettings = require('../models/StrategySettings');
const Position = require('../models/Position');
const OrderIntent = require('../models/OrderIntent');
const Trade = require('../models/Trade');
const { createAccountRepository } = require('../services/accountRepository');

function asId(value) {
  return value && typeof value === 'object' && value.toString ? value.toString() : String(value);
}

function matches(document, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = document[key];
    if (expected && typeof expected === 'object' && '$in' in expected) {
      return expected.$in.some(value => asId(value) === asId(actual));
    }
    if (expected && typeof expected === 'object' && !mongoose.isValidObjectId(expected)) {
      return false;
    }
    return asId(actual) === asId(expected);
  });
}

function fakeModel(seed = []) {
  const records = seed.map(record => ({ ...record }));
  return {
    records,
    async findOne(filter) { return records.find(record => matches(record, filter)) || null; },
    async create(document) {
      const record = { _id: `generated-${records.length + 1}`, version: 0, ...document };
      records.push(record);
      return record;
    },
    async findOneAndUpdate(filter, update) {
      const record = records.find(item => matches(item, filter));
      if (!record) return null;
      Object.assign(record, update.$set);
      for (const [field, amount] of Object.entries(update.$inc || {})) record[field] = (record[field] || 0) + amount;
      return record;
    },
    async findOneAndDelete(filter) {
      const index = records.findIndex(record => matches(record, filter));
      return index < 0 ? null : records.splice(index, 1)[0];
    },
  };
}

function makeRepository() {
  const ids = { userA: 'user-A', userB: 'user-B', accountA: 'account-A', accountB: 'account-B', strategyA: 'strategy-A', strategyB: 'strategy-B', tradeA: 'trade-A', tradeB: 'trade-B', settingsB: 'settings-B', positionB: 'position-B', positionOpenB: 'position-open-B', intentB: 'intent-B' };
  const models = {
    BrokerAccount: fakeModel([
      { _id: ids.accountA, userId: ids.userA, broker: 'ANGEL_ONE', brokerClientId: 'CLIENT-A', version: 0 },
      { _id: ids.accountB, userId: ids.userB, broker: 'ANGEL_ONE', brokerClientId: 'CLIENT-B', version: 0 },
    ]),
    Strategy: fakeModel([
      { _id: ids.strategyA, userId: ids.userA, name: 'HeikenAshi' },
      { _id: ids.strategyB, userId: ids.userB, name: 'HeikenAshi' },
    ]),
    StrategySettings: fakeModel([
      { _id: ids.settingsB, userId: ids.userB, brokerAccountId: ids.accountB, strategyId: ids.strategyB, config: { quantity: 20 }, version: 0 },
    ]),
    Trade: fakeModel([
      { _id: ids.tradeA, userId: ids.userA, brokerAccountId: ids.accountA, strategyId: ids.strategyA },
      { _id: ids.tradeB, userId: ids.userB, brokerAccountId: ids.accountB, strategyId: ids.strategyB },
    ]),
    Position: fakeModel([
      { _id: ids.positionB, userId: ids.userB, brokerAccountId: ids.accountB, strategyId: ids.strategyB, tradeId: ids.tradeB, status: 'CLOSED', version: 0 },
      { _id: ids.positionOpenB, userId: ids.userB, brokerAccountId: ids.accountB, strategyId: ids.strategyB, tradeId: ids.tradeB, status: 'OPEN', version: 0, ownerGeneration: 0, sessionGeneration: 0 },
    ]),
    OrderIntent: fakeModel([
      { _id: ids.intentB, userId: ids.userB, brokerAccountId: ids.accountB, positionId: ids.positionB, status: 'PREPARED', version: 0 },
    ]),
  };
  return { ids, models, repository: createAccountRepository(models) };
}

test('Phase 1 schemas add account ownership and durable records without rewriting legacy trades', () => {
  assert.equal(Trade.schema.path('brokerAccountId').options.required, undefined);
  assert.equal(Trade.schema.path('executionSnapshot').options.default, undefined);
  assert.ok(Trade.schema.indexes().some(([keys]) => keys.userId === 1 && keys.brokerAccountId === 1));

  const legacy = new Trade({
    userId: new mongoose.Types.ObjectId(),
    strategyId: new mongoose.Types.ObjectId(),
    index: 'SENSEX', premium: 'LEGACY-CE', qty: 20, buyPrice: 100,
  });
  assert.ok(legacy._id);
  assert.equal(legacy.brokerAccountId, undefined);
  assert.equal(legacy.executionSnapshot, undefined);

  assert.ok(BrokerAccount.schema.indexes().some(([, options]) => options.unique && options.name === 'uniq_broker_client_owner'));
  assert.ok(StrategySettings.schema.indexes().some(([, options]) => options.unique && options.name === 'uniq_strategy_settings_owner_account_strategy'));
  assert.ok(Position.schema.indexes().some(([, options]) => options.unique && options.name === 'uniq_position_per_owned_trade'));
  assert.ok(OrderIntent.schema.indexes().some(([, options]) => options.unique && options.name === 'uniq_order_intent_account_idempotency'));
  assert.equal(BrokerAccount.schema.path('brokerClientId').options.immutable, true);
  assert.equal(Position.schema.path('executionSnapshot').options.immutable, true);
  assert.equal(OrderIntent.schema.path('requestSnapshot').options.immutable, true);
  assert.equal(BrokerAccount.schema.path('apiKey'), undefined, 'credentials are not stored in BrokerAccount');
});

test('User A cannot read, update, or delete User B broker-account/settings/position records by known IDs', async () => {
  const { ids, models, repository } = makeRepository();
  assert.equal(await repository.getBrokerAccount(ids.userA, ids.accountB), null);
  assert.equal(await repository.updateBrokerAccountStatus({
    userId: ids.userA, brokerAccountId: ids.accountB, expectedVersion: 0, changes: { status: 'DISABLED' },
  }), null);
  assert.equal(models.BrokerAccount.records.find(row => row._id === ids.accountB).status, undefined);

  assert.equal(await repository.findStrategySettings({ userId: ids.userA, brokerAccountId: ids.accountB, settingsId: ids.settingsB }), null);
  assert.equal(await repository.updateStrategySettings({
    userId: ids.userA, brokerAccountId: ids.accountB, settingsId: ids.settingsB, expectedVersion: 0, config: { quantity: 999 },
  }), null);
  assert.equal(await repository.deleteStrategySettings({ userId: ids.userA, brokerAccountId: ids.accountB, settingsId: ids.settingsB }), null);
  assert.deepEqual(models.StrategySettings.records[0].config, { quantity: 20 });

  assert.equal(await repository.findPosition({ userId: ids.userA, brokerAccountId: ids.accountB, positionId: ids.positionB }), null);
  assert.equal(await repository.transitionPosition({
    userId: ids.userA, brokerAccountId: ids.accountB, positionId: ids.positionOpenB, expectedVersion: 0,
    expectedStatus: 'OPEN', status: 'PROTECTED',
  }), null);
  assert.equal(await repository.deleteClosedPosition({ userId: ids.userA, brokerAccountId: ids.accountB, positionId: ids.positionB }), null);
  assert.equal(models.Position.records[0].status, 'CLOSED');
  assert.equal(await repository.findOrderIntent({ userId: ids.userA, brokerAccountId: ids.accountB, intentRecordId: ids.intentB }), null);
});

test('new durable records require matching owner/account/strategy/trade references', async () => {
  const { ids, models, repository } = makeRepository();
  const snapshot = { executionMode: 'PAPER', quantity: 20, underlying: 'SENSEX', exchange: 'BFO', tradingsymbol: 'OPT-CE', symboltoken: 'token-1', entryPrice: 100 };

  assert.equal(await repository.createStrategySettings({
    userId: ids.userA, brokerAccountId: ids.accountB, strategyId: ids.strategyA, config: { quantity: 20 },
  }), null);
  const settings = await repository.createStrategySettings({
    userId: ids.userA, brokerAccountId: ids.accountA, strategyId: ids.strategyA, config: { quantity: 20 },
  });
  assert.equal(settings.userId, ids.userA);
  assert.equal(settings.brokerAccountId, ids.accountA);

  assert.equal(await repository.createPosition({
    userId: ids.userA, brokerAccountId: ids.accountA, strategyId: ids.strategyA, tradeId: ids.tradeB,
    executionSnapshot: snapshot, remainingQuantity: 20,
  }), null);
  const position = await repository.createPosition({
    userId: ids.userA, brokerAccountId: ids.accountA, strategyId: ids.strategyA, tradeId: ids.tradeA,
    executionSnapshot: snapshot, remainingQuantity: 20,
  });
  assert.equal(position.userId, ids.userA);

  assert.equal(await repository.createOrderIntent({
    userId: ids.userA, brokerAccountId: ids.accountA, strategyId: ids.strategyA,
    positionId: ids.positionB, tradeId: ids.tradeA, idempotencyKey: 'attempt-a',
  }), null);
  assert.equal(models.OrderIntent.records.length, 1, 'foreign position reference does not create an intent');

  const entryIntent = await repository.createOrderIntent({
    userId: ids.userA, brokerAccountId: ids.accountA, strategyId: ids.strategyA,
    idempotencyKey: 'entry-attempt-a', requestSnapshot: { action: 'BUY' },
    requestedQuantity: 20, remainingQuantity: 20,
  });
  assert.equal(entryIntent.positionId, undefined, 'entry intent can be recorded before a Position exists');
});

test('position and order-intent state changes use owner filters and compare-and-set versions', async () => {
  const { ids, models, repository } = makeRepository();
  const position = models.Position.records[0];
  await assert.rejects(repository.transitionPosition({
    userId: ids.userB, brokerAccountId: ids.accountB, positionId: ids.positionOpenB,
    expectedVersion: 0, expectedStatus: 'OPEN', status: 'PROTECTED', changes: { executionSnapshot: { quantity: 1 } },
  }), /Unsupported position update field/);
  assert.equal(position.status, 'CLOSED', 'immutable snapshot patch is rejected before update');

  const opened = await repository.transitionPosition({
    userId: ids.userB, brokerAccountId: ids.accountB, positionId: ids.positionOpenB,
    expectedVersion: 0, expectedStatus: 'OPEN', status: 'PROTECTED',
  });
  assert.equal(opened.status, 'PROTECTED');
  assert.equal(opened.version, 1);
  assert.equal(await repository.transitionPosition({
    userId: ids.userB, brokerAccountId: ids.accountB, positionId: ids.positionOpenB,
    expectedVersion: 0, expectedStatus: 'OPEN', status: 'PROTECTED',
  }), null, 'stale version cannot overwrite a newer position state');

  assert.equal(await repository.transitionOrderIntent({
    userId: ids.userA, brokerAccountId: ids.accountB, intentRecordId: ids.intentB,
    expectedVersion: 0, expectedStatuses: ['PREPARED'], status: 'SUBMITTING',
  }), null, 'known foreign intent ID cannot be updated');
  const intent = await repository.transitionOrderIntent({
    userId: ids.userB, brokerAccountId: ids.accountB, intentRecordId: ids.intentB,
    expectedVersion: 0, expectedStatuses: ['PREPARED'], status: 'SUBMITTING',
  });
  assert.equal(intent.status, 'SUBMITTING');
  assert.equal(intent.version, 1);
  await assert.rejects(repository.transitionOrderIntent({
    userId: ids.userB, brokerAccountId: ids.accountB, intentRecordId: ids.intentB,
    expectedVersion: 1, expectedStatuses: ['SUBMITTING'], status: 'ACKNOWLEDGED',
    changes: { sessionGeneration: 0 },
  }), /Unsupported order intent update field/);
  await assert.rejects(repository.transitionOrderIntent({
    userId: ids.userB, brokerAccountId: ids.accountB, intentRecordId: ids.intentB,
    expectedVersion: 1, expectedStatuses: ['SUBMITTING'], status: 'CANCELLED',
  }), /Invalid order intent transition/);
});

test('generation counters only advance through atomic increments', async () => {
  const { ids, models, repository } = makeRepository();
  await assert.rejects(repository.updateBrokerAccountStatus({
    userId: ids.userA, brokerAccountId: ids.accountA, expectedVersion: 0,
    changes: { sessionGeneration: 50 },
  }), /Unsupported broker account update field/);
  const account = await repository.updateBrokerAccountStatus({
    userId: ids.userA, brokerAccountId: ids.accountA, expectedVersion: 0,
    changes: { status: 'CONNECTED' }, incrementSessionGeneration: true,
  });
  assert.equal(account.sessionGeneration, 1);
  assert.equal(account.version, 1);

  const position = await repository.transitionPosition({
    userId: ids.userB, brokerAccountId: ids.accountB, positionId: ids.positionOpenB,
    expectedVersion: 0, expectedStatus: 'OPEN', status: 'PROTECTED', incrementOwnerGeneration: true,
  });
  assert.equal(position.ownerGeneration, 1);
  assert.equal(position.version, 1);
  assert.equal(models.Position.records[1].sessionGeneration, 0);
});

test('durable position and order-intent quantity invariants are validated', async () => {
  const position = new Position({
    userId: new mongoose.Types.ObjectId(), brokerAccountId: new mongoose.Types.ObjectId(),
    strategyId: new mongoose.Types.ObjectId(), tradeId: new mongoose.Types.ObjectId(),
    executionSnapshot: { executionMode: 'PAPER', quantity: 10, underlying: 'NIFTY', exchange: 'NFO', tradingsymbol: 'OPT-CE', symboltoken: '1', entryPrice: 100 },
    remainingQuantity: 8, filledExitQuantity: 3,
  });
  await assert.rejects(position.validate(), /Remaining plus exited quantity/);

  const intent = new OrderIntent({
    idempotencyKey: 'intent-1', userId: new mongoose.Types.ObjectId(), brokerAccountId: new mongoose.Types.ObjectId(),
    strategyId: new mongoose.Types.ObjectId(), requestSnapshot: { action: 'BUY', exchange: 'NFO', tradingsymbol: 'OPT-CE', symboltoken: '1', ordertype: 'MARKET', producttype: 'INTRADAY', quantity: 10 },
    requestedQuantity: 10, filledQuantity: 6, remainingQuantity: 5,
  });
  await assert.rejects(intent.validate(), /Filled plus remaining quantity/);
});
