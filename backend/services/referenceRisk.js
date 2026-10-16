// Generic reference-risk decisions. No broker calls and no strategy-specific exits.
const { sessionBounds } = require('./underlyingCandleStream');
function reason(snapshot, quote, now = Date.now()) {
  const risk = snapshot.referenceRisk;
  if (!risk) return null;
  if (!Number.isFinite(risk.squareOffAt) || !['LONG', 'SHORT'].includes(risk.direction) || ![risk.entry, risk.stop, risk.target].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error('Invalid persisted index risk snapshot');
  }
  const info = require('./candleService').INDEX_SPOT_TOKENS[risk.underlying];
  const points = risk.direction === 'LONG' ? risk.entry - risk.stop : risk.stop - risk.entry;
  if (!info || info.exchange !== risk.exchange || info.symboltoken !== risk.symboltoken || points <= 0
    || Math.abs(risk.target - (risk.entry + (risk.direction === 'LONG' ? 2 : -2) * points)) > 1e-8
    || !Number.isFinite(risk.signalClosedAt) || risk.squareOffAt <= risk.signalClosedAt) throw new Error('Invalid persisted index risk identity or levels');
  // Due liquidation is independent of spot feed health, including next-session recovery.
  if (now >= risk.squareOffAt) return 'EOD';
  if (!quote || quote.exchange !== risk.exchange || String(quote.symboltoken) !== risk.symboltoken
    || !Number.isFinite(quote.ltp) || quote.ltp <= 0 || !Number.isFinite(quote.quoteTimestamp)
    || now - quote.quoteTimestamp > 5000 || quote.quoteTimestamp - now > 5000) throw new Error('Index risk quote missing, mismatched or stale');
  if (risk.direction === 'LONG') return quote.ltp <= risk.stop ? 'SL' : quote.ltp >= risk.target ? 'Target' : null;
  return quote.ltp >= risk.stop ? 'SL' : quote.ltp <= risk.target ? 'Target' : null;
}
function snapshotFromSignal(signal, contract) {
  const { open } = sessionBounds(signal.signalClosedAt);
  const info = require('./candleService').INDEX_SPOT_TOKENS[signal.underlying];
  if (!info || !['LONG', 'SHORT'].includes(signal.direction)) throw new Error('Invalid reference signal');
  const risk = signal.direction === 'LONG' ? signal.entryPrice - signal.stopLoss : signal.stopLoss - signal.entryPrice;
  if (!Number.isFinite(risk) || risk <= 0 || Math.abs(signal.takeProfit - (signal.entryPrice + (signal.direction === 'LONG' ? 2 : -2) * risk)) > 1e-8) throw new Error('Invalid index reference risk');
  return { type: 'INDEX_SPOT', underlying: signal.underlying, exchange: info.exchange, symboltoken: info.symboltoken,
    direction: signal.direction, entry: signal.entryPrice, stop: signal.stopLoss, target: signal.takeProfit,
    signalClosedAt: signal.signalClosedAt, ruleVersion: signal.ruleVersion, setupId: signal.setupId,
    squareOffAt: open + 365 * 60000, // 09:15 -> 15:20 IST; persisted across restarts.
    optionExpiry: contract.expiry, optionStrike: contract.strike, optionType: contract.option_type };
}
module.exports = { reason, snapshotFromSignal };
