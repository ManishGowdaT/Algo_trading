# Spread Terminal implementation audit

Follow-up: the non-security remediation and its current verification status are recorded in [SPREADS_AUDIT_FIXES.md](SPREADS_AUDIT_FIXES.md). The findings below describe the pre-fix baseline and remain useful as audit history; they are not the current completion verdict.

Date: 2026-10-12. Scope: compare the user-supplied implementation plan against the current workspace and the original uploaded `Downloads/spread-terminal.zip`.

## Verdict

The integration is not fully compliant with the supplied plan. The core calculations match the original on the sampled offline inputs, and the existing regression suites pass, but important orchestration, parameter, UI, session-isolation, and live-validation requirements remain incomplete or differ from the plan. Earlier blanket completion statements for phases 7–10 were too broad.

No application code or environment files were edited during this audit. This report and offline audit artifacts under `tmp/spreads-plan-audit/` were added. Existing unrelated files were left alone. The audit made no live broker requests and placed no orders.

## Evidence and scope of validation

- Backend: all 221 tests passed in this audit, including the existing Angel One account, strategy, execution, recovery, and ownership tests.
- Python: all 93 tests passed, including the Spread transport tests added during Phase 10 and existing Python workflow tests.
- Frontend: all 51 tests in 9 test files passed. No dedicated Spread page frontend behavior test file was found; this is not proof of all planned Spread UI interactions.
- Frontend production build passed. It reports the existing large-chunk warning.
- Offline original-code comparison: 100 deterministic cases matched, covering 340 reference candidate outputs and every funnel counter for those cases. The comparison executes the actual calculation definitions from the ZIP using pandas/NumPy, against the current port on equivalent finite synthetic inputs. Script: `tmp/spreads-plan-audit/compare_original.py`.
- That comparison does not establish exhaustive floating-point boundary parity, the original full `scan_ticker` wrapper, API aggregation, frontend interactions, discovery orchestration, or live provider equivalence.
- Reproduced combined fixture output: 7 candidates, EV values `[-746, -746, -512, -512, -1746, -1512, -1512]`, not descending. Missing original combined fields: `elapsed`, `errors`, `funnels`, `meta`, `tickers_failed`, `tickers_ok`. No candidate had `ev_per_lot_inr`.
- Reproduced the current frontend API helper with simulated HTTP responses: a successful app-token refresh followed by an Upstox-specific 401 still redirected to app login. No real tokens were used.

Source files were read directly from the uploaded ZIP, rather than treating the extracted standalone prototype as the baseline. SHA-256 identities:

| ZIP entry | SHA-256 |
|---|---|
| `spread-terminal/screener.py` | `6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa` |
| `spread-terminal/main.py` | `e11cfa47f7f6638943c8f7f8bc1e281360c2ddd546e304c0591b966c70426a13` |
| `spread-terminal/templates/index.html` | `a882447ce0aedb2473865d1117e19c1c8fd599e595c34e02dabf44d49640c6a6` |

## Phase-by-phase review

