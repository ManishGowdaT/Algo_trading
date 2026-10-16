# Index VWAP ORB - Phase 2 verification

Scope: Phase 2 only from the end-to-end implementation PDF: pure analyzer and plug-in adapter. Phase 0's latest rule lock applies, including index-first internally calculated VWAP. No runtime execution, session persistence, risk/EOD, settings validation or UI source was changed.

## Added files

- `backend/trading/strategies/indexVwapOrb.js`: deterministic as-of replay analyzer.
- `backend/trading/strategies/plugins/indexVwapOrbPlugin.js`: BaseStrategy adapter, manifest ID `IndexVwapOrb`, engine version 1.0.0, underlying 1M/5M requirements.
- `backend/tests/indexVwapOrb.phase2.test.js`: synthetic deterministic strategy/adapter tests.
- This verification report.

The pre-existing Phase 1 tracked modifications and Phase 0 artifacts were preserved. No existing implementation files were edited during Phase 2.

## Behavior

The analyzer accepts `underlying`, explicit epoch-millisecond `asOf`, complete `candles1m`/`candles5m` histories (or a Phase 1 snapshot) and optional consumed setup IDs. The adapter passes its configuration into the analyzer. Per-index retest tolerance defaults are 10/20/30; `retestTolerancePointsByUnderlying` supports validated finite nonnegative overrides. No plug-in instance memory or wall-clock reads influence results.

Session validation reuses Phase 1's pure normalization helper. The input 5M stream must agree with complete groups of 1M bars; future/forming and previous-session bars are excluded. Missing/invalid volume, gaps, synthetic bars, conflicting duplicates, invalid timestamps/close times or timeframe disagreements block analysis. VWAP uses only selected-index 1M HLC3 times bar volume; zero-volume bars receive zero weight, and zero cumulative volume blocks entries. There is no futures/ETF substitution.

State progresses BUILDING_OR -> WAITING_BREAKOUT -> WAITING_RETEST -> WAITING_1M_CONFIRMATION -> SIGNAL_READY. Additional non-entry states explain invalid data, expired signal and closed entry window. The opening range freezes the three 5M bars in [09:15,09:30). Breakout is a strict closed 5M close beyond the range; retest must be a later closed 5M test/hold with the configured tolerance. The first accepted retest extremum remains fixed. Candle colour is not a filter.

Pivot centres form after retest close. Strict extrema require two candles on each side; equal highs/lows are not pivots. Confirmation time is the close of the second right-hand candle. Entry requires a later 1M close strictly through the latest confirmed pivot with session VWAP agreement. Opposite 5M breakout replaces pending setup without creating an exit. The first qualifying signal candidate exhausts that setup in replay; a later opportunity requires a fresh 5M breakout/retest sequence. `consumedSetupIds` suppresses an already consumed candidate while preserving deterministic reconstruction of subsequent setups. Durable acceptance/deduplication remains Phase 3.

The signal includes stable setup/signal IDs, direction, index reference token/exchange, entry-bar close time, OR levels, VWAP/source, breakout/retest/pivot timestamps, frozen pullback extrema, index entry/SL/TP, positive risk and exact 2R. SL buffer is fixed at 2 index points. `isExit` is always false. No contract, expiry or quantity is selected by the analyzer.

Signals are returned only for the latest closed 1M bar, no more than five seconds after close, and no later than 11:30:00 IST. Historical earlier candidates are diagnostics, not current executable entries. Broker admission, quota reservations and execution checks are not part of this pure function.

## Integration boundary

Existing startup discovery will discover the new adapter and may expose its manifest/card and auto-create missing Strategy records when the application next initializes with a database. Those are existing registry behaviors, not a new activation path. No registry initialization against a live database was performed for this phase.

The existing configuration validator still rejects `IndexVwapOrb` as unsupported, and Phase 1's underlying runner branch remains data-only. The adapter's manifest marks execution readiness as ANALYZER_ONLY. No settings API enablement, entry submission wiring or UI page was added. Those belong to subsequent phases; a discoverable manifest is not a finished runnable strategy.

## Validation

Backend regression command (from `backend`):

`node --test tests/indexVwapOrb.phase2.test.js tests/underlyingCandles.phase1.test.js tests/tradingBaseline.test.js tests/databaseSecurity.test.js tests/inputValidation.test.js tests/feedProductionPaths.phase4.test.js tests/entryReliability.test.js`

Final result: 68 tests passed, zero failed/skipped. `git diff --check` passed. Existing tests cover old strategy fixtures, Phase 1 isolation/cleanup/routing, API validation and mock execution reliability. No live broker calls/orders or real market-data tests were run.

New tests cover both directions/all indices, exact levels and 2R, lifecycle stages, immutable repeatability/fresh instances, replay prefixes and future-bar exclusion, strict pivot ties and close equality, wrong/no retest, opposite breakout, VWAP disagreement, zero/missing volume, synthetic/gapped data, timeframe mismatch, stale signal, exact cutoff, consumed setup, tolerance defaults/overrides, nonpositive risk and invalid targets. Adapter compatibility and current start-validation rejection are also checked.

Real market-data validation and end-to-end executable strategy operation remain deferred. Phase 3 owns persistent admission/counting/settings; Phase 4 owns index-reference position management; Phase 5 owns the dedicated matching UI.
