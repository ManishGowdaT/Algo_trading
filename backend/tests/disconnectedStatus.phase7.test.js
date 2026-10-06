const test = require('node:test');
const assert = require('node:assert/strict');
const BrokerAccount = require('../models/BrokerAccount');
const accounts = require('../services/accountContext');
const active = require('../services/activeAccountService');
const marketSessionManager = require('../services/marketSessionManager');
const engine = require('../services/strategyEngine');

test('owned strategy status remains visible through recovery while its broker session is disconnected', async t => {
  const originalFind = BrokerAccount.findOne;
  const userId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const accountId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  BrokerAccount.findOne = query => ({ lean: async () => query.userId === userId && !query._id
    ? { _id: accountId, userId, broker: 'ANGEL_ONE', brokerClientId: 'CLIENT-A', status: 'DISCONNECTED', sessionGeneration: 3, ownerGeneration: 1 }
    : null });
  active.clearActiveAccount(userId, accountId);
  const key = `${userId}_HeikenAshi`;
  const prior = engine.runners.get(key);
  t.after(() => {
    BrokerAccount.findOne = originalFind;
    active.clearActiveAccount(userId, accountId);
    if (prior) engine.runners.set(key, prior); else engine.runners.delete(key);
    marketSessionManager.stopMonitoring();
  });

  const runner = engine.getRunner(key);
  runner.userId = userId;
  runner.accountContext = null;
  runner.isRunning = false;
  runner.state = 'RECONCILIATION_REQUIRED';
  runner.message = 'Position recovery is pending';

  const req = { user: { _id: userId }, query: {}, body: {} };
  let verifiedContext;
  let status;
  await new Promise((resolve, reject) => accounts.readMiddleware(req, {}, error => {
    if (error) return reject(error);
    verifiedContext = req.accountContext;
    runner.accountContext = verifiedContext;
    try { status = engine.getStrategyStatus(userId, 'HeikenAshi', verifiedContext); }
    catch (statusError) { return reject(statusError); }
    resolve();
  }));
  assert.equal(verifiedContext.brokerAccountId, accountId);
  assert.equal(verifiedContext.sessionId, null);
  assert.equal(status.state, 'RECONCILIATION_REQUIRED');
  assert.match(status.message, /recovery is pending/i);
});
