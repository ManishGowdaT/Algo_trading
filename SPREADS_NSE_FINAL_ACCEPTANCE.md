# NSE Spread Terminal — final acceptance audit

Historical audit record: this document covers the pre-V2 release. On 16 October 2026 the user subsequently authorized a versioned reference-price/payoff correction. See `SPREADS_NSE_V2_IMPLEMENTATION_REPORT.md` for V2 behavior and validation; the original baseline and V1 calculation modules remain unchanged.

Report completed: 16 October 2026 (Asia/Kolkata). Test, arithmetic, replay and public-master evidence was collected on 15 October 2026. Archived authenticated provider responses are from 13 October 2026; they are not fresh live validation.

**SOFTWARE / READ-ONLY NSE RESEARCH WORKFLOW: PASS within the tested scope.** Four deterministic defects found during this audit were repaired and regression-tested. Fresh authenticated, browser-to-provider acceptance remains **UNVERIFIED**. Strategy calibration is **BACKTEST REQUIRED**. Real-money execution readiness is **UNVERIFIED**.

The completion report and completion-pass changes were reviewed. The US terminal was reference material only; numerical parity with the US implementation was not an acceptance requirement. This audit makes no claim of profitability, safety, or production trading readiness.

## A. SOFTWARE CORRECTNESS

**PASS** — current deterministic tests and independent arithmetic checks. No outstanding reproduced deterministic failure remains in the tested cases.

| Final check | Result | Evidence |
|---|---|---|
| Complete Python suite | PASS — 284 passed, six warnings | `tmp/final-acceptance-python.log` |
| Complete Node suite | PASS — 233 passed, zero failed/skipped | `tmp/final-acceptance-node.log` |
| Complete frontend suite | PASS — 73 tests across 12 files | `tmp/final-acceptance-frontend.log` |
| Production frontend build | PASS — existing bundle-size warning | `tmp/final-acceptance-build.log` |
| Newly added regressions before fixes | FAIL — eight failing cases proving four defects | `tmp/final-acceptance-before-fixes.log` |
| Affected tests after fixes | PASS — 47 passed | `tmp/final-acceptance-affected.log` |
| Independent candidate arithmetic | PASS — 34 candidates | `tmp/spread-audit/final-acceptance-independent.json` |
| Independent discovery metrics/ranking | PASS — four fixture underlyings | `tmp/spread-audit/final-acceptance-discovery.json` |

### Repaired findings

Each finding below was **FAIL** before repair and is **PASS** after repair. Regression tests are in `angel-one/tests/test_spread_final_acceptance_regressions.py`.

1. **Malformed option listing compressed the strike ladder.** Expected: incomplete contract metadata must not change listed-step distance. Actual: rows missing contract identity or strike were silently discarded; non-positive strikes were accepted. Root cause: filtering malformed contract rows instead of invalidating the incomplete listing. Impact: the next surviving strike could incorrectly become a one-step hedge. Minimal fix: reject the underlying contract response when required contract metadata or a positive finite strike is unavailable. Missing lot remains explicit and is handled separately. Five regression cases cover missing key, symbol, strike, zero strike and negative strike. File: `upstox_adapter.py`.

2. **Conflicting duplicate contract identity selected the first underlying.** Expected: conflicting authoritative identities must be excluded as ambiguous. Actual: duplicate contract IDs were skipped before checking identity conflicts. Root cause: deduplication used a set without the previously observed identity. Impact: an incorrect stock/index mapping could survive. Minimal fix: retain the identity associated with each contract ID and mark both conflicting symbols ambiguous. File: `universe.py`.

3. **Discovery claimed ATM IV without a reference spot.** Expected: absent eligible history/reference spot must make ATM IV unavailable. Actual: selecting nearest strikes with NaN distances could still produce an IV from the first rows. Root cause: passing a NaN reference into ATM selection. Impact: misleading IV coverage diagnostics. Minimal fix: compute ATM IV only when history metrics supply the reference spot. Provider errors remain separately classified. File: `discovery.py`.

4. **A partial cached ranking became “last successful.”** Expected: a failed refresh may retain prior partial data but cannot certify it as a successful ranking. Actual: a fallback promoted the old partial record into `last_successful`; UI wording reinforced the claim. Root cause: unconditional fallback to the old cache record. Impact: misleading completeness/freshness reporting. Minimal fix: preserve only an existing successful record, and label retained data “Previous cached ranking.” Files: `discovery_cache.py`, `DiscoveryPanel.tsx`.

