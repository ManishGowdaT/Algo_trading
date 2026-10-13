# Spread Terminal data-semantics validation — 13 October 2026

Status: PARTIAL. Code investigation, observational diagnostics and regressions are complete. Live raw-response-to-UI validation is deferred at the user's explicit request: “Continue with code/tests; live trace later”. No captured live candidate is presented as verified in this report.

## Warning findings

| Warning | Root cause and evidence | Status / action |
|---|---|---|
| OI unit equivalence | `/v2/option/chain` documentation calls `market_data.oi` “Open interest” without specifying lots, underlying quantity or contracts. The historical-candle endpoint separately defines its OI slot as outstanding derivative contracts; this does not establish the option-chain endpoint's unit. The ZIP passes Yahoo `openInterest` directly into the integer `min_oi` comparison (default 100), without lot multiplication/division. | UNVERIFIED. No conversion made. Divisibility by lot size or examples alone would not prove a unit. Warning retained. |
| Daily-candle completeness | The adapter sorted returned timestamps and silently skipped malformed rows; it had no full-range exchange-session calendar or validation details. Sorting cannot prove complete coverage. | Structural diagnostics FIXED. Full-range NSE session completeness remains UNVERIFIED in live mode. Missing-session list is null, not an invented empty list, when a calendar is absent. |
| Corporate-action adjustment | ZIP calls Yahoo history with `auto_adjust=True`. Upstox V3 documents OHLCV slots but no split/bonus/dividend adjustment policy, adjustment flag or equivalent adjusted-close field. | UNVERIFIED. Neither equivalence nor “definitely unadjusted” is established. Warning retained. No adjustment or alternate price data introduced. |

Authoritative references inspected:

