const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeIndexVwapOrb, RULE_VERSION } = require('../trading/strategies/indexVwapOrb');
const Plugin = require('../trading/strategies/plugins/indexVwapOrbPlugin');
const BaseStrategy = require('../trading/strategies/BaseStrategy');
const { normalizeSession } = require('../services/underlyingCandleStream');
const { validateStrategyConfig } = require('../utils/inputValidation');
const OPEN = Date.parse('2026-10-16T09:15:00+05:30');
function fixture(direction = 'LONG', count = 31) {
  const bars = Array.from({ length: count }, (_, i) => {
    let c = { open: 100, high: 110, low: 90, close: 100 };
    if (i >= 15 && i < 20) c = { open: 112, high: 116, low: 111, close: 114 };
    // Deliberately bearish retest for LONG (bullish mirror for SHORT).
    if (i >= 20 && i < 25) c = { open: 114, high: 115, low: 108, close: 112 };
    if (i >= 25) {
      const highs = [114, 115, 120, 116, 115, 122];
      const closes = [112, 113, 116, 114, 113, 121];
      c = { open: 112, high: highs[i - 25] ?? 123, low: 111, close: closes[i - 25] ?? 120 };
    }
    if (direction === 'SHORT') c = { open: 300 - c.open, high: 300 - c.low, low: 300 - c.high, close: 300 - c.close };
    return { time: (OPEN + i * 60000) / 1000, ...c, volume: 100 };
  });
  return bars;
}
function context(bars = fixture(), offset = 0, underlying = 'NIFTY') {
  const asOf = bars.at(-1).time * 1000 + 60000 + offset;
  const snapshot = normalizeSession(bars, asOf);
  return { underlying, asOf, candles1m: bars, candles5m: snapshot.candles5m };
}
function analyze(bars, config = {}, offset = 0) { return analyzeIndexVwapOrb(context(bars, offset), config); }

