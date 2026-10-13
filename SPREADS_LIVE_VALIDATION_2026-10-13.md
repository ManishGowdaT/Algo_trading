# Spread Terminal live validation — 2026-10-13

## Overall result

Live UI workflow works with the existing connected Upstox session. NIFTY, BANKNIFTY and RELIANCE generated spreads. Discovery refreshed 219 recommendations. Ten selected stocks produced eight successful scans, two explicit earnings-data failures and 26 combined opportunities.

**This is not a complete certification of raw-data parity.** Authenticated Upstox candle/chain response bodies and the corresponding Node/Python JSON bodies were not captured. The browser blocked direct navigation to the local authenticated API with ERR_BLOCKED_BY_CLIENT; supported browser tooling exposed UI/DOM, not network response bodies. The Upstox token stays in the running Node process. No authentication bypass, token extraction, server instrumentation or code modification was performed. Items requiring those raw bodies remain UNVERIFIED.

PASS below applies only to the stated evidence and scope. A working frontend is not proof that every raw input is correct.

## Tests performed in requested order

| Test | Status | Observed evidence |
|---|---|---|
| 1. Existing Upstox OAuth connection | PASS | UI reports connected; diagnostics report successful connection at 2026-10-13T05:33:10.107Z, token stored in Node and expiry 2026-10-14 03:30 local. Downstream live-mode expiry and scan requests succeeded. A fresh MPIN/token-exchange round trip was not replayed; that specific flow is UNVERIFIED in this validation pass. |
| 2. NIFTY | PASS | Default scan: 1 successful, 0 unavailable, 0 candidates, 1.1 seconds. Diagnostic scan: 23 candidates. Expiry 2026-11-09, DTE 27, scanner historical-close spot 22363.35, contract lot 65. |
| 3. BANKNIFTY | PASS | 24 candidates, 0 unavailable, 0.8 seconds. Expiry 2026-11-23, DTE 41, historical-close spot 54918, contract lot 30. |
| 4. RELIANCE | PASS | 23 candidates, 0 unavailable, 2.2 seconds. Expiry 2026-11-23, DTE 41, historical-close spot 1158.9, lot 500. Earnings adjustment exercised. |
| 5. Discovery refresh | PASS | Completed refresh timestamp shown as 2026-10-13 11:14:35 local. 219 eligible and ranked, source upstox_nse_bod. Independently downloaded master also produces 219 eligible underlyings. No provider-input error section appeared in the completed response view. |
| 6. Add discovered stocks | PASS | TATAELXSI and TECHM were selected and added; both resolved their expiries. Selection became three including RELIANCE. Existing one-stock result remained unchanged; adding did not auto-scan. |
| 7. Ten-underlying batch mechanics | PASS | All ten selections loaded expiries; explicit scan completed in 8.3 seconds. Eight succeeded, two failed independently; 26 candidates combined. |
| All ten stocks produce a valid scan | FAIL | IRFC lacked historical earnings dates; PNBHOUSING lacked an upcoming earnings date. No earnings inputs were assumed. Details below. |

Diagnostic form submissions used existing supported inputs, not changed defaults or code:
- NIFTY/BANKNIFTY: target DTE 30, width 100, minimum IV/RV21 0.8, OI 0, bid/ask fraction 0.3, cushion 0, RoR 5.
- RELIANCE single scan: same, width 10.
- Ten-stock scan: same, width 50.
- Browser form bounds rejected attempted VRP 0.5 and bid/ask fraction 0.5 before submission. They were corrected to permitted values. This was not a provider failure or a code change.

## Field and calculation checks

