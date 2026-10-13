# Phase 1 — Original discovery baseline

Completed 2026-10-12. Source: uploaded `Downloads/spread-terminal.zip`, read directly. This phase changes documentation and offline test artifacts only; application behavior, environments, broker workflows and routes are unchanged.

## Original behavior

Discovery and spread scanning are separate pipelines. Discovery ranks underlyings; selecting names then runs the five-layer spread scanner. Discovery does not calculate a predicted profit percentage.

### Universe acquisition (provider-specific)

`main.py` starts with core pillars `SPY, QQQ, IWM, NVDA, TSLA, MU`, then Yahoo `most_actives` and `day_gainers` screeners, requesting 30 quotes per screener. It preserves first occurrence, caps the merged universe at 40 and tries to reach at least 30. It tops up with the original emergency list; on failure it returns the normalized 20-name emergency fallback. Thus the fallback is smaller than the 30-name target.

US symbol normalization allows alphabetic symbols of length 1–5 only. Quote eligibility allows missing quote type or EQUITY/ETF, rejects reported prices below $5 and reported volume below 1,000,000, and rejects invalid numeric values. Missing price/volume are accepted by this best-effort sourcing check. Those are US/Yahoo acquisition rules, not scanner formulas; carrying the dollar threshold or five-character restriction into NSE would be incorrect. Phase 2 must explicitly document the replacement NSE F&O universe rather than claim identical Yahoo name selection.

### Stage 1 — unchanged calculations

- Six workers fetch `period="4mo", interval="1d", auto_adjust=True` for every universe name.
- Reject history shorter than 30 rows. Independently drop missing Close and Volume; require at least 22 values in each.
- Spot = latest remaining close. Daily change = `(latest / previous - 1) × 100`.
- Average volume = mean of `volume[-21:-1]`, excluding the latest observation. Shock = latest volume / that mean, or zero if the mean is non-positive.
- RV21 = sample standard deviation (`ddof=1`) of the latest 21 non-missing log returns, multiplied by `sqrt(252)`; unknown if fewer than 21 log returns.
- Display rounding: spot 2, daily change 2, RV21 4, shock 2 decimals. Keep unrounded spot/RV internally for stage 2.
- `shock_pass` is strictly raw shock `> 1.5`; it is not a comparison of the rounded display value. Per-name acquisition errors drop that name without aborting discovery.

### Stage 2 — unchanged calculations

- Stable descending sort by **rounded shock**, then select the first 10 names. Only those receive option-chain requests, using six workers.
- Pick expiry nearest 14 calendar days, excluding DTE below 3. First encountered expiry wins equal-distance ties.
- Clean quotes using the original chain cleaner. Per side, drop missing/non-positive IV and select the three strikes nearest unrounded spot; combine both sides and take NumPy median IV.
- VRP14 = unrounded ATM IV / unrounded RV21 if RV21 is positive and IV is available.
- IV display rounds to 4 decimals; VRP display to 2. `vrp_pass` compares **raw** VRP strictly `> 1.20`.
- Names outside the shortlist keep IV/VRP unknown, not zero. Failed stage-2 requests retain the stage-1 item with unknown IV/VRP.

### Ranking and response

Pandas percentile ranks use rounded `vrp14` and rounded `shock`, `rank(pct=True, na_option="bottom")`, with default average ties. Missing VRP ranks at the bottom of the ascending rank operation as in the source; do not substitute zero or redesign this behavior. `edge = vrp_pass & shock_pass`; score is the sum of both unrounded percentile ranks. Sort descending by edge and score **before** rounding score to 2 decimals. Preserve pandas sorting behavior; do not add a new alphabetical tie-breaker.

Remove `_rv21_raw`, `_spot_raw`, `vrp_rank` and `shock_rank` from returned records; replace non-finite floats with null. Returned fields: `ticker, spot, chg, rv21, iv14, vrp14, shock, vrp_pass, shock_pass, edge, score`.

