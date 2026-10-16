// Pure, as-of replay. No clock reads, broker calls, execution, or instance state.
const { normalizeSession, sessionBounds } = require('../../services/underlyingCandleStream');
const RULE_VERSION = '0.2.1';
const STRATEGY_ID = 'IndexVwapOrb';
const TOLERANCE = Object.freeze({ NIFTY: 10, BANKNIFTY: 20, SENSEX: 30 });
const INSTRUMENTS = Object.freeze({ NIFTY: { exchange: 'NSE', symboltoken: '99926000' },
  BANKNIFTY: { exchange: 'NSE', symboltoken: '99926009' }, SENSEX: { exchange: 'BSE', symboltoken: '99919000' } });
const MINUTE = 60000;

function candleStart(candle) {
  const value = candle?.time ?? candle?.ts;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e10 ? value * 1000 : value;
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN;
}

function analyzeIndexVwapOrb(context = {}, config = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  const underlying = config.underlying ?? context.underlying;
  const asOf = context.asOf;
  const base = { strategyId: STRATEGY_ID, ruleVersion: RULE_VERSION, underlying, signal: 'NONE', isEntry: false,
    isExit: false, state: 'BUILDING_OR', failedReasons: [], diagnostics: {} };
  const fail = (reason, diagnostics = {}) => ({ ...base, state: 'DATA_BLOCKED', failedReasons: [reason], diagnostics });
  if (!Object.hasOwn(INSTRUMENTS, underlying || '')) return fail('UNSUPPORTED_UNDERLYING');
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) return fail('EXPLICIT_AS_OF_REQUIRED');
  if (context.underlying && context.underlying !== underlying) return fail('UNDERLYING_MISMATCH');
  const snapshot = context.snapshot;
  const oneMinute = snapshot?.candles1m ?? context.candles1m;
  const fiveMinute = snapshot?.candles5m ?? context.candles5m;
  if (!Array.isArray(oneMinute) || !Array.isArray(fiveMinute)) return fail('BOTH_TIMEFRAME_HISTORIES_REQUIRED');
  if (context.consumedSetupIds !== undefined && (!Array.isArray(context.consumedSetupIds)
    || context.consumedSetupIds.some(id => typeof id !== 'string'))) return fail('INVALID_CONSUMED_SETUP_IDS');
  const tolerance = config.retestTolerancePointsByUnderlying?.[underlying] ?? TOLERANCE[underlying];
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1000000) {
    return fail('INVALID_RETEST_TOLERANCE');
  }
  const { date, open } = sessionBounds(asOf);
  if (snapshot?.date && snapshot.date !== date) return fail('SESSION_MISMATCH');
  if (oneMinute.some(c => c?.complete === false && candleStart(c) >= open && candleStart(c) + MINUTE <= asOf)) return fail('INCOMPLETE_CLOSED_BAR');
  const normalized = normalizeSession(oneMinute, asOf);
  if (!normalized.complete) return fail('INVALID_SESSION_DATA', { errors: normalized.errors, missingBars: normalized.missingBars });
  const bars = normalized.candles1m;
  const derived5m = normalized.candles5m;
  // Reject a second stream that contradicts the source 1M series. No double-counted VWAP.
  const seen5 = new Map(); let prior5 = null;
  for (const candle of fiveMinute) {
    const start = candleStart(candle);
    if (!Number.isFinite(start)) return fail('INVALID_5M_TIMESTAMP');
    if (start < open || start + 5 * MINUTE > asOf) continue;
    if (candle.synthetic || candle.complete === false || (prior5 !== null && start < prior5)) return fail('INVALID_5M_STREAM');
    if (candle.closeTime !== undefined && candle.closeTime !== start + 5 * MINUTE) return fail('INVALID_5M_CLOSE_TIME');
    const values = ['open', 'high', 'low', 'close', 'volume'].map(key => candle[key]);
    if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return fail('INVALID_5M_OHLCV');
    if (seen5.has(start) && JSON.stringify(seen5.get(start)) !== JSON.stringify(values)) return fail('CONFLICTING_5M_DUPLICATE');
    seen5.set(start, values); prior5 = start;
  }
  if (seen5.size !== derived5m.length || derived5m.some(c => !seen5.has(c.time * 1000)
    || ['open', 'high', 'low', 'close', 'volume'].some((key, i) => Math.abs(c[key] - seen5.get(c.time * 1000)[i]) > 1e-8))) {
    return fail('TIMEFRAME_MISMATCH');
  }
  if (oneMinute.some(c => c?.closeTime !== undefined && candleStart(c) + MINUTE <= asOf && candleStart(c) >= open
    && c.closeTime !== candleStart(c) + MINUTE)) return fail('INVALID_1M_CLOSE_TIME');
  if (asOf < open + 15 * MINUTE) return { ...base, failedReasons: ['OPENING_RANGE_BUILDING'] };
  const opening = derived5m.slice(0, 3);
  const orHigh = Math.max(...opening.map(c => c.high));
  const orLow = Math.min(...opening.map(c => c.low));
  const cutoff = open + 135 * MINUTE;
  const instrument = { underlying, ...INSTRUMENTS[underlying], referenceType: 'INDEX_SPOT' };
  const fiveByClose = new Map(derived5m.map(c => [c.closeTime, c]));
  let setup = null, state = 'WAITING_BREAKOUT', weighted = 0, volume = 0, vwap = null, latestCandidate = null;
  const vwapSeries = [];
  const consumed = new Set(context.consumedSetupIds ?? []); // supplied by later runner/session admission
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    weighted += (bar.high / 3 + bar.low / 3 + bar.close / 3) * bar.volume;
    volume += bar.volume; vwap = volume > 0 ? weighted / volume : null;
    if (!Number.isFinite(weighted) || !Number.isFinite(volume)) return fail('VWAP_OVERFLOW');
    vwapSeries.push({ time: bar.time, value: vwap });
    if (bar.closeTime <= open + 15 * MINUTE || bar.closeTime > cutoff) continue;
    const five = fiveByClose.get(bar.closeTime);
    if (five) {
      const side = five.close > orHigh ? 'LONG' : five.close < orLow ? 'SHORT' : null;
      if (side && (!setup || setup.direction !== side)) {
        setup = { direction: side, breakout: five, retest: null, pivot: null,
          setupId: `${STRATEGY_ID}:${RULE_VERSION}:${underlying}:${date}:${side}:${five.closeTime}` };
        state = 'WAITING_RETEST';
      } else if (setup && !setup.retest && five.closeTime > setup.breakout.closeTime) {
        const holds = setup.direction === 'LONG'
          ? five.low <= orHigh + tolerance && five.close >= orHigh
          : five.high >= orLow - tolerance && five.close <= orLow;
        if (holds) { setup.retest = five; state = 'WAITING_1M_CONFIRMATION'; }
      }
    }
    if (!setup?.retest) continue;
    // At i, only i-2 is newly confirmable. Its right-hand bars have already closed.
    const pivotIndex = i - 2;
    const centre = bars[pivotIndex];
    if (pivotIndex >= 2 && centre.time * 1000 >= setup.retest.closeTime) {
      const neighbours = [bars[pivotIndex - 2], bars[pivotIndex - 1], bars[pivotIndex + 1], bars[pivotIndex + 2]];
      const isPivot = setup.direction === 'LONG' ? neighbours.every(c => centre.high > c.high)
        : neighbours.every(c => centre.low < c.low);
      if (isPivot) setup.pivot = { price: setup.direction === 'LONG' ? centre.high : centre.low,
        formedAt: centre.time * 1000, confirmedAt: bar.closeTime };
    }
    if (!setup.pivot || bar.closeTime <= setup.pivot.confirmedAt || vwap === null) continue;
    const breaks = setup.direction === 'LONG' ? bar.close > setup.pivot.price : bar.close < setup.pivot.price;
    const agrees = setup.direction === 'LONG' ? bar.close > vwap : bar.close < vwap;
    if (!breaks || !agrees) continue;
    const entryPrice = bar.close;
    const stopLoss = setup.direction === 'LONG' ? setup.retest.low - 2 : setup.retest.high + 2;
    const riskPoints = setup.direction === 'LONG' ? entryPrice - stopLoss : stopLoss - entryPrice;
    if (!Number.isFinite(riskPoints) || riskPoints <= 0 || stopLoss <= 0) continue;
    const takeProfit = setup.direction === 'LONG' ? entryPrice + 2 * riskPoints : entryPrice - 2 * riskPoints;
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) continue;
    const candidate = { direction: setup.direction, setupId: setup.setupId,
      signalId: `${setup.setupId}:${bar.closeTime}`, signalClosedAt: bar.closeTime, referenceInstrument: instrument,
      entryPrice, stopLoss, takeProfit, riskPoints, riskReward: 2,
      orHigh, orLow, vwap, vwapSource: 'SELECTED_INDEX_1M_SESSION_HLC3_VOLUME',
      breakoutClosedAt: setup.breakout.closeTime, retestClosedAt: setup.retest.closeTime,
      pullbackLow: setup.retest.low, pullbackHigh: setup.retest.high, pivot: { ...setup.pivot } };
    if (!consumed.has(setup.setupId)) latestCandidate = candidate;
    // One candidate per setup. Further opportunities require a fresh 5M sequence.
    setup = null; state = 'WAITING_BREAKOUT';
  }
  const diagnostics = { sessionDate: date, asOf, orHigh, orLow, vwap, vwapSeries, tolerancePoints: tolerance,
    vwapSource: 'SELECTED_INDEX_1M_SESSION_HLC3_VOLUME', setup: setup ? structuredClone(setup) : null,
    latestCandidate, latestClosedAt: bars.at(-1).closeTime };
  if (asOf > cutoff) return { ...base, state: 'ENTRY_WINDOW_CLOSED', diagnostics, failedReasons: ['ENTRY_CUTOFF_PASSED'] };
  if (latestCandidate?.signalClosedAt === bars.at(-1).closeTime) {
    if (asOf - latestCandidate.signalClosedAt > 5000) return { ...base, state: 'SIGNAL_EXPIRED', diagnostics, failedReasons: ['SIGNAL_TOO_OLD'] };
    return { ...base, ...latestCandidate, state: 'SIGNAL_READY', signal: latestCandidate.direction === 'LONG' ? 'BUY_CE' : 'BUY_PE',
      isEntry: true, target: latestCandidate.takeProfit, diagnostics };
  }
  return { ...base, state, diagnostics, failedReasons: [state] };
}

module.exports = { analyzeIndexVwapOrb, RULE_VERSION, TOLERANCE };
