const { normalizeSession } = require('../../services/underlyingCandleStream');
const { analyzeIndexVwapOrb, RULE_VERSION } = require('../../trading/strategies/indexVwapOrb');
const OPEN = Date.parse('2026-10-16T09:15:00+05:30');
// Synthetic completed sessions: explicit test data, never broker history.
function candles(direction = 'LONG', scenario = 'signal') {
  return Array.from({ length: 375 }, (_, i) => {
    let c = { open: 100, high: 110, low: 90, close: 100 };
    if (i >= 15 && i < 20) c = { open: 112, high: 116, low: 111, close: 114 };
    if (i >= 20 && i < 25) c = { open: 114, high: 115, low: 108, close: 112 };
    if (i >= 25 && i <= 30) c = { open: 112, high: [114,115,120,116,115,122][i-25], low: 111, close: [112,113,116,114,113,121][i-25] };
    if (scenario === 'no-breakout') c = { open: 100, high: 110, low: 90, close: 100 };
    if (scenario === 'no-retest' && i >= 20 && i <= 30) c = { open: 150, high: 155, low: 145, close: 150 };
    if (scenario === 'failed-retest' && i >= 20 && i < 25) c.close = 109;
    if (scenario === 'failed-vwap' && i === 15) c = { ...c, high: 1000 };
    if (direction === 'SHORT') c = { open: 300-c.open, high: 300-c.low, low: 300-c.high, close: 300-c.close };
    return { time: OPEN / 1000 + i * 60, ...c, volume: scenario === 'zero-volume' ? 0 : scenario === 'failed-vwap' && i === 15 ? 1e6 : 100 };
  });
}
function evaluate(bars, count, underlying, offset = 0) {
  const asOf = OPEN + count * 60000 + offset;
  const snapshot = normalizeSession(bars.slice(0, count), asOf);
  return analyzeIndexVwapOrb({ underlying, asOf, snapshot }, { underlying });
}
function replay(underlying, direction, scenario) {
  const bars = candles(direction, scenario);
  if (scenario === 'missing-opening') bars[2] = { ...bars[2], time: bars[1].time };
  const trace = [];
  for (let count=1; count<=375; count++) {
    const result = evaluate(bars, count, underlying);
    if (result.isEntry || result.state !== trace.at(-1)?.state) trace.push({ asOf: OPEN + count*60000, state: result.state,
      failedReasons: result.failedReasons, ...(result.isEntry ? { signal: result } : {}) });
  }
  return { fixture: 'SYNTHETIC_COMPLETED_SESSION', ruleVersion: RULE_VERSION, underlying, direction, scenario, bars: bars.length, trace };
}
module.exports = { OPEN, candles, evaluate, replay };