test('LONG and SHORT emit exact 2R index-reference signals on all supported indices', () => {
  for (const underlying of ['NIFTY', 'BANKNIFTY', 'SENSEX']) for (const direction of ['LONG', 'SHORT']) {
    const result = analyzeIndexVwapOrb(context(fixture(direction), 0, underlying), { underlying });
    assert.equal(result.isEntry, true);assert.equal(result.isExit, false);assert.equal(result.direction, direction);
    assert.equal(result.ruleVersion, RULE_VERSION);assert.equal(result.state, 'SIGNAL_READY');
    assert.equal(result.signal, direction === 'LONG' ? 'BUY_CE' : 'BUY_PE');
    assert.equal(result.entryPrice, direction === 'LONG' ? 121 : 179);
    assert.equal(result.stopLoss, direction === 'LONG' ? 106 : 194);
    assert.equal(result.riskPoints, 15);assert.equal(result.takeProfit, direction === 'LONG' ? 151 : 149);
    assert.equal(result.referenceInstrument.referenceType, 'INDEX_SPOT');
    assert.equal(result.referenceInstrument.exchange, underlying === 'SENSEX' ? 'BSE' : 'NSE');
    assert.equal(result.breakoutClosedAt, OPEN + 20 * 60000);
    assert.equal(result.retestClosedAt, OPEN + 25 * 60000);
    assert.equal(result.pivot.formedAt, OPEN + 27 * 60000);assert.equal(result.pivot.confirmedAt, OPEN + 30 * 60000);
    const bars = fixture(direction);
    assert.ok(Math.abs(result.vwap - bars.reduce((s, c) => s + (c.high + c.low + c.close) / 3, 0) / bars.length) < 1e-10);
  }
});
test('range, breakout, retest and pivot knowledge stages progress without premature entry', () => {
  assert.equal(analyze(fixture('LONG', 14)).state, 'BUILDING_OR');
  assert.equal(analyze(fixture('LONG', 15)).state, 'WAITING_BREAKOUT');
  assert.equal(analyze(fixture('LONG', 20)).state, 'WAITING_RETEST');
  for (const count of [25, 28, 29, 30]) {
    const result = analyze(fixture('LONG', count));assert.equal(result.isEntry, false);
    assert.equal(result.state, 'WAITING_1M_CONFIRMATION');
    if (count < 30) assert.equal(result.diagnostics.setup.pivot, null);
  }
});
test('immutable deterministic histories are equivalent to late-start replay and fresh plugin instances', () => {
  const input = context(); const original = JSON.stringify(input);
  for (const candle of input.candles1m) Object.freeze(candle);
  Object.freeze(input.candles1m);Object.freeze(input.candles5m);Object.freeze(input);
  const result = new Plugin({ underlying: 'NIFTY' }).analyze(input);
  assert.deepEqual(new Plugin({ underlying: 'NIFTY' }).analyze(input), result);
  for (let count = 15; count < 31; count++) analyze(fixture('LONG', count));
  assert.deepEqual(new Plugin({ underlying: 'NIFTY' }).analyze(input), result);
  assert.equal(JSON.stringify(input), original);
});
test('future/forming bars cannot confirm pivots or alter as-of VWAP', () => {
  const input = context(fixture('LONG', 29));
  input.candles1m = fixture('LONG', 36);
  const result = analyzeIndexVwapOrb(input);
  assert.equal(result.isEntry, false);assert.equal(result.diagnostics.setup.pivot, null);
  assert.equal(result.diagnostics.vwapSeries.length, 29);
});
test('as-of results match every replay prefix and ignore previous-session candle metadata', () => {
  for (const direction of ['LONG', 'SHORT']) for (let count = 15; count <= 31; count++) {
    const prefix = context(fixture(direction, count));
    const full = { ...prefix, candles1m: fixture(direction, 36) };
    assert.deepEqual(analyzeIndexVwapOrb(full), analyzeIndexVwapOrb(prefix));
  }
  const input = context();
  input.candles1m.unshift({ ...input.candles1m[0], time: OPEN / 1000 - 86400, volume: null, complete: false });
  assert.deepEqual(analyzeIndexVwapOrb(input), analyzeIndexVwapOrb(context()));
});
test('strict swing ties and close-only breaks cannot generate an entry', () => {
  const tied = fixture();tied[26].high = 120;assert.equal(analyze(tied).isEntry, false);
  const equality = fixture();equality[30].close = 120;assert.equal(analyze(equality).isEntry, false);
});
test('wrong-side retest, absent retest and VWAP disagreement cannot generate entries', () => {
  const wrong = fixture();for (let i = 20; i < 25; i++) wrong[i].close = 109;
  assert.equal(analyze(wrong).isEntry, false);
  const noRetest = fixture();for (let i = 20; i < 30; i++) noRetest[i] = { ...noRetest[i], low: 125, open: 130, high: 140, close: 135 };
  assert.equal(analyze(noRetest).isEntry, false);
  const vwap = fixture();for (let i = 0; i < 15; i++) vwap[i] = { ...vwap[i], open: 100, high: 110, low: 90, close: 100 };
  // A breakout bar with a large wick/volume lifts VWAP above the final close without changing OR.
  vwap[15].high = 1000;vwap[15].volume = 1e6;
  assert.equal(analyze(vwap).isEntry, false);
});
test('actual selected-index volume required; isolated zero allowed; no proxy or missing-data substitute', () => {
  const zero = fixture();zero[2].volume = 0;assert.equal(analyze(zero).isEntry, true);
  for (const volume of [null, undefined, NaN, -1]) {
    const input = fixture();input[1].volume = volume;assert.equal(analyze(input).state, 'DATA_BLOCKED');
  }
  assert.equal(analyze(fixture().map(c => ({ ...c, volume: 0 }))).state, 'DATA_BLOCKED');
  const gap = fixture();gap.splice(2, 1);assert.equal(analyze(gap).state, 'DATA_BLOCKED');
});
test('cross-timeframe mismatch, malformed close times and synthetic bars fail closed', () => {
  const mismatch = context();mismatch.candles5m[0].volume++;assert.equal(analyzeIndexVwapOrb(mismatch).state, 'DATA_BLOCKED');
  const synthetic = context();synthetic.candles1m[3].synthetic = true;assert.equal(analyzeIndexVwapOrb(synthetic).state, 'DATA_BLOCKED');
  const timestamp = context();timestamp.candles1m[0].closeTime = OPEN;assert.equal(analyzeIndexVwapOrb(timestamp).state, 'DATA_BLOCKED');
});
test('entry cutoff, freshness and consumed-setup suppression do not belong to broker execution', () => {
  assert.equal(analyze(fixture(), {}, 5000).isEntry, true);
  assert.equal(analyze(fixture(), {}, 5001).state, 'SIGNAL_EXPIRED');
  const afterCutoff = context(fixture('LONG', 136));assert.equal(analyzeIndexVwapOrb(afterCutoff).isEntry, false);
  assert.equal(analyzeIndexVwapOrb(afterCutoff).state, 'ENTRY_WINDOW_CLOSED');
  const candidate = analyze(fixture());const input = context();input.consumedSetupIds = [candidate.setupId];
  assert.equal(analyzeIndexVwapOrb(input).isEntry, false);
  assert.equal(analyze(fixture('LONG', 32)).isEntry, false);
});
test('exact 11:30 close is eligible only at the cutoff and cannot be admitted a millisecond later', () => {
  const input = fixture('LONG', 15);
  const rest = fixture().slice(15);
  for (let i = 0; i < 100; i++) input.push({ ...input[0], time: (OPEN + input.length * 60000) / 1000 });
  for (const c of rest) input.push({ ...c, time: (OPEN + input.length * 60000) / 1000 });
  input[130] = { ...input[130], close: 119, high: 119 };
  while (input.length < 135) input.push({ ...input[130], time: (OPEN + input.length * 60000) / 1000 });
  input[134] = { ...input[134], high: 122, close: 121 };
  assert.equal(analyze(input).isEntry, true);
  assert.equal(analyze(input, {}, 1).state, 'ENTRY_WINDOW_CLOSED');
});
test('opposite 5M breakout replaces a pending setup without a discretionary exit', () => {
  const input = fixture('LONG', 25);
  for (let i = 20; i < 25; i++) input[i] = { ...input[i], open: 89, high: 89, low: 85, close: 86 };
  const result = analyze(input);
  assert.equal(result.diagnostics.setup.direction, 'SHORT');assert.equal(result.state, 'WAITING_RETEST');assert.equal(result.isExit, false);
});
test('non-positive risk and invalid short target are rejected', () => {
  const input = fixture();
  for (let i = 20; i < 25; i++) input[i] = { ...input[i], open: 140, high: 141, low: 130, close: 135 };
  assert.equal(analyze(input, { retestTolerancePointsByUnderlying: { NIFTY: 1000 } }).isEntry, false);
  const short = fixture('SHORT');short[20].high = 300;
  assert.equal(analyze(short).isEntry, false);
});
test('per-index tolerance defaults and explicit overrides are validated', () => {
  for (const [underlying, tolerance] of [['NIFTY', 10], ['BANKNIFTY', 20], ['SENSEX', 30]]) {
    assert.equal(analyzeIndexVwapOrb(context(fixture(), 0, underlying)).diagnostics.tolerancePoints, tolerance);
  }
  assert.equal(analyze(fixture(), { retestTolerancePointsByUnderlying: { NIFTY: 0 } }).isEntry, true);
  assert.equal(analyze(fixture(), { retestTolerancePointsByUnderlying: { NIFTY: -1 } }).state, 'DATA_BLOCKED');
});
test('invalid context fails closed and adapter is compatible but not startable through current config API', () => {
  assert.equal(analyzeIndexVwapOrb().isEntry, false);
  assert.equal(analyzeIndexVwapOrb({ underlying: 'NIFTY' }).failedReasons[0], 'EXPLICIT_AS_OF_REQUIRED');
  assert.equal(analyzeIndexVwapOrb({ ...context(), underlying: 'SENSEX' }, { underlying: 'NIFTY' }).state, 'DATA_BLOCKED');
  assert.equal(BaseStrategy.validateManifest(Plugin.manifest), true);assert.equal(new Plugin().shouldExit({}), false);
  assert.equal(Plugin.manifest.executionReadiness, 'REFERENCE_RISK_ACCOUNT_GATED');
  assert.throws(() => validateStrategyConfig('IndexVwapOrb', {}), /Select NIFTY/);
});
