# NSE market-structure adaptation — implementation and validation

13 October 2026. Read [Phase A parameter classification](SPREADS_NSE_PARAMETER_AUDIT.md) for the complete original-value/unit/classification/evidence/action table.

## Profiles and scope

| Profile | Behavior |
|---|---|
| ORIGINAL_ZIP_BASELINE (default) | Existing original ScanParams defaults, fixed price-point width, original strict credit >0.01 gate, same calculation definitions, rounding, funnel and stable descending rounded EV ordering. Uses the already integrated provider, including corrected OI contracts; does not reintroduce Yahoo US price/volume universe acquisition. |
| NSE_RESEARCH_V1 (explicit opt-in) | User selects actual listed hedge steps, default1. Same-expiry/same-option-type hedge is selected from authoritative contract strikes in the original risk-defined direction. No skipped missing quotes or manufactured strikes. Positive midpoint-credit floor derives from verified leg quote ticks. All other strategy thresholds/math/ranking unchanged. |

Width steps1-50 is an input safety bound, not an NSE profitability fit. One step defines the smallest adjacent listed hedge; its desirability as a strategy parameter still requires backtesting. Nonuniform ladders are supported: actual width is the selected leg strike distance, and displayed interval is the first local adjacent-strike gap, not a claimed global constant.

## US assumptions found and actions

- Price width5, minimum credit0.01, payoff/EV100-unit convention, discovery price floor$5, and original dollar spot/width/EV/$-per-contract labels are currency/price-scale assumptions. No FX conversion was applied.
- US fixed standard multiplier is retained only as the original EV ranking convention. Actual cash amounts multiply unrounded premium and loss by verified equal leg lot sizes, never100 by assumption.
- Original active-universe acquisition used SPY/QQQ/IWM/NVDA/TSLA/MU, Yahoo most_actives/day_gainers, an emergency20 US list, universe clamp30-40, a1-5-letter ticker rule and a1,000,000-share sanity floor. Existing NSE discovery already replaced those with the authoritative full NSE F&O universe and instrument identities; this task did not change discovery formulas or invent equivalent rupee/volume filters.
- Original UI width bounds0.5-25 and API bound100 were US convenience bounds. Existing integrated fixed-points API/controls already extend to5000; this task did not silently alter those convenience bounds or the original ScanParams defaults.
- DTE30, nearest actual expiry with minimum3 days, OI100 contracts, nearest12 OTM strikes, bid/ask fraction0.10, cushion2%, RoR15%, scanner VRP1.15 and discovery VRP1.20/shock1.5 remain unchanged. Market-specific tuning requires NSE out-of-sample research.
- RV10/21/63/252, logarithmic returns, ddof1, sqrt252, breach horizon round(DTE*252/365), minimum60 observations, 3-year history/earnings gaps, minimum270 closes, midpoint, credit, max-loss, RoR, VRP, earnings penalty, EV, rounding and stable ranking remain unchanged.

## Justified adaptations and authoritative evidence

