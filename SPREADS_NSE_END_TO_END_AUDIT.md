# Spread Terminal — NSE end-to-end audit

14 October 2026. **Audit and testing only. No production code, strategy behavior, parameters, dependencies or environment configuration changed during this pass.** Earlier working-tree changes were present at the start and were not reverted. The uploaded ZIP is a reference for strategy intent, not an NSE numerical oracle.

Status vocabulary: PASS, FAIL, PARTIAL, UNVERIFIED, NEEDS BACKTESTING. PASS is scoped to the evidence explicitly stated below; it does not imply production readiness.

## 1. Executive verdict

**PARTIAL. The current NSE research profile implements the core credit-spread concept coherently on valid inputs, but the complete workflow cannot yet be certified as correct for all NSE data conditions or production use.**

- PASS: market-independent arithmetic, directional listed hedges, correctly normalized OI on valid metadata, separate discovery/short-leg VRP, actual-lot premium and loss, and retained negative-EV ranking in the tested cases.
- FAIL: eight confirmed correctness/reporting defects detailed in section 26. They include malformed contract metadata changing what “one listed step” means, missing IV receiving a high ranking contribution, and known defective history remaining eligible.
- UNVERIFIED: a fresh authenticated raw-provider → Node → rendered-browser run, full session completeness, corporate-action treatment, quote freshness, earnings identity/timing/coverage and operational settlement assumptions.
- NEEDS BACKTESTING: economic thresholds and the statistical usefulness of the simplified EV score for NSE. No threshold tuning was performed.

**This is not a production-ready verdict.** Arithmetic correctness does not establish valid inputs, calibrated probabilities, executable credit or acceptable delivery/margin risk.

### Evidence boundaries

The in-app browser had no open authenticated tab. A direct attempt to open `http://localhost:5173/spreads` failed with `ERR_CONNECTION_REFUSED`. No service was started or restarted and no credentials were retrieved. Fresh live tests are therefore UNVERIFIED.

Two existing 13 October captures were replayed independently: six-underlying baseline and six-underlying NSE_RESEARCH_V1 scans. These are archived Upstox-path evidence, **not newly fetched quotes**. Synthetic diagnostic inputs reproduced edge-case defects; they are explicitly not market observations.

Evidence artifacts:

- [Independent arithmetic, every archived rejection, funnels and reproductions](tmp/spread-audit/nse-e2e-independent-evidence.json)
- [Archived raw legs, contracts and API candidate trace](tmp/spread-audit/nse-e2e-archived-raw-trace.json)
- [Actual view-helper precision reproduction](tmp/spread-audit/nse-e2e-ui-evidence.json)
- [Assumption occurrence inventory](tmp/spread-audit/nse-e2e-assumption-occurrences.json)
- Reproducible audit-only programs: `tmp/spread-audit/nse_e2e_diagnostics.py` and `nse_e2e_ui_diagnostics.cjs`.

## 2. Complete architecture and workflow traced

`SpreadsPage.tsx` / `DiscoveryPanel.tsx` → shared `trading/api.ts` → `/api/v1/spreads` in `backend/index.js` → authenticated `spreadRoutes.js` → `spreadController.js` → `spreadsPythonService.js` → existing `app.main:app` / `/spreads` router → provider → discovery or scanner → Python JSON → Node JSON → React result state → results/filter/breakdown components.

Expected deployment remains React 5173 → Node 5000 → Python 8000. MongoDB remains existing application infrastructure. Upstox is read-only; earnings dates come from the supplemental Yahoo source. No new queue, database or service is involved. The scanner itself makes no order request.

Connection path: Connect button → Node OAuth authorization URL → existing user-bound state → callback/token exchange → server-held session → Python request header. App login and Upstox connection are distinct; provider 401 is translated by Spread handling so it does not automatically become an app-login failure. Existing session-isolation tests pass.

Discovery and scanning are separate actions. Selection/expiry loading does not place orders or invoke a spread scan. The current selection limit is 50, not 10/20; the universe size is dynamic.

## 3. US reference intent versus current NSE workflow

| Strategy step | Reference intent | Current NSE interpretation | Verdict |
|---|---|---|---|
| Find candidates | Active liquid US symbols, volume shock and IV/RV | Actual NSE option-underlying master; full-universe IV attempts | PASS sourcing concept; ranking defect B2 |
| Estimate realized risk | Daily log returns and historical forward moves | Same market-independent arithmetic on Upstox history | PASS arithmetic; input quality PARTIAL |
| Select expiry | Listed expiry near a desired holding period | Actual provider dates, sorted, nearest calendar DTE | PASS selection; calendars UNVERIFIED |
| Construct credit spread | Sell OTM premium and buy a farther protective leg | Native profile uses actual CE/PE listing steps | PASS valid metadata; defect B3 |
| Screen liquidity | Positive tradable quotes, spread fraction and OI | Bid/ask midpoint; quantity OI divided by actual lot | PASS units; missing-data defect B7 |
| Adjust event risk | Penalize imminent earnings using historical gaps | Yahoo NSE dates with Upstox closes | PARTIAL coverage/timing |
| Compare opportunities | Risk/reward, VRP and a breach-based score | Same concepts, INR per lot shown separately | PASS arithmetic; NEEDS BACKTESTING economics |

`ORIGINAL_ZIP_BASELINE` is still the default profile; `NSE_RESEARCH_V1` is explicit opt-in. Fixed width 5 and strict credit >0.01 remain in the compatibility profile. They are not evidence of suitable NSE defaults. The native profile avoids those fixed-width assumptions. Making native the default is a product/research decision, not a reason to rewrite universal mathematics during this audit.

## 4. Underlying discovery

