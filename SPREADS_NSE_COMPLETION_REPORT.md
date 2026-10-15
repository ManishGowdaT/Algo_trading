# NSE Spread Terminal completion report

15 October 2026 · IST. Security review/hardening excluded at the user's request. This report covers the current Angel-one-trading Spread feature. Earlier working-tree changes were preserved; the original spread-terminal remains reference material.

## 1. Executive verdict

Deterministic completion changes and offline acceptance pass. This is a read-only NSE research workflow with explicit uncertainty, not a calibrated strategy or production certification. Fresh authenticated Upstox acceptance is UNVERIFIED. No running listener was found on 5173/5000/8000 during availability checking, so there was no existing running authenticated environment to reuse. No credentials were requested.

The native NSE profile remains opt-in, preserving the existing profile default and research thresholds. Select NSE_RESEARCH_V1 for listed-step construction. The legacy profile remains visibly identified.

Checklist:

| Classification | Evidence / outcome |
|---|---|
| DONE | Dynamic NSE universe, listed expiries, native hedge steps, lot/tick validation, OI/IV units, INR economics, partial failure isolation, eight earlier audit fixes, additional correctness fixes and diagnostics below |
| BROKEN | Newly confirmed missing-lot serialization crash and non-finite quote eligibility corrected |
| MISSING | Leg provenance, sample count, observation policy, fetch evidence, settlement/cost labels and native first-rejection coverage added |
| PARTIAL | Session and corporate-action validation: known defects rejected, unknown external coverage explicitly retained |
| UNVERIFIED | Fresh live provider acceptance, full authoritative session calendar, price/volume adjustments, quote age, issuer/event completeness, exact charges/margin |
| BACKTEST REQUIRED | Threshold suitability, probability calibration, event penalty, execution/cost-aware payoff EV |

## 2. What was already correct

B1–B8 implementations are present and regression-tested: known-defect history exclusion; missing-VRP score neutrality; authoritative strike-grid retention; stale identity refresh; latest-attempt discovery status; precise credit display/filter/sort; missing-versus-zero OI; quantity-to-contract warning. See SPREADS_NSE_B1_B8_FIX_REPORT.md for historical before/after evidence. Current full suites include these regressions.

Existing native construction, IV endpoint semantics, exact quantity-OI/lot normalization, real listed expiry selection and actual-lot arithmetic were retained. No source formula or economic threshold was tuned.

## 3. What was missing

The result did not expose all final-leg inputs or sample count. Observation time, raw history treatment, settlement exposure, excluded costs and quote-age uncertainty were insufficiently visible. Native rejection reporting covered contract failures but omitted many strategy gates. Same-day history finality had no deterministic blocker. Discovery history counts and cache age were not visible together.

## 4. Bugs fixed

- A valid baseline candidate with matched contracts whose lots were both missing could evaluate None > 0 and abort the underlying scan. It now returns unavailable monetary values.
- Infinite strikes/bid/ask could survive generic cleaning. Non-finite quote fields and non-positive strikes cannot enter scanner rows.
- Equal-distance expiry ties depended on caller ordering. The shared picker now sorts unique strings, consistently preferring the earlier listed expiry.
- Current/future-session candles without completed-session evidence could enter analysis. Both live history adapters now retain the original data but mark such observations ineligible.
- Native first-rejection diagnostics now cover cushion, short/long OI and bid/ask, tick/credit validity, RoR, missing IV, VRP and insufficient probability samples. Pair-metadata failures remain explicit. Tick validation is reported once at the applicable gate, avoiding duplicate rejection entries.

## 5. NSE structural adaptations completed

NSE_RESEARCH_V1 selects lower PE hedges for Bull Put and higher CE hedges for Bear Call by actual listing positions. Invalid/missing required hedges remain unavailable. Metadata controls lot/tick/expiry, never assumed intervals or expiry weekdays. Existing nonuniform-grid and missing-intermediate-metadata regressions remain passing.

## 6. Instrument/universe validation

The BOD universe derives eligible stock/index identities from current non-expired NSE option listings. Ambiguous symbols are excluded, lot parsing is integral and stale retained identities require a current authoritative refresh. Existing tests cover dynamic universe and identity failure behavior. Current live universe membership and provider publication freshness were not independently fetched in this pass; a local fetch date does not certify the source's publication age.

## 7. Historical/session validation

