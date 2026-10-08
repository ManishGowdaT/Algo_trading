'use strict';
const accounts = require('./accountContext');
const { requestPython } = require('./pythonApiClient');
const active = require('./activeAccountService');
const exchanges = new Set(['NSE', 'BSE', 'NFO', 'BFO', 'MCX']);
const intervals = new Set(['ONE_MINUTE', 'THREE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE', 'ONE_HOUR']);
const cache = new Map();
const inFlight = new Map();
const streams = new Map();
let totalStreams = 0;
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function text(value, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw invalid('Invalid search parameters.');
  return value.trim();
}
function searchInput(query) {
  const q = text(query.query);
  if (q.length < 2) throw invalid('Enter at least two characters.');
  const exchange = query.exchange === undefined ? 'ALL' : text(query.exchange, 10).toUpperCase();
  if (exchange !== 'ALL' && !exchanges.has(exchange)) throw invalid('Unsupported exchange.');
  return { query: q, exchange };
}
function selectionInput(query) {
  const exchange = text(query.exchange, 10).toUpperCase();
  const symboltoken = text(query.symboltoken, 32);
  const interval = query.interval === undefined ? 'FIVE_MINUTE' : text(query.interval, 24);
  if (!exchanges.has(exchange) || !/^\d+$/.test(symboltoken) || !intervals.has(interval)) throw invalid('Unsupported instrument or timeframe.');
  return { exchange, symboltoken, interval };
}
function scope(context) { return `${context.userId}:${context.brokerAccountId}:${context.sessionGeneration}:${context.sessionId}`; }
async function read(path, context) {
  await accounts.validate(context);
  const key = `${scope(context)}:${path}`;
  for (const [id, entry] of cache) if (entry.until <= Date.now()) cache.delete(id);
  const entry = cache.get(key);
  if (entry) return entry.data;
  if (!inFlight.has(key)) {
    if (inFlight.size >= 16) throw Object.assign(new Error('Search is busy. Try again shortly.'), { status: 503 });
    const promise = (async () => {
      const { response, data } = await requestPython(path, { context, timeoutMs: 10000 });
      if (!response.ok) throw Object.assign(new Error(response.status === 429 ? 'Market data is rate limited. Try again shortly.' : 'Instrument directory is unavailable. Reconnect your broker if needed.'), { status: response.status === 401 ? 503 : response.status });
      await accounts.validate(context);
      if (cache.size >= 500) cache.delete(cache.keys().next().value);
      cache.set(key, { data, until: Date.now() + 30000 });
      return data;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
  }
  return inFlight.get(key);
}
function reserve(context) {
  const key = `${context.userId}:${context.brokerAccountId}`;
  if ((streams.get(key) || 0) >= 2 || totalStreams >= 100) throw Object.assign(new Error('Live chart limit reached. Close another chart and retry.'), { status: 429 });
  streams.set(key, (streams.get(key) || 0) + 1); totalStreams++;
  let done = false;
  return () => { if (done) return; done = true; totalStreams--; const remaining = streams.get(key) - 1; if (remaining) streams.set(key, remaining); else streams.delete(key); };
}
function sessionCurrent(context) {
  const record = active.getActiveAccount(context.userId, context.brokerAccountId);
  return record?.sessionId === context.sessionId && record?.sessionGeneration === context.sessionGeneration && record?.ownerGeneration === context.ownerGeneration;
}
function snapshot(service, instrument, interval, now = Date.now()) {
  const builder = service.candleBuilders.get(`chart:${service.getBufferKey(instrument.exchange, instrument.symboltoken, interval)}`);
  const quote = service.ltpCache.get(`${service.getExchangeType(instrument.exchange)}:${instrument.symboltoken}`);
  const age = quote ? now - (Number.isFinite(quote.timestamp) ? quote.timestamp : quote.receivedAt) : Infinity;
  const status = service.destroyed || !service.sessionAvailable ? 'DISCONNECTED'
    : !quote ? 'WAITING' : !Number.isFinite(age) || age < -5000 || age > 15000 ? 'STALE'
      : quote.source === 'ANGEL_FULL' ? 'SNAPSHOT'
        : quote.source !== 'ANGEL_WEBSOCKET' ? 'FALLBACK' : 'LIVE';
  return { instrument, interval, status, serverTime: now,
    quote: quote ? { ltp: quote.ltp, timestamp: ['ANGEL_WEBSOCKET', 'ANGEL_FULL'].includes(quote.source) ? quote.timestamp : null,
      receivedAt: quote.receivedAt, source: quote.source } : null,
    historyStatus: builder?.historyReady ? 'READY' : builder?.historyFailures ? 'RETRYING' : 'LOADING',
    candles: [...(builder?.candles || []), ...(builder?.activeCandle ? [builder.activeCandle] : [])]
      .map(({ time, open, high, low, close }) => ({ time, open, high, low, close })) };
}
module.exports = { searchInput, selectionInput, read, reserve, sessionCurrent, snapshot };