Only those five production files changed from the audit-start fingerprint. The two calculation modules, strategy defaults and thresholds retained their audit-start hashes. The source comparison was rechecked on resumption; no additional production path differed from the recorded audit change list. Evidence: `tmp/spread-audit/final-acceptance-baseline.json` and `final-acceptance-source-checks.json`.

## B. NSE DATA INTEGRITY

**PASS** — normalization and rejection behavior in deterministic tests, archived raw-response replay and public-master inspection. **UNVERIFIED** — current authenticated quote/history quality and complete upstream data accuracy.

The public Upstox instrument master was fetched successfully on 15 October. It dynamically yielded 219 eligible underlyings, zero ambiguous identities and zero rejected entries in that response. This is an observation, not a fixed universe count or independent certification of publication freshness. NMDC, CANBK, NTPC and TATAELXSI resolved as equities; NIFTY and BANKNIFTY resolved as indices with their authoritative keys. Expiries came from listings, including dates on differing weekdays. Evidence: `tmp/spread-audit/final-acceptance-public-master.json`.

### Requested adversarial coverage

PASS below means the indicated behavior was verified within the stated evidence scope, not that all possible upstream defects have been excluded.

| # | Attempted failure | Verdict and observed protection |
|---|---|---|
| 1 | Dynamic F&O universe | PASS — public-master fetch and universe tests; no fixed membership/count requirement |
| 2 | Stock/index identity | PASS — authoritative keys, ambiguity exclusion and duplicate-conflict regression |
| 3 | Expiry selection/ties | PASS — nearest eligible expiry, deterministic equal-distance ordering, no invented weekday |
| 4 | Current/incomplete candles | PASS — current-day bars require finality; raw bars retained for diagnosis |
| 5 | Duplicate/invalid history | PASS — chronology, duplicate, malformed and coverage rejection tests |
| 6 | Missing lot | PASS — explicit unavailable lot; no guessed lot or compressed ladder |
| 7 | Missing vs zero OI | PASS — missing OI cannot pass even a zero threshold; zero remains a measured value |
| 8 | Raw quantity OI | PASS — raw quantity divided by actual listed lot; archive arithmetic independently checked |
| 9 | IV units | PASS — provider-specific percentage-to-decimal normalization tested and replayed |
| 10 | Missing IV | PASS — unavailable values retained/rejected appropriately; no ATM claim without spot |
| 11 | Bull Put steps | PASS — lower listed-strike hedge; one/two/three-step tests |
| 12 | Bear Call steps | PASS — higher listed-strike hedge; one/two/three-step tests |
| 13 | Missing intermediate metadata | PASS — missing-lot grid preservation and malformed-listing rejection regressions |
| 14 | Nonuniform ladder | PASS — listed steps used; actual price width calculated separately |
| 15 | Invalid/NaN/Infinity quotes/strikes | PASS — finite positive input gates and regression cases |
| 16 | Crossed/non-positive quotes | PASS — quote validity gates prevent candidate admission |
| 17 | Midpoints/credit | PASS — independent calculation from leg inputs |
| 18 | Actual width | PASS — absolute strike difference independently checked |
| 19 | Cushion | PASS — independent spot/strike calculation |
| 20 | RoR | PASS — independent credit/payoff-loss calculation |
| 21 | RV10/21/63/252 | PASS — independent log-return/sample-deviation calculations |
| 22 | Historical probability/counts | PASS — independent forward-return windows, hit counts and sample counts |
| 23 | Earnings uncertain/unavailable | PASS — capability/blocking paths tested; actual future event completeness UNVERIFIED |
| 24 | Model EV | PASS — independent existing score equation; predictive validity BACKTEST REQUIRED |
| 25 | INR credit/lot | PASS — unrounded source credit times listed lot |
| 26 | Payoff maximum loss/lot | PASS — (actual width minus credit) times listed lot |
| 27 | Margin/settlement labels | PASS — payoff loss distinguished from broker margin; settlement/cost notes present |
| 28 | Rejections | PASS — reason counts and funnel reconciled; 64 rejections in the fixture run |
| 29 | Discovery freshness/cache | PASS — TTL, partial/failure retention and last-success regression; cached data labeled |
| 30 | Partial multi-underlying | PASS — NIFTY plus invalid symbol preserves success and reports failure |
| 31 | Zero-result scans | PASS — successful empty response; no default threshold changes |
| 32 | 401/429/timeouts | PASS — mocked provider/transport/controller error tests; fresh live failures UNVERIFIED |
| 33 | Python → Node numbers | PASS — actual FastAPI JSON through actual Node forwarding service with injected HTTP response |
| 34 | Node → React numbers | PASS — JSON round-trip, TypeScript helpers and React server render preserve 32 candidates |
| 35 | UI terminology/units | PASS — tests and rendered markup; live browser visual acceptance UNVERIFIED |