Duplicates, malformed/skipped rows, non-finite/non-positive prices, invalid OHLCV, out-of-range dates and known missing/unexpected sessions block eligibility. Source ordering is recorded and parsed bars are sorted. Nothing is forward-filled or manufactured. Minimum history and sample thresholds are unchanged.

A covering SessionCalendar can validate expected completed sessions, including special sessions. No authoritative full-lookback live calendar is available in the current integration, so absence of missing sessions is UNVERIFIED. A current-day candle is conservatively unavailable without completed-session evidence even after normal closing time; the application does not infer finality from a guessed clock cutoff. It becomes prior-day evidence on a later date, still subject to the other checks. Raw rows remain available separately from parsed analysis bars.

## 8. Corporate-action policy

RAW PROVIDER HISTORY: original candle rows, including malformed rows, are retained in raw_provider_rows. ANALYSIS HISTORY: parsed, time-ordered provider OHLCV without price-factor or volume transformations. No silent dividend adjustment or split inference occurs. Known malformed/duplicate/session defects block analysis; unresolved corporate-action semantics are visibly warned in the existing raw-input research mode.

Splits, bonuses and consolidations require verified price/share conversion factors. Rights, mergers and demergers require issuer-specific evidence; dividends require an explicitly chosen economic-return treatment. Changed lots apply through current matched contracts and cannot establish historical return adjustment. Historical volume across these events is unverified. No factor is inferred from a large daily move. A future authoritative adjustment source must preserve raw rows and transformation provenance. Yahoo auto_adjust matching is no longer presented as the NSE objective.

## 9. Spot/observation-time policy

OTM classification, cushion, strike proximity and historical terminal-return thresholds use the final supplied historical close. Discovery ATM selection also uses its historical reference close. Chain spot is displayed separately as diagnostic evidence. Current option quotes and historical spot are not synchronized; the UI explicitly says so. Reference date is exposed. This is a historical-close-reference research view, not a completed-close option-book snapshot or synchronized live scanner.

## 10. Expiry validation

Only listed contract dates are considered. Expired and less-than-three-calendar-day expiries are excluded. Target and actual DTE remain distinct. Explicit overrides must be listed. Nearest-distance ties now prefer the earlier expiry independent of source order. No weekly/monthly holiday dates are manufactured.

## 11. Strike/hedge validation

Existing tests cover different strike ladders, both directions, multiple listed steps, missing intermediate quotes/metadata, conflicting lot/tick data and nonuniform widths. Each opportunity retains requested steps, actual strikes, actual width and tick-derived midpoint-credit quantum. The quantum is mathematical granularity, not a profitability threshold.

## 12. Quote/liquidity validation

Both legs require valid positive non-crossed quotes, normalized OI and the configured bid/ask fraction. Native legs additionally require matched contract/tick data and grid-compatible quotes. Invalid quote rows are removed before the considered-candidate funnel; missing hedge rows are never skipped to reinterpret width. Rejection reasons describe the failing gate rather than calling all failures illiquid. The native considered funnel reconciles to final candidates plus first rejection records in offline acceptance.

## 13. IV validation

Option Chain IV percentage points are divided by 100. V3 Option Greeks IV is decimal and remains decimal. Positive chain IV is preferred; matched fallback is used only when needed. Missing IV remains unavailable. Final details expose raw IV, decimal IV and endpoint source. Discovery ATM-IV/RV21 and selected-short-leg IV/RV21 remain separate.

## 14. OI validation

Raw quantity divided by the exact matched contract lot yields integral contract-count OI. Invalid/non-integral mapping remains missing. Zero is preserved as zero. Both raw quantity and normalized contracts, lot and normalization status are exposed in final-leg details. No threshold compares quantity OI directly with contract-count min_oi.

## 15. Lot/tick validation

Current authoritative metadata controls money and native tick grids. Missing/conflicting lots or ticks reject native pairs. Baseline unavailable lot metadata now yields null INR economics without a crash. Fixture lots/ticks remain explicitly synthetic. No assumption of 100 shares is used for actual-lot amounts.

## 16. Earnings/event validation

Indices have no company earnings filter. Stocks retain date acquisition and historical-gap calculation; missing historical/upcoming evidence blocks the required earnings input. Source notes now explicitly state unknown announcement timing and uncertified symbol/company and historical coverage. Date-only evidence does not establish before/during/after-market release timing. Source dates/coverage are not independently certified by passing software tests.

## 17. Probability validation

