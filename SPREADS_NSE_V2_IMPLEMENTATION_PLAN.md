# NSE reference-price and payoff correction plan

Scope authorized 16 October 2026: correct the diagnosed reference-price mismatch and binary EV approximation safely. Read-only research only; no orders or profitability claims.

1. Preserve ORIGINAL_ZIP_BASELINE and NSE_RESEARCH_V1 calculations and API defaults for reproducibility. Add explicit NSE_PAYOFF_RESEARCH_V2; select it by default in the UI. Do not silently reinterpret old results.
2. Require a positive finite chain-reported underlying spot for V2. Use that same reference for strike proximity, OTM selection, cushion and historical return thresholds. Keep completed history for RV and return scenarios; never append chain spot as a historical candle. Missing chain spot must fail rather than fall back to yesterday's close.
3. Project each observed horizon return onto the chain spot. Evaluate both option legs' actual terminal intrinsic values, subtract net liability from midpoint credit, and average the resulting per-unit payoffs. Retain the 100-unit score convention and calculate lot values from unrounded payoff means. Preserve negative scores.
4. Do not apply an uncalibrated earnings-probability uplift to V2. Retain earnings availability requirements, flags, historical event-change metadata and explicit warnings. Historical scenarios are unconditional and do not establish conditional earnings risk. V1 remains the historical comparison model.
5. Expose the profile, reference price, raw terminal breach frequency, sample count, payoff method, earnings treatment and unknown quote age in API/UI. Describe scores as historical scenario estimates before costs, not expected profit or recommendations.
6. Independently test between-strike profits/losses, both payoff directions, capped losses, invalid spots, missing history, lot scaling, API metadata, profile preservation and UI request/rendering. Replay the captured authenticated scan through V2 offline. Run full Python, Node, frontend tests and production build; record actual outcomes and blockers.

Acceptance: between-strike expiry scenarios no longer become automatic maximum losses in V2; a short call below the chain spot cannot be admitted as OTM; API and UI report the same research model and unrounded lot math. No threshold tuning. Backtest/forward testing and real-money readiness remain unverified.
