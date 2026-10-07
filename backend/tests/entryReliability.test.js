const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/executionFixture');
const leases = require('../services/executionLeaseService');
const ExecutionLease = require('../models/ExecutionLease');

test('a late renewal from an old generation cannot erase the new local owner', async t => {
  const f = await fixture(t, { readyFeed: false });
  const old = await leases.acquire(f.contexts[0]);
  const savedNow = Date.now;
  let fresh;
  try {
    Date.now = () => old.leaseUntil.getTime() + 1;
    fresh = await leases.executionContext(f.contexts[0]);
  } finally { Date.now = savedNow; }
  assert.ok(fresh.generation > old.generation);
  await assert.rejects(leases.renew(old), { code: 'EXECUTION_LEASE_UNAVAILABLE' });
  assert.equal(leases.current(f.contexts[0]).generation, fresh.generation);
  await leases.assertCurrent(fresh);
});

test('renewal timers stay bounded while A is blocked and still renew B independently', async t => {
  const f = await fixture(t, { readyFeed: false });
  const a = await leases.acquire(f.contexts[0]);
  const b = await leases.acquire(f.contexts[1]);
  const original = ExecutionLease.updateOne;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const counts = new Map();
  t.mock.method(ExecutionLease, 'updateOne', async function (filter, mutation, options) {
    const id = String(filter.brokerAccountId);
    counts.set(id, (counts.get(id) || 0) + 1);
    if (id === a.brokerAccountId) await blocked;
    return original.call(this, filter, mutation, options);
  });
  const savedNow = Date.now;
  try {
    Date.now = () => Math.min(a.leaseUntil.getTime(), b.leaseUntil.getTime()) - 1000;
    t.mock.timers.tick(15_000);
    const pass = leases.renewDueLeases();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(counts.get(a.brokerAccountId), 1, 'blocked account must not accumulate renewals');
    assert.equal(counts.get(b.brokerAccountId), 1);
    assert.ok(leases.current(f.contexts[1]).leaseUntil > b.leaseUntil);
    release();
    await pass;
  } finally { release(); Date.now = savedNow; }
});

test('breakout persistence errors consume the evaluated candle instead of replaying entry', async t => {
  const f = await fixture(t, { readyFeed: true });
  const runner = await f.runner(0, '5minBreakout', false);
  Object.assign(runner, { state: 'WAITING',
    ceContract: { exchange: 'NFO', symboltoken: '77', tradingsymbol: 'CE-OPT' },
    peContract: { exchange: 'NFO', symboltoken: '88', tradingsymbol: 'PE-OPT' } });
  const end = Math.floor(Date.now() / 60000) * 60;
  const bars = Array.from({ length: 6 }, (_, i) => ({ time: end - (6 - i) * 60,
    open: 105, high: i === 5 ? 112 : 110, low: 100, close: i === 5 ? 111 : 106 }));
  const feeds = require('../services/marketDataService');
  t.mock.method(feeds, 'getBuffer', () => bars);
  f.stores.OrderIntentControl.fail = 'intent persistence unavailable';
  await f.accounts.run(f.contexts[0], () => runner.startScanLoop());
  const event = { ...f.contexts[0], exchange: 'NFO', interval: 'ONE_MINUTE', role: 'scanner', symboltoken: '77' };
  await f.accounts.run(f.contexts[0], () => runner.candleListener(event));
  const canonicalTime = new Date(bars.at(-1).time * 1000).toISOString();
  assert.equal(runner.lastProcessedBreakoutCandles.get('NFO:77'), canonicalTime);
  assert.equal(runner.lastProcessedBreakoutCandles.get('NFO:88'), canonicalTime);
  f.stores.OrderIntentControl.fail = null;
  runner.state = 'WAITING';
  await f.accounts.run(f.contexts[0], () => runner.candleListener(event));
  assert.equal(f.stores.OrderIntent.length, 0);
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple').length, 0);
});

function risingCandles(count = 30) {
  const end = Math.floor(Date.now() / 300_000) * 300;
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index;
    return { time: end - (count - index) * 300, open, high: open + 1, low: open, close: open + 1 };
  });
}

test('idle account leases renew in the background without changing owner generation', async t => {
  const f = await fixture(t, { readyFeed: false });
  const token = await leases.acquire(f.contexts[0]);
  await new Promise(resolve => setTimeout(resolve, 5));
  const savedNow = Date.now;
  try {
    // Put the locally held lease inside the renewal window without waiting 25s.
    Date.now = () => token.leaseUntil.getTime() - 1_000;
    const renewed = await leases.renewDueLeases();
    Date.now = savedNow;
    assert.deepEqual(renewed.map(row => row.renewed), [true]);
    assert.equal(leases.current(f.contexts[0]).generation, token.generation);
    assert.ok(leases.current(f.contexts[0]).leaseUntil > token.leaseUntil);
  } finally {
    Date.now = savedNow;
  }
});

