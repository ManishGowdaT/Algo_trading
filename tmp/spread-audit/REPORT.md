# Spread Terminal live scan diagnostic — 13 October 2026

Scope: temporary opt-in observation and independent replay only. No data corrections, scanner changes, Angel One changes, architecture changes or orders.

## Outcome

| Check | Status | Evidence |
|---|---|---|
| Original ZIP calculation definitions | PASS | Seven AST-identical definitions; hash-verified original screener.py |
| Candidate-by-candidate replay | PASS | All 40 successful underlyings: identical candidates, RV values, funnels and original API fields |
| Combined ranking | PASS | Stable descending rounded EV ranking identical |
| First rejection / funnel reconciliation | PASS | 853 rejected + 3 final = 856 considered |
| Market inputs | PASS for captured provenance | Same Upstox transport responses recorded; no mock/fixture market inputs in live scan |
| OI source-unit equivalence | FAIL | Raw quantity passed to contract-count filter; six candidate legs independently match NSE contracts × actual lot size |
| Adjusted-close equivalence | FAIL for sampled values; complete adjustment policy UNVERIFIED | Captured Upstox values differ from contemporaneously retrieved Yahoo adjusted closes |
| Complete NSE session coverage | UNVERIFIED | No authoritative calendar covering the entire requested range; no fabrication |
| Ten earnings-blocked stocks | UNVERIFIED / not replayed | Required historical and upcoming dates unavailable; no assumption of no earnings |
| Final fresh DOM verification | UNVERIFIED | Scan completed in browser earlier; browser tabs were gone at follow-up, so fresh displayed numeric values could not be reread |

50 requested; 40 successful; 10 blocked; 3 opportunities; 107.1 seconds. Diagnostic capture can add local processing time; this is not a benchmark of normal scans.

## Evidence

Full batch: [batch-fc89a9a5-49aa-42d3-a0d2-539e93a4bdb1.json](batch-fc89a9a5-49aa-42d3-a0d2-539e93a4bdb1.json). Every underlying links its own raw input, normalized input, earnings inputs, API response and independent replay in result.underlyings[].scan_audit.file.

Raw capture permits only approved market fields. Headers, cookies, access tokens and OAuth data are excluded. A recursive inspection of all 50 snapshots found no credential keys. Existing transport caching may apply; individual quote timestamps were not certified.

Original source SHA256: `6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa`.

## Funnel

| considered | cushion | friction | paired | RoR | VRP | final |
|---|---|---|---|---|---|---|
|856|731|19|19|13|3|3|

| First failing condition | Count |
|---|---|
|cushion|125|
|short bid/ask fraction|546|
|missing hedge strike|132|
|long bid/ask fraction|30|
|short OI|4|
|VRP|10|
|RoR|6|

All other first-failure categories have zero counts in this captured scan. Cushion: 856−125=731. Friction: 731−546−132−30−4=19. Paired:19. RoR:19−6=13. VRP:13−10=3. Historical probability: all 3 retained. No earnings-blocked stock is counted as an original candidate rejection.

## Live candidate traces

The UI-value column below names API presentation values; fresh DOM confirmation is UNVERIFIED, as noted above. Source/normalization comparisons and ZIP arithmetic comparisons are independently PASS, except OI unit equivalence, which is FAIL. Full precision and every rejected candidate are in the linked JSON snapshots.

### NMDC

Underlying: `NSE_EQ|INE584A01023`. Expiry 2026-11-23; DTE 41; BEAR CALL / CE. Snapshot [9ed69d34-cf6d-4736-9371-f4d3c7237c34.json](9ed69d34-cf6d-4736-9371-f4d3c7237c34.json).