| Phase | Status | Findings |
|---|---|---|
| 0 — Baseline | Not separately defined | The pasted plan defines phases 1–10 only. This audit establishes the original ZIP identities and comparison evidence; no separate Phase 0 definition of done can be certified. |
| 1 — Spreads page | Implemented; UI verification partial | Protected `/spreads`, desktop/mobile navigation link, shared layout, explicit Scan button, and page shell exist. Page startup loads connection status and expiries, without starting a scan. Browser-level routing/mobile/no-auto-scan tests are missing. |
| 2 — OAuth | Partial | Node owns authorization, user-bound single-use state, expiry, disconnect, and in-memory tokens. Mock unit tests pass, including inactive-segment errors. Provider 401 still invokes app-login failure behavior; state is user-bound rather than browser-session-bound; app logout does not clear the Upstox session. End-to-end browser OAuth has not been demonstrated. |
| 3 — Adapter | Partial | Provider/fixture interfaces, normalized history/contracts/chains, instrument identities, IV conversion, and capability flags exist. The planned 120-second isolated cache and 0.4-second global call spacing are absent. OI meaning, daily candle completeness, and live input equivalence remain unverified. |
| 4 — Original engine | Core sampled parity verified; full phase incomplete | RV, midpoint spreads, friction, probability, earnings adjustment, EV, candidate fields, and funnels exist and matched the audit's sampled cases. The permanent tests do not run the untouched ZIP oracle. NumPy/pandas operations were reimplemented with Python math/statistics/helpers, so exhaustive boundary equivalence has not been established. |
| 5 — NIFTY | Partial | Fixture scans work through private Python routes without Angel session dispatch. The integrated API/UI use an explicitly selected expiry instead of the original target-DTE picker. Width defaults differ from the plan. The original picker exists in the engine but is not wired to integrated scans. |
| 6 — BANKNIFTY and stocks | Partial | BANKNIFTY and sample stock fixtures scan. Unavailable stock adjusted-history/earnings inputs correctly block exact live stock scans. Contracts parse lot sizes, but candidate output discards contract/lot identity and has no per-lot INR values. The UI silently changes the global width when adding BANKNIFTY. |
| 7 — Multi-underlying | Does not meet plan | 1–10 selection bounds, partial failures, and summed funnels exist. Scans run sequentially; symbols retain input order and duplicates are rejected rather than deduplicated/sorted; combined candidates are not sorted by rounded EV; original combined response fields are missing. One existing test explicitly asserts the incorrect no-ranking behavior. |
| 8 — Full UI | Partial | Candidate fields, layer details, basic text/type filtering, a sort dropdown, and combined/per-symbol funnels exist. Original per-column numeric filters, earnings filter, bidirectional column sorting, clear/reset behavior, parameter ranges, EV/per-lot explanation, and unavailable-discovery presentation are incomplete. Fraction/percent labels are inconsistent. |
| 9 — Real Upstox validation | Not completed | No sanitized real fixtures or original-versus-port live comparisons were found. Units, candle completeness, market-open/closed behavior, and supported live stock inputs have not been validated. Fixture/mock success does not satisfy this phase. |
| 10 — Hardening | Partial | Authentication, single-use OAuth state, expiry checks, safe error text, rate limits, private Python key checks, exact Upstox read allowlist, HTTPS host restriction, and production token-transport checks exist. Logout cleanup, browser-session binding, planned origin/CSRF validation, bounded caches, and dedicated callback-log/deployment-redaction verification remain incomplete. |

Proposed module names in the plan are not themselves mandatory. Locating routes in `services/spreads/api.py` or using one React component is acceptable if the required behavior is preserved. Findings above concern behavior, not naming.

## Priority findings

### 1. Upstox disconnect/expiry can redirect a valid app session to login

`backend/controllers/spreadController.js:61` returns HTTP 401 when there is no Upstox token. `sendScanError` does not attach a distinct provider-session marker. `algo-trading/src/trading/api.ts:51` interprets every 401 except `brokerSessionUnavailable` as app-auth failure; its request flow refreshes the app JWT, retries, and redirects to `/login` even if the refresh succeeded and the repeated failure is only Upstox-related.

This violates the plan's explicit app-session isolation requirement and prevents certifying that other workflows are unaffected. Use a distinct Upstox connection error and test that app JWT refresh/logout behavior remains unchanged for actual app-auth failures.

### 2. Combined ranking is incorrect

Original ZIP `main.py:278` sorts combined candidates descending by rounded `ev`. Current `angel-one/app/services/spreads/api.py:187` only concatenates candidates. Its `ranking_note` at line 198 incorrectly claims that the source defines no cross-underlying score. The UI defaults to this unsorted source order. The existing Python test at `tests/test_spread_nifty_api.py:91` locks in the divergence.

Preserve the original stable combined sort and rounded `ev` ranking field, including negative EV and ties. Do not replace it with RoR or per-lot EV ranking.

### 3. Defaults, bounds, and expiry semantics changed

The original width default is 5.0. Integrated request models (`api.py:32`, `:44`) and UI (`SpreadsPage.tsx:42`) default to 50. Adding BANKNIFTY automatically changes width 50 to 100 (`SpreadsPage.tsx:168`), affecting the entire multi-underlying scan. The plan explicitly prohibits new width defaults or automatic substitutions.

The original target DTE defaults to 30 with closest-valid-expiry selection. Integrated scans require an expiry mapping and initially choose the first available expiry (`SpreadsPage.tsx:100`). The original `pick_expiration` is unused by the API. Other non-width API/UI bounds were widened, including VRP, RoR, cushion, OI, and bid/ask fraction; `max_strikes` is exposed although the plan keeps it internal. Only an explicitly identified NSE width-range extension was authorized.

