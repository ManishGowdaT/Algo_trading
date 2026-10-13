# Spread Terminal audit remediation

Latest user override — remove live validation gates: OI-unit, daily-candle-completeness and corporate-action-adjustment equivalence checks now produce non-blocking `data_warnings`. Scans consume raw normalized Upstox inputs and run the unchanged original calculations. NIFTY/BANKNIFTY no longer require a live-equivalence certificate to scan. This supersedes earlier statements in this report that those verification checks block execution. Actual insufficient history, empty/malformed chains and missing stock earnings inputs remain errors; missing earnings are not fabricated. Failed scans now show “Scan unavailable” instead of misleading “No candidates passed.”

Follow-up — silent OAuth return / disconnected badge: fixed the page's `Promise.all` coupling, which discarded a successful connection-status response when the Python/expiry request failed. OAuth status now commits first, and provider connection failures remain visible independently of market-data errors and query cleanup. Added a bounded per-user last-attempt diagnostic, a page diagnostics panel, and `[SpreadsOAuth]` Node logs for callback admission (including rejected app authentication), state verification/token exchange HTTP outcome, success/failure/expiry and final redirect outcome. Log tests verify no credentials, tokens, authorization codes, OAuth states or raw provider bodies are exposed. Real provider acceptance still requires a fresh browser login; this change does not establish live OAuth success or segment activation.

Follow-up — connection refused after OAuth: local `backend/.env` still contained the standalone `http://127.0.0.1:8001/auth/callback`. Corrected it to `http://localhost:5000/api/v1/spreads/upstox/callback` and set the frontend return URL to `http://localhost:5173/spreads`. Added pre-login validation rejecting obsolete callback paths/port 8001; local and deployed integrated callback tests pass. The identical redirect URL must still be saved in the user's Upstox developer app, followed by a Node restart and fresh login. No live OAuth success is claimed until that external configuration is updated.

Follow-up — Spreads login redirect: resolved after the user reported it. Spread controller downstream 401 errors now return 409 with `upstoxSessionUnavailable`, so missing/expired Upstox connections do not trigger shared app-login refresh/redirect. App authentication middleware and the shared API client are unchanged. Added backend connection-isolation tests and frontend tests proving provider errors stay on Spreads while genuine app-auth failures still refresh/redirect. Other security findings below remain open.

Date: 2026-10-12. Scope: fix the non-security findings in `SPREADS_PLAN_AUDIT.md`. Security/session/OAuth findings were explicitly excluded by the user. No broker orders or live broker requests were made.

## Implemented

