const candleService = require('./candleService');
const indicatorService = require('./indicatorService');
const tradeOverlayService = require('./tradeOverlayService');

async function getMarketChartData({ underlying, date, interval, userId }) {
  const candles = await candleService.getCandles(underlying, date, interval);
  const indicators = indicatorService.computeChartIndicators(candles);
  const tradeOverlays = await tradeOverlayService.getTradeOverlays(underlying, date, userId);

  return {
    underlying: (underlying || 'NIFTY').toUpperCase(),
    date: date || new Date().toISOString().split('T')[0],
    interval: interval || '5m',
    candles,
    indicators,
    tradeOverlays,
  };
}

module.exports = {
  getMarketChartData,
};
