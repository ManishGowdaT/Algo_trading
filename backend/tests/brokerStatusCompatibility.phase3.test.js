const test = require('node:test');
const assert = require('node:assert/strict');

const accounts = require('../services/accountContext');
const controller = require('../controllers/brokerProxyController');
const marketSessionManager = require('../services/marketSessionManager');

test('status keeps the disconnected response for users without a linked broker account', async t => {
  const originalOwned = accounts.owned;
  accounts.owned = async () => {
    throw Object.assign(new Error('Broker account not found.'), { status: 404 });
  };
  t.after(() => {
    accounts.owned = originalOwned;
    // Importing the controller initializes the strategy engine, which starts
    // this process-wide market-hours timer. Stop it in this isolated test worker.
    marketSessionManager.stopMonitoring();
  });

  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await controller.status({ user: { _id: 'user-without-account' }, query: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { connected: false, clientCode: null, message: undefined });
});
