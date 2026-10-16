const { INDEX_SPOT_TOKENS } = require('./candleService');
const OFFSET = 330 * 60000;
const MINUTE = 60000;

function sessionBounds(now) {
  const day = Math.floor((now + OFFSET) / 86400000) * 86400000 - OFFSET;
  return { date: new Date(day + OFFSET).toISOString().slice(0, 10), open: day + 555 * MINUTE, close: day + 930 * MINUTE };
}

// A complete session snapshot, never a rolling 200-bar buffer. No synthetic bars.
function normalizeSession(items, now) {
  const { date, open, close } = sessionBounds(now);
  const end = Math.min(Math.floor(now / MINUTE) * MINUTE, close);
  const rows = new Map(); const errors = [];
  let prior = null;
  for (const item of items || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push('INVALID_ROW'); continue; }
    const raw = item.ts ?? item.time;
    const numeric = typeof raw === 'number' ? raw : NaN;
    const ms = Number.isFinite(numeric) ? (numeric < 1e10 ? numeric * 1000 : numeric)
      : (typeof raw === 'string' && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? Date.parse(raw) : NaN);
    if (!Number.isFinite(ms)) { errors.push('INVALID_TIMESTAMP'); continue; }
    if (ms < open || ms >= end) continue; // exclude other sessions and forming bars
    if (ms % MINUTE) { errors.push('MISALIGNED_BAR'); continue; }
    if (prior !== null && ms < prior) errors.push('OUT_OF_ORDER');
    prior = ms;
    const values = ['open', 'high', 'low', 'close'].map(key => item[key]);
    if (!values.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
      || item.high < Math.max(item.open, item.close) || item.low > Math.min(item.open, item.close)
      || item.high < item.low || item.synthetic) { errors.push('INVALID_OR_SYNTHETIC_BAR'); continue; }
    const volume = typeof item.volume === 'number' && Number.isFinite(item.volume) && item.volume >= 0 ? item.volume : null;
    if (volume === null) errors.push('INVALID_OR_MISSING_VOLUME');
    const row = { time: ms / 1000, open: item.open, high: item.high, low: item.low, close: item.close,
      volume, closeTime: ms + MINUTE, complete: true, synthetic: false, source: 'ANGEL_HISTORICAL' };
    if (rows.has(ms) && JSON.stringify(rows.get(ms)) !== JSON.stringify(row)) errors.push('CONFLICTING_DUPLICATE');
    rows.set(ms, row); // identical overlaps count once
  }
  const candles1m = [...rows.values()].sort((a, b) => a.time - b.time);
  let missingBars = 0;
  for (let time = open; time < end; time += MINUTE) if (!rows.has(time)) missingBars++;
  if (missingBars) errors.push('SESSION_GAP');
  if (!candles1m.length) errors.push('NO_COMPLETED_BARS');
  if (!candles1m.some(c => c.volume > 0)) errors.push('ZERO_CUMULATIVE_VOLUME');
  if (!Number.isFinite(candles1m.reduce((sum, c) => sum + (c.volume ?? 0), 0))) errors.push('VOLUME_OVERFLOW');
  const candles5m = [];
  for (let time = open; time + 5 * MINUTE <= end; time += 5 * MINUTE) {
    const group = Array.from({ length: 5 }, (_, i) => rows.get(time + i * MINUTE));
    if (group.some(c => !c || c.volume === null)) continue;
    candles5m.push({ time: time / 1000, open: group[0].open, high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)), close: group[4].close,
      volume: group.reduce((sum, c) => sum + c.volume, 0), closeTime: time + 5 * MINUTE,
      complete: true, synthetic: false, source: 'AGGREGATED_ANGEL_1M' });
  }
  const latestCloseTime = candles1m.at(-1)?.closeTime ?? null;
  return { date, candles1m, candles5m, missingBars, errors: [...new Set(errors)], complete: errors.length === 0,
    latestCloseTime, fresh: latestCloseTime !== null && now >= latestCloseTime && now - latestCloseTime <= 5000 };
}