- Restored original defaults and non-width API/UI ranges. Width defaults to 5; only its NSE range is extended. Maximum candidate strikes stays internal at 12. No automatic BANKNIFTY width mutation.
- Default expiry selection now uses the original nearest-target-calendar-DTE picker, default 30, excluding expiries under three days. An explicitly selected expiry remains an optional override.
- Multi-underlying scans normalize, deduplicate and sort symbols; four global worker slots bound concurrency. Results use the original stable descending rounded `ev` sort, including negative EV and ties.
- Restored `elapsed`, integer `tickers_ok`/`tickers_failed`, `funnels`, `meta`, `errors`, `candidates`, aggregate seven-stage `funnel`, and recursive non-finite-to-null serialization. Existing integrated response fields remain additive.
- Extracted the actual original ZIP calculation definitions into `angel-one/app/services/spreads/original_calculations.py`. The engine executes these through DataFrame/Series representation adapters. NumPy/pandas are declared dependencies. Permanent tests verify AST identity against a SHA-256-checked untouched source fixture, not another rewrite of the formulas.
- Restored pandas chain cleaning, nearest-three ATM IV behavior, discovery stage-one metrics, percentile ranking, raw-VRP threshold evaluation before rounding, and score sorting before display rounding. Offline tests execute the original discovery and earnings definitions for comparison.
- Added contract identities, lot-size provenance, and separately computed INR credit/loss/EV per lot from unrounded source inputs. Original EV and ranking remain unchanged. Missing or inconsistent lots produce unavailable monetary values, not invented quantities. Fixture lots are labeled synthetic.
- Added bounded process-local 120-second cache, scoped by token fingerprint/client/provider endpoint/instrument/parameters, with defensive copies and 512-entry bound. Actual HTTP calls use global 0.4-second spacing; cache hits do not. Four-attempt retry behavior retains exponential delay plus jitter. Explicit Upstox Retry-After remains a provider adaptation.
- Multi-scan response waits at most 45 seconds, returning per-symbol deadline errors and completed results. Workers share the deadline and do not begin further HTTP requests/retries after it. HTTP timeouts use remaining budget. Cancellation does not forcibly kill an already-running synchronous HTTP call; its bounded timeout and finalizers release the worker slot. Default Node timeout remains 60 seconds; custom `SPREADS_PYTHON_TIMEOUT_MS` should exceed 45,000.
- Restored inclusive numeric filters for short strike, credit, RoR, cushion, VRP, adjusted breach percent and EV, plus underlying/type/earnings filtering. Sortable columns toggle both directions; reset returns to API EV ranking. Corrected fraction/percent labels and layer display, added per-lot values and ranking explanation, clear selection, and comma/space multi-add. Scanning runs only on explicit form submission; an immediate busy ref prevents duplicate submissions.
- Edge Discovery is visibly unavailable because provider-equivalent universe inputs are missing. Its calculations are retained and tested; no fabricated discovery universe, substitute score, startup scan or background scanner was introduced. File import remains optional and is not implemented.
- Live scans now block rather than apply original OI thresholds to unverified units, or assume daily candle completeness. Existing stock adjusted-history and earnings blockers remain.
- Node rejects a Python response with mismatched `data_mode`. Added `SPREADS_DATA_MODE=upstox` to the local Python `.env` to match the existing Node setting. No credential values were changed or printed. For offline UI testing, set **both** services to `fixtures` and restart them; fixtures cannot be used in production.

## Preservation map

| Original function / calculation | Current destination and evidence |
|---|---|
| `ScanParams`, constants | `original_calculations.py`; original defaults and AST-identity test |
| `realized_vols` | Original definition, Series adapter in `engine.py`; 10/21/63/252 windows, log returns, ddof=1 unchanged |
| `empirical_breach_prob` | Original definition, Series adapter; overlapping horizons, inclusive breach tests, 60-observation gate, zero/non-finite boundary oracle cases |
| `apply_earnings_penalty` | Original definition; AST-identical |
| `friction_detail`, `passes_friction` | Original definitions; midpoint/fraction/OI gates unchanged |
| `build_spreads` | Original definition; both spread directions, nearest 12, NumPy hedge tolerance, filter order, credit/width/loss/RoR, IV/VRP, probability/EV, all layers/rounding/funnel counters unchanged |
| `safe_option_chain._clean` | `engine._clean_frame`, `clean_option_rows`, `option_chain_rows`; pandas coercion, missing IV/OI, quote gates and strike ordering |
| `fetch_history` | `upstox_adapter.get_history`, `HistoryData.scanner_history_eligible`, engine close filtering; provider acquisition adaptation, 270-close requirement |
| `pick_expiration` | `engine.pick_expiration` wired into `_scan_underlying`; optional explicit override labeled in UI |
| `get_earnings_info` | Date/gap calculation in engine; original-source comparison test. Provider earnings unavailable for stocks, explicitly blocked; indices not applicable |
| `scan_ticker` | `scan_provider_data` + `_scan_underlying`; original envelope/fields, history-derived spot and explicit provider capability failures |
| `_atm_iv` | `engine.atm_iv`; original nearest-three-per-side median. Discovery provider orchestration unavailable |
| `edge_discovery.stage1`, shortlist/stage2, threshold/rank/serialization | `edge_discovery_metrics`, `edge_discovery_shortlist`, `rank_edge_discovery`; original pipeline comparison and threshold-rounding regression |
| `trending_scan`, active-universe sourcing, `api_discover`/`api_trending` | Explicitly unavailable discovery feature. No claim of a working Yahoo-equivalent Upstox universe or alias endpoint |
| `_throttle`, `_yf_call`, `_cache_get/put` | Upstox `transport.py`; read-only provider adaptation, global spacing/retries/isolated bounded TTL cache |
| `RateLimited`, `_is_rate_limited` | Upstox status/error mapping and retry policy; no Yahoo error dependency |
| `_json_safe` | `api._json_safe`; nested dictionary/list/tuple non-finite normalization |
| `ScanRequest`, `_scan_one`, `api_scan` | Original ranges in API models; four-worker orchestration, dedup/sort, rounded EV stable ranking, complete combined contract |
| Original UI parameters, watchlist add/remove/clear | React controls with original defaults/ranges except labeled NSE width range; multi-add/removal/clear; no auto scan |
| `filters`, `sortColumns`, `passesFilters`, `displayedCandidates` | `viewFilters.ts` + sortable result headers, inclusive numeric and earnings filters, percent accessor |
| `toggleSort`, `sortIndicator`, `hasActiveView`, `resetView` | React view state, aria-sort, direction indicators, clear/reset to API ranking |
| Original funnel/layers/results | Combined and per-underlying funnels plus all candidate fields/layer details; separate INR lot adaptation |
| Logging | Existing sanitized Python/Node logging retained. Callback/deployment-redaction verification remains in excluded security scope |

