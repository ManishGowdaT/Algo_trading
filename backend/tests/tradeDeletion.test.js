const assert = require('node:assert/strict');
const test = require('node:test');
const mongoose = require('mongoose');
const Trade = require('../models/Trade');
const BrokerAccount = require('../models/BrokerAccount');
const strategyEngine = require('../services/strategyEngine');
const tradeController = require('../controllers/tradeController');
const marketSessionManager = require('../services/marketSessionManager');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('trade deletion only removes the authenticated owner’s closed, inactive trade', async (t) => {
  const originalFindOne = Trade.findOne;
  const originalBrokerFindOne = BrokerAccount.findOne;
  const originalFindOneAndDelete = Trade.findOneAndDelete;
  const originalIsTradeActive = strategyEngine.isTradeActive;
  const originalConsoleError = console.error;
  t.after(() => {
    Trade.findOne = originalFindOne;
    BrokerAccount.findOne = originalBrokerFindOne;
    Trade.findOneAndDelete = originalFindOneAndDelete;
    strategyEngine.isTradeActive = originalIsTradeActive;
    console.error = originalConsoleError;
    marketSessionManager.stopMonitoring();
  });

  const tradeId = new mongoose.Types.ObjectId().toString();
  BrokerAccount.findOne = () => ({ select: () => ({ lean: async () => null }) });
  const ownerId = new mongoose.Types.ObjectId();
  const closedTrade = { _id: tradeId, userId: ownerId, exitPrice: 196.55, positionState: 'CLOSED' };
  let findFilter;
  let deleteFilter;
  let deleteCalls = 0;
  Trade.findOne = async (filter) => {
    findFilter = filter;
    return closedTrade;
  };
  Trade.findOneAndDelete = (filter) => {
    deleteFilter = filter;
    deleteCalls += 1;
    return { select: async () => ({ _id: tradeId }) };
  };
  strategyEngine.isTradeActive = () => false;

  const response = createResponse();
  await tradeController.deleteTrade({ params: { tradeId }, user: { _id: ownerId } }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { status: 'success', data: { tradeId } });
  assert.deepEqual(findFilter, { _id: tradeId, userId: ownerId });
  assert.deepEqual(deleteFilter, {
    _id: tradeId,
    userId: ownerId,
    exitPrice: { $gt: 0 },
    positionState: { $nin: ['PROTECTED', 'UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED'] },
  });
  assert.equal(deleteCalls, 1);
});

test('trade deletion refuses malformed IDs, unclosed positions, active states, and active runner records', async (t) => {
  const originalFindOne = Trade.findOne;
  const originalBrokerFindOne = BrokerAccount.findOne;
  const originalFindOneAndDelete = Trade.findOneAndDelete;
  const originalIsTradeActive = strategyEngine.isTradeActive;
  const originalConsoleError = console.error;
  t.after(() => {
    Trade.findOne = originalFindOne;
    BrokerAccount.findOne = originalBrokerFindOne;
    Trade.findOneAndDelete = originalFindOneAndDelete;
    strategyEngine.isTradeActive = originalIsTradeActive;
    console.error = originalConsoleError;
    marketSessionManager.stopMonitoring();
  });

  const tradeId = new mongoose.Types.ObjectId().toString();
  BrokerAccount.findOne = () => ({ select: () => ({ lean: async () => null }) });
  const ownerId = new mongoose.Types.ObjectId();
  let deleteCalls = 0;
  Trade.findOneAndDelete = () => {
    deleteCalls += 1;
    return { select: async () => ({ _id: tradeId }) };
  };
  strategyEngine.isTradeActive = () => false;

  const invalidResponse = createResponse();
  await tradeController.deleteTrade({ params: { tradeId: 'not-an-object-id' }, user: { _id: ownerId } }, invalidResponse);
  assert.equal(invalidResponse.statusCode, 400);
  assert.equal(deleteCalls, 0);

  const records = [
    { _id: tradeId, userId: ownerId },
    { _id: tradeId, userId: ownerId, exitPrice: 10, positionState: 'PROTECTED' },
  ];
  for (const record of records) {
    Trade.findOne = async () => record;
    const response = createResponse();
    await tradeController.deleteTrade({ params: { tradeId }, user: { _id: ownerId } }, response);
    assert.equal(response.statusCode, 409);
  }

  Trade.findOne = async () => ({ _id: tradeId, userId: ownerId, exitPrice: 10, positionState: 'CLOSED' });
  strategyEngine.isTradeActive = () => true;
  const activeRunnerResponse = createResponse();
  await tradeController.deleteTrade({ params: { tradeId }, user: { _id: ownerId } }, activeRunnerResponse);
  assert.equal(activeRunnerResponse.statusCode, 409);
  assert.equal(deleteCalls, 0);
});

test('trade deletion returns not found for another owner and refuses a changed database state', async (t) => {
  const originalFindOne = Trade.findOne;
  const originalBrokerFindOne = BrokerAccount.findOne;
  const originalFindOneAndDelete = Trade.findOneAndDelete;
  const originalIsTradeActive = strategyEngine.isTradeActive;
  const originalConsoleError = console.error;
  t.after(() => {
    Trade.findOne = originalFindOne;
    BrokerAccount.findOne = originalBrokerFindOne;
    Trade.findOneAndDelete = originalFindOneAndDelete;
    strategyEngine.isTradeActive = originalIsTradeActive;
    console.error = originalConsoleError;
    marketSessionManager.stopMonitoring();
  });

  const tradeId = new mongoose.Types.ObjectId().toString();
  BrokerAccount.findOne = () => ({ select: () => ({ lean: async () => null }) });
  const ownerId = new mongoose.Types.ObjectId();
  let deleteCalls = 0;
  Trade.findOne = async () => null;
  Trade.findOneAndDelete = () => {
    deleteCalls += 1;
    return { select: async () => null };
  };
  strategyEngine.isTradeActive = () => false;

  const notFoundResponse = createResponse();
  await tradeController.deleteTrade({ params: { tradeId }, user: { _id: ownerId } }, notFoundResponse);
  assert.equal(notFoundResponse.statusCode, 404);
  assert.equal(deleteCalls, 0);

  Trade.findOne = async () => ({ _id: tradeId, userId: ownerId, exitPrice: 10, positionState: 'CLOSED' });
  const changedStateResponse = createResponse();
  await tradeController.deleteTrade({ params: { tradeId }, user: { _id: ownerId } }, changedStateResponse);
  assert.equal(changedStateResponse.statusCode, 409);
  assert.equal(deleteCalls, 1);
});
