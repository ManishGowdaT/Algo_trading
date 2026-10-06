# Phase 0–8 review finding fixes

Date: 6 October 2026

Scope: the six confirmed review defects and the additional held-position quote-age gap. No new migration phase or LIVE rollout was enabled.

## Fixes

1. **Next-entry quantity:** completion restores the exact persisted execution configuration. Remaining exposure continues to determine held-position exit/protection quantity. PAPER and LIVE partial exit tests demonstrate 10 units entered, 4 then 6 exited, and 10 units requested on the next entry.
2. **Standalone intent recovery:** recovery processes all standalone intents in creation order and performs an account-scoped final orphan check before READY. Unknown outcomes and unlinked fills retain DEGRADED status. Another user's readiness is unaffected.
3. **Recovered reversal monitoring:** recovery initializes the verified account feed and registers the existing candle evaluator. It leaves isRunning/feedScanReady false and does not start discovery or new-entry timers. A real routed held-candle event executes the original Heiken Ashi reversal rule.
4. **Offboarding:** BrokerAccount reads/writes use userId + _id; exposure queries use userId + brokerAccountId. Tests exercise actual Mongoose casting/query paths at an in-memory collection boundary for Position, OrderIntent and LIVE Trade, including foreign-account exposure and history retention.
5. **Stale-position alerts:** runtime health contains the durable position ID. Watchdog matching and stale-alert deduplication use that ID within verified account scope. Two strategies on one account no longer mask each other's stale quotes. Existing lease-owner filtering is retained.
6. **Credential redaction:** quoted JSON values, escaped strings, whitespace-containing credentials, and complete Bearer/Basic authorization values are redacted. Ordinary operational fields are preserved.
7. **Actual quote age:** account-owned position monitors request an additive requireFresh=true option on the existing /market/ltp path. Python uses the existing SDK getMarketData('FULL', exchangeTokens) method and the broker's exchFeedTime. Account-local locking, one request per second, batches of at most 50 instruments, inactive-instrument expiration, and invalidation on refresh failure bound resource use. Exchange/symbol/token must match. Node rejects missing/non-finite timestamps, quotes older than STALE_POSITION_QUOTE_MS (default 20 seconds, minimum 5 seconds), and timestamps more than 5 seconds in the future. Ordinary frontend/chart LTP reads retain the existing ltpData path and response contract.

Broker source: https://smartapi.angelone.in/docs (FULL market quotes, exchange feed time, batching and request limit). The local project virtual environment's installed SmartConnect exposes getMarketData(self, mode, exchangeTokens). Actual deployed quote availability and entitlements still require release validation.

## Compatibility and deliberate safety changes

- No strategy/indicator source, signal formula, contract-selection rule, entry precedence, SL/target/trailing calculation, cooldown calculation, frontend source, or existing API path was modified in this fix task.
- PAPER entry pricing and LIVE fill-evidence semantics remain unchanged.
- The Phase 0 baseline fixtures and expected outputs were not changed.
- One Phase 2 mock response and the execution fixture gained additive quote timestamps; their expected prices, quantities and P&L remain unchanged.
- Recovery restores exits without enabling new entries. Offboarding remains blocked by unresolved exposure.
- Missing/stale exchange timestamps now explicitly withhold price-driven automatic exit/trailing decisions and report degraded monitoring. Broker-side protective orders and reconciliation continue through their existing paths. This is the planned quote-safety correction, not a guarantee of uninterrupted exits during broker/data failure.

## Verification

The final full suites ran serially:

| Suite | Result |
|---|---|
| Node, including Phase 0–8 regressions | 184 passed; 0 failed; no skipped/cancelled tests; normal exit without force-exit |
| Python | 51 passed; 0 failed |
| Frontend | 48 passed across 9 files |
| Frontend TypeScript/Vite production build | Passed |

13 Node regressions and 9 Python regressions were added. Targeted tests passed before the final full runs. The first full Node run caught a Phase 2 mock without the newly required exchange timestamp; only that mock's additive response metadata changed, not its expected trading outputs. Frontend esbuild initially encountered sandbox filesystem denial; tests/build passed after rerunning with approved execution permissions. Existing Python dependency/deprecation warnings and frontend bundle-size warning remain.

## Files changed in this fix task

Production:

- backend/services/positionExecution.js
- backend/services/startupRecovery.js
- backend/services/accountOffboarding.js
- backend/services/operationalWatchdog.js
- backend/services/strategyEngine.js
- backend/services/notificationService.js
- backend/services/productionHardening.js
- angel-one/app/services/angel_client.py
- angel-one/app/main.py

Tests/fixtures:

- backend/tests/positionExecution.phase5.test.js
- backend/tests/startupRecovery.phase6.test.js
- backend/tests/productionHardening.phase8.test.js
- backend/tests/accountContext.phase2.test.js
- backend/tests/helpers/executionFixture.js
- angel-one/tests/test_quote_freshness.py (new)
- angel-one/tests/test_account_dispatch_phase2.py

Documentation: this file. Node test output: tmp/review-fixes-node.log.

## Deployment and release gates

- Deploy the Python timestamp-capable gateway before the Node monitor changes, or deploy them as a coordinated release. A new Node monitor against the older gateway will safely degrade when timestamps are absent; it must not be treated as a successful rollout.
- Validate FULL quotes for each deployed exchange/instrument/account, freshness threshold suitability, clock synchronization, broker quotas, protection and account entitlements in controlled PAPER validation before LIVE rollout.
- Normal account cache startup can briefly withhold a newly registered instrument until the next allowed batch refresh; it never substitutes an unrelated quote or invents a timestamp.
- Database tests use real Mongoose models/middleware with substituted collection storage; broker tests use deterministic adapters. These do not replace real MongoDB backup/restore, broker-order or Render deployment evidence.
- The previously accepted external Angel One approval/policy, production MongoDB/index/backup, Render/always-on topology, static IP, entitlement, real-account, rolling deploy and full-session/browser-free soak gates remain required before multi-user LIVE release.

Local finding fixes and regression verification pass. This does not certify full LIVE production readiness or authorize live test orders.