| Item | Status | Evidence / limit |
|---|---|---|
| Underlying identity | PASS | Public Upstox master independently confirms NIFTY=NSE_INDEX\|Nifty 50, BANKNIFTY=NSE_INDEX\|Nifty Bank, RELIANCE=NSE_EQ\|INE002A01018. Discovered stocks resolved without identity errors. |
| Expiries / nearest DTE | PASS | UI expiry lists matched independently built public-master lists. NIFTY nearest target 30 is 27 days; BANKNIFTY and stock monthly expiry nearest 30 is 41 days rather than 14. |
| Strikes / CE / PE contracts | PASS | Sampled scanner leg IDs were matched independently to raw public master records, including both CE and PE for both indices. See trace samples below. |
| Actual contract lot sizes | PASS | Raw master confirms NIFTY 65, BANKNIFTY 30, RELIANCE 500, TATAELXSI 125 and COALINDIA 1350 for sampled exact legs/expiries. These are actual source values, not fixture lots. |
| Historical candles / OHLC / row count / chronology | UNVERIFIED | The live scan consumed sufficient history and produced results, but raw candle arrays and normalized bar objects were not captured. |
| Latest historical close and its timestamp | UNVERIFIED | Scanner spots were 22363.35, 54918 and 1158.9 respectively. Code takes the final non-missing historical close, not option-chain spot. Raw candle timestamps were unavailable for independent confirmation that this was the latest appropriate completed daily close. |
| Historical volume | UNVERIFIED | Discovery reports volume capability as reported and 219 histories qualified, but raw volume arrays were not captured. |
| Bid / ask and midpoint credit from source quotes | UNVERIFIED | Valid spreads and friction fields appeared, but exact raw leg bid/ask and normalized quote objects were not exposed in the UI. Per-lot/displayed credit relationships reconcile; raw midpoint origin cannot be independently certified. |
| OI value transport | UNVERIFIED | UI layers show OI, e.g. NIFTY sample 1950/455 and RELIANCE 18000/85000. Raw option-chain bodies were not captured. |
| OI units / original contract-count threshold equivalence | UNVERIFIED | Adapter passes raw oi through without lot conversion; capability remains unverified. Upstox option-chain docs label the field Open interest without a unit. E.g. 1950/65=30 is suggestive of total quantity, but divisibility is not proof. Original minimum-OI contract-count equivalence is not certified. Diagnostic OI=0 did not test the original 100-contract threshold. |
| IV source and normalization | UNVERIFIED | Code maps option_greeks.iv / 100 to impliedVolatility and UI decimals are plausible. Raw IV percentage values were not captured for paired source/normalized comparison. |
| RV10 / RV21 / RV63 / RV252 | UNVERIFIED | All four outputs appeared. Original definitions are AST-identical to ZIP, but independent live recomputation requires the exact raw close series. Sample values below. |
| Volume shock | UNVERIFIED | Outputs and rank inputs were observed; exact last volume / preceding-20 mean cannot be recomputed without raw volumes. |
| ATM IV | UNVERIFIED | Exactly ten selected names have IV, matching the ten highest rounded shocks. Source chain rows needed to independently reproduce nearest-three-per-side median were not captured. |
| Displayed VRP arithmetic | PASS | Sample displayed IV/RV21 ratios reproduce displayed VRP; full unrounded raw-input calculation remains UNVERIFIED. |
| Bull Put construction | PASS | Observed short PE below historical-close spot, hedge lower by explicit width. Sample contract types verified independently. |
| Bear Call construction | PASS | Observed short CE above historical-close spot, hedge higher by explicit width. Sample contract types verified independently. |
| Cushion | PASS | Independently recomputed from observed strike/spot; NIFTY 2.62%, BANKNIFTY 1.61%, RELIANCE 7.67% match UI. |
| RoR | PASS | Recomputed from per-lot credit divided by actual lot and width; 58.9%, 133.2%, 21.2% match UI. Raw-quote credit origin remains UNVERIFIED. |
| Historical breach probability | UNVERIFIED | Layer values and horizons observed; 27 calendar days → 19 trading days and 41 → 28 match original conversion. Recomputing breach counts requires exact historical series. |
| Earnings event flag | PASS | Independent supplementary Yahoo fetch returned RELIANCE event 2026-10-16, inside 2026-11-23 expiry. Index earnings correctly not applicable. |
| Historical earnings maximum gap | UNVERIFIED | RELIANCE displays 2.36%; cannot recompute without exact Upstox closes matched to earnings dates. |
| Earnings penalty formula on observed sample | PASS | Original formula applied to displayed p=.0923, cushion=7.67, max_gap=2.36 yields .1207, matching RELIANCE. This does not certify raw-date/close coverage. |
| EV from exact raw inputs | UNVERIFIED | Values, negative-EV retention and per-lot figures observed; exact probability/credit inputs were not captured. Display rounding prevents a full exact-value assertion. |
| Funnel aggregation | PASS | Eight successful per-stock funnels sum exactly to considered177, cushion177, friction27, paired27, ror27, vrp26, final26. All per-filter raw-row decisions remain UNVERIFIED without source frames. |
| Discovery ranking | PASS | All 219 displayed percentile-rank-sum scores independently reconcile, with zero score mismatches and zero edge/score ordering violations. Ten IV recipients exactly match highest-shock shortlist. Raw history metrics remain UNVERIFIED. |
| Final combined ranking | PASS | All 26 displayed candidates sorted descending by original rounded EV. 23 negative EVs retained. Candidate totals: TATAELXSI 3, RELIANCE 20, COALINDIA 3. |
| Original calculation implementation unchanged | PASS | Compared actual uploaded ZIP with production source during this pass: all seven original core definitions remain AST-identical. This is code parity evidence, not a substitute for raw live-data parity. |
| No fixture or alternative price/chain provider in inspected live path | PASS | Node/Python .env mode is upstox; UI returned Upstox mode results. Inspected live provider uses fixed official Upstox HTTPS read-only paths; it has no error-to-fixture fallback. Exact live contract IDs/lots independently match current master. Yahoo is used only for expressly authorized supplementary earnings dates. |
| Every individual received value has independently proven provenance | UNVERIFIED | Cannot make this stronger assertion without authenticated raw response captures. Existing original cleaning can convert missing OI to zero; this was not changed and must not be described as source-reported zero without the raw field. |

## Observed sample traces

