# Index VWAP ORB - Phase 1 implementation verification

Scope: Phase 1 only, from the end-to-end PDF. No analyzer, new plug-in registration, strategy UI, execution/risk changes, EOD changes, account-setting changes or live testing.

## Implemented

- Compatible opt-in manifest requirement: `dataStreams: ['UNDERLYING_CANDLES']`, with unique `timeframes: ['ONE_MINUTE', 'FIVE_MINUTE']`. Existing manifests retain validation behavior.
- Account-scoped `subscribeUnderlying`, `unsubscribeUnderlying`, `getUnderlyingSnapshot` on the existing market-data service/router. Full-session index history remains separate from legacy option/chart candle builders.
- NIFTY/BANKNIFTY NSE and SENSEX BSE token mappings reuse `candleService`. No futures/ETF source.
- Optional Python `include_volume=true` candle requests preserve real volume, genuine zero and missing/invalid values distinctly. Default existing candle response remains unchanged.
- The new stream fetches completed broker 1M OHLCV through the verified Node/Python account context. It backfills from 09:15 and derives opening-aligned 5M bars only from five actual complete 1M bars.
- Session snapshots include OHLCV, source, close time, completeness, gap/error state, receive time and dynamically evaluated freshness. Entire session is retained beyond 200 bars. Previous days and forming bars are excluded.
- Identical history overlap is deduplicated; conflicting duplicates, out-of-order rows, missing/invalid volume, zero total volume, invalid OHLC or gaps withhold readiness. No synthetic gap candles or invented volume. Isolated genuine zero-volume bars are allowed when cumulative volume is positive.
- Fetches never overlap per stream. Scheduled boundary refreshes have at most three repair retries per minute. Session ownership is revalidated before and after requests. Ref counts, cancellation and retired-session response handling prevent detached streams from publishing.
- Runner opt-in data branch accepts only the configured underlying token/exchange/interval and matching user/account/session identity. It stores the snapshot/readiness; it does not generate or execute signals. Contract discovery can retain CE/PE metadata without subscribing option candles for underlying signal evaluation.

## Deliberate transport choice

Existing SmartStream subscriptions are LTP-only and do not carry decoded volume. This phase uses authoritative broker historical 1M OHLCV at minute boundaries instead of altering legacy WebSocket modes or estimating volume. Five-minute candles derive from this same 1M series, eliminating cross-stream double counting. The new path bypasses the existing five-minute chart cache and synthetic/rolling scanner buffers. Existing option/chart subscriptions are unchanged.

Freshness for new-entry evaluation is five seconds after latest candle close, matching the Phase 0 rule lock. If broker historical delivery cannot meet this window, readiness remains false. Actual broker latency/volume suitability is deferred to user testing; a polling adapter is not evidence that the broker meets these criteria. No stream starts merely because the module is imported; only a future opt-in strategy subscribes it.

## Automated validation

Backend command (from backend):

`node --test tests/underlyingCandles.phase1.test.js tests/marketDataIsolation.phase4.test.js tests/entryReliability.test.js tests/tradingBaseline.test.js tests/historyRecovery.test.js tests/feedProductionPaths.phase4.test.js tests/breakoutProductionCandles.test.js`

Result: 53 passed, zero failed/skipped. New coverage includes three-index routing, exact three-bar opening range, volume aggregation, late-start full-session retention, gap repair, stale readiness, duplicate/order handling, non-overlap, reference cleanup, generation retirement, bounded retries, pending-subscription cancellation, option-subscription isolation and runner event filtering without entries.

Python command (from angel-one):

`.venv/Scripts/python.exe -m pytest tests/test_candle_volume_phase1.py tests/test_quote_freshness.py tests/test_account_dispatch_phase2.py tests/test_api_docs.py -q`

Result: 40 passed. Includes new volume normalization and route opt-in/default compatibility, plus existing quote/account/API tests. Existing deprecation warnings remain unchanged.

`git diff --check`: passed. No frontend sources or environment configuration changed. Previously untracked Phase 0 documents/PDF/images remain untouched by this phase.

## Remaining scope

Phase 2 implements analyzer and plug-in adapter. Session quota and executable entry admission remain Phase 3; index-reference risk and EOD remain Phase 4. This phase provides readiness metadata but no new entry path. Real broker sample/latency validation and live testing remain deferred at the user's request.
