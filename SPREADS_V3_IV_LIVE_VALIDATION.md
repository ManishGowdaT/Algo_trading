# Upstox V3 IV fallback: live validation, 13 October 2026

Implemented after live equivalence was demonstrated. No new authentication or API key. The existing Node OAuth token was forwarded through the existing authenticated expiry-read path to a temporary read-only Python audit launcher; token/header/cookie values were never saved. Normal Python startup has been restored.

## Live results

All four used the unchanged original discovery target-DTE 14 expiry picker: 2026-10-27. These measurements are API snapshots, not a guarantee of a currently executable quote.

| Underlying | Sample CE instrument / strike | Chain IV % | V3 raw IV | Normalized V3 IV | Original ATM IV (decimal) | RV21 (decimal) | VRP | Source used | Result |
|---|---|---:|---:|---:|---:|---:|---:|---|---|
| PNBHOUSING | NSE_FO|103346 / 1200.0 | 31.49 | 0.31494140625 | 0.31494140625 | 0.3137 | 0.33484074 | 0.936863 | Option Chain preferred | PASS |
| SAIL | NSE_FO|107096 / 170.0 | 31.25 | 0.3125 | 0.3125 | 0.293 | 0.39063245 | 0.750066 | Option Chain preferred | PASS |
| NTPC | NSE_FO|97941 / 310.0 | 17.58 | 0.17578125 | 0.17578125 | 0.17945 | 0.18281749 | 0.981580 | Option Chain preferred | PASS |
| APOLLOHOSP | NSE_FO|54829 / 7800.0 | 23.96 | 0.23956298828125 | 0.23956298828125 | 0.2388 | 0.34722980 | 0.687729 | Option Chain preferred | PASS |

The sample CE values above are individual quote IVs; ATM IV is the original median of the nearest three valid-IV strikes per side. Do not confuse a single-leg IV with that median.

## Scale and coverage evidence

- PNBHOUSING: observed 2026-10-13T16:33:36.790300+05:30; 42 ATM-adjacent CE/PE keys compared; 31 positive same-contract matches; maximum decimal difference 0.0000500000; V3-only comparison median 0.313720703125. Raw keyed evidence: tmp/live-v3-PNBHOUSING.json. Before-integration evidence: tmp/live-v3-before-PNBHOUSING.json.
- SAIL: observed 2026-10-13T16:33:39.280645+05:30; 50 ATM-adjacent CE/PE keys compared; 29 positive same-contract matches; maximum decimal difference 0.0000468750; V3-only comparison median 0.292968750000. Raw keyed evidence: tmp/live-v3-SAIL.json. Before-integration evidence: tmp/live-v3-before-SAIL.json.
- NTPC: observed 2026-10-13T16:33:41.656451+05:30; 50 ATM-adjacent CE/PE keys compared; 39 positive same-contract matches; maximum decimal difference 0.0000500000; V3-only comparison median 0.179443359375. Raw keyed evidence: tmp/live-v3-NTPC.json. Before-integration evidence: tmp/live-v3-before-NTPC.json.
- APOLLOHOSP: observed 2026-10-13T16:33:44.074770+05:30; 50 ATM-adjacent CE/PE keys compared; 39 positive same-contract matches; maximum decimal difference 0.0000426758; V3-only comparison median 0.238800048828. Raw keyed evidence: tmp/live-v3-APOLLOHOSP.json. Before-integration evidence: tmp/live-v3-before-APOLLOHOSP.json.

138 positive same-instrument comparisons establish V3 iv is already decimal. Chain IV is rounded percentage points; the maximum decimal discrepancy was 0.00005, consistent with that rounding. Normalization is fixed identity for V3, not a magnitude heuristic or /100 conversion.

## Important outcome and limits

- PNBHOUSING, SAIL, NTPC and APOLLOHOSP all return valid original ATM IV and VRP when directly evaluated at the discovery expiry. V3 valid values exist for all four. All V3 requests succeeded; no fabricated or fixture prices, IVs or OI were used.
- For the 50 ATM-adjacent keys per stock, there were zero cases where V3 supplied a positive IV while the chain supplied missing/zero IV. Therefore actual live rescue of a missing value is UNVERIFIED; controlled tests verify the fallback behavior. Some contracts returned zero from both sources and remain invalid.
- The original discovery methodology only requests IV for the top-10 volume-shock shortlist. These four names can still display Unavailable when outside it. This provider fallback does not extend that shortlist, change ranking, or promise every discovery row will get IV.
- Quote data can change between requests. No exact full-history/corporate-action/OI-unit equivalence claim is made by this IV validation.

## Implementation

Option-chain finite positive IV remains preferred and is converted from percentage points as before. Only existing option quotes with missing/nonpositive IV are requested from V3, deduplicated into batches of at most 50 keys. Response mapping uses instrument_token, not the symbolic dictionary key. Unrequested keys and nonfinite/nonpositive/non-numeric/boolean IVs are ignored. V3 API failures or partial responses leave the original unavailable/invalid values unchanged. CE/PE, strike, expiry, lot, bid/ask, OI and volume are not replaced by V3. No quote row is invented for an absent chain side.

The nearest-valid-strike ATM selection, three-per-side median, target expiry, RV21, VRP, scanner formulas, gate/filter order, rounding, funnel and final EV ranking are unchanged.

## Files created/modified in this task

- angel-one/app/services/spreads/transport.py: allowlist the official read-only V3 Option Greeks path; existing transport/token/cache/retry behavior reused.
- angel-one/app/services/spreads/upstox_adapter.py: batched matched-key V3 parser and IV-only fallback using dataclasses.replace; capability explanation updated to describe both sources.
- angel-one/tests/test_spread_v3_greeks.py: parsing, live-observed decimal normalization, matched keys, invalid IV, partial response, 50-key batching, API failure, CE/PE/expiry/strike preservation, chain preference and unchanged ATM median/VRP behavior.
- tmp/live_v3_iv_validation.py: temporary audit launcher, no longer running. It temporarily wrapped the existing expiry read in the Python process to capture sanitized read-only comparisons. No application route or alternate authentication was installed.
- tmp/live-v3-*.json: token-free before/after raw-field and normalization evidence; includes option key, strike, side, expiry, actual contract lot, raw chain IV, chain decimal IV, raw V3 IV, V3 OI and matching ratio.
- tmp/live-v3-runtime.log and tmp/live-v3-errors.log: temporary audit runtime logs. tmp/v3-greeks-*-tests.log: regression logs.
- This report.

No frontend or Node production file, Angel One code, environment configuration, dependency, original calculation module or ranking code was modified by this task. Earlier working-tree changes remain separate.

## Verification

- Full Python suite: 171 passed; six existing dependency/deprecation warnings.
- Full Node suite: 233 passed, zero failures.
- Full frontend suite: 68 passed across twelve files.
- Focused adapter/V3 suite: 21 passed.
- All seven core calculation definitions match uploaded ZIP syntax trees exactly: ScanParams, realized_vols, apply_earnings_penalty, empirical_breach_prob, friction_detail, passes_friction, build_spreads.
- No mocks/fixtures were used in live requests. Test doubles were used only in automated tests.
- Angel One application code and behavior were not changed. No trading UI action was performed.
- ZERO Upstox orders placed. Only GET market-data reads were used.

Official endpoint documentation: https://upstox.com/developer/api-documentation/option-greek/ . Live evidence, rather than the documentation sample alone, established normalization.