### 4. Multi-scan orchestration and contract are incomplete

`api.py:172` runs symbols sequentially, without the original semaphore of four. It rejects duplicates and preserves input order instead of using sorted normalized unique symbols. The original combined keys are missing, as reproduced above. Sequential network retries across 10 symbols can also exceed the Node bridge's 60-second timeout; no batch deadline or cooperative cancellation test demonstrates otherwise.

### 5. Provider normalization is not live-certified

`upstox_adapter.py:185` explicitly marks OI as unverified, but `capability_blockers` checks only history and earnings; index scans still apply the original OI threshold to those raw values. Contract lot sizes are parsed but never included in results. Daily history includes returned candles through the current date without a demonstrated completeness policy. IV division by 100 exists, but no sanitized live unit validation is present.

Stock earnings and adjusted-history blockers are correctly visible. Preserve them; do not fabricate missing inputs to make stock scans succeed. Discovery universe sourcing can remain unsupported as the plan permits, but that limitation must be visible and the calculation preservation checklist completed independently.

### 6. UI does not preserve the original view behavior

The original template has inclusive min/max filters for strike, credit, RoR, cushion, VRP, breach percent, and EV, plus ticker/type/earnings filters, ascending/descending column toggles, and clear/reset. The integrated page has only symbol/type filters and five fixed-direction numeric sort choices.

`SpreadsPage.tsx:287` labels `max_spread_pct` as percent while editing the raw fraction (0.10 means 10%, not 0.10%). Layer friction at line 361 likewise appends `%` to an unconverted fraction. The original EV ×100 convention and separate per-lot INR result are not explained or displayed. Candidate raw/adjusted probability percent display is present and correct.

### 7. Remaining session/production requirements

Upstox session expiry is pruned lazily during service requests. Explicit Upstox disconnect removes state and token, but `authController.logout` does not call it. OAuth state records a user ID, not a browser-session identifier. Existing SameSite cookies and CORS are present; no explicit Spread origin/CSRF validation was found. The app's error logger omits request URLs, which helps avoid code leakage, but dedicated callback/deployment access-log redaction verification is absent. No new Redis, queue, database, or extra service is needed to address these gaps.

## Function preservation checklist

Legend: **Sampled** = direct original-code comparison in this audit; **Implemented** = corresponding behavior found with current unit/fixture coverage, without exhaustive oracle coverage; **Partial** = helper exists but integration/data semantics incomplete; **Missing** = required behavior not found; **Intentional** = permitted UX/provider adaptation.

### Original screener.py

