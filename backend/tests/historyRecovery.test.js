const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/executionFixture');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function candles() {
  const end = Math.floor(Date.now() / 300000) * 300000;
  return Array.from({ length: 30 }, (_, i) => ({ ts: new Date(end - (30 - i) * 300000).toISOString(),
    open: 100 + i, high: 101 + i, low: 100 + i, close: 101 + i }));
}
function configure(r) {
  Object.assign(r, { state: 'SCANNING', ceContract: { exchange: 'NFO', symboltoken: '77', tradingsymbol: 'CE' },
    peContract: { exchange: 'NFO', symboltoken: '88', tradingsymbol: 'PE' } });
}
const event = context => ({ ...context, exchange: 'NFO', symboltoken: '77', interval: 'FIVE_MINUTE', role: 'scanner' });

test('real HTTP 429 seed recovery resumes scanner once without increasing subscriptions; B remains independent', async t => {
  const f = await fixture(t);
  const r = await f.runner(0, 'HeikenAshi', false); configure(r);
  const [a, b] = await Promise.all(f.contexts.map(c => f.accounts.run(c, () => f.feeds.ensureReady())));
  const bars = candles(); let failing = true; const calls = [];
  f.state.onHistory = ({ row, url, res, respond }) => {
    calls.push({ account: String(row._id), token: url.searchParams.get('symboltoken') });
    if (String(row._id) === f.contexts[0].brokerAccountId && failing) {
      res.statusCode = 429; res.setHeader('Retry-After', '2'); respond({ detail: 'limited' });
    } else respond({ items: bars });
    return true;
  };
  for (const token of ['77', '88']) await a.subscribe('NFO', token, 'FIVE_MINUTE', null, { role: 'scanner' });
  await b.subscribe('NFO', '77', 'FIVE_MINUTE', null, { role: 'scanner' });
  await r.startScanLoop();
  await f.accounts.run(f.contexts[0], () => r.candleListener(event(f.contexts[0])));
  await f.accounts.run(f.contexts[0], () => r.candleListener(event(f.contexts[0])));
  assert.equal(r.dataReadiness, 'DATA_DEGRADED'); assert.equal(f.stores.OrderIntent.length, 0);
  assert.equal(a.subscribers.get('scanner:NFO_77_FIVE_MINUTE').refCount, 1);
  assert.equal(a.subscribers.get('scanner:NFO_88_FIVE_MINUTE').refCount, 1);
  assert.equal(calls.filter(c => c.account === f.contexts[0].brokerAccountId).length, 2);
  assert.equal(b.getBuffer('NFO', '77', 'FIVE_MINUTE').length, 30);
  failing = false;
  // Exercise the actual scheduled retry; no scanner/request heartbeat is needed.
  const deadline = Date.now() + 6000;
  while (a.getBuffer('NFO', '88', 'FIVE_MINUTE').length !== 30 && Date.now() < deadline) await pause(50);
  assert.equal(a.getBuffer('NFO', '77', 'FIVE_MINUTE').length, 30);
  assert.equal(a.getBuffer('NFO', '88', 'FIVE_MINUTE').length, 30);
  await f.accounts.run(f.contexts[0], () => r.candleListener(event(f.contexts[0])));
  await f.accounts.run(f.contexts[0], () => r.candleListener(event(f.contexts[0])));
  assert.equal(r.dataReadiness, 'READY');
  assert.equal(f.stores.OrderIntent.filter(i => i.purpose === 'ENTRY').length, 1);
  assert.equal(a.subscribers.get('scanner:NFO_77_FIVE_MINUTE').refCount, 1);
  assert.equal(b.subscribers.get('scanner:NFO_77_FIVE_MINUTE').refCount, 1);
});

test('unsubscribe and session reset cancel history retry without recreating feeds', async t => {
  const f = await fixture(t);
  const a = await f.accounts.run(f.contexts[0], () => f.feeds.ensureReady());
  let calls = 0;
  f.state.onHistory = ({ res, respond }) => { calls++; res.statusCode = 500; respond({ detail: 'temporary' }); return true; };
  await a.subscribe('NFO', '77', 'FIVE_MINUTE');
  a.unsubscribe('NFO', '77', 'FIVE_MINUTE');
  await a.subscribe('NFO', '88', 'FIVE_MINUTE');
  a.resetAccountSession();
  await pause(2200);
  assert.equal(calls, 2); assert.equal(a.candleBuilders.size, 0); assert.equal(a.streamSubscribers.size, 0);
});

test('failed warm-up pauses entries, does not substitute older dates, and recovers the original date', async t => {
  const f = await fixture(t);
  const r = await f.runner(0, 'HeikenAshi', false); configure(r);
  const a = await f.accounts.run(f.contexts[0], () => f.feeds.ensureReady());
  const bars = candles(); let failWarmup = true; const dates = [];
  const today = r.getIstDateIso(); const yesterday = r.shiftIsoDate(today, -1);
  f.state.onHistory = ({ url, res, respond }) => {
    const date = url.searchParams.get('date');
    if (date !== today) {
      dates.push(date);
      if (failWarmup) { res.statusCode = 429; respond({ detail: 'limited' }); return true; }
      respond({ items: bars.map(c => ({ ...c, ts: new Date(Date.parse(c.ts) - 86400000).toISOString() })) }); return true;
    }
    respond({ items: bars }); return true;
  };
  for (const token of ['77', '88']) await a.subscribe('NFO', token, 'FIVE_MINUTE');
  await r.loadPreviousDayWarmup(r.ceContract, 'ce');
  await r.startScanLoop(); await f.accounts.run(f.contexts[0], () => r.candleListener(event(f.contexts[0])));
  assert.equal(r.dataReadiness, 'DATA_DEGRADED'); assert.equal(f.stores.OrderIntent.length, 0);
  assert.deepEqual(dates, [yesterday]);
  failWarmup = false; r.warmupRecovery.ce.nextAttemptAt = 0;
  await f.accounts.run(f.contexts[0], () => r.candleListener(event(f.contexts[0])));
  assert.deepEqual(dates, [yesterday, yesterday]);
  assert.equal(r.previousDayCandles.ce.length, 30); assert.equal(r.dataReadiness, 'READY');
});

test('concurrent history repair joins one request and preserves live closed bars', async t => {
  const f = await fixture(t); const a = await f.accounts.run(f.contexts[0], () => f.feeds.ensureReady());
  let calls = 0; let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  f.state.onHistory = async ({ respond }) => { calls++; await held; respond({ items: candles() }); return true; };
  const pending = a.subscribe('NFO', '77', 'FIVE_MINUTE');
  while (!calls) await pause(5);
  const builder = a.candleBuilders.get('scanner:NFO_77_FIVE_MINUTE');
  const live = { time: Date.parse(candles().at(-1).ts) / 1000, open: 120, high: 140, low: 110, close: 139 };
  builder.candles.push(live);
  const joined = a.ensureHistory('NFO', '77', 'FIVE_MINUTE');
  release(); await Promise.all([pending, joined]);
  assert.equal(calls, 1); assert.deepEqual(builder.candles.at(-1), live);
  assert.equal(a.subscribers.get('scanner:NFO_77_FIVE_MINUTE').refCount, 1);
});
