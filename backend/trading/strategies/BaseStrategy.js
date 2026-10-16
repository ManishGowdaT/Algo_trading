/**
 * Abstract Base Strategy Class for OptionAlgo Strategy Plugins
 * All strategy plugins must extend this class and implement the required manifest and analyze method.
 */
class BaseStrategy {
  /**
   * Static manifest object required on every child class.
   * Example:
   * static manifest = {
   *   id: 'heiken_ashi',
   *   name: 'Heiken Ashi Strategy',
   *   version: '1.0.0',
   *   engineVersion: '1.0.0',
   *   description: 'Dual Heiken Ashi candle agreement with EMA and JMA filters.',
   *   requires: {
   *     timeframe: 'FIVE_MINUTE',
   *     lookbackCandles: 20,
   *     dataStreams: ['CE_CANDLES', 'PE_CANDLES']
   *   },
   *   parameters: { ... }
   * };
   */

  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Lifecycle hook called when strategy is initialized.
   */
  onInit() {}

  /**
   * Lifecycle hook called when strategy is stopped.
   */
  onCleanup() {}

  /**
   * Core Signal Evaluation Method (Must be implemented by child plugin)
   * @param {Object} context { ceBuffer, peBuffer, spotLtp, indicators }
   * @returns {Object} { signal: 'BUY_CE'|'BUY_PE'|'NONE', isExit: boolean, haClose, failedReasons, diagnostics }
   */
  analyze(context) {
    throw new Error(`[${this.constructor.name}] analyze(context) must be implemented.`);
  }

  /**
   * Optional custom position exit check override.
   * @param {Object} positionContext { activeContract, items, indicators }
   * @returns {Object|boolean} { isExit: boolean, exitReason: string }
   */
  shouldExit(positionContext) {
    return false;
  }

  /**
   * Validates strategy manifest structure.
   */
  static validateManifest(manifest) {
    if (!manifest) throw new Error('Strategy plugin missing static manifest');
    if (!manifest.id || typeof manifest.id !== 'string') throw new Error('Strategy manifest requires a string id');
    if (!manifest.name || typeof manifest.name !== 'string') throw new Error('Strategy manifest requires a string name');
    if (!manifest.engineVersion || typeof manifest.engineVersion !== 'string') throw new Error('Strategy manifest requires engineVersion string');
    if (!manifest.requires || typeof manifest.requires !== 'object') throw new Error('Strategy manifest requires a requires object');
    if (manifest.requires.dataStreams?.includes('UNDERLYING_CANDLES')) {
      const frames = manifest.requires.timeframes;
      if (!Array.isArray(frames) || !frames.length || new Set(frames).size !== frames.length
        || frames.some(frame => !['ONE_MINUTE', 'FIVE_MINUTE'].includes(frame))) {
        throw new Error('Underlying candle streams require unique ONE_MINUTE/FIVE_MINUTE timeframes');
      }
    }
    return true;
  }
}

module.exports = BaseStrategy;
