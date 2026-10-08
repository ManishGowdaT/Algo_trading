const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const search = require('../services/instrumentSearchService');
const { fixture } = require('./helpers/executionFixture');
const controller = require('../controllers/instrumentSearchController');

const instrument = { exchange: 'NFO', symboltoken: '77', tradingsymbol: 'NIFTY-CE', name: 'NIFTY', instrumentType: 'OPTIDX' };
function bars(interval = 300000) {
  const start = Math.floor(Date.now() / interval) * interval;
  return Array.from({ length: 4 }, (_, i) => ({ ts: new Date(start - (4 - i) * interval).toISOString(), open: 100, high: 110, low: 90, close: 105 }));
}
class Response extends EventEmitter {
  constructor() { super(); this.writableLength = 0; this.frames = []; this.destroyed = false; }
  status(code) { this.statusCode = code; return this; }
  set(headers) { this.headers = headers; return this; }
  flushHeaders() { this.headersSent = true; }
  write(frame) { this.frames.push(JSON.parse(frame.slice(6).trim())); return true; }
  end() { this.emit('close'); }
  json(body) { this.body = body; return this; }
}

test('search rejects arrays, unsupported exchanges, short input and oversized instrument identities', () => {
  for (const query of [{ query: ['NIFTY'] }, { query: 'A' }, { query: 'A'.repeat(81) }, { query: 'NIFTY', exchange: 'NYSE' }]) assert.throws(() => search.searchInput(query), { status: 400 });
  assert.deepEqual(search.searchInput({ query: ' nifty ce ', exchange: 'nfo' }), { query: 'nifty ce', exchange: 'NFO' });
  assert.throws(() => search.selectionInput({ exchange: 'NFO', symboltoken: '77&x=y' }), { status: 400 });
  assert.throws(() => search.selectionInput({ exchange: 'NFO', symboltoken: '77', interval: 'BOGUS' }), { status: 400 });
});

test('chart admission is bounded per account and release is idempotent', () => {
  const context = { userId: 'bounded-user', brokerAccountId: 'bounded-account' };
  const a = search.reserve(context), b = search.reserve(context);
  assert.throws(() => search.reserve(context), { status: 429 });
  const other = search.reserve({ ...context, brokerAccountId: 'another-account' });
  a(); a(); const c = search.reserve(context);
  b(); c(); other();
});

test('chart subscription shares broker token references without affecting strategy candles; stale/fallback states are honest', async t => {
  const f = await fixture(t);
  const context = f.contexts[0];
  const service = await f.accounts.run(context, () => f.feeds.ensureReady());
  t.mock.method(service, 'requestPython', async () => ({ response: { ok: true }, data: { items: bars() } }));
  await service.subscribe('NFO', '77', 'FIVE_MINUTE', null, { role: 'scanner', tradingsymbol: 'NIFTY-CE' });
  await service.subscribe('NFO', '77', 'FIVE_MINUTE', null, { role: 'chart', tradingsymbol: 'NIFTY-CE' });
  assert.equal(service.streamSubscribers.get('2:77').refCount, 2);
  let strategyEvents = 0;
  service.on('candle:closed', event => { if (event.role === 'scanner') strategyEvents++; });
  service.handleTick({ token: '77', exchangeType: 2, ltp: 106, timestamp: Date.now() }, service.sessionIdentity);
  const live = search.snapshot(service, instrument, 'FIVE_MINUTE');
  assert.equal(live.status, 'LIVE');
  assert.equal(live.candles.length, 5);
  assert.equal(search.snapshot(service, instrument, 'FIVE_MINUTE', Date.now() + 16000).status, 'STALE');
  const chart = service.candleBuilders.get('chart:NFO_77_FIVE_MINUTE');
  const previousClose = chart.activeCandle.close;
  service.handleTick({ token: '77', exchangeType: 2, ltp: 120, timestamp: Date.now(), isFallback: true }, service.sessionIdentity);
  assert.equal(search.snapshot(service, instrument, 'FIVE_MINUTE').status, 'FALLBACK');
  assert.equal(search.snapshot(service, instrument, 'FIVE_MINUTE').quote.timestamp, null);
  assert.equal(chart.activeCandle.close, previousClose, 'REST fallback must not fabricate chart candles');
  assert.equal(strategyEvents, 0);
  service.unsubscribe('NFO', '77', 'FIVE_MINUTE', 'chart');
  assert.equal(service.streamSubscribers.get('2:77').refCount, 1);
  assert.ok(service.candleBuilders.has('scanner:NFO_77_FIVE_MINUTE'));
  assert.ok(service.smartStream.subscribedTokens.has('2:77'));
  service.unsubscribe('NFO', '77', 'FIVE_MINUTE', 'scanner');
  assert.equal(service.streamSubscribers.size, 0);
});

test('SSE publishes verified selection, disconnect releases its reference, and foreign selection cannot initialize a feed', async t => {
  const f = await fixture(t);
  const context = f.contexts[0];
  const service = await f.accounts.run(context, () => f.feeds.ensureReady());
  t.mock.method(service, 'requestPython', async () => ({ response: { ok: true }, data: { items: bars() } }));
  t.mock.method(search, 'read', async (_path, receivedContext) => { assert.equal(receivedContext, context); return { item: instrument }; });
  const req = { query: { exchange: 'NFO', symboltoken: '77', interval: 'FIVE_MINUTE' }, accountContext: context };
  const res = new Response();
  await controller.live(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/event-stream');
  assert.equal(res.frames[0].instrument.symboltoken, '77');
  res.end(); res.end();
  assert.equal(service.streamSubscribers.size, 0);
  const mismatch = new Response();
  await controller.live({ ...req, query: { ...req.query, symboltoken: '88' } }, mismatch);
  assert.equal(mismatch.statusCode, 502);
  assert.equal(service.streamSubscribers.size, 0);
  await assert.rejects(f.accounts.resolve(context.userId, f.contexts[1].brokerAccountId), { status: 404 });
  assert.equal(f.state.calls.filter(call => call.path === '/angel/orders/simple').length, 0);
});

test('disconnect while history is in flight cannot leak a chart subscription', async t => {
  const f = await fixture(t);
  const context = f.contexts[0];
  const service = await f.accounts.run(context, () => f.feeds.ensureReady());
  let finish;
  t.mock.method(service, 'requestPython', () => new Promise(resolve => { finish = () => resolve({ response: { ok: true }, data: { items: bars() } }); }));
  t.mock.method(search, 'read', async () => ({ item: instrument }));
  const res = new Response();
  const pending = controller.live({ query: { exchange: 'NFO', symboltoken: '77' }, accountContext: context }, res);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  res.end(); finish(); await pending;
  assert.equal(service.streamSubscribers.size, 0);
  assert.equal(service.candleBuilders.size, 0);
});