| Original function/behavior | Current destination | Status / qualification |
|---|---|---|
| `TRADING_DAYS_PER_YEAR`, `CAL_TO_TRADING` | `engine.py` | Implemented: 252 and 252/365. |
| `ScanParams` | `engine.py`, API/UI | Sampled engine defaults; integrated defaults/bounds differ. |
| `RateLimited`, `_is_rate_limited` | `transport.py` | Implemented provider-specific 429 errors; adapted error detection. |
| `_throttle` | Transport | Missing global 0.4-second spacing. |
| `_yf_call` | `UpstoxTransport.get` | Partial: default four attempts and bounded retries exist; provider-specific Retry-After and capped delays differ from source retry policy. |
| `_cache_get`, `_cache_put` | Transport/adapter | Missing 120-second user/provider/instrument/data-type isolated cache. |
| `fetch_history` | `upstox_adapter.py`, `provider.py`, engine | Partial: three years, sorted candles, missing-close removal, 270-close gate exist; stock adjustment and daily completeness unverified. |
| `safe_option_chain`, `_clean` | `engine.clean_option_rows`, adapter | Implemented for ordinary finite quotes: numeric coercion, missing IV/OI handling, two-sided quote validation, ascending strikes. Exhaustive pandas coercion/duplicate-strike parity unproven. |
| `pick_expiration` | `engine.pick_expiration` | Partial: helper exists/tested; target-DTE selection not used by integrated scan. |
| `realized_vols` | `engine.realized_vols` | Sampled: log returns, sample standard deviation and four windows matched within numerical tolerance. |
| `get_earnings_info` | `engine.get_earnings_info`, adapter | Partial: date/gap calculation exists; original 24-date/future-calendar acquisition unavailable from current provider; stock scans blocked. |
| `apply_earnings_penalty` | `engine.py` | Sampled: both earnings-enabled/disabled spread branches included. |
| `empirical_breach_prob` | `engine.py` | Sampled: overlapping returns, calendar horizon, inclusive direction thresholds and sample gate retained. Zero/invalid-price edge semantics are not certified. |
| `friction_detail`, `passes_friction` | `engine.py` | Sampled for valid finite quotes and OI gate branches. |
| `build_spreads` OTM selection / nearest 12 | `engine.py` | Sampled: selection before subsequent gates retained. |
| `build_spreads` Bull Put / Bear Call | `engine.py` | Sampled: correct hedge direction and probability side. |
| `build_spreads` hedge matching | `_numpy_isclose`, engine | Sampled: emulates rtol 1e-5 plus atol 0.011; exhaustive tolerance-boundary parity not established. |
| `build_spreads` credit / actual width / RoR | `engine.py` | Sampled: midpoint credit, >0.01 and <width gates, original RoR. |
| `build_spreads` filter order / IV / VRP | `engine.py` | Sampled: original computation/gate order retained. |
| `build_spreads` EV | `engine.py` | Sampled: original ×100 and negative EV retained. Global ranking is separate and incorrect. |
| `build_spreads` funnel increments | `engine.py` | Sampled: all seven counters matched. |
| `build_spreads` fields / layers / rounding | `engine.py` | Sampled: all original candidate fields/layers matched in 340 candidate outputs. |
| `scan_ticker` | `scan_provider_data`, API | Partial: history-derived spot and result envelope exist; source expiry/orchestration/acquisition sequence not fully retained. |
| `_atm_iv` | `engine.atm_iv` | Partial: median of nearest three valid-IV strikes per side exists; closest 14-day provider orchestration absent. |
| `edge_discovery.stage1` | `edge_discovery_metrics` | Partial: history metrics exist; original four-month sourcing and six-worker orchestration absent. |
| `edge_discovery.stage2` | `edge_discovery_shortlist`, `rank_edge_discovery` | Partial: rounded shock shortlist and raw RV intermediates exist; source/provider discovery pipeline absent. |
| `edge_discovery` thresholds / percentile scoring | `rank_edge_discovery` | Implemented helper, unit-tested; pandas percentile behavior reimplemented and not exhaustively compared to original. |
| `edge_discovery` serialization | Ranking helper / API | Partial: intermediate removal exists; recursive NaN/Infinity sanitizer missing. |
| `trending_scan` alias | Discovery | Missing; no integrated discovery endpoint currently exposes it. |
| `applog.get_logger` integration | Python logging | Partial: sanitized event warnings exist; full original useful-event and deployment-redaction coverage absent. |

### Original main.py

| Original function/behavior | Status / destination |
|---|---|
| `_json_safe` | Missing equivalent recursive NaN/Infinity-to-null serializer. |
| `ScanRequest` | Partial: 1–10 selection bound exists; target DTE, original defaults, and non-width bounds differ. |
| `_scan_one` / semaphore 4 | Missing in integrated orchestration. |
| `api_scan` normalize/deduplicate/sort | Partial: normalization exists; duplicates rejected and order preserved. |
| `api_scan` per-symbol aggregation | Partial: per-symbol failures/funnels/meta exist under changed response structure. |
| `api_scan` combined rounded-EV stable ranking | Missing; current test asserts unsorted concatenation. |
| `api_scan` summed funnel | Implemented; null aggregate when no successes. |
| `api_scan` elapsed and original response contract | Missing six original combined fields. |
| `_normalize_symbol` | Implemented NSE identity adaptation in `instruments.py`. |
| `_quote_is_liquid`, `_fetch_screener_symbols` | Intentional unavailable provider sourcing; reference coverage and visible unsupported-state documentation incomplete. |
| `_get_active_universe` | Intentional unavailable Yahoo universe sourcing; no silent NSE replacement found. |
| `_refresh_trending`, `_trending_payload` | Not integrated; unavailable discovery presentation incomplete. |
| `api_trending`, 15-minute cache, `api_discover` | Not integrated; optional provider-dependent discovery can remain unavailable, explicitly labeled. |
| `startup` background discovery | Intentionally omitted for explicit scan-once UX. |
| `index` | Replaced by protected React route, as planned. |