## Verification

- Python full suite: 103 tests pass, followed by a passing additional per-lot regression (104 total; eleven new audit regression tests).
- Frontend full suite: 56 tests pass; includes view-filter tests and page action tests for no-auto-scan, original defaults, automatic expiry, duplicate-submit prevention and no BANKNIFTY width mutation.
- Frontend production build and targeted Spread ESLint pass. Existing bundle-size warning remains.
- Backend full regression suite: 222 tests pass, including mode-mismatch coverage. Spread bridge/OAuth targeted run passes all 12 tests.
- Permanent ZIP oracle: 100 deterministic calculation cases/340 reference candidate outputs, all candidate fields/layers/funnel counters; original-function AST identity and additional invalid-price boundaries. Earnings and discovery comparisons also pass.
- No edits to existing Angel strategy, order execution, account/session, market-data workflow implementations, shared frontend auth/API helper or OAuth service during this remediation. Existing integration route/navigation hooks remain as previously added. Tests are regression evidence, not a guarantee of every browser/live deployment behavior.

## Still open

1. **Phase 9 live validation:** Upstox activation/login and sanitized real provider samples are still needed to establish OI units, IV units, complete daily candles, market-open/closed behavior, real contract lots and original/provider input equivalence. No equivalence certification or live-validation completion is claimed. Live exact scans remain blocked on unverified OI/completeness; there is no bypass flag.
2. **Stock source inputs:** Upstox adjusted-close equivalence and the original earnings calendar/historical gaps are unavailable/unverified. Stock fixtures work; exact live stock scans remain blocked.
3. **Excluded security findings:** provider 401 can still trigger shared app-login handling, OAuth state is not browser-session bound, app logout does not disconnect Upstox, and origin/CSRF/callback-log/deployment verification remains pending. Therefore an unconditional statement that every other workflow is unaffected would be incorrect.
4. Dedicated real-browser mobile/routing/OAuth end-to-end validation remains pending. Page action tests use a hook harness; they do not substitute for browser layout or a real OAuth callback.

Restart Node and Python for configuration/code changes. Ensure Python dependencies are installed with `python -m pip install -r requirements.txt` from `angel-one` before starting the existing port-8000 service. The frontend remains on 5173 and Node on 5000; no new service or infrastructure was added.
