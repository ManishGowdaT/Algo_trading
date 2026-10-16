# NSE payoff research V2 — implementation and validation

Completed 16 October 2026. Implements `SPREADS_NSE_V2_IMPLEMENTATION_PLAN.md` under the user's authorization to correct the reference-price and EV methodology issues.

## Result

**PASS** — tested software implementation. **BACKTEST REQUIRED** — strategy/model calibration. **UNVERIFIED** — fresh authenticated V2 browser/provider run and real-money readiness.

The new explicit `NSE_PAYOFF_RESEARCH_V2` profile is the frontend default. API callers must request it explicitly; the API's original default remains unchanged. `ORIGINAL_ZIP_BASELINE` and `NSE_RESEARCH_V1` remain available for historical reproduction. Neither original calculation module was modified (source comparison accounts for Windows line endings).

## Corrections

- V2 requires a positive finite chain-reported spot and uses it for OTM selection, proximity, cushion and projected terminal prices. No previous-close fallback. Completed historical candles remain unchanged and supply RV and return scenarios only.
- Each historical horizon return is projected onto that reference spot. Both option legs' expiry intrinsic values determine net payoff, including partial profits/losses between strikes and capped losses beyond the hedge. The average is retained at full precision, then scaled to the existing 100-unit ranking convention or actual NSE lot. Rounding the score does not determine lot money.
- V2 removes the uncalibrated earnings probability uplift from its score. Earnings availability checks, flags and source metadata remain. Historical scenarios are unconditional and already include event periods; they do not establish conditional future earnings risk. V1's original penalty remains unchanged.
- API/UI explicitly distinguish the versioned payoff model, reference spot, historical terminal-breach frequency, historical loss frequency, sample count, earnings treatment and costs/freshness limitations. Negative scores remain valid and are retained.
- Filter defaults and construction/liquidity gates remain unchanged. No tuning to force positive scores or extra results. No order paths added; Angel One production code unchanged; ZERO Upstox orders.

## Validation evidence

| Check | Result | Evidence |
|---|---|---|
| Complete Python suite | PASS — 300 tests, six warnings | `tmp/v2-python-full.log` |
| Complete Node suite | PASS — 234 tests | `tmp/v2-node-full.log` |
| Complete frontend suite | PASS — 74 tests / 12 files | `tmp/v2-frontend-full.log` |
| Production frontend build | PASS — existing large-chunk warning | `tmp/v2-build.log` |
| Captured authenticated data replay | PASS — eight V2 candidates independently reconciled | `tmp/v2-replay.log`, `tmp/spread-audit/payoff-v2-replay.json` |
| Diff whitespace check | PASS | `git diff --check` |

New tests cover actual call/put expiry payoffs, between-strike profit, capped loss, reference-price scaling, missing/zero/negative/NaN/Infinity/bool spot rejection, API reference metadata, independent payoff/lot calculations, earnings treatment, HTTP JSON, UI default/request/rendering and Node numeric preservation. Existing baseline/V1 tests passed with the full suite.

The replay uses the real current API and Upstox normalizer against token-free raw responses captured on 16 October at approximately 09:32 IST. Independent expected values use a separately written clamped-loss equation and captured returns, not production payoff functions. At INFY chain spot ₹1,148.80, the 1140 short call is excluded as ITM. RELIANCE uses ₹1,196 rather than the previous ₹1,215 close. All eight resulting scores, cushions, lot model values and sample counts reconcile. Script: `tmp/spread-audit/verify_payoff_v2_replay.py`.

## Remaining limits and rollout

At final verification no development services were listening on 5173, 5000 or 8000. A fresh authenticated V2 scan therefore was not claimed, and credentials were not requested. Start/restart the normal frontend, Node and Python services together before using the new UI profile. Existing loaded results remain results of their labeled profile; rerun a scan to obtain V2 output.

Using the chain's supplied spot fixes the known previous-close mismatch; it does not certify exchange-level synchronization. Upstox chain responses lack per-leg timestamps, so quote age remains unknown. Equity corporate-action adjustment, earnings date/timing completeness, horizon approximation, overlapping samples, regime changes, fillability, fees, slippage and settlement obligations remain limitations. Scores are gross historical scenario estimates, not promises of expected profit, profitability or trading safety. Some scores remain negative.

This report supersedes the original final acceptance document only for V2 behavior. Its original formula-preservation statements describe the older audited release; the explicitly authorized V2 introduces a new payoff model while preserving those older profiles.
