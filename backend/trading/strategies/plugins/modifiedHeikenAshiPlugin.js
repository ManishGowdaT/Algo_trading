const BaseStrategy = require('../BaseStrategy');
const strategyStats = require('../../../services/strategyStats');

class ModifiedHeikenAshiPlugin extends BaseStrategy {
  static manifest = {
    id: 'ModifiedHeikenAshi',
    name: 'Modified Heiken Ashi Strategy',
    version: '1.0.0',
    engineVersion: '1.0.0',
    description: 'Modified Heiken Ashi strategy logic supporting trailing stop loss options.',
    requires: {
      timeframe: 'FIVE_MINUTE',
      lookbackCandles: 20,
      dataStreams: ['CE_CANDLES', 'PE_CANDLES']
    },
    parameters: {
      emaPeriod: { type: 'number', default: 20, label: 'EMA Period', min: 2, max: 200 },
      jmaLength: { type: 'number', default: 7, label: 'JMA Length', min: 2, max: 100 },
      exitStrategy: { type: 'string', default: 'CANDLES', label: 'Exit Strategy' },
      initialSlPoints: { type: 'number', default: 30, label: 'Initial SL Points' },
      trailingStopPoints: { type: 'number', default: 20, label: 'Trailing Stop Points' },
      finalTargetPoints: { type: 'number', default: 100, label: 'Final Target Points' },
      cooldownMinutesSL: { type: 'number', default: 4, label: 'SL Cooldown (min)' },
      cooldownMinutesTarget: { type: 'number', default: 2, label: 'Target Cooldown (min)' }
    }
  };

  constructor(config = {}) {
    super(config);
    this.emaPeriod = Number(config.emaPeriod) || 20;
    this.jmaLength = Number(config.jmaLength) || 7;
  }

  analyze(context) {
    const { items, indicators } = context;
    if (!Array.isArray(items) || items.length < 2) {
      return { trend: 'NEUTRAL', ema: 0, jma: 0, haClose: 0, isEntry: false, isExit: false, failedReasons: ['Insufficient candle data'] };
    }

    const haCandles = indicators.computeHeikenAshi(items);
    const closes = haCandles.map(c => c.close);
    const emas = indicators.computeEMA(closes, this.emaPeriod);
    const jmas = indicators.computeJMA(closes, this.jmaLength);

    const lastClosedIdx = haCandles.length - 1;
    const prevClosedIdx = haCandles.length - 2;

    const last = haCandles[lastClosedIdx];
    const prev = haCandles[prevClosedIdx];
    const lastEma = emas[lastClosedIdx];
    const lastJma = jmas[lastClosedIdx];

    const lastNoWick = Math.abs(last.open - last.low) <= 0.05;
    const prevNoWick = Math.abs(prev.open - prev.low) <= 0.05;
    const lastGreen = last.close > last.open;
    const prevGreen = prev.close > prev.open;
    const jmaGtEma = lastJma > lastEma;
    const closeGtJma = last.close > lastJma;

    const isEntry = (
      lastNoWick && prevNoWick &&
      lastGreen &&
      prevGreen &&
      jmaGtEma &&
      closeGtJma
    );

    const failedReasons = [];
    if (!lastNoWick) failedReasons.push(`lastNoWick = false (open - low = ${Math.abs(last.open - last.low).toFixed(4)}, required <= 0.05)`);
    if (!prevNoWick) failedReasons.push(`prevNoWick = false (open - low = ${Math.abs(prev.open - prev.low).toFixed(4)}, required <= 0.05)`);
    if (!lastGreen) failedReasons.push(`lastGreen = false (close = ${last.close.toFixed(2)}, open = ${last.open.toFixed(2)})`);
    if (!prevGreen) failedReasons.push(`prevGreen = false (close = ${prev.close.toFixed(2)}, open = ${prev.open.toFixed(2)})`);
    if (!jmaGtEma) failedReasons.push(`jmaGtEma = false (JMA = ${lastJma.toFixed(2)}, EMA = ${lastEma.toFixed(2)})`);
    if (!closeGtJma) failedReasons.push(`closeGtJma = false (close = ${last.close.toFixed(2)}, JMA = ${lastJma.toFixed(2)})`);

    const isExit = (
      last.close < last.open &&
      prev.close < prev.open
    );

    let trend = 'NEUTRAL';
    if (isEntry) trend = 'BULLISH';
    else if (isExit) trend = 'BEARISH';

    const result = {
      trend,
      ema: lastEma,
      jma: lastJma,
      haClose: last.close,
      isEntry,
      isExit,
      lastNoWick,
      prevNoWick,
      lastGreen,
      prevGreen,
      jmaGtEma,
      closeGtJma,
      failedReasons,
      lastCandle: last,
      prevCandle: prev
    };

    strategyStats.record(result, 'ModifiedHeikenAshi', context.userId);
    return result;
  }
}

module.exports = ModifiedHeikenAshiPlugin;