| Field | Raw / normalized | Original calculation / API presentation | Status |
|---|---|---|---|
| History | 743 captured closes; latest {'timestamp': '2026-10-12T00:00:00+05:30', 'open': 71.99, 'high': 72.24, 'low': 70.34, 'close': 70.34, 'volume': 15649136.0, 'open_interest': 0.0} | Scanner spot 70.34 | PASS mapping; completeness UNVERIFIED |
| short contract | NSE_FO|139549; strike 75.0; CE; lot [6750] | Same contract in replay | PASS |
| short bid/ask | 1.65 / 1.69 | midpoint 1.67 | PASS |
| short IV | Option Chain 30.27 → 0.30269999999999997; source Option Chain | No V3 substitution needed for this leg | PASS mapping |
| short OI | 810000 → unchanged 810000 | Same raw value used by scanner | PASS mapping; FAIL units |
| long contract | NSE_FO|120954; strike 80.0; CE; lot [6750] | Same contract in replay | PASS |
| long bid/ask | 0.68 / 0.71 | midpoint 0.6950000000000001 | PASS |
| long IV | Option Chain 31.25 → 0.3125; source Option Chain | No V3 substitution needed for this leg | PASS mapping |
| long OI | 1019250 → unchanged 1019250 | Same raw value used by scanner | PASS mapping; FAIL units |
| credit | Calculated 0.9749999999999999 | API 0.97 | PASS replay |
| width | Calculated 5.0 | API 5.0 | PASS replay |
| cushion_pct | Calculated 6.6249644583451754 | API 6.62 | PASS replay |
| ror_pct | Calculated 24.223602484472046 | API 24.2 | PASS replay |
| vrp | Calculated 1.224918244480562 | API 1.22 | PASS replay |
| p_raw | Calculated 0.28251748251748254 | API 0.2825 | PASS replay |
| p_adj | Calculated 0.48076669977192976 | API 0.4808 | PASS replay |
| ev | Calculated -142.88334988596492 | API -143.0 | PASS replay |
| RV21 | Normalized closes → 0.24711853330943137 | API 0.2471 | PASS replay |
| Earnings | Upcoming ['2026-10-29']; event dates/gaps fully captured | inside True; max gap 4.648894668400527; horizon 28; 202/715 historical breaches | PASS replay; independent earnings-source accuracy UNVERIFIED |

### CANBK

Underlying: `NSE_EQ|INE476A01022`. Expiry 2026-11-23; DTE 41; BEAR CALL / CE. Snapshot [927a86ad-e97f-49ba-8fa5-9fb5e136a9be.json](927a86ad-e97f-49ba-8fa5-9fb5e136a9be.json).

| Field | Raw / normalized | Original calculation / API presentation | Status |
|---|---|---|---|
| History | 743 captured closes; latest {'timestamp': '2026-10-12T00:00:00+05:30', 'open': 120.0, 'high': 120.1, 'low': 117.71, 'close': 118.38, 'volume': 9100287.0, 'open_interest': 0.0} | Scanner spot 118.38 | PASS mapping; completeness UNVERIFIED |
| short contract | NSE_FO|83051; strike 125.0; CE; lot [6750] | Same contract in replay | PASS |
| short bid/ask | 3.52 / 3.64 | midpoint 3.58 | PASS |
| short IV | Option Chain 31.25 → 0.3125; source Option Chain | No V3 substitution needed for this leg | PASS mapping |
| short OI | 1086750 → unchanged 1086750 | Same raw value used by scanner | PASS mapping; FAIL units |
| long contract | NSE_FO|83064; strike 130.0; CE; lot [6750] | Same contract in replay | PASS |
| long bid/ask | 2.12 / 2.23 | midpoint 2.175 | PASS |
| long IV | Option Chain 32.23 → 0.3223; source Option Chain | No V3 substitution needed for this leg | PASS mapping |
| long OI | 1849500 → unchanged 1849500 | Same raw value used by scanner | PASS mapping; FAIL units |
| credit | Calculated 1.4050000000000002 | API 1.41 | PASS replay |
| width | Calculated 5.0 | API 5.0 | PASS replay |
| cushion_pct | Calculated 5.592160837979392 | API 5.59 | PASS replay |
| ror_pct | Calculated 39.08205841446454 | API 39.1 | PASS replay |
| vrp | Calculated 1.5610008357585747 | API 1.56 | PASS replay |
| p_raw | Calculated 0.29790209790209793 | API 0.2979 | PASS replay |
| p_adj | Calculated 0.5800723688756809 | API 0.5801 | PASS replay |
| ev | Calculated -149.53618443784046 | API -150.0 | PASS replay |
| RV21 | Normalized closes → 0.20019207731438488 | API 0.2002 | PASS replay |
| Earnings | Upcoming ['2026-10-29']; event dates/gaps fully captured | inside True; max gap 5.2968460111317395; horizon 28; 213/715 historical breaches | PASS replay; independent earnings-source accuracy UNVERIFIED |