Relevant test inventories include `test_spread_b1_b8.py`, `test_spread_completion.py`, `test_spread_audit_regressions.py`, discovery/adapter/cache/provider suites, Node Spread suites and frontend Spread suites. The expanded inventory is `tmp/spread-audit/final-acceptance-test-inventory.txt`.

No independent exchange calendar reconciliation, corporate-action adjustment certification, or exhaustive upstream event-data audit was completed; these remain **UNVERIFIED** rather than assumed correct.

## C. END-TO-END WORKFLOW

**PASS** — deterministic integrated boundaries and offline provider replay. **UNVERIFIED** — one fresh authenticated browser → Node → Python → Upstox → browser run.

Reviewed path: React requests → authenticated Node routes/controllers → explicit Python-service endpoints → FastAPI → GET-only Upstox market-data transport → normalization → discovery/chain → construction/calculation/ranking → JSON → React. Fixtures cannot silently substitute for live provider mode.

The independent harness exercised real FastAPI serialization. The Node service consumed that payload through an injected HTTP response, followed by JSON serialization, actual TypeScript helpers and React server rendering. All 32 fixture candidates survived unchanged. This verifies numeric boundaries without claiming real network sockets or browser interaction. Evidence: `final_acceptance_serialization.cjs`, `final-acceptance-serialization.json`, `final-acceptance-render.html` under `tmp/spread-audit/`.

Archived raw Upstox responses for BANKNIFTY, CANBK, NIFTY, NMDC, NTPC and TATAELXSI were replayed at their original 13 October observation context through the current normalizer/API under both existing profiles. All 12 scans completed. Native-profile results were zero; the legacy profile produced one CANBK and one NMDC candidate. Zero candidates were accepted without tuning.

### Independent numerical reconciliation

Expected values were generated using standard-library arithmetic/statistics and raw inputs, not production calculation functions. Production functions were used only for the actual side of comparisons. The harness independently reconstructed midpoints, credit, width, OI conversion, all four RV windows, VRP, cushion, RoR, historical probability and sample count, event adjustment, model EV, and both INR lot amounts. It also independently checked discovery metrics and percentile ranking.

| Input/example | CANBK archived Bear Call | NMDC archived Bear Call | NIFTY synthetic Bull Put |
|---|---:|---:|---:|
| Short / long strike | 125 / 130 | 75 / 80 | 25100 / 25050 |
| Short / long midpoint | 3.58 / 2.175 | 1.67 / 0.695 | 500 / 485 |
| Source credit | 1.405 | 0.975 | 15 |
| Actual width | 5 | 5 | 50 |
| Lot | 6750 | 6750 | 1 (fixture only) |
| Raw short / long OI | 1086750 / 1849500 | 810000 / 1019250 | Already contract OI |
| Short / long OI contracts | 161 / 274 | 120 / 151 | 25000 / 25000 |
| RV21 decimal | 0.2001920773 | 0.2471185333 | 0.0167996700 |
| Displayed VRP | 1.56 | 1.22 | 14.88 |
| Cushion % | 5.59 | 6.62 | 2.08 |
| RoR % | 39.1 | 24.2 | 42.9 |
| Historical probability | 0.2979 | 0.2825 | 0.3649 |
| Adjusted probability | 0.5801 | 0.4808 | 0.3649 |
| Samples | 715 | 715 | 296 |
| Model EV score | -150 | -143 | -324 |
| INR credit/lot | 9483.75 | 6581.25 | 15 |
| INR payoff maximum loss/lot | 24266.25 | 27168.75 | 35 |

Synthetic lots are not assertions about current NSE lots. Fixture OI is already expressed in contracts; archived cases validate raw-quantity conversion. Existing display rounding is distinct from source precision: for example, NMDC's binary-float legacy display rounds credit to 0.97 while lot money uses the source credit. The audit did not change rounding or formulas. Full precision and all 34 reconciled candidates are in `final-acceptance-independent.json`; the independent implementation is `final_acceptance_independent.py`.

