/**
 * strategyStats.js
 *
 * Pure statistics collector for strategy condition evaluation.
 * Zero impact on strategy logic — only records observations.
 *
 * Usage:
 *   const strategyStats = require('./strategyStats');
 *   strategyStats.record(signal, strategyName);
 *
 * Report:
 *   strategyStats.getReport()
 *   strategyStats.reset()
 */

class StrategyStats {
  constructor() {
    this.userCollectors = new Map();
    this.reset();
  }

  _getUserCollector(userId) {
    const key = String(userId);
    if (!this.userCollectors.has(key)) {
      const collector = Object.create(StrategyStats.prototype);
      collector.userCollectors = new Map();
      collector.reset();
      this.userCollectors.set(key, collector);
    }
    return this.userCollectors.get(key);
  }

  reset(userId = null) {
    if (userId !== null && userId !== undefined) {
      const collector = this._getUserCollector(userId);
      collector.reset();
      return;
    }
    this.startedAt = new Date().toISOString();
    this.totalCandles = 0;

    // Per-condition pass/fail counters
    this.conditions = {
      lastNoWick:  { pass: 0, fail: 0 },
      prevNoWick:  { pass: 0, fail: 0 },
      lastGreen:   { pass: 0, fail: 0 },
      prevGreen:   { pass: 0, fail: 0 },
      jmaGtEma:    { pass: 0, fail: 0 },
      closeGtJma:  { pass: 0, fail: 0 },
    };

    this.entrySignals = 0;
    this.exitSignals  = 0;

    // Rejection combination map: "lastNoWick|prevNoWick" → count
    this.rejectionCombinations = {};

    // Lower wick samples for both formulas
    // currentWick  = abs(open - low)   ← the current (possibly wrong) formula
    // correctWick  = min(open,close) - low  ← the proposed correct formula
    this.wickSamples = []; // { currentWick, correctWick, isRedCandle }

    // Formula divergence counters
    this.formulaDivergence = {
      total:           0,   // candles where formulas differ
      changesDecision: 0,   // candles where changing formula would change isEntry
    };

    // Per-strategy tallies (keyed by strategyName)
    this.byStrategy = {};
  }

  /**
   * Record one candle evaluation.
   *
   * @param {Object} signal  - The object returned by analyzeHeikenAshiStrategy /
   *                           analyzeModifiedHeikenAshiStrategy. Must contain:
   *                           lastNoWick, prevNoWick, lastGreen, prevGreen,
   *                           jmaGtEma, closeGtJma, isEntry, isExit,
   *                           lastCandle (with open, high, low, close fields).
   * @param {string} strategyName - e.g. 'HeikenAshi' | 'ModifiedHeikenAshi'
   */
  record(signal, strategyName = 'Unknown', userId = null) {
    if (userId !== null && userId !== undefined) {
      this._getUserCollector(userId).record(signal, strategyName);
      return;
    }
    if (!signal || typeof signal !== 'object') return;

    this.totalCandles++;

    const {
      lastNoWick, prevNoWick,
      lastGreen,  prevGreen,
      jmaGtEma,  closeGtJma,
      isEntry,   isExit,
      lastCandle
    } = signal;

    // ── Condition counters ─────────────────────────────────────────────────
    const conds = { lastNoWick, prevNoWick, lastGreen, prevGreen, jmaGtEma, closeGtJma };
    for (const [name, passed] of Object.entries(conds)) {
      if (passed) {
        this.conditions[name].pass++;
      } else {
        this.conditions[name].fail++;
      }
    }

    if (isEntry) this.entrySignals++;
    if (isExit)  this.exitSignals++;

    // ── Rejection combination tracking ─────────────────────────────────────
    if (!isEntry) {
      const failedNames = Object.entries(conds)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);

      const key = failedNames.length > 0 ? failedNames.join(' + ') : '__all_passed_but_no_entry__';
      this.rejectionCombinations[key] = (this.rejectionCombinations[key] || 0) + 1;
    }

    // ── Wick sample collection ─────────────────────────────────────────────
    if (lastCandle && typeof lastCandle.open === 'number' &&
        typeof lastCandle.close === 'number' && typeof lastCandle.low === 'number') {

      const { open, close, low } = lastCandle;
      const isRedCandle    = close < open;

      // Current formula (potentially wrong for red candles)
      const currentWick = Math.abs(open - low);

      // Correct formula: distance from bottom of body to candle low
      const correctWick = Math.min(open, close) - low;

      this.wickSamples.push({ currentWick, correctWick, isRedCandle });

      // ── Formula divergence analysis ────────────────────────────────────
      const THRESHOLD = 0.05; // the current hardcoded threshold
      const currentPasses = currentWick <= THRESHOLD;
      const correctPasses = correctWick <= THRESHOLD;

      if (currentPasses !== correctPasses) {
        this.formulaDivergence.total++;

        // Would this difference have changed the isEntry decision?
        // isEntry needs BOTH lastNoWick AND prevNoWick AND other conditions.
        // If lastNoWick was the only failing condition and the correct formula
        // would have passed it, then this is a missed entry.
        if (!isEntry && !lastNoWick && correctPasses) {
          // Check if all other conditions passed
          const otherConditions = prevNoWick && lastGreen && prevGreen && jmaGtEma && closeGtJma;
          if (otherConditions) {
            this.formulaDivergence.changesDecision++;
          }
        }
      }
    }

