# B1–B8 correctness and reporting fixes

14 October 2026. Only the eight confirmed audit fixes were implemented in this task. Pre-existing working-tree changes from earlier tasks remain separate. No strategy tuning/backtesting was implemented.

## Fix results

| Bug | Root cause / old behavior | New behavior | Files changed for fix | Regression / result |
|---|---|---|---|---|
| B1 history validity | Eligibility counted non-null closes even when structural diagnostics proved duplicate/invalid/skipped/session-defective observations. | History marked `incomplete` is ineligible for scanning and discovery; exact diagnostic reason retained. `unverified` calendar coverage is not falsely certified or automatically treated as a known defect. No filling/deduplication/factor changes. | `provider.py`, `engine.py`, `discovery_adapter.py` | `test_b1_known_defective_history_is_not_eligible`: failed before, PASS after. Existing history tests exercise actual duplicates, invalid OHLCV and confirmed calendar defects. |
| B2 missing VRP rank | Ascending percentile ranking with NA at bottom rewarded unknown VRP with a high contribution. | Only measured VRP participates in that percentile distribution. Missing VRP contribution is zero; value/status remains unavailable and EDGE false on missing required measurement. Shock contribution, weights and EDGE thresholds unchanged. | `engine.py` | `test_b2_missing_vrp_receives_no_measured_percentile_reward`: HIGH2.0, LOW1.0, MISSINGnull now order HIGH/LOW/MISSING for equal shock. Failed before, PASS after. |
| B3 listed hedge grid | Invalid/missing lot contract rows were dropped before forming the strike grid. | Listed contracts remain in the grid with unavailable lot metadata. A selected invalid hedge is rejected; the grid is not compressed. Valid OI mapping still requires an authoritative positive integer lot. | `provider.py`, `upstox_adapter.py`, `nse_calculations.py` | Four `test_b3_invalid_intermediate_lot_does_not_compress_grid` cases cover both directions and1/2 steps. Old implementation failed; PASS after. 1 step selects/rejects105,2 steps can legitimately select100↔110. |
| B4 stale identity | Snapshot date was stored but ignored. | Current-day retained identity is reused. Stale identity requires a current authoritative master; missing/ambiguous replacement fails explicitly. No guessed replacement. Loader results also require a current snapshot date. | `instruments.py` | `test_b4_stale_identity_refreshes_exact_authoritative_key`: old key replaced only by current exact master key. Failed before, PASS after. Existing identity/API tests now use current declared snapshot date instead of a stale fixed date. |
| B5 refresh truth | Failed/empty refresh retained prior complete stats and lacked a distinct latest attempt. | Latest attempt exposes SUCCESS/PARTIAL/EMPTY/FAILED, time, counts/errors. Only SUCCESS has completion true. Previous successful ranking/time/counts are retained separately, with explicit cached-previous label when served after failure/empty. Partial new rows are labelled PARTIAL. | `discovery_cache.py`, `DiscoveryPanel.tsx` | Empty, failed and partial cache tests PASS; frontend failed-cache label test PASS. Old-source memory replay confirms empty refresh left complete=true and no latest_attempt. |
| B6 precise credit | UI displayed precise credit but view filter/sort used rounded credit. | Shared `preciseCredit` accessor drives display, credit view filtering and user-selected credit sorting, with the same six-decimal presentation precision. Default server EV ordering untouched. | `viewFilters.ts`, `SpreadsPage.tsx` | View test .005 displayed/.006 minimum excludes row; explicit precise-credit sort agrees. Failed before, PASS after. |
| B7 missing OI | Missing count was coerced to known zero before friction, passing min_oi0. | Missing/invalid OI retains an explicit `oi_available=false` mask and an internal invalid-count sentinel−1 for the untouched integer friction gate. This sentinel is not market data or an estimated count; every supported OI threshold is nonnegative, so it cannot pass. Reported zero remains0 and can pass min_oi0. Rows remain available for ATM-IV discovery, which does not require OI. Raw quantity/lot diagnostics remain unchanged. | `engine.py` | `test_b7_missing_oi_is_not_zero_and_cannot_pass_zero_threshold`: missing fails, actual0 passes. Failed before, PASS after. Existing valid quantity/lot tests unchanged and passing. |
| B8 OI warning | Aggregate invalid mapping emitted outdated “reported OI directly” text. | Warning describes quantity divided by matched lot into contract-count OI and states invalid/missing mappings are unavailable. Genuine warning remains. | `engine.py` | `test_b8_oi_warning_describes_normalized_contracts_and_missing_mapping`: old text absent, truthful warning present. Failed before, PASS after. |