class UnderlyingCandleStream {
  constructor(owner, underlying, now = () => Date.now()) {
    if (!['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(underlying)) throw new Error('Unsupported index candle stream');
    this.owner = owner; this.underlying = underlying; this.instrument = INDEX_SPOT_TOKENS[underlying];
    this.now = now; this.references = 0; this.stopped = false; this.timer = null; this.inFlight = null;
    this.lastEmitted = {}; this.snapshot = normalizeSession([], now()); this.failures = 0;
  }
  getSnapshot() {
    const current = sessionBounds(this.now());
    if (this.snapshot.date !== current.date) return normalizeSession([], this.now());
    const copy = structuredClone(this.snapshot);
    copy.fresh = copy.latestCloseTime !== null && this.now() >= copy.latestCloseTime && this.now() - copy.latestCloseTime <= 5000;
    copy.ready = copy.complete && copy.fresh && !this.stopped && !this.owner.destroyed;
    return copy;
  }
  async refresh() {
    if (this.stopped || this.owner.destroyed) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetch().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async fetch() {
    const { date, open, close } = sessionBounds(this.now());
    if (this.now() < open + MINUTE || this.now() > close + MINUTE) {
      if (this.snapshot.date !== date) this.snapshot = normalizeSession([], this.now());
      return;
    }
    const info = this.instrument;
    try {
      await this.owner.validateUnderlyingContext();
      if (this.stopped || this.owner.destroyed) return;
      const { response, data } = await this.owner.requestPython(`/market/candles?exchange=${info.exchange}&symboltoken=${info.symboltoken}&interval=ONE_MINUTE&date=${date}&include_volume=true`,
        { context: this.owner.accountContext, timeoutMs: 5000 });
      await this.owner.validateUnderlyingContext();
      if (this.stopped || this.owner.destroyed || sessionBounds(this.now()).date !== date) return;
      if (!response.ok || !Array.isArray(data?.items)) throw new Error(`INDEX_HISTORY_UNAVAILABLE_${response.status || 'INVALID'}`);
      this.snapshot = normalizeSession(data.items, this.now());
      this.snapshot.receivedAt = this.now();
      this.failures = 0;
      if (!this.snapshot.complete) return;
      // 5M is delivered before 1M at a common boundary. Backfill emits only the latest
      // closed bar; old bars are context, never a sequence of historical entry events.
      for (const [interval, key] of [['FIVE_MINUTE', 'candles5m'], ['ONE_MINUTE', 'candles1m']]) {
        const candle = this.snapshot[key].at(-1);
        if (!candle || candle.closeTime <= (this.lastEmitted[interval] || 0)) continue;
        this.lastEmitted[interval] = candle.closeTime;
        this.owner.emit('candle:closed', { ...this.owner.sessionIdentity, role: 'underlying', underlying: this.underlying,
          exchange: info.exchange, symboltoken: info.symboltoken, interval, closedAt: candle.closeTime,
          deliveredAt: this.now(), synthetic: false, candle: structuredClone(candle), candles: structuredClone(this.snapshot[key]),
          dataReady: this.getSnapshot().ready });
      }
    } catch (error) {
      if (this.stopped || this.owner.destroyed) return;
      this.failures++;
      this.snapshot = { ...normalizeSession([], this.now()), errors: ['INDEX_HISTORY_UNAVAILABLE'], lastError: error.message };
    }
  }
  schedule() {
    if (this.stopped || this.owner.destroyed || this.timer) return;
    const now = this.now(); const { open, close } = sessionBounds(now);
    // One refresh per boundary, bounded repair retries for delayed/incomplete broker history.
    const needsRepair = now >= open + MINUTE && now < close + MINUTE
      && (!this.snapshot.complete || this.snapshot.latestCloseTime < Math.floor(now / MINUTE) * MINUTE);
    const boundary = Math.floor(now / MINUTE) * MINUTE;
    if (this.repairBoundary !== boundary) { this.repairBoundary = boundary; this.repairAttempts = 0; }
    const nextBoundaryDelay = Math.max(1000, boundary + MINUTE + 1000 - now);
    const delay = needsRepair && this.repairAttempts < 3
      ? Math.min(nextBoundaryDelay, 3000 * 2 ** this.repairAttempts++) : nextBoundaryDelay;
    this.nextRefreshAt = now + delay;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await this.refresh(); } finally { this.schedule(); }
    }, delay);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }
}

module.exports = { UnderlyingCandleStream, normalizeSession, sessionBounds };
