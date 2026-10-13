# Phase A — parameter audit before strategy behavior changes

13 October 2026. Source of truth: uploaded spread-terminal.zip / screener.py. No USD/INR exchange conversion is appropriate. Existing OI normalization remains quantity divided by authoritative contract lot size. ORIGINAL_ZIP_BASELINE remains the default; NSE_RESEARCH_V1 is explicit opt-in research.

Classification: A currency/price scale; B percentage/ratio/dimensionless; C contract/market structure; D universal mathematics.

| Original parameter | Original value | Original unit / meaning | Class | Current NSE interpretation | Problem | Recommended NSE interpretation | Evidence | Action |
|---|---|---|---|---|---|---|---|---|
| US discovery price floor |5 USD|Yahoo active-universe plausibility filter|A,C|Not applied by existing full NSE F&O universe discovery|A dollar floor cannot become a rupee floor|Do not add any rupee price exclusion without NSE research|ZIP main.py _quote_is_liquid|BACKTEST REQUIRED; existing NSE universe unchanged|
| US discovery volume floor |1,000,000 shares|Yahoo active-universe liquidity sanity check|C|Not applied by existing full NSE F&O universe discovery|Universe discovery/volume semantics differ from option contract OI|No arbitrary new NSE volume floor|ZIP main.py _quote_is_liquid|BACKTEST REQUIRED; no change|
| US discovery universe |US core pillars, most_actives/day_gainers, emergency20, clamp30-40|US listings|C|Existing full authoritative NSE F&O universe|Cannot substitute US emergency list into live NSE mode|Keep existing authoritative NSE universe and full IV coverage; no fallback market data|ZIP main.py; current universe/discovery modules|KEEP existing adaptation|
| US symbol restrictions |1-5 alphabetic characters|US ticker plausibility|C|Existing NSE instrument-key identities and symbols up to30 characters|NSE symbols include digits and longer names|Keep exact NSE instrument identity mapping|ZIP main.py and template watchlist regex|KEEP existing adaptation|
| Width input bounds |ZIP UI0.5-25, API>0-100|US convenience/validation bounds|A,C|Existing NSE API range extends to5000|Not a formula or FX conversion|Keep existing fixed-points bounds; explicit NSE steps1-50 are an input safety bound, not fitted strategy settings|ZIP main.py / templates versus existing API|KEEP existing integration; profiles preserve original defaults/math|
| USD UI labels |Spot $, EV $, EV $/contract, width $|US money display|A|NSE INR money and original score|EV score is not actual lot money|INR labels for premium/money; original EV100-unit score explicitly separate|ZIP templates/index.html lines221,333,380,428|CHANGE display only|
| width |5|Underlying price points, USD per share for US stocks|A,C|Fixed 5 INR price points|Many NSE chains have different/non-uniform strike ladders|Explicit NSE profile: user-selected number of actual listed hedge steps; no fabricated or skipped missing strikes|Captured NMDC/CANBK/TATAELXSI contracts; NSE individual securities contract specs|CHANGE in NSE profile only|
| minimum credit |strictly >0.01|USD price points; tiny-credit exclusion|A,C|Strictly >0.01 INR|US cent floor not an NSE tick definition|Smallest positive midpoint-credit quantum = gcd(short tick,long tick)/2; quotes must respect authoritative leg ticks; no economic-profit threshold inferred|NSE FAOP70382; Upstox developer topic17796; midpoint arithmetic|CHANGE in NSE profile only|
| US payoff multiplier |100|US shares per standard option, used in EV score|A,C|Original 100-unit ranking score retained; actual lot money already separate|A ranking score must not be mislabeled actual lot P/L|Keep EV x100 score for ranking; INR credit, max loss and EV per actual lot separately|Original EV line; actual Upstox contract lot metadata|KEEP score; CHANGE display labels|
| min_vrp |1.15|IV / RV21 ratio|B|Same ratio|No currency problem|Unchanged; any market tuning requires NSE out-of-sample research|ZIP ScanParams / build_spreads|KEEP; BACKTEST REQUIRED for tuning|
| min_ror |15|Percent credit / max loss|B|Same percent|No currency problem|Unchanged|ZIP ScanParams / build_spreads|KEEP; BACKTEST REQUIRED for tuning|
| min_cushion |2|Percent short-strike distance from historical spot|B|Same percent|No currency problem|Unchanged|ZIP ScanParams / build_spreads|KEEP; BACKTEST REQUIRED for tuning|
| max_spread_pct |0.10|Bid/ask width / midpoint|B,C|Same dimensionless liquidity fraction|Different NSE liquidity is not evidence for a new threshold|Unchanged|ZIP friction_detail / passes_friction|KEEP; BACKTEST REQUIRED for tuning|
| min_oi |100|Contracts|C|Upstox quantity / exact lot = contracts|Previously fixed unit defect; do not undo|Unchanged 100-contract gate; raw quantity preserved|Prior six-leg NSE reconciliation|KEEP; BACKTEST REQUIRED for tuning|
| target DTE |30|Calendar days|C|Nearest actual NSE expiry|No basis for changing target|Keep nearest actual expiry and earlier-expiry tie order|ZIP picker, existing sorted NSE expiry integration|KEEP; BACKTEST REQUIRED for tuning|
| minimum expiry DTE |3|Calendar days|C|Same exclusion|No evidence to retune|Unchanged|ZIP pick_expiration|KEEP|
| max_strikes |12 per side|Nearest OTM short candidates|C|Same 12 per side|NSE listing depth varies; not a conversion|Unchanged|ZIP build_spreads|KEEP; BACKTEST REQUIRED for tuning|
| weekly/monthly expiries |Provider listing|Actual listed dates|C|Authoritative contracts|Cannot infer dates from weekday assumptions|Use existing listed dates; no new calendar assumptions|Upstox option-contract API|KEEP|
| stock vs index options |US underlying identity|Instrument metadata|C|NSE_EQ/NSE_INDEX plus CE/PE keys|Different lots/strikes/ticks|Exact leg identity, expiry, lot and tick required|Upstox option-contract API|CHANGE metadata interpretation only|
| RV windows |10,21,63,252|Trading observations|D|Same|No currency problem|Unchanged|ZIP realized_vols|KEEP|
| log returns / ddof |log(Ct/Ct-1),1|Dimensionless sample volatility|D|Same|Adjusted-input parity unresolved|Unchanged mathematics, explicit input warning|ZIP realized_vols; prior history audit|KEEP|
| annualization |sqrt(252)|Trading days/year|D|Same|No evidence to change|Unchanged|ZIP constant|KEEP|
| history |3 years; at least270 closes|Lookback and eligibility|C,D|Upstox returned history|Adjustment and session coverage unresolved|Do not fabricate or tune around missing parity|ZIP fetch_history; prior diagnostic|UNVERIFIED inputs; KEEP math|
| breach horizon / minimum sample |round(DTE*252/365),>=60|Trading observations|D|Same|No currency problem|Unchanged|ZIP empirical_breach_prob|KEEP|
| earnings penalty |same capped formula, cap0.95|Probability|D|Yahoo earnings dates plus Upstox event-close gaps|Price adjustment/source accuracy still separate|Unchanged; never missing earnings=no earnings|ZIP apply_earnings_penalty|KEEP|
| midpoint |(bid+ask)/2|Price points|D,A|INR option premium per unit|Midpoint is indicative, may be half tick|Same formula; never presented as guaranteed execution|ZIP friction_detail|KEEP|
| credit / max loss |shortmid-longmid / width-credit|Price points|D,A|INR per unit|Actual lot multiplier needed|Unchanged; multiply unrounded values by actual equal leg lot for money|ZIP build_spreads; actual contracts|KEEP math; CHANGE labels|
| credit>=width |Reject|No-arbitrage/risk gate|D|Same|No currency problem|Unchanged|ZIP build_spreads|KEEP|
| EV |(credit*(1-p)-maxloss*p)*100|Original score|D,A|100-unit convention|Not actual lot rupees|Same probability/score/ranking, actual lot money separate|ZIP EV / main sort|KEEP|
| rounding |credit2,RoR1,cushion2,VRP2,IV/RV4,p4,EV0|Presentation/ranking|D|Same original fields|Midpoint credits can need more than2 decimals|Keep original fields and rounding; additive unrounded INR price fields for display|ZIP candidate output|KEEP original; ADD precise display|
| final ranking |stable descending rounded EV|Score ordering|D|Same including negatives|No evidence for new ranking|Unchanged|Original main.py sort|KEEP|
| discovery volume shock |latestvolume / previous20 mean; >1.5|Ratio|B,D|Same|Index volume remains provider capability issue|Unchanged, no tuning|ZIP discovery|KEEP|
| discovery VRP / expiry / ATM |VRP>1.20; target14; median nearest3 valid IV per side|Ratio / calendar days / observations|B,C,D|Full eligible NSE universe now attempted|Coverage was intentionally expanded previously, not retuned here|No change in this task|ZIP discovery + existing integration|KEEP|
| discovery score |VRP percentile + shock percentile; edge then score|Dimensionless rank|B,D|Same|No currency issue|Unchanged|ZIP discovery|KEEP|
| Yahoo auto_adjust=True |Adjusted OHLC|Input semantics|C|Upstox closes not equivalent|Confirmed sampled mismatch|Keep FAIL/UNVERIFIED explicit; separate provider research required|Prior diagnostic report|UNVERIFIED; NO FIX HERE|