### Regression evidence

`tmp/b1-b8-before-python.log` records9 failures in the initial new regression run against old behavior; B5 was initially skipped due to the absent asyncio pytest plugin. The B5 test was corrected to run its memory-only coroutine without installing a dependency. An independent replay of the old committed cache source then reproduced B5's false complete=true state; this is recorded in `tmp/spread-audit/b1-b8-before-after.json`. Do not interpret the skipped initial B5 test as an old-behavior failure.

`tmp/b1-b8-before-ui.log` records the old precise-credit filtering failure. New regression tests now run without skips. Existing tests whose assertions deliberately described old bugs were updated to the approved requirements, not worked around in production to preserve wrong behavior.

One old discovery test used impossible OHLC (Close above High); its synthetic candle High was corrected so its normal-history assertion tests valid data. Its separate malformed/out-of-range case now expects rejection. Source-reference missing-IV score assertions explicitly account for B2; source files/formulas are not rewritten to change the oracle.

## Full tests and build

| Suite | Result |
|---|---|
| Complete Python |260 passed,0 failed,0 skipped;6 existing dependency/deprecation warnings |
| Complete Node |233 passed,0 failed; serialized test-file concurrency |
| Complete frontend |73 passed across12 files |
| Production frontend build |PASS; existing large-chunk warning |
| Diff whitespace check |PASS |

Logs: `tmp/b1-b8-python-full.log`, `tmp/b1-b8-node-full.log`, `tmp/b1-b8-frontend-full.log`, `tmp/b1-b8-build.log`.

## Before/after discovery behavior

- Equal shock / HIGH VRP2.0 / LOW VRP1.0 / MISSINGnull: formerly missing received a superior percentile contribution; now measured values rank HIGH then LOW and missing receives no VRP contribution. It can still receive its actual shock contribution; weights are not changed and high shock can legitimately affect ordering.
- Old successful ranking followed by an empty/failed attempt: useful ranking is retained, but latest outcome/counts no longer inherit completion=true. UI explicitly identifies previous cached ranking.
- Known defective history no longer counts as eligible input. This can reduce ranked names; it is correction of input validity, not a lower threshold or fabricated replacement.

## Before/after funnel evidence

Existing 13 October provider captures were replayed on current code, **not fetched again**. Neither captured valid-data funnel changed:

| Profile | Before considered/cushion/friction/paired/RoR/VRP/final | After | Final opportunities |
|---|---|---|---:|
| ORIGINAL_ZIP_BASELINE |141/87/2/2/2/2/2|141/87/2/2/2/2/2|2 |
| NSE_RESEARCH_V1,1 listed step |141/87/1/1/1/0/0|141/87/1/1/1/0/0|0 |

Evidence: `tmp/spread-audit/b1-b8-before-after.json`. Known-defect cases can now fail earlier or select the correctly requested unavailable hedge; no claim is made that all future live funnels will stay identical. No opportunity target was used to determine behavior.

## Live validation attempt

After regressions passed, the existing frontend/Node/Python services were started at5173/5000/8000 without code/configuration changes. Browser app login was active and the Spreads page loaded. It displayed **Upstox not connected**; discovery and scan buttons were disabled. No existing Upstox session was available and no credential was requested/exposed.