- [Upstox option chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/): OI and IV field descriptions.
- [Upstox historical candles V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/): timestamp/Open/High/Low/Close/Volume/OI array slots, inclusive end date. No adjustment guarantee found.
- [Upstox market holidays](https://upstox.com/developer/api-documentation/get-market-holidays/): annual endpoint covers the current year; a per-date endpoint exists. This alone is not a retrieved, validated three-year completed-session calendar (special sessions and actual close times matter).
- Original uploaded `C:/Users/Manish gowda/Downloads/spread-terminal.zip`, `spread-terminal/screener.py`, SHA256 `6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa`.

The missing semantics must be confirmed for the exact API endpoint/version. A general definition of open interest does not resolve whether a vendor serializes it as units or lots.

## Data path and changes

History: Upstox transport data.candles → indices 0..6 → PriceBar timestamp/O/H/L/C/volume/OI → chronological sort → HistoryData → non-null closes → original realized_vols and build_spreads → API underlyings/candidates → Spreads result table/breakdown.

Option OI: option-chain market_data.oi → `_integer` → OptionQuote.open_interest → `as_scanner_row()['openInterest']` → existing original cleaning/friction logic → `detail['oi'] >= params.min_oi` → candidate layers.l5 → frontend full breakdown. No new scaling occurs. Existing ZIP cleaning of absent OI to zero remains unchanged; it is not evidence that an upstream missing field reported zero.

IV: option-chain option_greeks.iv → adapter division by 100 → decimal impliedVolatility → original short-leg IV/RV21 → candidate VRP. This existing convention remains unchanged; no new live measurement was made.

New history diagnostics report requested dates, raw/parsed/skipped row counts, source order (ascending/descending/out_of_order), normalized ascending order, duplicate local NSE dates, invalid OHLCV dates, out-of-range dates, calendar source, missing/unexpected sessions, status and explanation. Descending responses are accepted as an input order and remain sorted as before. Duplicate rows are reported and retained, not silently deduplicated. Malformed rows continue following the existing skip behavior, now with an explicit count. No missing bars are created; no close or volume value changes.

`HistoryData.validation` is additive. `scan_provider_data` forwards it as `history_validation` even on capability-blocked scans and appends diagnostic text to existing `data_warnings`. Node forwards that existing response. The frontend's existing “Market-data notes” renders those messages per underlying. No frontend or API calculation changes were needed in this pass.

Session comparison is implemented against an explicitly supplied `SessionCalendar` with source and full requested-range coverage. Tests exercise holidays/special Saturday sessions without a weekday heuristic. No production calendar is fabricated or injected. The live Upstox adapter currently invokes validation without such a calendar, so it cannot return VERIFIED completeness. A structure-only clean result remains UNVERIFIED; confirmed malformed/duplicate/out-of-range data reports INCOMPLETE plus the missing-calendar limitation. No new scan blocker is introduced.

## Smallest outstanding provider-layer work

1. Obtain endpoint-specific Upstox confirmation of option-chain OI units, then compare one identical instrument/date against an authoritative exchange count and its actual contract lot. Only if proven necessary, normalize OI in the adapter; retain the ZIP filter unchanged. No conversion is approved by this evidence yet.
2. Retrieve and validate an authoritative NSE completed-session calendar for the entire three-year requested interval, including exceptional weekend sessions, holidays, the current session's actual completion time, and listing/suspension eligibility. Wire it to the existing comparator. Show exact missing dates; do not fill them. A current-year holiday list cannot certify three years.
3. Obtain Upstox's versioned adjustment policy and compare actual split/bonus/cash-dividend events against authoritative raw prices and adjustment factors. If history is not Yahoo-equivalent, the smallest solution is a provider-layer adjusted OHLC series backed by verified corporate-action factors or an explicit equivalent adjusted-history source. Factor basis, ex-dates, cumulative events and already-applied adjustments must be proven before implementation to prevent double adjustment. Scanner mathematics stays unchanged. No such transformation has been implemented.

## Live stock trace — deferred, not passed

No live Upstox token was available in the inspected environment files; only OAuth application configuration was present. The accessible browser inventory had no authenticated tab. Tokens were not extracted from browser storage or process memory. User explicitly chose live validation later. Previous screenshots and old reports are not a fresh raw-response trace.

The following table documents exact mapping/calculation targets. “Not captured” means all five stages of a new real candidate remain UNVERIFIED, even where code-level mapping tests pass.

| Field | Raw → normalized → calculated → UI target | Live status |
|---|---|---|
| Underlying identity | contract/search instrument key → resolved underlying key → scanner ticker → table underlying / API instrument_key; not captured | UNVERIFIED |
| Expiry | contract expiry → date → existing nearest-target-DTE selection or override → table expiry; not captured | UNVERIFIED |
| Option type | CE/PE → contracts and call_options/put_options → Bear Call/Bull Put → strategy badge; not captured | UNVERIFIED |
| Strikes | strike_price → numeric strike → existing exact hedge pairing → short/long strikes; not captured | UNVERIFIED |
| Lot size | contract lot_size → positive integer → existing exact-leg lot metadata → full breakdown; not captured | UNVERIFIED |
| Historical candles | candle array → PriceBar → sorted non-null closes → RV layers; not captured | UNVERIFIED |
| Scanner spot/latest close | candle[4] → close → last historical close (not chain spot) → per-underlying diagnostics; not captured | UNVERIFIED |
| Volume | candle[5] → volume → original discovery volume shock → discovery row; not captured | UNVERIFIED |
| Bid/ask | market_data bid_price/ask_price → numeric quotes → original liquidity/friction → breakdown; not captured | UNVERIFIED |
| Midpoint | bid/ask → quote → (bid+ask)/2 → credit calculation; not captured | UNVERIFIED |
| OI | market_data.oi → integer preserved → original min_oi filter/layers → OI breakdown; not captured and unit unresolved | UNVERIFIED |
| IV/normalization | option_greeks.iv → /100 → short-leg decimal IV → full breakdown; not captured | UNVERIFIED |
| RV21 | candle closes → close series → sample std(log returns), last 21, annualized sqrt(252) → full breakdown; not captured | UNVERIFIED |
| VRP | normalized IV and RV21 → original IV/RV21 → rounded ratio → full breakdown; not captured | UNVERIFIED |
| Credit | bid/ask of both legs → midpoint pair → short mid minus long mid → rounded table credit; not captured | UNVERIFIED |
| Width | paired strikes → numeric values → absolute difference → full breakdown; not captured | UNVERIFIED |
| Cushion | latest history close and short strike → original directional distance % → rounded table cushion; not captured | UNVERIFIED |
| RoR | credit and width → original credit/(width-credit)*100 → rounded table return/risk; not captured | UNVERIFIED |
| Historical breach | chronological closes, DTE and cushion → original empirical_breach_prob → p_raw → breakdown; not captured | UNVERIFIED |
| Earnings adjustment | approved supplemental Yahoo earnings dates plus Upstox closes → existing gap/event inputs → original apply_earnings_penalty when applicable → p_adj; not captured | UNVERIFIED |
| EV | credit, maximum loss, adjusted probability → original expected value *100 → rounded original EV → table EV; not captured | UNVERIFIED |
| Funnel | original gate decisions → original counters → existing aggregated counts → scan diagnostics; not captured | UNVERIFIED |
| Final ranking | original rounded candidate EV → stable descending sort including negatives → combined table order; not captured | UNVERIFIED |

## Fixtures and order paths

Code-level inspection: `_mode()` selects Upstox provider in live mode; transport is restricted to official Upstox read paths and retains token-isolated response caching. There is no fixture substitution on a provider error. Synthetic data was used only in automated tests. Yahoo remains the already-authorized earnings-date source; market prices/chains are not replaced with Yahoo. No runtime claim is made that a newly observed live response is fixture-free because the requested live trace was deferred. No Upstox order request was made. No order endpoint or permission was added.

## Files changed in this task

- `angel-one/app/services/spreads/history_validation.py`: new observational structural/session comparator, no market-data generation.
- `angel-one/app/services/spreads/provider.py`: optional validation metadata on HistoryData, default preserves existing callers.
- `angel-one/app/services/spreads/upstox_adapter.py`: run diagnostics before existing timestamp sorting and attach report.
- `angel-one/app/services/spreads/engine.py`: only forward diagnostics and add warning explanation; original calculation definitions and decisions untouched.
- `angel-one/tests/test_spread_history_validation.py`: six focused tests, including special-session gaps, partial calendar, malformed rows, duplicates, ordering, unchanged OHLCV mapping.
- `angel-one/tests/test_spread_upstox_adapter.py`: assert preserved OI reaches scanner row unchanged, supplementing existing raw OI and IV normalization tests.
- `angel-one/tests/test_spread_nifty_api.py`: stale rejection boundary changed from 11 to 51 to reflect the user's previously authorized 50-name cap. This was the only initial regression failure; no production cap change here.
- This report and test/build logs in `tmp/spread-data-validation-*.log`.

Pre-existing UI and 50-name-cap working-tree changes are separate from this task. No Angel One application code, shared layout, backend production code, UI code, environment settings or dependency versions were modified in this pass. No service was restarted; new diagnostics load on the next normal Python restart.

## Regression results and parity

- Full Python: 157 passed, 6 existing dependency/deprecation warnings. Initial run found the stale 11-name boundary test; after updating only that test, full rerun passed.
- Full Node: 232 passed, 0 failed.
- Full frontend: 68 passed across 12 files.
- Production frontend build: passed; existing >500 kB bundle warning remains.
- Focused adapter/history tests: 13 passed before full run.
- ZIP AST comparison: exact matches for ScanParams, realized_vols, apply_earnings_penalty, empirical_breach_prob, friction_detail, passes_friction and build_spreads. Uploaded ZIP SHA256 recorded above. Original calculations file unmodified.
- Original discovery ranking, final EV ranking, rounding, thresholds, filters, funnel mathematics and Angel One behavior were not changed. Zero Upstox orders placed.

Conclusion: diagnostic omissions are fixed; endpoint OI units, full-history completed-session coverage, adjusted-price equivalence and the real-candidate trace remain UNVERIFIED. Warning disappearance is not a success criterion, and no warning was removed to manufacture a passing result.