The existing rounded DTE × 252/365 horizon, historical forward terminal returns, directional thresholds, minimum sample gate and event adjustment remain unchanged. Sample count is exposed beside raw/adjusted probability and approximate sessions. Samples overlap. The estimate describes terminal directional threshold exceedance, not an intraperiod path-breach model or calibrated probability.

## 18. Credit/RoR/risk validation

Midpoint credit = short midpoint minus long midpoint. Width minus credit is gross payoff maximum loss per unit; RoR uses that denominator. Positive/less-than-width credit and native tick checks remain enforced. Bid/ask and midpoint inputs are inspectable. Indicative midpoint credit does not guarantee executable premium.

## 19. EV/score semantics

Ranking remains stable descending rounded model EV with its existing 100-unit convention, including negative scores. The UI calls it a model score. The additive actual-lot scaling is labeled a simplified model score per lot; neither is presented as guaranteed expected INR profit. No terminal-payoff model redesign occurred.

## 20. INR/lot validation

Unrounded midpoint credit and payoff maximum loss are multiplied by matched NSE lot and rounded only for money presentation. Regression tests recompute credit/lot from leg inputs. Precise credit filtering/sorting regressions still pass. ₹ payoff maximum loss per lot replaces ambiguous maximum-loss labeling.

## 21. Settlement/risk communication