### GAIL

Underlying: `NSE_EQ|INE129A01019`. Expiry 2026-11-23; DTE 41; BEAR CALL / CE. Snapshot [4ef44e78-8fe4-41f4-84e0-6355e1e2a24c.json](4ef44e78-8fe4-41f4-84e0-6355e1e2a24c.json).

| Field | Raw / normalized | Original calculation / API presentation | Status |
|---|---|---|---|
| History | 743 captured closes; latest {'timestamp': '2026-10-12T00:00:00+05:30', 'open': 167.75, 'high': 169.82, 'low': 166.91, 'close': 166.91, 'volume': 8839150.0, 'open_interest': 0.0} | Scanner spot 166.91 | PASS mapping; completeness UNVERIFIED |
| short contract | NSE_FO|91873; strike 175.0; CE; lot [3550] | Same contract in replay | PASS |
| short bid/ask | 2.97 / 3.1 | midpoint 3.035 | PASS |
| short IV | Option Chain 21.97 → 0.21969999999999998; source Option Chain | No V3 substitution needed for this leg | PASS mapping |
| short OI | 266250 → unchanged 266250 | Same raw value used by scanner | PASS mapping; FAIL units |
| long contract | NSE_FO|91876; strike 180.0; CE; lot [3550] | Same contract in replay | PASS |
| long bid/ask | 1.72 / 1.81 | midpoint 1.7650000000000001 | PASS |
| long IV | Option Chain 23.44 → 0.23440000000000003; source Option Chain | No V3 substitution needed for this leg | PASS mapping |
| long OI | 568000 → unchanged 568000 | Same raw value used by scanner | PASS mapping; FAIL units |
| credit | Calculated 1.27 | API 1.27 | PASS replay |
| width | Calculated 5.0 | API 5.0 | PASS replay |
| cushion_pct | Calculated 4.846923491702117 | API 4.85 | PASS replay |
| ror_pct | Calculated 34.048257372654156 | API 34.0 | PASS replay |
| vrp | Calculated 1.2608236351241986 | API 1.26 | PASS replay |
| p_raw | Calculated 0.2993006993006993 | API 0.2993 | PASS replay |
| p_adj | Calculated 0.5766878838868719 | API 0.5767 | PASS replay |
| ev | Calculated -161.34394194343596 | API -161.0 | PASS replay |
| RV21 | Normalized closes → 0.1742511750887016 | API 0.1743 | PASS replay |
| Earnings | Upcoming ['2026-10-29']; event dates/gaps fully captured | inside True; max gap 4.492052522460277; horizon 28; 214/715 historical breaches | PASS replay; independent earnings-source accuracy UNVERIFIED |

Final rank: NMDC EV −143; CANBK EV −150; GAIL EV −161. Negative EV retained exactly as original ZIP. Original 100-unit convention retained; monetary lot metadata does not change ranking.

## OI semantics