Trending envelope: `updated, refreshing, top` (first five), `all` (full ranking), `universe` (source/size). TTL is 15 minutes. Original trending serves stale results while refreshing; forced Discover invalidates the timestamp and waits. Concurrent refreshes wait for one refresh, polling every 0.5 seconds. Empty refreshes preserve previous items. Original startup performs discovery; the accepted integrated UX instead uses an explicit Discover button and never automatically launches spread scans. `trending_scan` is a backward-compatible alias to `edge_discovery` in the ZIP.

## Preservation / destination checklist

| Original function | Destination | Phase 1 status |
|---|---|---|
| `_normalize_symbol`, `_quote_is_liquid` | NSE universe adapter, phase 2 | Source rules captured and oracle-tested; explicit provider adaptation required |
| `_fetch_screener_symbols`, core/emergency lists, `_get_active_universe` | NSE F&O universe service, phase 2 | Provider boundary documented; Yahoo endpoints/lists will not be represented as Upstox equivalents |
| `edge_discovery.stage1` | `engine.edge_discovery_metrics` + discovery provider orchestration | Existing calculations compared to untouched source; four-month acquisition still to implement |
| Rounded shock shortlist | `engine.edge_discovery_shortlist` | Existing helper; original top-ten acquisition selection tested |
| `pick_expiration` | Existing engine helper + discovery service | Existing helper; 14-day orchestration to wire in phase 4 |
| `safe_option_chain._clean` | Existing `engine._clean_frame` / adapter | Existing pandas cleaner; provider quote adaptation retained |
| `_atm_iv` | Existing `engine.atm_iv` + discovery service | Source nearest-three/median reference baseline added; orchestration pending |
| `edge_discovery.stage2` | Discovery service + `rank_edge_discovery` | Existing calculation helper; worker/provider orchestration pending |
| Thresholds, percentile score, ordering, null serialization | `engine.rank_edge_discovery` | Original pipeline oracle comparison exists; retained raw-threshold and ranking behavior |
| `trending_scan` | Discovery compatibility wrapper, phase 4 | Not exposed; do not claim implemented |
| `_refresh_trending`, `TRENDING_TTL` | Discovery in-memory cache/orchestrator, phase 5 | 900-second TTL, single refresh and empty-refresh behavior captured |
| `_trending_payload`, `_json_safe` | Discovery API serializer, phase 5 | Exact reference response tested; integration pending |
| `api_trending`, `api_discover` | Node/private Python discovery routes, phase 5 | Not implemented in this baseline phase |
| Trending/discovery UI, select/add names | React discovery component, phase 6 | Intended fields and top-five/full list captured; no new UI in phase 1 |
| Five-layer spread engine and EV ranking | Existing scanner | Separate from discovery score; unchanged |

## Data limitations to retain

Upstox acquisition must supply daily Close/Volume, expiries, bid/ask/OI and IV. The original four-month discovery request must not be silently replaced with the three-year scan-history contract or its 270-close gate. Index volume may be absent/non-comparable; never borrow futures volume or fabricate volume shock. Missing volume or short history should make a name ineligible under the original stage-1 rules.

Stock corporate-action-adjusted close equivalence is still unverified. Earnings are not used by discovery, so missing earnings alone must not block a discovery row. They are required by the separate original stock spread event layer; discovery availability does not certify full stock scan availability. OI/completeness verification notes remain non-blocking under the user's latest instruction.

## Evidence and completion

- `angel-one/tests/fixtures/spreads/original_screener.txt`: untouched original screener, SHA256 `6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa`.
- `original_main.txt`: untouched original API/universe source, SHA256 `e11cfa47f7f6638943c8f7f8bc1e281360c2ddd546e304c0591b966c70426a13`.
- `discovery_baseline_manifest.json`: source hashes and exact original function line locations.
- `test_spread_discovery_baseline.py`: nine offline reference tests covering source identity, provider rules, history gates/request contract, shortlist/unknown IV, ATM median and top-five/null-safe response.
- Existing audit oracle tests additionally compare full discovery ranking and raw VRP threshold rounding against the original source.

Phase 1 definition of done met: discovery methodology, defaults, fields, acquisition boundaries and destinations are recorded; reference tests pass. Phases 2–8 remain pending. No live data validation or new discovery endpoint is claimed.
