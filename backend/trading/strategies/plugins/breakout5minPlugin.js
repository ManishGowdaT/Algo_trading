const BaseStrategy = require('../BaseStrategy');
const { computePremiumRange, detectBreakoutCloseOnly, shouldProcessCandle } = require('../premiumRangeBreakout');

class Breakout5minPlugin extends BaseStrategy {
  static manifest = {
    id: '5minBreakout',
    name: '5 Min Premium Range Breakout Strategy',
    version: '1.0.0',
    engineVersion: '1.0.0',
    description: 'Breakout strategy based on 5-minute premium range bounds.',
    requires: {
      timeframe: 'ONE_MINUTE',
      lookbackCandles: 6,
      dataStreams: ['CE_CANDLES', 'PE_CANDLES']
    },
    parameters: {
      lookback: { type: 'number', default: 5, label: 'Lookback Period' },
      maxRangeLimit: { type: 'number', default: 30, label: 'Max Range Limit (Pts)' },
      bufferPoints: { type: 'number', default: 2, label: 'Buffer Points' },
      targetPoints: { type: 'number', default: 20, label: 'Target Points' },
      cooldownMinutes: { type: 'number', default: 1, label: 'Cooldown (min)' }
    }
  };

  constructor(config = {}) {
    super(config);
    this.lookback = Number(config.lookback) || 5;
    this.maxRangeLimit = Number(config.maxRangeLimit) || 30;
    this.bufferPoints = Number(config.bufferPoints) || 2;
    this.targetPoints = Number(config.targetPoints) || 20;
  }

  analyze(context) {
    const { items, lastProcessedTs } = context;
    const requiredCandles = this.lookback + 1;

    if (!Array.isArray(items) || items.length < requiredCandles) {
      return { isBreakout: false, failedReasons: ['Insufficient candle data'] };
    }

    const window = this.getLastCompletedCandleWindow(items, this.lookback);
    if (!window) {
      return { isBreakout: false, failedReasons: ['Completed candle window unavailable'] };
    }

    const range = computePremiumRange(window.rangeCandles, this.lookback, this.maxRangeLimit);
    const nextTs = window.breakoutCandle.ts;
    const isNewCandle = shouldProcessCandle({ lastProcessedTs, nextTs });

    if (!isNewCandle) {
      return { isBreakout: false, nextTs, failedReasons: ['Candle timestamp already processed'] };
    }

    const isBreakout = range ? detectBreakoutCloseOnly({ candleClose: window.breakoutCandle.close, range }) : false;

    return {
      isBreakout,
      nextTs,
      range,
      breakoutCandle: window.breakoutCandle,
      entryPrice: window.breakoutCandle.close,
      stopLoss: range ? range.rangeLow - this.bufferPoints : null,
      target: window.breakoutCandle.close + this.targetPoints,
      failedReasons: isBreakout ? [] : ['Breakout condition not met']
    };
  }

  getLastCompletedCandleWindow(candles, lookback) {
    if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
    const now = new Date();
    now.setSeconds(0, 0);
    const currentMinuteStartMs = now.getTime();

    const parseCandleTsMs = (ts) => {
      const raw = String(ts || '').trim();
      if (!raw) return null;
      const direct = Date.parse(raw);
      if (Number.isFinite(direct)) return direct;
      const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
      if (!m) return null;
      return new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6] || 0).getTime();
    };

    // Feed buffers use Unix seconds; retain support for existing REST ts candles.
    const normalized = candles.map(c => {
      if (c.ts || !Number.isFinite(c.time)) return c;
      const date = new Date(c.time * 1000);
      return Number.isFinite(date.getTime()) ? { ...c, ts: date.toISOString() } : c;
    });
    const completed = normalized.filter(c => {
      const ms = parseCandleTsMs(c.ts);
      return ms !== null && ms < currentMinuteStartMs;
    });

    if (completed.length < lookback + 1) return null;

    const breakoutCandle = completed[completed.length - 1];
    const rangeCandles = completed.slice(completed.length - (lookback + 1), completed.length - 1);
    if (rangeCandles.length !== lookback) return null;
    return { rangeCandles, breakoutCandle };
  }
}

module.exports = Breakout5minPlugin;
