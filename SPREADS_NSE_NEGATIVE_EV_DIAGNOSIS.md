# Negative EV diagnosis — 16 October 2026

Fresh authenticated read-only scan captured at approximately 09:32 IST through the existing React → Node → Python → Upstox workflow. No orders. No production code, formulas or default thresholds changed. Temporary UI inputs used NSE_RESEARCH_V1, one listed step, 30 target calendar days, IV/RV minimum 1.0, OI minimum 100, bid/ask maximum 0.10, cushion minimum 1.5%, RoR minimum 10%. Existing NIFTY selection remained alongside INFY and RELIANCE. All three underlyings completed; eight candidates were returned.

The earlier screenshot scan was no longer in the browser, and no matching diagnostic snapshot existed. Fresh quotes differ from that screenshot. These are fresh measured inputs, not a reconstruction of the earlier quote snapshot.

## Independently verified contributions

The diagnostic script uses captured quotes and closes, with standard Python arithmetic only. It does not call production calculation functions. For all eight candidates, midpoint credit, 26-session horizon, 719 overlapping historical observations, breach counts, raw/adjusted probabilities and rounded EV matched.

`EV = 100 × (credit − actual width × adjusted probability)`

| Candidate | Breaches / samples | Raw probability | Adjusted probability | Score before earnings adjustment | Earnings change | Final rounded score |
|---|---:|---:|---:|---:|---:|---:|
| INFY Call 1240/1280 | 52/719 | 7.23% | 8.78% | 458.21 | −61.75 | 396 |
| RELIANCE Call 1320/1330 | 84/719 | 11.68% | 14.87% | −1.83 | −31.90 | −34 |
| RELIANCE Call 1290/1300 | 133/719 | 18.50% | 25.57% | −37.48 | −70.72 | −108 |
| INFY Put 1020/1000 | 155/719 | 21.56% | 28.20% | −223.65 | −132.93 | −357 |
| INFY Call 1140/1160 | 278/719 | 38.66% | 74.43% | 231.70 | −715.26 | −484 |
| INFY Put 1040/1020 | 199/719 | 27.68% | 38.65% | −271.05 | −219.43 | −490 |
| INFY Put 1060/1040 | 241/719 | 33.52% | 52.12% | −305.38 | −372.04 | −677 |
| INFY Put 1080/1060 | 291/719 | 40.47% | 77.91% | −344.46 | −748.71 | −1093 |

Differences of a hundredth in displayed contribution sums are rounding only. JSON evidence retains full precision.

## Why the scores are negative

1. **Binary payoff approximation.** Historical terminal returns beyond the short strike are assigned maximum loss, rather than the actual piecewise payoff between short and hedge strikes. This is a pessimistic approximation relative to applying actual expiry payoff to the same terminal observations. It is not a certified lower bound on real future trading returns. The probability is a terminal-return frequency, not a probability of touching the strike during the holding period.
2. **Earnings heuristic.** Both symbols were flagged inside expiry. Captured Yahoo dates list INFY 23 October and RELIANCE 21 October; these future dates were not independently certified against exchange/company announcements. Maximum event-related historical close changes used were 2.4998698% for INFY and 2.3600185% for RELIANCE. With positive gap and cushion, probability is scaled by `1 + gap/cushion`, with an additional term when the ratio exceeds one, and capped at 95%. This heuristic is not a calibrated earnings-loss probability. It turns INFY 1140/1160 negative and amplifies already-negative rows.
3. **No positive-score admission requirement.** Final candidates are retained even if their score is negative, then sorted descending. Filter qualification is not a favorable trading recommendation.

The field called historical earnings “gap” is calculated from selected daily close-to-close changes, not necessarily overnight close-to-open gaps or the correctly timed post-announcement reaction. Date-only events lack before/after-market timing. Historical windows already include earnings periods, so adding an earnings penalty may overlap risks already represented in the raw distribution; the extent requires calibration, not an arithmetic patch.

## Material reference-price mismatch

| Symbol | Calculation reference (last completed daily close, 15 October) | Underlying spot supplied with the fresh chain |
|---|---:|---:|
| INFY | ₹1,110 | ₹1,148.80 |
| RELIANCE | ₹1,215 | ₹1,196 |

Cushion, OTM selection and historical breach thresholds use the historical close. Quotes use the current fetched chain. Therefore the score combines different observation bases. For INFY 1140/1160, the short call is above ₹1,110 but below ₹1,148.80: it qualifies as OTM against the research reference but is ITM against the chain's supplied underlying spot. The displayed 2.70% cushion must not be interpreted as a current-market OTM cushion. Likewise, RELIANCE 1320 has 8.64% cushion from ₹1,215, versus about 10.37% from the supplied ₹1,196.

The chain does not provide per-quote timestamps. Fresh retrieval is established by capture time; quote-level freshness/synchronization is not certified. This was existing previous-close methodology, not a newly introduced formula error. It is a material limitation for interpreting the page as current-market recommendations.

## Conclusion

No reproduced arithmetic error in the eight captured candidates. Main causes: the short-strike-breach/max-loss approximation, earnings probability uplift, and credit small relative to width/probability. Separate data/model limitation: previous-close reference prices combined with a fresh chain. These findings do not establish profitability or validate the negative score as actual expected profit/loss. Changing the payoff model or reference-price policy would be a deliberate methodology change requiring separate validation; this diagnosis changes neither.

Evidence: `tmp/spread-audit/batch-303cd255-87d5-4f12-8ed4-23d1d09e5a88.json`, per-underlying captures referenced by that batch, `tmp/spread-audit/explain_live_negative_ev.py`, and `tmp/spread-audit/live-negative-ev-explanation.json`.