Public-master raw contract → normalized OptionContract → original build_spreads → Python API enrichment → Node bridge → frontend:

- NIFTY BEAR CALL 22950/23050: NSE_FO\|39907 and NSE_FO\|39912, both CE, expiry 2026-11-09, lot 65. Credit 37.08, RoR 58.9%, cushion 2.62%, IV .1332, RV21 .1351, VRP .99, p_raw=p_adj .2376, EV 1332, per-lot EV 865.68. RV10=.1597, RV63=.1042, RV252=.136. Per-lot credit 2409.88, max loss 4090.12.
- NIFTY BULL PUT 22200/22100: NSE_FO\|39862 and NSE_FO\|39858, both PE, same expiry/lot. Credit 25.45, p_raw=p_adj .3080, EV -535, per-lot EV -347.82.
- BANKNIFTY BEAR CALL 55800/55900: NSE_FO\|62177 and NSE_FO\|62181, CE, expiry 2026-11-23, lot 30. Credit 57.12, RoR 133.2%, cushion 1.61%, IV .1401, RV21 .1446, VRP .97, p .4448, EV 1265. Per-lot credit 1713.75, max loss 1286.25, EV 379.48. RV10=.1556, RV63=.1198, RV252=.1693.
- BANKNIFTY BULL PUT 53900/53800: NSE_FO\|62132 and NSE_FO\|62124, PE, same expiry/lot. Credit 24.58, p .2420, EV 38, per-lot EV 11.38.
- RELIANCE BULL PUT 1070/1060: NSE_FO\|144150 and NSE_FO\|125974, PE, expiry 2026-11-23, lot 500. Credit 1.75, RoR 21.2%, cushion 7.67%, IV .2527, RV21 .2239, VRP 1.13; earnings inside, max gap 2.36%; raw p .0923 → adjusted .1207; EV 54, per-lot EV 271.47. RV10=.2627, RV63=.1985, RV252=.217. Per-lot credit 875, max loss 4125.
- Combined top TATAELXSI BEAR CALL 3300/3350: NSE_FO\|129247 / NSE_FO\|146931, CE, lot 125. Credit 39.55, p .2867, EV 2521, per-lot EV 3151.79. Earnings outside expiry. Hedge OI=0 is admitted because diagnostic minimum OI was explicitly 0.
- Combined COALINDIA BEAR CALL 430/480: NSE_FO\|84773 / NSE_FO\|84783, CE, lot 1350. Credit 4.47, p .2503 → .4566 with earnings; EV -1836, per-lot EV -24780.94.

For prices/greeks/history the mapping was traced statically through existing code, but raw and normalized runtime snapshots were unavailable. Do not interpret these sample chains as a captured five-stage raw price/greek trace.

Discovery mapping: public master underlying_key → four-month Upstox candle close/volume fields → original volume-shock/RV metrics → top-ten nearest-14-DTE ATM-chain stage → original rank calculation → discovery API → frontend recommendations. Finished leaders: TATAELXSI shock2.82 IV41.72% VRP1.28 score1.03; TECHM shock2.16 IV33.97% VRP1.63 score1.02; IRFC shock1.74 IV34.67% VRP1.28 score1.00. Edge is sorted first, so a non-edge row may have a larger numeric score below these leaders; that matches the original methodology.

## Failures and limits; no fixes applied

1. IRFC stock scan FAIL: separate live earnings fetch returned zero historical dates in the three-year window, upcoming 2026-10-15, calendar_known=False. Current guard requires both historical and upcoming inputs, so it correctly refuses to invent the historical gap.
2. PNBHOUSING stock scan FAIL: separate live fetch returned 12 historical dates in the window, no future dates and calendar_known=False. Current guard cannot establish the upcoming earnings window, so it refuses the scan.
3. Default NIFTY zero results are expected for width5: current public master has 95 CE and 95 PE strikes for selected expiry, minimum spacing50, zero width5 hedge pairs and 93 width100 pairs per side. Funnel friction also requires a valid liquid hedge; zero at that counter does not by itself mean missing bid/ask.
4. Raw private response capture remains UNVERIFIED for candles, volumes, bid/ask, IV, OI units, exact breach counts, gap maxima, exact EV and per-row filter decisions. No pass was inferred merely from a connected badge or plausible number.
5. Daily-candle completeness, equity corporate-action adjustment equivalence and quote freshness remain UNVERIFIED. Adapter reports no per-quote chain timestamp. Scanner uses historical closes, not a claimed current live spot. The live transport's short-lived cache is cached Upstox data, not a fixture substitution.

No application code, environment settings, architecture, original ZIP formulas, thresholds, rounding, filters, funnels, ranking implementation or Angel One functionality were changed. No Upstox order was placed and no Angel One trading control was used. Only live data scans, supplementary date reads, read-only source inspection and this report were performed.

Sources: [Upstox public NSE instrument master](https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz), [option contracts API documentation](https://upstox.com/developer/api-documentation/get-option-contracts/), [option-chain API documentation](https://upstox.com/developer/api-documentation/get-pc-option-chain/).