[Upstox developer confirmation](https://community.upstox.com/t/wrong-oi-in-option-chain-data/8631/6): OI is supplied in multiples of lot size. Public profile identifies Ketan as Developer @ Upstox. [NSE option-chain page](https://www.nseindia.com/option-chain) states OI is displayed in contracts.

Independent NSE public option-chain-v3 responses are saved as nse-NMDC.json, nse-CANBK.json and nse-GAIL.json with source URLs. NSE timestamp 13-Oct-2026 15:40:00. Exact expiry/strike/CE mapping:

| Contract | Upstox OI | NSE contracts | Actual lot | Equality |
|---|---|---|---|---|
| NMDC 75 CE |810000|120|6750|120×6750|
| NMDC 80 CE |1019250|151|6750|151×6750|
| CANBK 125 CE |1086750|161|6750|161×6750|
| CANBK 130 CE |1849500|274|6750|274×6750|
| GAIL 175 CE |266250|75|3550|75×3550|
| GAIL 180 CE |568000|160|3550|160×3550|

43 of 57 nonzero comparisons across these chains matched exactly after scaling; 14 did not. Non-synchronized snapshots or provider differences could explain them, but their exact cause remains UNVERIFIED. Do not infer units from magnitude. All six final-candidate legs match, supporting the published Upstox semantics.

Recommendation for a separately authorized fix: divide quantity OI by the verified contract lot size in the adapter, retaining the original contract-count threshold. No conversion was implemented. GAIL short leg represents 75 contracts, below min_oi=100: it currently passes because quantity OI is compared with a contract threshold. This is a provider-input issue, not evidence that original math should change.

## Corporate-action equivalence

[Upstox official historical guidance](https://community.upstox.com/t/is-historical-price-adjusted-for-corporate-action/3548/4) says bonus/split adjustment only; [dividend question follow-up](https://community.upstox.com/t/historical-stock-data-are-they-adjusted-for-dividends-splits/5942) repeats that guidance. It is older guidance, not a complete current V3 adjustment contract.

Independent Yahoo histories were retrieved with auto_adjust=False to expose Close and Adj Close. These are diagnostic comparison files ONLY: no Yahoo market values entered the live scanner. Yahoo auto_adjust=True scales OHLC by Adj Close / Close. 737 common dates per stock were compared.

| Date / stock | Captured Upstox close | Yahoo Close | Yahoo Adj Close |
|---|---|---|---|
|2023-10-13 / NMDC|51.38|53.29999923706055|47.13303756713867|
|2023-10-13 / CANBK|73.3|73.30999755859375|66.70455932617188|
|2023-10-13 / GAIL|122.75|128.25|115.21147918701172|

Sampled adjusted-input equivalence is demonstrably absent. The discrepancy must not be assigned to dividends alone without a full authoritative corporate-action factor reconciliation; the complete current Upstox treatment of dividends, rights and volume remains UNVERIFIED. Smallest proposed provider-only solution: authoritative corporate-action events/factors and a verified adjusted-OHLC history adapter matching the required adjustment convention. This needs approval and evidence; no adjusted history was invented or substituted.

## Changes and tests

| File | Purpose |
|---|---|
| angel-one/app/services/spreads/scan_audit.py | New isolated whitelist capture, ZIP replay, first-rejection analysis and batch report; malformed observation cannot change transport output |
| angel-one/app/services/spreads/api.py | Optional capture flag and result metadata; flag excluded from calculation parameters |
| angel-one/app/services/spreads/earnings_source.py | Observe actual earnings dates/gaps without changing existing availability behavior |
| algo-trading/src/pages/SpreadsPage/SpreadsPage.tsx | Temporary off-by-default diagnostic checkbox and snapshot status |
| angel-one/tests/test_spread_scan_audit.py | Observation isolation, secret exclusion, unchanged outputs and 100 independent randomized rejection reconciliations |

Python: 178 passed (6 existing dependency/deprecation warnings). Node: 233 passed. Frontend: 68 passed across 12 files. Production frontend build: passed, existing chunk-size warning. New diagnostic tests are included in full Python suite; existing parity tests passed. Generated diagnostic artifacts are under tmp/spread-audit.

No scanner-calculation file was changed in this task. No OI conversion, IV normalization, thresholds, history, ranking, earnings behavior or Angel One behavior was changed. No Upstox orders were placed.

NO SCANNER FORMULA CHANGE REQUIRED.