Stock options are physically settled and may require delivery/funding at expiry. Index options are cash settled. The UI distinguishes gross payoff maximum loss from broker margin/capital and states broker square-off policies are not modeled. Sources checked: [NSE individual securities](https://www.nseindia.com/static/products-services/equity-derivatives-individual-securities), [NSE settlement mechanism](https://www.nseindia.com/static/products-services/equity-derivatives-settlement-mechanism). No broker-specific obligations are calculated.

## 22. Discovery validation

Dynamic universe history/IV stages, unavailable states and partial refresh behavior retain regression coverage. History attempted/available and ranking cache age/status are now visible. Cache age is ranking-result age, not quote age. Latest FAILED/EMPTY/PARTIAL attempts remain distinct from the last successful ranking. Missing IV earns no measured-VRP percentile contribution.

Offline fixture acceptance: universe 4; history attempted/available 4/4; IV attempted/available 4/4; ranked 4; provider errors 0; runtime 0.08s. Evidence: tmp/spread-audit/completion-fixture-discovery.json. These are synthetic workflow counts, not live NSE counts.

## 23. Scan/funnel validation

Batch responses now expose requested_count and SUCCESS/PARTIAL/UNAVAILABLE alongside scanned/unavailable counts. Existing per-name failures remain isolated. Native rejection diagnostics span all considered gates. Zero results remain valid and no thresholds were weakened.

Fixture batch: BANKNIFTY, HDFCBANK, NIFTY, RELIANCE; requested/scanned 4/4; unavailable 0; funnel considered/cushion/friction/paired/RoR/VRP/final = 96/42/32/32/32/32/32. First rejections 64; final candidates 32. All four underlying funnels reconcile. Evidence: tmp/spread-audit/completion-fixture-acceptance.json.

## 24. Frontend validation

Full frontend suite passes, including expanded raw OI/leg-input rendering, sample count, unavailable values and revised terminology. Full production build passes. UI presents per-underlying observation/freshness/history/settlement/cost notes and expandable leg inputs. This is component/hook verification; no new live browser rendering acceptance is claimed.

## 25. Data freshness

Scan fetch-completion time is recorded with IST offset. Provider per-leg quote timestamp/age remain UNKNOWN; fetch time is not described as an exchange quote timestamp. Discovery records ranking cache age and CACHED/STALE/UNKNOWN plus latest attempt/last success. Historical same-day finality is conservative as described above. Sources checked: [Upstox Historical Candle V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/).

## 26. Failure handling

Current full tests exercise provider/transport failures, retry/quota behavior, missing/invalid IV/OI/lot/tick/history, stale identities, partial discovery and scans, invalid quote/hedge cases, unavailable earnings and zero results. Added regressions cover non-finite quotes, missing-lot crash, current-day finality, expiry order and explainable native results. Unknown external data is not replaced with zeros or invented estimates.

## 27. Performance measurements

Four-underlying native fixture batch: 0.282s wall time, API rounded elapsed 0.3s. Fixture discovery: 0.08s. No real provider requests or quota waits occur in these measurements. Fresh full-universe/50-name Upstox runtime and request counts are UNVERIFIED. Existing safe request scoping, caching and quota implementation retained; no architecture or worker/database redesign.

## 28. Live acceptance evidence

Not performed: no running authenticated environment was available. Historical captures and fixture acceptance are not fresh live acceptance. Prior B1–B8 report records an earlier disconnected browser attempt; it is not claimed as today's observation. Current low/medium/high stock, NIFTY/BANKNIFTY live reconciliation remains dependent on an already connected provider environment.

## 29. Test totals

- Full Python: 276 passed, 6 existing warnings. Global Python used because the local venv lacks numpy; no dependency files were changed.
- Full Node: 233 passed, 0 failed, serialized files; 158.813s.
- Full frontend: 73 passed across 12 files.
- Production build: PASS; existing large-chunk warning.
- git diff --check: PASS; existing CRLF conversion notices only.

Logs: tmp/completion-python-full.log, tmp/completion-node-full.log, tmp/completion-frontend.log, tmp/completion-build.log. An initial test run correctly caught obsolete wording and cross-request timestamp equality expectations; those tests now preserve their intended assertions while allowing real fetch times to differ.

## 30. Files changed

This pass: angel-one/app/services/spreads/{api.py,engine.py,nse_calculations.py,provider.py,history_validation.py,upstox_adapter.py,discovery_adapter.py,discovery_cache.py,earnings_source.py}; angel-one/tests/{test_spread_completion.py,test_spread_nse_profile.py,test_spread_scan_audit.py}; algo-trading/src/pages/SpreadsPage/{SpreadsPage.tsx,SpreadsPage.test.tsx,DiscoveryPanel.tsx}; this report; completion evidence/logs under tmp/.

Other modified/untracked files visible in the working tree predate this pass. No Node implementation changes were needed in this pass; its existing forwarding preserves additive result fields.

## 31. Remaining limitations

Raw corporate-action/volume treatment and session-calendar coverage remain unverified. Current-day history can make analysis unavailable conservatively. Quote timestamps and synchronized observation times are unavailable. Earnings timing/issuer mapping/coverage remain uncertain. Exact charges and net executable credit are null/unverified; no schedule or broker assumptions are invented. No fresh live performance certification or browser acceptance.

## 32. Backtesting-only questions

DTE, listed steps, OI, spread fraction, cushion, RoR, VRP, candidate depth, earnings penalty, sample sufficiency, overlapping-window effects and probability calibration require chronological NSE evaluation. A realistic terminal-payoff/cost-aware EV model and economic minimum-credit policy require historical option/execution data. No profitability, safety or optimal-default claim is made.

## 33. Angel One confirmation

This pass changed only Spread implementation/tests/UI/reporting. Angel One authentication, trading, positions, monitoring, execution and ports were not modified. Existing architecture remains React 5173 → Node 5000 → Python 8000.

## 34. ZERO-order confirmation

ZERO Upstox orders were placed. Validation used local fixtures/tests and documentation reads. No execution code was added. Security hardening/audit was outside this request; this is an action/scope confirmation, not a security certification.

## A. COMPLETED NOW

Deterministic NSE workflow corrections, B1–B8 regression verification, listed contract construction, missing-data correctness, final-leg input provenance, gross INR economics, model-score terminology, observation/finality policy, native first-rejection diagnostics, discovery status/cache visibility, partial failure handling and full automated tests/build. Offline discovery and representative four-name native scan acceptance pass.

## B. BLOCKED BY EXTERNAL DATA / PROVIDER

Fresh authenticated live acceptance and 50-name/provider performance; authoritative full-lookback completed-session calendar; verified corporate-action/volume adjustments; provider quote timestamps; certified earnings issuer/timing/coverage; broker/order-specific charges, margin, delivery and square-off details. Current software reports these as unavailable/unverified rather than fabricating values. Completing live acceptance requires a running connected environment, not code changes or secrets in chat.

## C. REQUIRES NSE BACKTESTING

Strategy thresholds and defaults, probability/event calibration, effective sample sufficiency, realistic payoff EV, execution/cost effects and profitability. These are research questions, not deferred software bugs.

## D. ACTUAL REMAINING DEVELOPMENT

No confirmed deterministic software defect identified in this completion pass remains unfixed. External-data integrations and fresh live/browser acceptance remain unverified as listed in B; this does not certify those paths as passing or imply that future provider evidence cannot reveal additional defects. Security work was explicitly excluded.