### Original UI

| Original function/behavior | Status / destination |
|---|---|
| `params`, `sliders`, `fmtParam`, `pct` | Partial: controls/probability display exist; defaults/ranges/fraction formatting differ. |
| `addTickers`, `quickAdd`, `removeTicker`, `clearWatchlist` | Partial: add/remove and 10 limit exist; source normalization/duplicate semantics differ; no dedicated clear/import implementation. |
| `loadWatchlistFile` | Not implemented; optional according to plan, so not a blocker by itself. |
| `runScan` | Implemented explicit request/busy/error handling; no automatic scan call found. |
| `sortColumns`, `filters` | Partial: original numeric and earnings filters missing. |
| `colByKey`, `toggleSort`, `sortIndicator` | Partial: limited dropdown replaces original bidirectional column sorting. |
| `hasActiveView`, `resetView` | Missing equivalent reset/detection behavior. |
| `passesFilters`, `displayedCandidates` | Partial: symbol/type filtering then local sorting exists; original inclusive numeric bounds missing. |
| `funnelSegments` | Implemented counts/fractions with max(considered,1). |
| Layer tooltips / EV explanation | Partial: layer data shown; friction percent labels incorrect; original EV/per-lot explanation missing. |
| `init`, `bootstrapEdge` automatic scanning | Intentionally omitted, as required by scan-once UX. |
| `autoDiscover`, `loadTrending` | Not integrated; provider limitations need visible unavailable presentation. |

## Environment check at audit time

This supersedes the earlier environment observation; the user has changed settings since Phase 10.

| File | Observed state |
|---|---|
| `backend/.env` | Upstox client ID, client secret, and redirect URI now present and nonblank. `SPREADS_DATA_MODE=upstox`. Values were not displayed and correctness against the developer console is unverified. |
| `backend/.env` frontend return URL | Missing/blank; code defaults to `http://localhost:5173/spreads` for this setting. |
| `angel-one/.env` | `SPREADS_DATA_MODE` is absent/blank in the current file. Code defaults to `fixtures` if absent. Configure the same mode in both services and restart them. |
| Python Upstox OAuth credentials | Not required in this file; OAuth secrets belong to Node. |

No credentials or environment settings were changed by the audit. A running process may still hold previously loaded values; env-file inspection is not a runtime mode verification.

## Effect on existing workflows

The tracked integration diff modifies the layout title/navigation and router additively, mounts a new Node route, imports/registers the new Python router, and adds environment examples. Existing Angel One order/strategy source files were not changed by this integration diff. Spread Python routes use their own internal-key dependency and bypass the Angel account-dispatch prefixes, as intended. No Upstox order-execution API is exposed.

However, a valid app session can be redirected to login by an Upstox-only 401, as reproduced. Shared request/thread resource effects and real browser/broker operation are not covered by the passing regression suites. Therefore the supported conclusion is **existing automated regressions pass, but complete workflow isolation is not yet established**.

## Work required before full plan sign-off

1. Fix provider-session error classification and add app-login isolation tests.
2. Restore original combined rounded-EV ranking, stable tie order, symbol normalization, four-worker bound, and complete response contract.
3. Restore original parameter defaults/bounds and target-DTE expiry selection; keep any NSE width-range extension explicit and remove automatic width changes.
4. Add original UI view-filter/sort/reset behavior; correct fraction-to-percent display and EV/per-lot explanation.
5. Carry contract identity/lot sizes into additive result fields and calculate separately named per-lot INR values without altering original `ev` ranking.
6. Implement the planned bounded isolated caches and global provider call spacing; preserve provider-safe retries and test cancellation/timeout behavior.
7. Complete logout/browser-session security behavior, origin/CSRF protection, callback/deployment redaction verification, and permanent original-versus-port parity coverage.
8. Align service modes, perform real Upstox validation when account permissions allow, capture sanitized fixtures, and verify OI/IV/history semantics. Keep stock/discovery input limitations explicit.

Until these are resolved, phases 0–10 should not be represented as fully implemented and validated against this plan.