## Evidence and Phase B decision

- NSE stock-option tick revision: https://nsearchives.nseindia.com/content/circulars/FAOP70382.pdf. Tick selection is reviewed monthly; never infer current option tick from current spot.
- Upstox contract schema: https://upstox.com/developer/api-documentation/get-option-contracts/.
- Upstox developer confirmation: https://community.upstox.com/t/title-clarification-required-bod-json-tick-size-5-0-vs-nifty-option-price-step-0-05/17796/2. JSON and option-contract tick_size use paise; divide by100 for INR. No scale inference from magnitude.
- NSE listing structure: https://www.nseindia.com/static/products-services/equity-derivatives-individual-securities.
- Captured real contracts contain nonuniform strike ladders. One hedge step means the next listed strike in the risk-defined direction (down for Bull Put, up for Bear Call); multiple steps follow the listing, not a guessed constant spacing. If the selected listed contract lacks a usable quote, reject it rather than jump to a farther strike.
- The positive midpoint-credit quantum is a mathematical inference from the two authoritative quote ticks, NOT an exchange rule for minimum executable spread credit or an economic profitability threshold. Execution costs and appropriate economic minimums require backtesting. No execution claims or orders.
- Missing/conflicting lot, tick, identity or off-grid quotes are explicit NSE-profile validation failures, never guessed. Baseline keeps its original behavior.

This audit was written before implementing the separate NSE profile. Only width selection, tick-derived positive-credit granularity and INR/lot/profile presentation are authorized adaptations. No threshold optimization.

## Scope clarification

The baseline is the untouched ZIP calculation/configuration profile on the existing integrated provider. It does not reintroduce Yahoo US active-universe acquisition, US fallback tickers or US-only UI symbol restrictions. Those provider/universe adaptations predate this task and are explicitly recorded above. API and UI convenience bounds already extended for NSE remain as previously integrated; original ScanParams defaults and formulas remain the oracle.