[NSE stock-option tick circular FAOP70382](https://nsearchives.nseindia.com/content/circulars/FAOP70382.pdf) establishes stock-option tick revisions and monthly review. Current tick is read from actual contract metadata, never inferred from current spot. [Upstox Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/) supplies actual keys, expiry, type, strikes, lots and ticks.

[Upstox developer confirmation](https://community.upstox.com/t/title-clarification-required-bod-json-tick-size-5-0-vs-nifty-option-price-step-0-05/17796/2) explicitly states JSON instrument and Option Contracts tick_size is in paise: tick INR = raw tick_size/100. Raw values1 and5 therefore become ₹0.01 and ₹0.05. Fixture ticks are explicitly synthetic rupee values, never inferred by magnitude.

For ticks ts and tl, each midpoint is a half-tick grid value, so the difference has positive quantum gcd(ts,tl)/2. NSE_RESEARCH_V1 requires credit at least that quantum, retains credit<actual width, and rejects off-grid bid/ask data. This quantum is a mathematical inference about the unchanged midpoint estimator, NOT a published exchange minimum executable spread credit, cost allowance or economic profitability requirement. Missing/conflicting ticks or incompatible leg lots are rejected with explicit diagnostic reasons. No threshold was selected to improve opportunity counts.

## Live validation

Two read-only scans used existing Upstox authentication after the user restarted Python. Both processed BANKNIFTY, CANBK, NIFTY, NMDC, NTPC and TATAELXSI successfully: six scanned, zero unavailable. No fixtures/mock/fallback market prices were used. The second scan may reuse existing provider transport caching; these are not synchronized exchange snapshots or execution guarantees.

| Stage | Baseline | NSE research / one listed step |
|---|---:|---:|
|considered|141|141|
|cushion|87|87|
|friction|2|1|
|paired|2|1|
|ror|2|1|
|vrp|2|0|
|final|2|0|

Baseline runtime 11.8 seconds; native runtime 1.3 seconds. Do not interpret the runtime difference as a benchmark: cache/capture/oracle work differs.

Baseline source oracle replay: all six successful scans, aggregate funnel and final combined ranking match exactly; replay issues are empty. Its two retained negative-EV candidates are NMDC75/80 and CANBK125/130. NSE one-step profile produced no final candidate. One BANKNIFTY pair passed liquidity and RoR and failed original VRP1.15. No threshold was relaxed or hedge step adjusted to manufacture results.

## Actual NSE structure and numerical examples

The following are independently calculated examples on ACTUAL captured quotes, including REJECTED pairs. They are not accepted scanner recommendations. Arithmetic after the first failing gate is shown for audit only; production still stops at its gate. The diagnostic example selection shows a pair reaching the most gates for each instrument; it is not a strategy or ranking change. Full instrument keys, bid/ask, raw quantity OI, lot, normalized OI, IV and intermediate precision are in the [example evidence](tmp/spread-audit/nse-representative-examples.json).

| Underlying | Spot / historical close | Expiry | Actual pair | Listed step width | Lot | Tick INR | First rejection |
|---|---:|---|---|---:|---:|---|---|
|BANKNIFTY|54918.0|2026-11-23|CE 56100.0/56200.0|100.0|30|[0.05, 0.05]|VRP: unchanged threshold|
|CANBK|118.38|2026-11-23|PE 110.0/109.0|1.0|6750|[0.01, 0.01]|long friction: bid/ask fraction > 0.10|
|NIFTY|22363.35|2026-11-09|CE 22900.0/22950.0|50.0|65|[0.05, 0.05]|long friction: contract OI < 100|
|NMDC|70.34|2026-11-23|CE 75.0/76.0|1.0|6750|[0.01, 0.01]|long friction: bid/ask fraction > 0.10|
|NTPC|310.0|2026-11-23|CE 320.0/322.5|2.5|1500|[0.05, 0.05]|long friction: bid/ask fraction > 0.10|
|TATAELXSI|3257.0|2026-11-23|PE 3000.0/2950.0|50.0|125|[0.05, 0.05]|long friction: bid/ask fraction > 0.10|

The original fixed5-point mode cannot pair index or high-stock strikes separated by50/100 points just by assuming a hedge at short±5. Native selection follows the actual listing. Conversely, an adjacent stock hedge can be less liquid than a farther fixed5-point hedge; a smaller native width is not automatically a better opportunity.

| Underlying | Credit INR/unit | Credit INR/lot | Max loss INR/lot | Cushion % | RoR % | RV21 decimal | IV decimal | VRP |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|BANKNIFTY|62.400000|1872.00|1128.00|2.152300|165.957447|0.14456819|0.13500000|0.93381537|
|CANBK|0.330000|2227.50|4522.50|7.078898|49.253731|0.20019208|0.31250000|1.56100084|
|NIFTY|27.075000|1759.88|1490.12|2.399685|118.102508|0.13508547|0.12900000|0.95495098|
|NMDC|0.335000|2261.25|4488.75|6.624964|50.375940|0.24711853|0.30270000|1.22491824|
|NTPC|0.775000|1162.50|2587.50|3.225806|44.927536|0.18281749|0.18800000|1.02834801|
|TATAELXSI|5.925000|740.63|5509.38|7.890697|13.442995|0.32497146|0.38640000|1.18902748|

| Underlying | Raw breach | Earnings-adjusted breach | Original EV100-unit unrounded | Actual EV INR/lot | Short quantity / lot = contracts | Long quantity / lot = contracts |
|---|---:|---:|---:|---|---|
|BANKNIFTY|0.38601399|0.38601399|2379.860140|713.96|10950.0/30=365|13620.0/30=454|
|CANBK|0.14965035|0.26162750|6.837250|461.51|810000.0/6750=120|0.0/6750=0|
|NIFTY|0.25690608|0.25690608|1422.969613|924.93|10920.0/65=168|5330.0/65=82|
|NMDC|0.28251748|0.48076670|-14.576670|-983.93|810000.0/6750=120|0.0/6750=0|
|NTPC|0.39440559|0.77509001|-116.272502|-1744.09|226500.0/1500=151|1500.0/1500=1|
|TATAELXSI|0.30069930|0.30069930|-910.996503|-1138.75|17875.0/125=143|125.0/125=1|

Monetary definitions: credit_per_lot = unrounded(short midpoint−long midpoint) × actual lot; max_loss_per_lot = (actual width−unrounded credit) × actual lot; per-lot EV uses the same original probability/payoff arithmetic multiplied by actual lot. Candidate credit/EV source fields retain original rounding; additive unrounded credit is displayed with INR precision. Native results expose lot, actual width, local interval and INR per-lot money. Original EV is explicitly labeled a100-unit ranking score, not actual contract rupees.

## What remains unresolved / requires research

- **Adjusted history remains FAIL for sampled Yahoo-adjusted equivalence / UNVERIFIED for complete current corporate-action semantics.** No history provider change, correction factors, synthetic closes or threshold compensation was added. Native UI displays this prominently. Universal calculations on non-equivalent history do not prove original-model economic validity.
- Full NSE session-calendar coverage, source quote timestamps and independent earnings-source accuracy remain existing data-validation limitations. No warning was removed to make a scan appear verified.
- Economic minimum-credit policy, transaction costs/taxes/slippage, appropriate DTE/hedge step/OI/VRP/RoR/cushion/friction/max-strike settings, stock-vs-index performance and settlement/margin effects require historical NSE backtesting and out-of-sample validation. No tuning occurred.
- The original EV is a simplified breach/max-loss score. This task does not add a new payoff/settlement/exercise/cost model or claim profitability from the two live scans.

## Files modified in this task

| File | Why |
|---|---|
| angel-one/app/services/spreads/nse_calculations.py (new) | Separate listed-strike/tick resolver and NSE build loop; direct original helpers and unchanged universal arithmetic expressions. |
| angel-one/app/services/spreads/engine.py | Two-line optional builder hook; default still calls original build_spreads. No original calculation function modified. |
| angel-one/app/services/spreads/api.py | Validated explicit profile/steps, native builder wiring, profile/result metadata, actual unrounded INR premium field and native validation reasons. |
| angel-one/app/services/spreads/scan_audit.py | Keep baseline oracle replay; explicitly label native profile adaptation rather than falsely claiming original candidate parity. |
| algo-trading/src/pages/SpreadsPage/SpreadsPage.tsx | Opt-in profile/steps controls, captured-result profile badge, INR actual-lot columns and precise premium, index-point labels, unresolved-history banner and collapsed validation notes. |
| algo-trading/src/pages/SpreadsPage/DiscoveryPanel.tsx | Spot unit header only; no discovery computation/selection change. |
| angel-one/tests/test_spread_nse_profile.py (new) |27 tests: listed grids/directions/missing quote/no skipping/ticks/invalid metadata/identity/universal-expression AST equality/10 oracle-agreeing datasets/native tiny-credit boundary/negative EV/API/money checks. |
| angel-one/tests/test_spread_audit_regressions.py | Exclude new non-ScanParams profile fields when constructing the original ScanParams in an existing regression test. Intended behavior unchanged. |
| algo-trading/src/pages/SpreadsPage/SpreadsPage.test.tsx | Opt-in payload/no threshold mutation plus native INR/profile/lot/width presentation checks. |
| SPREADS_NSE_PARAMETER_AUDIT.md; this report; tmp/spread-audit captures/examples | Parameter classification, authoritative evidence and live verification artifacts. |

No Node/Angel One/order-execution module changed. Existing OI normalization and raw diagnostics were not changed in this task. No new permanent service/database/queue. React5173 → Node5000 → existing Python8000 remains intact.

## Verification

- Full Python: **224 passed**,6 existing dependency/deprecation warnings. Original ZIP AST/oracle/parity and NSE-specific tests included.
- Full Node: **233 passed** with test-file concurrency1. Initial default concurrent run had232 pass/1 failure in the existing ready-feed recovery timing test, which waits40ms for a restored monitor callback. Isolated recovery suite then passed25/25; full serialized suite passed233/233. No Node logic/test/timer behavior was modified to obtain a pass.
- Full frontend: **70 passed** across12 files.
- Production frontend build: passed; existing large-chunk warning.
- Original calculation file SHA256 remains **bf9b30eb93fb82f17e16e79ed4be58cb929ffdab82a1d218bf3eeaf911da551c**; original uploaded scanner SHA256 remains **6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa**.

Evidence: [baseline live batch](tmp/spread-audit/batch-86c96a05-c13f-4166-9a3b-d1a26dfec2cd.json), [native live batch](tmp/spread-audit/batch-98083cd6-a4f1-4693-a15f-df06ce8b314e.json), [actual quote arithmetic](tmp/spread-audit/nse-representative-examples.json), [full serialized Node output](tmp/nse-node-full-serial.log).

Original ZIP universal definitions/configuration retained. Adjusted-history issue not hidden by tuning. Angel One unchanged. ZERO Upstox orders placed.