| Requested live field | Observed result |
|---|---|
| React → Node app session |Authenticated page loaded |
| Upstox connection |Not connected |
| Discovery status / eligible / ranked |UNVERIFIED; discovery not run |
| Scan selection |Default NIFTY visible; no scan submitted |
| Scanned / unavailable / funnel / final opportunities |UNVERIFIED; no current live result |
| Provider/data warnings |Connection unavailable; no newly fetched market data |
| Profile shown |ORIGINAL_ZIP_BASELINE default; no profile scan executed |

This is **not** a successful live Upstox validation. Zero native opportunities in archived replay are not treated as failure. Temporary service listeners started for this check were stopped afterward so they do not conflict with manual startup; no listener remained on5173/5000/8000. No authentication system or saved credential was changed.

## Remaining UNVERIFIED / NEEDS BACKTESTING

UNVERIFIED: fresh authenticated end-to-end Upstox scan; completed-session calendar for the whole lookback; current-day finality; corporate-action price/volume semantics; quote timestamps/time alignment; earnings source/time/coverage; costs/margin/physical-delivery implications; external/multiworker quota traffic. B1 blocks known defects and does not certify unknown completeness.

NEEDS BACKTESTING: NSE DTE/steps/width/OI/friction/cushion/RoR/VRP/candidate-depth settings; earnings-penalty calibration; approximate session horizon and probability calibration; simplified EV versus realized payoff and costs. None was tuned.

## Files modified in this task

Production:

- `angel-one/app/services/spreads/provider.py`: known-defect history eligibility and nullable contract lot metadata.
- `engine.py`: B1 blockers, B2 measured-only percentile, B7 unavailable mask/sentinel, B8 warning.
- `discovery_adapter.py`: reject known-defective discovery history.
- `upstox_adapter.py`: retain listed contract positions despite unusable lot metadata.
- `nse_calculations.py`: explicitly reject a selected leg whose retained lot is unavailable; no arithmetic change.
- `instruments.py`: date-enforced retained identities and authoritative revalidation.
- `discovery_cache.py`: separate latest attempt and last successful result metadata/content.
- `algo-trading/src/pages/SpreadsPage/viewFilters.ts`: shared precise-credit accessor/filter/sort.
- `SpreadsPage.tsx`: use precise accessor for credit display/breakdown.
- `DiscoveryPanel.tsx`: explicit latest attempt status and previous-ranking label.

Tests/evidence:

- New `angel-one/tests/test_spread_b1_b8.py`: B1/B2/B3/B4/B5/B7/B8 regressions.
- `test_spread_audit_regressions.py`: truthful OI warning and current-date identity fixtures.
- `test_spread_discovery_adapter.py`: valid OHLC fixture and explicit known-defect rejection assertions.
- `test_spread_discovery_baseline.py`: account for approved B2 missingness correction while retaining metric/reference checks.
- `algo-trading/src/pages/SpreadsPage/viewFilters.test.ts`: B6 exact precision/filter/sort regression.
- `SpreadsPage.test.tsx`: B5 failed-refresh UI regression.
- This report, before/after JSON and task logs under `tmp/`.

No Node implementation or Angel One implementation changed in this task. Earlier Node/provider/quota changes visible in the working tree are pre-existing; they were not reverted or expanded here.

## Confirmations

- No DTE, VRP, OI, bid/ask, cushion, RoR or other strategy threshold was tuned.
- RV, probability, credit, RoR, EV and earnings-penalty formulas were not changed. `original_calculations.py` is untouched. B2 corrects missing-data percentile handling without changing the score objective/weights.
- NSE_RESEARCH_V1 still selects actual listed steps in the same risk-defined directions; B3 preserves that concept in defective-metadata cases.
- Valid Upstox OI quantity/lot normalization and endpoint-specific IV normalization were not redesigned.
- Architecture and Angel One were untouched.
- ZERO Upstox orders were placed.
