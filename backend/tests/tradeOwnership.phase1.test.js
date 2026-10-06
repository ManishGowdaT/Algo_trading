const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Trade = require('../models/Trade');
const BrokerAccount = require('../models/BrokerAccount');
const Strategy = require('../models/Strategy');
const tradeController = require('../controllers/tradeController');
const marketSessionManager = require('../services/marketSessionManager');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('authenticated User A cannot read or update User B trade by supplying its known trade ID', async (t) => {
  const originalTradeFindOne = Trade.findOne;
  const originalBrokerFindOne = BrokerAccount.findOne;
  const originalStrategyFindOne = Strategy.findOne;
  let readFilter;
  let updateFilter;
  let saveCalls = 0;
  const userA = new mongoose.Types.ObjectId();
  const userB = new mongoose.Types.ObjectId();
  const strategyId = new mongoose.Types.ObjectId();
  const tradeId = new mongoose.Types.ObjectId().toString();
  BrokerAccount.findOne = () => ({ select: () => ({ lean: async () => null }) });

  t.after(() => {
    Trade.findOne = originalTradeFindOne;
    BrokerAccount.findOne = originalBrokerFindOne;
    Strategy.findOne = originalStrategyFindOne;
    marketSessionManager.stopMonitoring();
  });

  Strategy.findOne = async (filter) => {
    assert.deepEqual(filter, { name: 'HeikenAshi', userId: userA });
    return { _id: strategyId };
  };
  Trade.findOne = (filter) => {
    if (filter.strategyId) {
      readFilter = filter;
      return { sort: async () => null };
    }
    updateFilter = filter;
    return Promise.resolve(null);
  };

  const readResponse = response();
  await tradeController.getLatestOpenTrade({ query: { strategyName: 'HeikenAshi' }, user: { _id: userA } }, readResponse);
  assert.equal(readResponse.statusCode, 200);
  assert.equal(readResponse.body.data.trade, null);
  assert.deepEqual(readFilter, {
    userId: userA,
    strategyId,
    exitPrice: { $exists: false },
  });

  const updateResponse = response();
  await tradeController.updateTradeExit({
    body: { tradeId, exitPrice: 110, exitReason: 'Target' },
    user: { _id: userA },
  }, updateResponse);
  assert.equal(updateResponse.statusCode, 404);
  assert.deepEqual(updateFilter, { _id: tradeId, userId: userA });
  assert.equal(saveCalls, 0, `the simulated User B trade (${userB}) must never be saved`);
});
