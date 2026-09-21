const test = require('node:test');
const assert = require('node:assert/strict');

const marketDataService = require('../services/marketDataService');

test('concurrent broker session checks share one Python request', async (t) => {
  const originalFetch = global.fetch;
  let resolveFetch;
  let calls = 0;

  t.after(() => {
    global.fetch = originalFetch;
    marketDataService.sessionCheckPromise = null;
  });

  global.fetch = async () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };

  const first = marketDataService.autoInitSession();
  const second = marketDataService.autoInitSession();

  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveFetch({ ok: false, status: 429 });
  await first;
  assert.equal(marketDataService.sessionCheckPromise, null);
});