## D. UI / EXPLAINABILITY

**PASS** — automated UI tests, source inspection and React rendered-output checks. **UNVERIFIED** — fresh authenticated interactive browser rendering.

The live Spread path was searched for dollar/USD currency, fixed 100-share assumptions, hard-coded lots/counts/strike intervals, fabricated expiry weekdays, missing-data coercion, nonfinite propagation, misleading expected-profit/maximum-risk labels, stale freshness claims and order paths. Search evidence: `final-acceptance-pattern-search.txt`, `final-acceptance-source-checks.json` and `final-acceptance-reviewed-diff.txt` under `tmp/spread-audit/`.

- No USD currency, hard-coded universe count, misleading “expected profit”/“maximum risk” label, or order endpoint was found in the inspected live Spread path.
- Dollar characters were JavaScript interpolation or regex syntax; rendered money labels use INR.
- Constants of 100 serve percentage/paise conversion, the existing OI threshold, or the explicitly labeled model-score convention; actual monetary amounts use listed NSE lots.
- Fixed synthetic lots, strike spacing and expiry construction in fixture code are fixture-only, not live metadata assumptions.
- Missing VRP receives zero ranking contribution, not a fabricated measured VRP. Earnings-gap fallbacks occur behind availability gates; UI count defaults represent counts. Missing leg values display unavailable.
- Prior cached ranking wording was corrected as part of finding 4. Observation/cache diagnostics distinguish retained data from the latest refresh.

Equity physical-settlement and index cash-settlement descriptions were cross-checked with [NSE individual-security specifications](https://www.nseindia.com/static/products-services/equity-derivatives-individual-securities) and [NSE settlement information](https://www.nseindia.com/static/products-services/equity-derivatives-settlement-mechanism). Provider response fields were reviewed against [Upstox option-chain documentation](https://upstox.com/developer/api-documentation/get-pc-option-chain/) and [option-Greek documentation](https://upstox.com/developer/api-documentation/option-greek/). These references do not certify a particular live payload or future settlement rule.

## E. LIVE PROVIDER VALIDATION

**UNVERIFIED** — fresh authenticated history/option-chain scans for low-, medium-, high-priced equities, NIFTY and BANKNIFTY.

**PASS** — unauthenticated public-master fetch on 15 October, including representative equity/index identities and listed expiries.

No running service listeners were found on the configured development ports (5173, 5000, 8000) during the audit or the resumption check. The inspected Node implementation holds Upstox sessions in memory; no existing authenticated service session was available to reuse. No credentials were requested. Archived 13 October responses provide replay evidence across low-priced NMDC/CANBK, NTPC, high-priced TATAELXSI and both indices, but cannot satisfy the requested fresh authenticated test. Current prices and access were not inferred from archived observations.

## F. STRATEGY CALIBRATION

**BACKTEST REQUIRED** — profitability, threshold suitability, stability of ranking, probability calibration, event adjustments, execution-cost sensitivity and out-of-sample performance.

Arithmetic agreement does not establish predictive accuracy. Negative model scores and zero-opportunity scans are valid outcomes. No strategy parameters were tuned to obtain candidates, and no genuine research uncertainty was classified as a software defect.

## G. EXECUTION / REAL-MONEY READINESS

**UNVERIFIED** — broker margin, realizable fills, slippage, fees/taxes, exercise/assignment obligations, operational resilience and production trading readiness. Payoff maximum loss is not broker margin or an all-inclusive risk estimate.

**PASS** — inspected Spread workflow remains read-only. Its market-data transport uses allowed GET endpoints. OAuth token exchange and local disconnect are session operations, not order submissions. No hidden order/execution path was found in the inspected Spread path. Mock order logs in unrelated Node tests are not broker submissions.

Explicit audit confirmations:

- Strategy formulas unchanged.
- Thresholds unchanged; isolated adversarial test inputs did not change defaults.
- Angel One production code unchanged by this audit.
- Upstox remains read-only in the Spread workflow.
- **ZERO Upstox orders submitted by this audit.**

Release distinction: **PASS** for the tested software/read-only research behavior; **UNVERIFIED** for fresh authenticated end-to-end acceptance and real-money execution readiness; **BACKTEST REQUIRED** for strategy calibration.