test('a verified pre-submit ownership failure does not consume a fresh signal; recovery admits one entry', async t => {
  const f = await fixture(t, { readyFeed: true });
  const runner = await f.runner(0, 'ModifiedHeikenAshi', false);
  runner.state = 'SCANNING';
  runner.ceContract = { exchange: 'NFO', symboltoken: '77', tradingsymbol: 'CE-OPT' };
  runner.peContract = { exchange: 'NFO', symboltoken: '88', tradingsymbol: 'PE-OPT' };
  const feeds = require('../services/marketDataService');
  const oldGetBuffer = feeds.getBuffer;
  feeds.getBuffer = (_exchange, token) => risingCandles().map(candle => ({ ...candle }));
  t.after(() => { feeds.getBuffer = oldGetBuffer; });
  await f.accounts.run(f.contexts[0], () => runner.startScanLoop());

  const event = { ...f.contexts[0], exchange: 'NFO', interval: 'FIVE_MINUTE', role: 'scanner', symboltoken: '77' };
  f.state.failFence = true;
  await f.accounts.run(f.contexts[0], () => runner.candleListener(event));
  assert.equal(runner.lastEntryTime, null, 'pre-submit fence failure must leave the signal retryable');
  assert.equal(f.stores.OrderIntent.length, 0, 'no order intent or broker mutation exists yet');
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple').length, 0);

  f.state.failFence = false;
  await f.accounts.run(f.contexts[0], () => runner.candleListener({ ...event, symboltoken: '88' }));
  assert.equal(f.stores.OrderIntent.filter(intent => intent.purpose === 'ENTRY').length, 1);
  assert.equal(String(f.stores.Position[0].executionSnapshot.symboltoken), '77', 'CE precedence remains unchanged');
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple').length, 0, 'PAPER must not send broker orders');
});

test('wrong timeframe and synthetic bars cannot submit a five-minute strategy entry', async t => {
  const f = await fixture(t, { readyFeed: true });
  const runner = await f.runner(0, 'ModifiedHeikenAshi', false);
  runner.state = 'SCANNING';
  runner.ceContract = { exchange: 'NFO', symboltoken: '77', tradingsymbol: 'CE-OPT' };
  runner.peContract = { exchange: 'NFO', symboltoken: '88', tradingsymbol: 'PE-OPT' };
  const feeds = require('../services/marketDataService');
  const oldGetBuffer = feeds.getBuffer;
  feeds.getBuffer = () => risingCandles();
  t.after(() => { feeds.getBuffer = oldGetBuffer; });
  await f.accounts.run(f.contexts[0], () => runner.startScanLoop());
  const event = { ...f.contexts[0], exchange: 'NFO', role: 'scanner', symboltoken: '77' };

  await f.accounts.run(f.contexts[0], () => runner.candleListener({ ...event, interval: 'ONE_MINUTE' }));
  assert.equal(f.stores.OrderIntent.length, 0);
  await f.accounts.run(f.contexts[0], () => runner.candleListener({ ...event, interval: 'FIVE_MINUTE', synthetic: true }));
  assert.equal(f.stores.OrderIntent.length, 0);
  assert.equal(runner.lastEntryTime, null);
});

test('current-day history seed drops a forming candle and merges rather than overwrites live bars', async t => {
  const f = await fixture(t, { readyFeed: true });
  const service = await f.accounts.run(f.contexts[0], () => f.feeds.ensureReady());
  const now = Date.now();
  const intervalMs = 300_000;
  const liveTime = Math.floor(now / intervalMs) * (intervalMs / 1000) - (intervalMs / 1000);
  const formingTime = Math.floor(now / intervalMs) * (intervalMs / 1000);
  const timestamp = time => new Date(time * 1000).toISOString();
  const liveCandle = { time: liveTime, open: 100, high: 115, low: 99, close: 114 };
  service.requestPython = async () => {
    const builder = [...service.candleBuilders.values()].find(row => row.symboltoken === '77');
    builder.candles.push(liveCandle);
    return { response: { ok: true }, data: { items: [
      { ts: timestamp(liveTime), open: 100, high: 110, low: 99, close: 105 },
      { ts: timestamp(formingTime), open: 105, high: 120, low: 104, close: 119 },
    ] } };
  };
  const result = await f.accounts.run(f.contexts[0], () => service.subscribe('NFO', '77', 'FIVE_MINUTE', null, { role: 'scanner' }));
  assert.deepEqual(result, [liveCandle], 'live overlap wins and the forming REST row is excluded');
  assert.equal(result.some(row => row.time === formingTime), false);
});