    // ── Per-strategy breakdown ─────────────────────────────────────────────
    if (!this.byStrategy[strategyName]) {
      this.byStrategy[strategyName] = { candles: 0, entries: 0, exits: 0 };
    }
    this.byStrategy[strategyName].candles++;
    if (isEntry) this.byStrategy[strategyName].entries++;
    if (isExit)  this.byStrategy[strategyName].exits++;
  }

  // ── Statistics helpers ───────────────────────────────────────────────────

  _percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil(p * sorted.length) - 1;
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  _mean(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  _median(sorted) {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  _histogram(values) {
    const buckets = [
      { label: '0.00–0.05',   min: 0,    max: 0.05,  count: 0 },
      { label: '0.05–0.10',   min: 0.05, max: 0.10,  count: 0 },
      { label: '0.10–0.25',   min: 0.10, max: 0.25,  count: 0 },
      { label: '0.25–0.50',   min: 0.25, max: 0.50,  count: 0 },
      { label: '0.50–1.00',   min: 0.50, max: 1.00,  count: 0 },
      { label: '1.00–2.00',   min: 1.00, max: 2.00,  count: 0 },
      { label: '2.00–5.00',   min: 2.00, max: 5.00,  count: 0 },
      { label: '>5.00',       min: 5.00, max: Infinity, count: 0 },
    ];

    for (const v of values) {
      for (const b of buckets) {
        if (v >= b.min && v < b.max) { b.count++; break; }
      }
    }

    return buckets;
  }

  // ── Public report ────────────────────────────────────────────────────────

  getReport(userId = null) {
    if (userId !== null && userId !== undefined) {
      return this._getUserCollector(userId).getReport();
    }
    const n = this.totalCandles;
    const pct = (v) => n > 0 ? ((v / n) * 100).toFixed(1) + '%' : '0%';

    // ── Condition table ────────────────────────────────────────────────────
    const conditionReport = {};
    for (const [name, c] of Object.entries(this.conditions)) {
      conditionReport[name] = {
        passed:     c.pass,
        failed:     c.fail,
        passRate:   pct(c.pass),
        failRate:   pct(c.fail),
      };
    }

    // ── Rejection combinations (sorted by frequency) ───────────────────────
    const sortedRejections = Object.entries(this.rejectionCombinations)
      .sort(([, a], [, b]) => b - a)
      .map(([conditions, count]) => ({
        conditions,
        count,
        percentage: pct(count)
      }));

    // ── Wick statistics ────────────────────────────────────────────────────
    const allCurrentWicks  = this.wickSamples.map(s => s.currentWick).sort((a, b) => a - b);
    const allCorrectWicks  = this.wickSamples.map(s => s.correctWick).sort((a, b) => a - b);
    const redCandles       = this.wickSamples.filter(s => s.isRedCandle);
    const greenCandles     = this.wickSamples.filter(s => !s.isRedCandle);

    const wickStats = (sorted) => sorted.length === 0 ? null : {
      count:  sorted.length,
      min:    sorted[0].toFixed(4),
      max:    sorted[sorted.length - 1].toFixed(4),
      mean:   this._mean(sorted).toFixed(4),
      median: this._median(sorted).toFixed(4),
      p95:    this._percentile(sorted, 0.95).toFixed(4),
      p99:    this._percentile(sorted, 0.99).toFixed(4),
      histogram: this._histogram(sorted)
    };

    const wickReport = {
      currentFormula:  wickStats(allCurrentWicks),
      correctFormula:  wickStats(allCorrectWicks),
      redCandlesOnly: {
        current: wickStats(redCandles.map(s => s.currentWick).sort((a,b)=>a-b)),
        correct: wickStats(redCandles.map(s => s.correctWick).sort((a,b)=>a-b)),
      },
      greenCandlesOnly: {
        current: wickStats(greenCandles.map(s => s.currentWick).sort((a,b)=>a-b)),
        correct: wickStats(greenCandles.map(s => s.correctWick).sort((a,b)=>a-b)),
      },
      candlesWhereFormulasGiveIdenticalResult: this.wickSamples.length - this.formulaDivergence.total,
      candlesWhereFormulasDiffer: this.formulaDivergence.total,
      divergenceChangesEntryDecision: this.formulaDivergence.changesDecision,
    };

    // ── Infrastructure evidence ─────────────────────────────────────────────
    // These are populated by strategyEngine.js via recordInfraEvent()
    const infraReport = {
      note: 'Infrastructure events are counted by the engine, not the strategy analyzer.'
    };

    return {
      generatedAt:        new Date().toISOString(),
      collectionStarted:  this.startedAt,
      totalCandlesEvaluated: n,
      entrySignalsGenerated: this.entrySignals,
      exitSignalsGenerated:  this.exitSignals,
      entryRate:             pct(this.entrySignals),
      byStrategy:            this.byStrategy,

      // Part 1 — Condition statistics
      conditionStatistics: conditionReport,

      // Part 2 — Rejection combinations
      rejectionAnalysis: {
        totalRejections: n - this.entrySignals,
        topRejectionReasons: sortedRejections.slice(0, 20)
      },

      // Part 3 + 4 — Wick threshold evidence
      wickAnalysis: wickReport,

      // Infrastructure (populated from engine)
      infrastructure: infraReport
    };
  }
}

module.exports = new StrategyStats();
