# NSE correction implementation — 14 October 2026

This is a progress report, not a claim that all ten phases or NSE strategy calibration are complete. The user deferred live validation and requested code/tests to continue.

## Implemented and tested

1. Recorded SHA256 baselines before edits. `original_calculations.py`, `engine.py` and `nse_calculations.py` remain byte-for-byte unchanged. No economic parameter, OI conversion, IV scale, earnings formula, ranking, probability or funnel definition changed.
2. Replaced the global 0.4-second outbound delay with atomic rolling quotas: 50 requests/second, 500/minute and 2,000/30 minutes per server-owned app identity/API. Candle URLs share one historical API budget. Retries consume budget; cache hits do not. Independent identities/APIs do not wait on each other's quotas.
3. Node now forwards the existing server-owned user ID for live scans and expiry requests as well as discovery. The Python authorization dependency scopes and resets that identity across request/worker contexts. Token rotation retains that app user's quota. Legacy direct calls lacking an owner use a token hash.
4. Numeric and HTTP-date Retry-After values are honoured without the previous four-second cap. Shared cooldowns coordinate retrying transports. Quota waits respect the existing cooperative deadline and release the lock while waiting. Discovery progress exposes quota waiting instead of appearing idle.
5. V3 fallback failures retain safe endpoint/status/code/requested-key diagnostics. No raw exception payload or credentials are returned. Discovery with no usable ATM IV and failed fallback is FAILED; a successful request with insufficient IV stays UNAVAILABLE. Failed input stages without an HTTP status are counted too.
6. Quotes retain raw IV and source. Existing positive Option Chain IV stays preferred, with its existing percentage-point conversion. V3 decimal normalization is unchanged. Existing batching remains at most 50 keys.
7. Discovery's fallback skips missing-IV rows farther than the third already valid row on each side. Those rows cannot affect the original nearest-three-valid-IV aggregation. Missing rows closer than that boundary are still requested; if fewer than three valid rows exist, all eligible missing rows remain candidates for fallback. Standalone spread scans still retrieve fallback for all needed chain rows. Tests compare scoped and full-chain ATM-IV outputs.
8. Option Chain response expiry/underlying conflicts and Option Contracts underlying conflicts now fail explicitly rather than silently being assigned the requested identity.
9. Universe lot parsing no longer truncates non-integral values or accepts booleans as authoritative lots.
10. Discovery now uses the shared OHLCV/date/duplicate/skipped-row validation and retains its report. Scan API responses expose existing history validation plus IV provider errors. Non-finite/boolean OHLCV values cannot be certified. These diagnostics do not fabricate, deduplicate, adjust or substitute history.

## Phase status

| Phase | Status | Outstanding work |
|---|---|---|
| 1 baseline | Code baseline complete; live baseline deferred | Capture a current authenticated scan after restart. |
| 2 request scheduling | Core quota/retry fixes complete; operational validation partial | Live request timing; assess 180-second scan/900-second discovery budgets under genuine provider delays. No arbitrary budget increase. |
| 3 identities | Confirmed parsing/response-conflict defects fixed; live validation partial | Daily master lifecycle, lot revisions and representative live reconciliation. |
| 4 history | Shared diagnostics improved; partial | Authoritative completed-session calendar over the full lookback; current-session cutoff; corporate-action equivalence; explicit invalid-input policy. |
| 5 IV | Error/provenance fixes and selection-preserving request reduction complete in tests | Live comparison and performance measurement after restart. |
| 6 discovery | Existing full dynamic universe preserved; statuses/progress improved | Full-universe live counts, failures and runtime. |
| 7 NSE construction/earnings | Existing structure, OI and earnings behavior preserved | Independent live validation and earnings-source accuracy. |
| 8 economic calibration | Not calibrated | Historical option bid/ask/IV coverage, costs and chronological out-of-sample research. No fitted parameters invented. |
| 9 UI | Quota waiting implemented | Remaining planned data-quality/timestamp workflow improvements after their source semantics are established. |
| 10 regression/live | Regression passed; live deferred | Current end-to-end authenticated scans and fresh oracle replay. |

## Important limitations

- Quota state is in memory in the existing single Python process. It does not observe traffic from other applications, survive process restarts or coordinate multiple workers. The server's Retry-After remains authoritative. No Redis/database/queue was added.
- Identity is the authenticated application user; it is not an independently verified broker-account identifier across multiple application accounts. Direct legacy requests fall back to token identity. Do not claim globally complete broker quota accounting.
- Candle completeness is still UNVERIFIED without a covering authoritative session calendar. Today is still requested as before; a completed-session cutoff is not invented from weekdays or a guessed closing time.
- Corporate-action adjustment remains unresolved. The history API's OHLC schema is not evidence of Yahoo auto_adjust=True equivalence. Raw returned history is retained with the warning.
- A mathematical midpoint-credit quantum is not an economic minimum-credit policy. Existing NSE research parameters remain research defaults. No attempt was made to increase opportunities by relaxing thresholds.
- Historical candles alone do not establish availability of historical option bid/ask or IV suitable for strategy calibration. No synthetic option prices were used to fill this gap.
- Error counts identify failed input stages, not an exhaustive count of every failed HTTP retry. Existing transport Option Chain/V3 attempt and 429 metrics remain available.

## Files changed

| Files | Purpose |
|---|---|
| `angel-one/app/services/spreads/rate_limit.py` (new), `transport.py` | Rolling quotas, retry delay parsing, cooldowns and wait observer. |
| `backend/controllers/spreadController.js`, `backend/services/spreadsPythonService.js`, `angel-one/app/services/spreads/api.py` | Existing server-owned identity propagation; additive scan diagnostics. |
| `provider.py`, `upstox_adapter.py` | Additive raw IV/source/errors, identity checks and scoped discovery fallback. |
| `discovery.py`, `discovery_adapter.py` | Failure classification, quota progress and shared history diagnostics. |
| `history_validation.py`, `universe.py` | Reject certification of invalid numeric data; strict lot parsing. |
| `algo-trading/src/pages/SpreadsPage/DiscoveryPanel.tsx` | Show quota wait duration in discovery progress. |
| Python quota, V3, history, universe, orchestration and audit-regression tests | Validate new behavior and preserve baseline parity. |
| `backend/tests/spreadsPythonService.test.js`, `algo-trading/src/pages/SpreadsPage/SpreadsPage.test.tsx` | Server-owned scan identity forwarding and quota-wait UI behavior. |
| This report; `tmp/nse-correction-baseline.json` | Scope and before/after evidence. |

## Verification

- Full Python: 248 tests passed, including original ZIP parity and NSE profile tests. Existing dependency/deprecation warnings remain.
- Full Node: 233 passed, zero failed, serialized suite. After the header assertion was added, both affected Node suites also passed (15 tests).
- Full frontend: 71 passed across 12 files.
- Production frontend build: passed; existing chunk-size warning remains.
- `git diff --check`: no whitespace defects.
- Calculator/engine/NSE profile hashes match the recorded pre-edit baseline.
- No Angel One implementation file changed; Node changes are confined to the existing Spread controller/service/test.
- No Upstox order was placed and no order API was added.
- Live metrics are NOT reported as verified: live validation was explicitly deferred.

Logs: `tmp/nse-corrections-python.log`, `tmp/nse-corrections-node.log`, `tmp/nse-corrections-frontend.log`, `tmp/nse-corrections-build.log`.

Documentation checked: [Upstox rate limits](https://upstox.com/developer/api-documentation/rate-limiting/), [Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/), [Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/), [Historical Candle V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/), [Instruments](https://upstox.com/developer/api-documentation/instruments/).