`universe.py` downloads the official NSE JSON BOD master, selects non-expired NSE_FO CE/PE contracts, groups by underlying key/symbol, preserves INDEX/EQUITY identity, rejects malformed lots and ambiguous symbols, and returns actual listed expiries. It uses instrument keys rather than reused exchange tokens. No 219-name constant is present in the operational universe loop. [Upstox instruments documentation](https://upstox.com/developer/api-documentation/instruments/)

`discovery_adapter.py` requests four months of daily OHLCV, requires 30 history rows and 22 non-missing closes/volumes, and chooses a listed expiry near 14 days. `discover()` attempts history and IV for every universe entry, including an IV-stage terminal result for history-failed names; only history-eligible names appear in the ranked table. Tests cover dynamic counts 13, 23 and 219 and isolated failures.

Volume shock = latest volume / mean of the preceding 20 volume observations. Daily change = last close / preceding close − 1. Discovery RV21 uses the last 21 log returns. Invalid/missing prices and volumes are currently dropped independently, so the effective last volume date need not match the last close date; session alignment is UNVERIFIED. Index volume is not replaced with futures volume. A zero/unsupported index volume is not proof of zero market activity.

Discovery uses median IV from up to three nearest positive-IV, clean-quote rows on each side; then ATM IV/RV21. EDGE requires both VRP >1.20 and shock >1.5. SCORE sums percentile ranks of VRP and shock; ranking sorts EDGE then SCORE, then displays rounded score. **B2: unavailable VRP is ranked at the high end by `na_option='bottom'` with ascending percentile ranking.**

Identity/date handling has defect B4. Empty/failed refresh reporting has defect B5. Full-universe fresh live counts/runtime are UNVERIFIED this pass.

## 5. Historical market data and corporate actions

Raw V3 candle slots 0..6 map to timestamp, Open, High, Low, Close, volume and optional historical OI. Values are parsed as finite numbers; dates become timezone-aware. Bars are sorted ascending. Discovery uses four months; spread scanning uses three years and at least 270 non-null close rows. V3 daily retrieval supports that range; the API schema alone does not certify adjustment or completeness. [Historical Candle V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/)

The shared validator reports duplicates, malformed/skipped rows, invalid OHLCV, ordering, range errors and missing/unexpected sessions when given a complete calendar. The live adapters do **not** supply that calendar. No actual missing-session dates can currently be certified. Requests include today; there is no verified completed-session cutoff. Duplicates and invalid OHLCV are diagnosed but not blocked by the scanner eligibility check: B1.

**Appropriate NSE treatment is not “blindly reproduce Yahoo auto_adjust=True.”** Splits/bonuses/consolidations must not appear as economic crashes in a return series. Historical volume must also be consistently interpreted across share changes. Raw closes, explicit corporate-action events and derived analysis series should remain distinguishable.

Ordinary dividends, extraordinary dividends, rights and mergers require separate consideration. NSE Clearing adjusts strikes/lots for specified actions; ordinary dividend treatment is not identical to a total-return chart. For a price-strike breach model, a dividend-adjusted total-return series cannot automatically be treated as the future spot-price distribution. Upcoming dividends and contract adjustments must be considered consistently. This is a model/data-policy recommendation, not an implemented change. [NSE Clearing corporate-action methodology](https://www.nseclearing.in/clearing-settlement/equity-derivatives/corporate-actions-adjustment)

Current code has no event/factor adjustment pipeline and no verified provider adjustment specification. **UNVERIFIED**, not “definitely raw” or “must match Yahoo.” Existing UI language treating Yahoo equivalence as the objective needs revision after an NSE price-series policy is agreed; that wording is not proof of a numerical defect.

## 6. Scanner spot price

`engine.scan_provider_data()` removes null closes and uses `float(closes[-1])`. `OptionChain.spot` comes from `underlying_spot_price` but is not the scanner anchor. No standalone underlying LTP request supplies scanner spot.

| Archived stock | History anchor | Chain spot | Consequence |
|---|---:|---:|---|
| CANBK |118.38|120.44|125 short call cushion is computed against 118.38, not 120.44 |
| NMDC |70.34|71.34|75 short call cushion is computed against 70.34, not 71.34 |

OTM eligibility, nearest short candidates, cushion, discovery ATM proximity and the historical threshold all use the history anchor. This is internally coherent for a daily-close research model with suitable quote timing. For an intraday/current-market model, a synchronized current underlying spot should anchor OTM/cushion while completed history supplies RV/probability. Changing spot alone without defining observation times would not resolve the problem. **PARTIAL / UNVERIFIED time alignment**, not an automatic instruction to replace spot because the reference did so.

## 7. Realized volatility

Independent calculation uses `log(C[t]/C[t−1])`, sample standard deviation with n−1 denominator, last 10/21/63/252 returns and √252 annualization. It does not call the production RV helper to produce expected values. All four windows agree on the archived six-underlying inputs within floating-point tolerance.

| Archived stock | RV10 | RV21 | RV63 | RV252 |
|---|---:|---:|---:|---:|
| CANBK |0.23544839|0.20019208|0.19261378|0.28637632|
| NMDC |0.25230933|0.24711853|0.22871374|0.28748061|

Decimals are annualized volatility: CANBK RV21 is approximately 20.0192%. Discovery renders percentages; breakdown layers render decimal values. No factor-of-100 discrepancy was found in these paths. **PASS arithmetic.** √252 is a conventional approximation, not a US-only currency constant. Exact session count, history continuity and empirical calibration remain separate questions.

## 8. Expiry selection

Requested DTE → authoritative option contracts → unique ISO expiry dates sorted ascending → valid dates at least three calendar days ahead → minimum absolute difference from target → actual DTE. Earlier expiry wins an equal-distance tie because call sites sort first. Explicit expiry overrides must be listed and at least three days away.

This supports weekly/monthly/index/stock dates without assuming a particular weekday. Holiday-adjusted dates should be accepted from the actual listing, not manufactured from a Tuesday/Thursday rule. [Current NSE contract specifications](https://www.nseindia.com/static/products-services/equity-derivatives-contract-specifications)

Archived CANBK target 30 chose actual DTE 41; this is not inherently an expiry bug. Tests verify tie/minimum rules. **PASS selection code; UNVERIFIED fresh current listings and exchange-calendar reconciliation.** Minimum three days and desired holding periods are research parameters.

## 9. Option-chain field trace

| Field | Raw → normalized | Scanner/API/UI usage | Status |
|---|---|---|---|
| Underlying key | master/search key; response conflict checks | contract resolution; API instrument_key | PASS code; stale cache B4 |
| Option key | call_options/put_options.instrument_key | exact leg attribution; API keys; breakdown | PASS valid metadata |
| CE/PE | response side + contract instrument_type | Bear Call / Bull Put | PASS |
| Strike/expiry | strike_price / expiry / contracts | listed grid, width, expiry and DTE | PASS; malformed-grid B3 |
| Bid/ask | market_data.bid_price/ask_price → finite floats | midpoint, friction, credit; raw quote not directly in results table | PASS valid quotes |
| Midpoint | arithmetic mean, no LTP substitute | gross premium estimate | PASS estimate; execution UNVERIFIED |
| LTP | market_data.ltp exists in raw response | not retained in OptionQuote; not used for scanner pricing | PARTIAL diagnostic coverage, not an arithmetic bug |
| Volume | option volume parsed as non-negative integer | retained on quote; discovery uses underlying daily volume instead | PASS distinction; source units/freshness UNVERIFIED |
| OI | quantity / matched lot | contract threshold and layer l5 | PASS valid mappings; B7 missing values |
| IV | V2 percentage points /100; V3 decimal unchanged | discovery median or short-leg ratio | PASS archived/tests; live UNVERIFIED |
| Lot | exact contract metadata | actual INR cash amounts; never assumed 100 | PASS valid metadata |
| Tick | raw metadata in paise → explicit INR conversion | native quote-grid and midpoint quantum checks | PASS code/tests; live UNVERIFIED |
| Timestamp | chain has no per-leg quote timestamp in this response schema | capability says unavailable; transport response cache 120 seconds | UNVERIFIED executable freshness |

The chain and contracts endpoints expose different objects; they are joined by exact instrument identity. Neither market_data.close_price nor option LTP is the historical underlying spot. [Option Chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/), [Option Contracts](https://upstox.com/developer/api-documentation/get-option-contracts/)

## 10. IV and the two VRPs

Option Chain raw IV 31.25 → 0.3125 decimal. Existing V3 support uses its previously validated decimal convention, matched `instrument_token`, finite positive values and up to 50 keys per request. Positive chain IV remains preferred. Missing/failed values are not numerically fabricated. V3 parsing and preference/batching/failure tests pass. [V3 Option Greeks](https://upstox.com/developer/api-documentation/option-greek/)

**Discovery:** median nearest-three-positive-IV per side at the discovery expiry near 14 days, divided by RV21. **Spread:** the selected short leg's IV at the scan expiry divided by RV21. These are not interchangeable. A stock's discovery VRP does not certify every spread's VRP.

Scoped discovery fallback is tested against full fallback on relevant nearest selections. Still, median IV from sparse, potentially stale valid legs is not proof of a reliable ATM surface. Chain/fallback partial failures remain important provenance. Current UI does not render every detailed `iv_provider_errors` item even though the API exposes them: PARTIAL diagnostics.

## 11. OI normalization

The existing fix was verified, not redesigned: raw quantity / authoritative matched contract lot → integer contract OI. Missing/invalid lot, negative/missing quantity and non-integral ratios remain unusable; actual zero quantity produces actual zero contracts.

Six archived independent NSE reconciliation rows:

| Stock / CE strike | Upstox quantity | Lot | Normalized contracts | Archived NSE contracts | min_oi=100 |
|---|---:|---:|---:|---:|---|
| NMDC 75 |810000|6750|120|120|PASS |
| NMDC 80 |1019250|6750|151|151|PASS |
| CANBK 125 |1086750|6750|161|161|PASS |
| CANBK 130 |1849500|6750|274|274|PASS |
| GAIL 175 |266250|3550|75|75|FAIL |
| GAIL 180 |568000|3550|160|160|PASS |

Sources are existing `oi-comparison-{NMDC,CANBK,GAIL}.json` plus archived NSE payloads, not a fresh exchange comparison. Broader archived comparisons had 14/19, 16/21 and 13/17 matches respectively; unmatched observations are not erased or claimed proven equal. Unsynchronized observation times may contribute, but that explanation is UNVERIFIED.

The required 810000/6750=120 example and 75-contract rejection pass existing tests. Raw quantity remains diagnostic data. **PASS normalization on proven samples; UNVERIFIED fresh synchronization.** Missing OI coercion at a zero threshold is B7; misleading raw-OI warning is B8.

## 12. Strike and hedge structure

Native profile selects up to 12 nearest OTM short rows per side, then indexes actual same-expiry/type listed strikes. Bull Put steps downward; Bear Call steps upward. Two steps means two listed positions, including nonuniform spacing; no uniform 5-point assumption is made. Missing selected quote does not intentionally jump to a farther hedge. Metadata checks require compatible lots and valid ticks.

Representative archived local intervals/lots:

| Underlying | Local interval | Lot | Tick INR |
|---|---:|---:|---:|
| NMDC |1|6750|0.01 |
| CANBK |1|6750|0.01 |
| NTPC |2.5|1500|0.05 |
| TATAELXSI |50|125|0.05 |
| NIFTY |50|65|0.05 |
| BANKNIFTY |100|30|0.05 |

These are captured contract facts, not permanent constants or a claim every strike interval is uniform. Low/medium/high stocks and both indices are represented. Tests exercise one/two steps, both directions and nonuniform ladders. **PASS valid grid; FAIL B3 when the adapter silently removes a listed contract with missing lot metadata.**

## 13. Credit

Short midpoint = (bid+ask)/2; long midpoint likewise; gross credit = short midpoint−long midpoint. It must be positive and smaller than actual width. Native minimum is the positive midpoint grid quantum gcd(leg ticks)/2, with off-grid quotes rejected. This is a mathematical quote-estimator resolution, **not an exchange economic minimum credit or a transaction-cost allowance**.

Archived CANBK 125/130 CE: (3.52+3.64)/2=3.58; (2.12+2.23)/2=2.175; credit=1.405. Archived NMDC 75/80 CE: 1.67−0.695≈0.975. API rounded credit and additive precise premium are separate fields; floating-point arithmetic explains boundary rounding. UI displays the additive precise credit. **PASS arithmetic; FAIL B6 filter/sort precision mismatch.**

## 14. Liquidity/friction

Both legs must have positive midpoint, bid/ask fraction (ask−bid)/mid ≤ configured bound, sufficient normalized OI and a valid hedge. Cleaning first drops non-positive/crossed/missing bid/ask rows. Thus some malformed raw legs disappear before “considered”; zero candidates is not proof that raw data was complete.

The funnel's “friction” count is after both legs and hedge existence, not just short-leg liquidity. First failures were independently separated into cushion, short OI, short bid/ask, missing hedge, long bid/ask, long OI and subsequent gates; see section 22 and per-candidate evidence JSON. Native production snapshots do not themselves provide the complete first-failure replay, so app diagnostics are PARTIAL.

Positive/ordered quotes and identity are validity conditions; actual tick/lot/grid are NSE structural conditions; OI 100 and bid/ask fraction 0.10 are research thresholds. No threshold was lowered to manufacture opportunities. Midpoint credit is indicative: an immediately executable sell-short/buy-long estimate would use the appropriate bid/ask sides and costs, which is a separate model choice requiring approval/backtesting.

## 15. Cushion

Bull Put: (spot−short strike)/spot×100 after OTM filtering. Bear Call: (short strike−spot)/spot×100. The shared absolute-distance expression is correct because directional OTM selection occurs first.

CANBK historical spot 118.38, short CE125 → 5.59216…%, API/UI 5.59%. NMDC spot70.34, short CE75 → 6.62496…%, API/UI 6.62%. **PASS arithmetic and serialization intent.** If current-chain spot were selected instead, these values would change; that requires a consistent observation-time decision, not a threshold adjustment.

## 16. RoR

Maximum terminal payoff loss before costs = actual width−credit. RoR = credit/(width−credit)×100. Multiplying both cash amounts by the same lot does not change RoR.

CANBK: width5, credit1.405, loss3.595 → RoR39.082…%, API/UI39.1%. NMDC: width5, credit≈0.975, loss≈4.025 → RoR24.2236…%, API/UI24.2%. **PASS arithmetic.** This is return relative to payoff loss, not return on actual broker margin/capital.

## 17. Historical breach probability

Calendar DTE → n=max(1, round(DTE×252/365)) observations → forward simple returns (C[t+n]/C[t]−1)×100 → downside≤−cushion or upside≥cushion → frequency. At least 60 forward observations are required.

The archived 41-day stocks use 28 observations and 715 usable forward returns. Independent CANBK raw probability rounds to0.2979; NMDC to0.2825, matching captured API fields. **PASS arithmetic.** Duplicate/missing dates invalidate the interpretation of “28 sessions”: B1.

252/365 is an approximation, not an exact NSE holiday calculation. Current long expiry/holiday distributions and sample overlap require NSE validation. Overlapping historical windows are not independent trials. This measures endpoint short-strike breach, not pathwise touch, loss probability after credit, assignment probability or full spread payoff distribution.

## 18. Earnings

`YahooEarningsSource` normalizes symbol, appends `.NS`, asks for up to24 dates, uses calendar fallback, caches by symbol/day for900 seconds and requires historical plus upcoming evidence. It matches event dates to Upstox close dates within0..3 calendar days and uses the largest absolute close-to-close change. It does not replace missing earnings with “no earnings.” Indices use not-applicable status.

For the archived CANBK and NMDC inputs, 12 historical events each were examined. Independent event/date/close arithmetic reproduces maximum gaps5.296846…% and4.648895…% respectively. This verifies the supplied-date calculation, **not the financial-event accuracy of Yahoo dates**.

Earnings penalty when inside expiry: severity=gap/cushion; adjusted p=min(max(p×(1+severity)+max(0,severity−1)×0.10,p),0.95). The alternative no-positive-gap/cushion branch caps p×1.25+0.05. Arithmetic is PASS. `.NS` mapping, stale/missing dates, after-close/before-open timing, complete three-year coverage, and the exclusive-today rule are UNVERIFIED/NEEDS BACKTESTING for actual NSE events. Date-only extraction loses time-of-day; a same-day close can precede an after-close result announcement. No evidence justifies retuning around that limitation.

## 19. Expected value and ranking

Current score = [credit×(1−adjusted breach p)−(width−credit)×adjusted breach p]×100. Independent checks reproduce both archived candidate scores and combined order: NMDC−143 ahead of CANBK−150. Negative values are retained. API aggregation stably sorts descending rounded EV; UI keeps that order unless an explicit view sort is chosen.

**PASS this score's arithmetic; NEEDS BACKTESTING its economic interpretation.** The score assumes full credit for non-breach and full maximum loss for breach. Real terminal spreads have intermediate payoffs between strikes, break-even differs from the short strike, and fees/slippage are omitted. It is not a fully modeled expected net profit. The100 factor is an arbitrary ranking scale now explicitly labeled a100-unit score, not an actual NSE contract multiplier. Removing it would not improve the underlying model.

## 20. INR/lot monetary validation

| Archived candidate | Credit/unit | Actual lot | INR credit/lot | INR payoff max loss/lot | INR model score/lot |
|---|---:|---:|---:|---:|---:|
| CANBK125/130 CE |1.405|6750|9483.75|24266.25|−10093.69 |
| NMDC75/80 CE |≈0.975|6750|6581.25|27168.75|−9644.63 |

API money uses unrounded quote/probability inputs and matched equal leg lots. It does not multiply rounded score or rounded credit by an assumed100. Duplicate-strike ambiguity leaves money unavailable rather than assigning the last quote. **PASS tested cash arithmetic.**

“Maximum loss” here is a spread payoff bound before costs, not a certified bound on funding requirements or delivery/margin/liquidation consequences. NSE stock options are European and physically settled; index/stock settlement must be distinguished in the product's risk interpretation. [NSE individual-stock options](https://www.nseindia.com/static/products-services/equity-derivatives-individual-securities)

## 21. Parameter audit

| Parameter | Current value / unit | Purpose / US reference | Current NSE behavior | Classification | Evidence / recommendation |
|---|---|---|---|---|---|
| Strategy profile |baseline default; native opt-in|Compatibility versus market structure|Only native uses listed steps|NSE STRUCTURAL ADAPTATION|Expose deliberate profile choice; do not equate baseline parity with NSE validation |
| Target DTE |30 calendar days|Holding horizon, reference30|Nearest actual expiry; actual DTE may differ|NEEDS NSE BACKTESTING|Keep until research supports change; UI5–90, API5–180 |
| Discovery target DTE |14 calendar days|Near-term ATM risk premium|Nearest listed expiry|NEEDS NSE BACKTESTING|No US weekday assumption |
| Minimum actual DTE |3 days|Avoid immediate expiry|Both profiles|NEEDS NSE BACKTESTING|Listed dates tested; settlement/calendar consequences separate |
| Fixed width |5 price points|Reference USD/share convenience|Compatibility mode only; API>0–5000|NSE STRUCTURAL ADAPTATION|Native avoids universal fixed5; do not FX-convert |
| Listed width |1 step, input1–50|No direct US equivalent|Actual same-side hedge positions|NSE STRUCTURAL ADAPTATION|Correct valid grids; fix B3; economic step choice needs research |
| Min spread VRP |1.15 ratio|IV versus RV richness|Short-leg decimal IV/RV21|NEEDS NSE BACKTESTING|Formula KEEP; threshold not calibrated |
| Min OI |100 contracts, API0–10000|Liquidity proxy|Quantity divided by matched lot|NEEDS NSE BACKTESTING|Units correct; fix B7 for missing values at zero |
| Max bid/ask fraction |0.10 ratio|Quote friction|Both legs|NEEDS NSE BACKTESTING|Not10 price points; preserve units |
| Min cushion |2 percent|OTM distance|Historical spot anchor|NEEDS NSE BACKTESTING|Recompute shown examples; settle time-anchor policy |
| Min RoR |15 percent, API5–100|Gross payoff reward/risk|Real width/credit; lot cancels|NEEDS NSE BACKTESTING|Not margin return |
| Max short strikes |12 per side, hidden constant|Bound candidate search|Nearest OTM rows before cushion gate|NEEDS NSE BACKTESTING|Can exclude farther qualifying strikes; not a universal NSE rule |
| Minimum credit baseline |strictly>0.01 price points|US cent filter|Compatibility mode|NSE STRUCTURAL ADAPTATION|Do not treat as an NSE economic threshold |
| Minimum credit native |gcd(ticks)/2|Positive midpoint granularity|Valid contract tick grid|KEEP|Resolution only; economic minimum NEEDS NSE BACKTESTING |
| RV windows |10/21/63/252 observations|Realized risk estimation|Same log-return statistics|KEEP|Independent recomputation; data validity is separate |
| Annualization |√252|Annualized risk units|Approximate trading year|KEEP|Reasonable convention; actual-calendar sensitivity needs validation |
| Breach horizon |round(DTE×252/365)|Approximate session horizon|Same endpoint-return model|NEEDS NSE BACKTESTING|No exact NSE session calendar currently supplied |
| Min probability sample |60 forward observations|Minimum sample gate|Same|NEEDS NSE BACKTESTING|Not statistical calibration evidence |
| History lookback / min rows |3 years /270 closes|Risk history sufficiency|Non-null row count|BUG|B1 duplicates/invalid dates can satisfy count |
| Discovery history / min data |4 months /30 rows /22 non-null closes and volumes|Shock/RV eligibility|Same observations, independently dropped nulls|UNVERIFIED|Date alignment and missing sessions not certified |
| Shock |latest / preceding20 mean|Unusual activity|Underlying daily reported volume|KEEP|Date/volume semantics must be validated |
| Discovery EDGE |VRP>1.20 and shock>1.5|Rank enriched risk/activity|Same concepts|NEEDS NSE BACKTESTING|Do not lower to force EDGE |
| Discovery SCORE |VRP percentile+shock percentile|Relative ranking|Missing VRP rewarded|BUG|B2 reproduced; fix missingness policy explicitly |
| Earnings dates/gap lookback |24 dates;3 years;0..3-day match|Event risk proxy|Yahoo `.NS` with Upstox closes|UNVERIFIED|Source/time/coverage separate from arithmetic |
| Earnings penalty |severity formula/cap0.95|Conservative event adjustment|Same proxy|NEEDS NSE BACKTESTING|Formula implemented correctly; not an NSE-calibrated model |
| EV scale |100 units|US-origin score multiplier|Score only; actual lot money separate|KEEP|Do not mislabel expected net INR profit |
| Rounding |credit2,RoR1,cushion2,VRP2,IV/RV4,p4,EV0|Result precision|Precise credit added for UI|BUG|B6 inconsistent view filtering; scoring precision is a separate policy |
| Data cache/freshness |transport120s; discovery900s|Reduce provider requests|No per-leg quote timestamp|UNVERIFIED|Show response age/snapshot context; not a strategy threshold |
| Deadlines/concurrency |scan180s/discovery900s; scan4/discovery6 workers|Bound workloads|Partial terminal failures preserved|KEEP|Operational limits; live sufficiency UNVERIFIED |

No recommended research value was invented. UI/API ranges are not identical but UI-supported values fit the API; that alone is not a correctness defect.

## 22. Complete funnel reconciliation

Archived six-name scans, independently recomputed on current code concepts:

| Stage | Baseline | NSE_RESEARCH_V1 /1 step |
|---|---:|---:|
| considered |141|141 |
| cushion |87|87 |
| friction |2|1 |
| paired |2|1 |
| RoR |2|1 |
| VRP |2|0 |
| final |2|0 |

Baseline first failures: cushion54, short OI10, missing hedge7, short bid/ask65, long bid/ask1, long OI2; plus2 finals =141. Native: cushion54, short OI10, short bid/ask65, long bid/ask9, long OI2, VRP1; plus0 finals =141. Every next-stage count is ≤ previous, and final rows reconcile exactly with combined candidates. **PASS archived accounting.** Zero native finals is explained by gates, not proof of service failure or a reason to relax parameters.

The JSON evidence contains each underlying/profile's rejected short/hedge record, first failure and intermediate values reached before rejection. It is new audit-only evidence, not added production instrumentation. Fresh live funnel remains UNVERIFIED.

## 23. Raw → Python → Node → React → UI reconciliation

Representative archived CANBK Bear Call:

| Value | Raw / normalized / calculated | Serialized result | UI binding / audit status |
|---|---|---|---|
| Identity |NSE_EQ\|INE476A01022; CE keys83051/83064|Exact short/long keys|Full breakdown; PASS code/archived |
| Expiry/strikes |2026-11-23;125/130|Same; DTE41|Same fields; PASS code/archived |
| Bid/ask |short3.52/3.64; long2.12/2.23|Not table fields; raw capture retains them|Midpoint calculation verified, raw quote display PARTIAL |
| Mid/credit |3.58−2.175=1.405|credit1.41; precise1.405|Table₹1.405; FAIL filter precision B6 |
| OI |1086750/6750=161;1849500/6750=274|layers.l5 OI161/274|Breakdown same; PASS |
| IV |31.25→0.3125|iv0.3125|Breakdown0.3125 decimal; PASS |
| RV21 / VRP |0.20019208;0.3125/RV21≈1.561|rv21 .2002;vrp1.56|Same rounded fields; PASS |
| Cushion/RoR |5.592…%;39.082…%|5.59%;39.1%|Same fields; PASS |
| Probability |28-step715 observations; raw .2979; adjusted .5801|p_raw/p_adj and layers|Same fields; PASS arithmetic |
| Score/money |EV−150 rounded; lot6750|₹9483.75 credit,₹24266.25 payoff loss|Actual-lot fields; PASS arithmetic |

Python `_json_safe` converts non-finite outputs to null. Node parses JSON and returns the object; no financial recalculation occurs. React stores the result and formats fields. Existing service, session-isolation and hook/view tests verify these boundaries with controlled inputs. **PARTIAL end-to-end:** fresh HTTP responses and actual rendered browser values were not observed while the app was offline. No mock result is labeled a live UI observation.

## 24. Failure and partial-scan behavior

| Failure | Current behavior / evidence | Status |
|---|---|---|
| Missing/insufficient history |270-close gate / discovery eligibility error|PASS basic gate; B1 invalid rows |
| Empty/malformed chain |underlying fails, other results survive|PASS tests |
| Missing IV |V3 fallback; missing remains unavailable or candidate fails|PASS; B2 discovery score |
| Missing OI |provider None; cleaning converts to0|min100 rejects; FAIL B7 atmin0 |
| Missing lot |bad contract omitted|FAIL B3 grid can change |
| Missing tick |native resolver rejects; no invented tick|PASS tests |
| Missing earnings |stock blocked; indices not applicable|PASS missing-data policy; source UNVERIFIED |
| Invalid bid/ask |cleaning removes malformed/nonpositive/crossed rows|PASS validity gate; pre-funnel visibility PARTIAL |
| Missing hedge |pair rejected, not fabricated|PASS quoted valid-grid case; B3 malformed metadata |
| Stale data |caches retained with partial age metadata|UNVERIFIED market freshness; B4/B5 |
| Timeout/401/429 |bounded retries/deadlines; safe failure/status|PASS tests; fresh operational timing UNVERIFIED |
| Partial batch |each HTTPException isolated; successful candidates aggregate|PASS tests |

Current rolling quotas account for one process/app identity/API, not external apps or multiple Python workers. Retried requests count; cache hits do not. Rate-limit tests pass. A finite scan budget can legitimately expire while waiting on provider quotas; that is not evidence of a formula failure.

## 25. US-to-NSE assumption inventory

The machine-readable appendix records256 matching source/test lines across37 files, with source text and classification. It includes dollar syntax/interpolation and numeric false positives so the search is reproducible; a match is not automatically a US assumption.

| Occurrence family | Classification | Audit finding |
|---|---|---|
| US ticker lists/regex in reference/test fixtures |Harmless reference/test fixture|Not the live NSE universe; do not reintroduce |
| `$` in JS template strings/regex, Tailwind `100` |Harmless language syntax/reference|Not a USD monetary label |
| Live INR labels and index-point labels |Correct NSE adaptation|No live monetary result field using a dollar symbol was found |
| Fixed width5 / credit0.01 baseline |Intentionally retained compatibility research behavior|Not endorsed NSE economics; native exists |
| EV×100 / “100-unit score” |Intentionally retained research formula|Not used as the NSE lot multiplier |
| ×100 percentages and V2 IV/100 |Correct unit conversions|Not US-share assumptions |
| `.NS` earnings mapping |NSE adaptation with UNVERIFIED data accuracy|Not a Yahoo price/option fallback |
| √252 /252÷365 /3×365 |Intentionally retained research assumptions|Conventional observation/horizon approximations, not a US holiday calendar |
| Yahoo auto_adjust equivalence warnings |Needs NSE policy/wording adaptation|US reference treatment is no longer the objective; NSE corporate-action policy remains unresolved |
| “original” parity comments / oracle tests |Harmless reference/research evidence|Not sufficient for conceptual NSE certification |
| Missing IV ranking inherited from reference |BUG B2|Reference origin does not excuse an NSE ranking error |

There is no hard-coded current universe size, universal actual NSE lot100, US market holiday list, or US weekday-derived expiry in the audited live Spread path. Synthetic lots/history remain explicitly selected by fixture mode. Live mode has no provider-error branch that substitutes a fixture market price. Runtime fixture-free certification for a new scan is UNVERIFIED because no new live scan ran.

## 26. Confirmed bugs — expected, actual, cause, impact and minimal fix

These were documented only. No fix is implemented in this audit.

### B1. Known defective history remains scanner-eligible — FAIL

- EXPECTED: one valid completed observation per trading session for session-based RV/probability; known duplicate/invalid history must not silently become usable model history.
- ACTUAL: a duplicate inserted into captured history produces `completeness=incomplete` and duplicate dates but `scanner_history_eligible=True` and no capability blocker. Original closes are still consumed.
- ROOT CAUSE: eligibility counts non-null closes; diagnostics are warnings only. Discovery similarly counts rows rather than validated sessions.
- IMPACT: duplicate sessions/missing-date compression can alter RV, effective horizon, sample count and probability; invalid closes can cause nonsensical returns or errors.
- MINIMAL FIX: enforce a documented provider quality policy for confirmed duplicate/invalid/session defects before scanning; retain raw evidence. Do not fill missing candles or silently alter thresholds. Full calendar coverage remains a separate prerequisite.

### B2. Missing IV is rewarded in discovery SCORE — FAIL

- EXPECTED: unknown VRP is not evidence of richer implied volatility and should not receive a superior VRP contribution.
- ACTUAL: equal-shock examples HIGH VRP2.0, LOW VRP1.0 and MISSING VRPnull rank MISSING first among non-EDGE names: scores1.67,1.33,1.00.
- ROOT CAUSE: ascending percentile ranking with `na_option='bottom'` gives missing values the highest rank before descending score sorting.
- IMPACT: unavailable-IV names can outrank measured candidates; EDGE false mitigates but does not correct the non-EDGE ranking.
- MINIMAL FIX: explicitly exclude unknown VRP from the measured percentile distribution and adopt a documented missing-data contribution/unranked policy. Preserve score meaning; do not tune weights for opportunity counts.

### B3. Missing lot metadata changes listed hedge-step meaning — FAIL

- EXPECTED: for listed strikes100,105,110, one upward step from100 targets105; missing metadata for105 should reject that hedge.
- ACTUAL: a raw105 contract with missing lot is dropped; normalized grid becomes100,110 and one step selects110.
- ROOT CAUSE: adapter excludes incomplete contracts before the native resolver constructs its supposedly complete strike grid.
- IMPACT: the selected width/risk can differ from the requested listed-step distance, despite a valid farther contract.
- MINIMAL FIX: preserve authoritative listing positions separately from metadata validity; reject the selected incomplete contract, never compress the grid to jump over it.

### B4. Discovered identity snapshot date is unused — FAIL

- EXPECTED: a stale BOD identity is refreshed/revalidated before being treated as current.
- ACTUAL: a snapshot explicitly dated2000-01-01 is immediately returned by `resolve_underlying` without lookup.
- ROOT CAUSE: `_identity_day` is recorded but never consulted on lookup.
- IMPACT: renamed/removed/changed instrument identities can survive across trading dates until a discovery refresh; downstream contracts may fail or reference an obsolete identity.
- MINIMAL FIX: invalidate/revalidate the snapshot against a current authoritative master date; keep exact keys and ambiguity handling.

### B5. Failed refresh can retain old “complete” metrics — FAIL

- EXPECTED: retained old ranking is clearly identified as old, while the latest refresh outcome/counts are truthful.
- ACTUAL: empty/failed refresh retains prior `stats.complete=True` and counts alongside new errors; frontend can print “Discovery complete.” `refresh_empty` is not presented.
- ROOT CAUSE: cache merges the old entry when the new list is empty instead of keeping latest refresh status separately.
- IMPACT: stale ranking/counters can appear to describe a successful new full-universe pass.
- MINIMAL FIX: separate last successful ranking metadata from latest refresh status/counts; display both honestly.

### B6. Credit filtering/sorting differs from displayed credit precision — FAIL

- EXPECTED: the ₹ Credit/unit filter refers to the displayed field.
- ACTUAL: a displayed0.005 credit survives a minimum0.006 filter because `viewFilters.ts` uses rounded `credit=0.01`; the table uses `credit_points_unrounded`.
- ROOT CAUSE: the additive precise display field is not used by credit view comparisons.
- IMPACT: visible rows can contradict the requested filter; sorting can have the same precision inconsistency.
- MINIMAL FIX: use one explicit accessor for displayed credit/filter/sort. Do not change scanner thresholds, EV rounding or ranking.

### B7. Missing OI can pass as actual zero contracts — FAIL, conditional on min_oi=0

- EXPECTED: unknown OI remains distinguishable from a provider-reported zero, even if the numerical threshold is zero.
- ACTUAL: `_clean_frame` maps None to0; `passes_friction` then accepts it with min_oi0.
- ROOT CAUSE: generic compatibility cleaning destroys missingness before the threshold test.
- IMPACT: missing/invalid lot-to-OI mapping can be accepted as known liquidity when the UI-supported zero threshold is selected. Default100 rejects it; the default path is not claimed affected.
- MINIMAL FIX: preserve an availability mask and require usable OI data unless a separately explicit unavailable-data research mode is chosen. Keep real zero-OI and min_oi semantics distinct.

### B8. OI warning describes the wrong normalization path — FAIL reporting

- EXPECTED: warning accurately explains normalized contracts and unusable mappings.
- ACTUAL: if any chain OI mapping is unavailable, the engine says “Using Upstox reported OI directly,” although valid legs are divided by matched lot and invalid legs remain missing before cleaning.
- ROOT CAUSE: warning text predates the normalization fix and is keyed to aggregate capability status.
- IMPACT: users can infer that raw quantities are compared to contract thresholds when they are not.
- MINIMAL FIX: describe converted valid legs and exact invalid/missing cases; preserve warnings rather than hide unverified data.

## 27. Unverified assumptions and data gaps

1. Fresh live provider/account access, raw responses and current rendered values: frontend offline.
2. Full completed NSE session calendar and same-day finality for the entire lookback.
3. Price/volume corporate-action treatment; upcoming dividend and contract-adjustment alignment.
4. Quote timestamps, book freshness, synchronized spot/chain/history and cache-age suitability.
5. Yahoo `.NS` issuer mapping, actual NSE result dates/times, upcoming completeness and three-year event coverage.
6. Index volume semantics and missing-close/volume date alignment.
7. Exact calendar-to-session horizons and effective independent historical sample size.
8. Margin, taxes, physical delivery, broker square-off and executable two-leg fill consequences. These are not modeled by gross payoff max loss.
9. Complete first-rejection observability in the current native production API; the independent audit supplies archived records only.
10. Runtime single-process quotas versus other apps/accounts/workers sharing a broker account, and fresh 50-name deadline adequacy.

## 28. Backtesting rather than arbitrary code changes

NSE indices and stock liquidity/price regimes require chronological out-of-sample evaluation of DTE, hedge steps, cushion, OI, friction, RoR, VRP, candidate depth, event penalty, sample requirements and cost-aware economic minimum credit. Results must include failures, zero-result periods, turnover, costs, drawdown and calibration, not only accepted trades or opportunity count.

The simplified EV/breach model should be compared with actual spread terminal payoffs and realistic fills. Corporate-action and session policies must be established first. Historical OHLC alone does not prove availability of historical option bid/ask/IV needed for this research. No optimized NSE defaults are asserted here.

## 29. Test results and evidence limitations

| Verification | Result |
|---|---|
| Full Python suite |248 PASS,6 existing warnings;27.48 seconds |
| Full Node suite, serialized files |233 PASS,0 FAIL;154.76 seconds |
| Full frontend suite |71 PASS across12 files |
| Production frontend build |PASS; existing chunk-size warning |
| Independent archived arithmetic |Two batches,12 underlying/profile replays; all four RV windows; two final candidates; native funnel matches current implementation |
| Diagnostic defect reproductions |Six Python reproductions plus actual TS-helper precision reproduction; warning B8 traced in source |
| Fresh live scan/browser numerical test |UNVERIFIED: connection refused |

Logs: `tmp/nse-e2e-audit-python.log`, `tmp/nse-e2e-audit-node.log`, `tmp/nse-e2e-audit-frontend.log`, `tmp/nse-e2e-audit-build.log`. Existing oracle/source-parity tests passed but are **not** used as proof that US constants are appropriate for NSE.

## 30. Files inspected and audit-only files created

Production inspected: all `.py` modules in `angel-one/app/services/spreads` (API, providers, fixtures/mode boundary, transport/quota, history, universe/identity, discovery/cache, calculations, earnings and capture); `angel-one/app/main.py` router mount; `backend/index.js` Spread mount; Spread routes/controller/Python service/OAuth service; rate-limiter middleware; `SpreadsPage.tsx`, `DiscoveryPanel.tsx`, `viewFilters.ts`, Spread CSS, shared trading API and API base/session behavior.

Tests inspected/run: all Python tests, particularly Spread provider/transport/OI/V3/history/discovery/earnings/native/audit suites; all Node tests, particularly Spread routing/service/session/OAuth; all frontend tests, particularly Spread page/view/API isolation; production build.

Reference inspected: uploaded ZIP `spread-terminal/screener.py`, `main.py` and reference templates/earlier parameter audit for purpose/US assumptions. Archived batch, underlying raw-response, OI/NSE comparison and numerical examples were inspected. Earlier validation reports are historical and can contain superseded OI/Yahoo-parity wording; this report's current-code trace takes precedence.

Created only this report and audit-only artifacts/programs/logs under `tmp/`. Production-source fingerprints recorded at the start are checked at completion to prove this audit did not change behavior; hash equality is a scope check, not the strategy objective.

## 31. Angel One confirmation

No Angel One authentication, strategy, order, position, monitoring, shared architecture or other non-Spread implementation was modified in this audit. Running regression tests is not evidence that every possible non-Spread behavior is exhaustively proven, but all existing suites passed and production source remained untouched.

## 32. Order confirmation

ZERO Upstox orders were placed. No order endpoint, permission, execution path or strategy change was added. Diagnostic programs replay local evidence and synthetic failure cases only.

## A. FIX NOW — confirmed correctness bugs only

1. B1: prevent known defective/duplicate historical observations from silently becoming session-based scanner inputs; preserve raw evidence.
2. B2: stop rewarding unavailable IV/VRP in discovery percentile score.
3. B3: retain listing positions when contract metadata is invalid; reject the selected hedge rather than shorten the grid.
4. B4: revalidate stale discovered identities against the authoritative master date.
5. B5: distinguish last successful ranking from the latest failed/empty refresh and its counts.
6. B6: reconcile precise displayed credit with credit filters/sorting.
7. B7: retain missing OI distinction at the UI-supported zero threshold.
8. B8: correct OI provenance warning text without suppressing genuine warnings.

## B. BACKTEST LATER — Indian-market research

- Index/stock-specific DTE, steps/width, cushion, OI, bid/ask, RoR, VRP, maximum short strikes and economic minimum credit.
- Calendar horizon approximation, sample sufficiency, overlapping-window effects and probability calibration.
- Earnings penalty magnitude and timing; dividend/corporate-action-consistent return-model treatment after source semantics are established.
- Simplified EV versus actual option-spread payoff, realistic execution, costs, margin and physical settlement outcomes.
- Any new ranking objective or risk-adjusted score. No tuning merely to increase opportunities.

## C. LEAVE UNCHANGED — logic already correct on validated NSE inputs

- Existing architecture, Angel One separation and read-only Upstox boundary.
- Dynamic NSE instrument-key universe; no hard-coded219-name assumption.
- Existing quantity-OI divided by exact contract lot normalization for valid mappings.
- Explicit endpoint-specific IV normalization and chain-IV preference.
- Distinction between discovery ATM VRP and spread short-leg VRP.
- Log-return/sample-standard-deviation RV mathematics and explicit units.
- Actual listed expiry selection and deterministic earlier-date tie behavior.
- Correct Bull Put/Bear Call direction and native listed-grid selection when the full grid and metadata are valid.
- Midpoint/credit, actual width, cushion and RoR arithmetic; actual-lot INR cash calculations.
- Negative-score retention and explicit separation of ranking scale from actual-lot money.
- Partial-underlying failure isolation, existing authentication separation and explicit fixture/live mode distinction.
