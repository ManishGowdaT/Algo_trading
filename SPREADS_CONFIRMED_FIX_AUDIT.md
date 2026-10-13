# Confirmed Spread Terminal fixes and affected-path audit

Date: 2026-10-13. Scope: the seven confirmed integration issues only. Architecture remains React 5173 → Node 5000 → existing Python 8000. No Angel One production implementation, environment credentials, scanner formulas, production hardening, or order-placement behavior was changed in this fix pass.

| Affected path | Status | Re-audit evidence / remaining limit |
|---|---|---|
| Discovered underlying identities | FIXED | The authoritative Upstox NSE universe is retained as a server-owned symbol → key/kind/segment snapshot before ranking. Both expiry and scan resolution use it before EQ search. Live resolution can reload the public master on an EQ-search miss after a restart or before discovery. Tests cover FINNIFTY, MIDCPNIFTY, NIFTYNXT50, stock keys, defensive copying, master fallback, and discovery API → expiry API identity continuity. No guessed index aliases were added. |
| Empty/stale discovery refresh | FIXED | Retry age is separated from the original successful-ranking timestamp. Empty or failed refreshes do not cause every progress GET to start another refresh; explicit refresh still works. Retained ranking keeps its original universe/capability provenance, with current failure details. Original ranking and top-five behavior are unchanged. |
| Duplicate-strike monetary inconsistency | FIXED for incorrect money; STILL PARTIAL for enrichment | Duplicate rows still enter the original scanner unchanged. Contract/monetary metadata no longer takes the last duplicate quote arbitrarily. Ambiguous legs have no per-lot amount and an explicit API/UI explanation. Original candidates, EV values, and funnel counters are regression-compared unchanged. Recovering exact leg provenance for ambiguous rows remains unresolved; no replacement calculation or guessed identity was introduced. |
| Stock capability status | FIXED | Live stock expiry setup reports available=null, status=requires_validation, and the actual supplementary earnings source. UI displays the reason even when readiness is conditional. Scan-time earnings capability and missing-input errors remain authoritative. Fixture readiness remains explicitly synthetic; index earnings remain not applicable. |
| Expiry tie handling | FIXED | Discovery and spread scanning normalize expiries chronologically before invoking the unchanged original nearest-DTE picker. Equal-distance ties consistently select the earlier expiry. |
| Scan deadlines | FIXED for premature collection loss; STILL PARTIAL for external latency | Removed the outer asyncio.wait cancellation that discarded completed worker results at 45 seconds. Every worker result is collected; four-worker concurrency remains. Cooperative provider budget is 180 seconds; Node scan transport allows at least 210 seconds. Expired workers report explicit failures, without fabricated results. Tests cover delayed delivery, expired admission, and transport-budget ordering. These are finite budgets, not a guarantee that every slow provider response will finish. The supplementary synchronous Yahoo earnings call does not share the Upstox ContextVar deadline; it can outlast the cooperative budget. Live latency/coverage validation remains necessary. |
| Backend monitor test failure | FIXED | The test's fixed 80 ms delay raced asynchronous monitor completion under the full suite. It now polls for the expected degraded state with a bounded wait and retains all rejection/recovery assertions. Angel One monitor implementation and intended behavior were unchanged. Full Node suite passes. |
| Actual Upstox contract/OI/IV/candle/earnings coverage | BLOCKED UNTIL LIVE UPSTOX TESTING | Pending activation prevents certifying live end-to-end behavior. OI units, equity corporate-action adjustment equivalence, candle completeness, Yahoo earnings coverage and practical latency remain unverified. No data was invented, silently substituted or marked verified. |

## Validation

- Full Python suite: **151 passed**, 6 existing dependency/deprecation warnings. Command from angel-one: `python -m pytest -o addopts='' -q`.
- Full Node suite: **232 passed**, zero failures/skips. Command from backend: `npm test -- --test-reporter=spec`.
- Full frontend suite: **68 passed**, 12 test files. Command from algo-trading: `npm test`.
- Frontend TypeScript/Vite production build: **passed**. Existing large-chunk warning remains; no bundling refactor was performed.
- Spread-page ESLint: **passed**.
- Original ZIP parity: actual uploaded `spread-terminal/screener.py` equals the test oracle byte-for-byte. SHA256: `6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa`.
- Seven original definitions remain AST-identical: ScanParams, realized_vols, apply_earnings_penalty, empirical_breach_prob, friction_detail, passes_friction, build_spreads.
- Full Python suite includes the 100-case original ZIP oracle comparison, discovery ranking parity, defaults, rounding boundaries, filters/funnels, stable multi-underlying EV ranking, earnings-source tests and new integration regressions.
- Full frontend tests/build and Node session-isolation tests pass. This supports regression confidence, not a claim of live trading or real OAuth browser validation.

## Files changed in this pass

- angel-one/app/services/spreads/api.py
- angel-one/app/services/spreads/instruments.py
- angel-one/app/services/spreads/upstox_adapter.py
- angel-one/app/services/spreads/discovery_cache.py
- angel-one/app/services/spreads/discovery_adapter.py
- angel-one/tests/test_spread_audit_regressions.py
- angel-one/tests/test_spread_discovery_cache_api.py
- angel-one/tests/test_spread_discovery_adapter.py
- angel-one/tests/test_spread_stock_integration.py
- backend/services/spreadsPythonService.js
- backend/tests/spreadsPythonService.test.js
- backend/tests/positionExecution.phase5.test.js (test synchronization only)
- algo-trading/src/pages/SpreadsPage/SpreadsPage.tsx
- algo-trading/src/pages/SpreadsPage/SpreadsPage.test.tsx
- this report

Existing changes from earlier phases and unrelated files were left in place. Services were not restarted and no real orders were submitted.
