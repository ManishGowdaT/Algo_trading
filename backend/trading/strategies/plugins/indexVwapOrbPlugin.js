const BaseStrategy = require('../BaseStrategy');
const { analyzeIndexVwapOrb, RULE_VERSION } = require('../indexVwapOrb');

class IndexVwapOrbPlugin extends BaseStrategy {
  static manifest = {
    id: 'IndexVwapOrb', name: 'Index VWAP + Opening Range', version: '1.0.0', engineVersion: '1.0.0',
    description: 'NIFTY, BANKNIFTY and SENSEX spot OR breakout/retest with confirmed 1M structure and internal session VWAP.',
    requires: { timeframe: 'ONE_MINUTE', timeframes: ['ONE_MINUTE', 'FIVE_MINUTE'],
      lookbackCandles: 15, dataStreams: ['UNDERLYING_CANDLES'] },
    ruleVersion: RULE_VERSION,
    parameters: {}, // Configuration persistence and page controls are later phases.
    executionReadiness: 'REFERENCE_RISK_ACCOUNT_GATED',
    lockedRules: { riskReward: 2, swingLength: 2, stopBufferPoints: 2, maxEntriesPerDay: 2,
      entryCutoffIst: '11:30', squareOffTimeIst: '15:20' },
  };

  analyze(context) { return analyzeIndexVwapOrb(context, this.config); }
}

module.exports = IndexVwapOrbPlugin;
