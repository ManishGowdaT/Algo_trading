# Upstox OI normalization - scoped fix and live verification

Implemented ONLY the confirmed Upstox quantity-versus-contract OI defect. No scanner formula/threshold, ranking, IV normalization, earnings behavior, history, Angel One or architecture change. ZERO orders placed.

## Files modified in this task

| File | Purpose |
|---|---|
| angel-one/app/services/spreads/upstox_adapter.py | Match authoritative option-contract key/expiry/strike/CE-PE and divide quantity OI by valid integral lot size. Reuse contracts already fetched by this provider. Reject fractional lot sizes instead of truncating them. |
| angel-one/app/services/spreads/provider.py | Add optional raw_oi_quantity, oi_lot_size and oi_normalization_status quote diagnostics; original scanner row mapping remains intact. |
| angel-one/app/services/spreads/fixture_adapter.py | Preserve existing synthetic contract-count OI without dividing it twice. |
| angel-one/tests/test_spread_upstox_adapter.py | Update raw-OI expectations to contract-count expectations with authoritative lots. |
| angel-one/tests/test_spread_v3_greeks.py | Supply contract metadata in the test transport and update OI expectations; retain the existing IV assertions. |
| angel-one/tests/test_spread_oi_normalization.py | Add 19 tests for conversion, thresholds, raw diagnostics, invalid inputs, exact contract mapping, fixture preservation and original ZIP AST parity. |

Generated evidence/report files are under tmp/spread-audit; earlier working-tree changes were not part of this fix.

## Invalid inputs

Missing, zero, negative, fractional or conflicting lot sizes and mismatched contract identities result in missing normalized OI with an explicit reason. Missing, negative, boolean or non-finite OI likewise remains unavailable. Non-integral quantity/lot counts are not rounded or guessed. Valid zero quantity maps to exactly zero contracts. Existing scanner cleaning behavior is untouched. Raw numeric quantity and matched lot size remain in quote diagnostics, with raw provider responses in opt-in snapshots. Contract endpoint failures remain explicit provider failures.

## Before / after

Exactly ONE new read-only live 50-name scan completed after the user restarted local services and reconnected Upstox: 40 successful, 10 earnings-blocked, 2 final opportunities, 174.9 seconds with diagnostic capture enabled. No fixture/mock market inputs were used; no normalization-related request failure or scan timeout was observed.

| Funnel | Previous captured live scan | New normalized live scan |
|---|---:|---:|
| Considered |856|856|
| Cushion |731|731|
| Friction |19|9|
| Paired |19|9|
| RoR |13|7|
| VRP |3|2|
| Final |3|2|

Two controlled replays isolate OI semantics: (1) the old captured prices/IV/history/earnings with OI normalization produce the new funnel; (2) the NEW live inputs with only OI restored to raw quantity produce the old funnel. No other input or scanner mathematics was changed in either comparison.

| Live contract | Raw quantity | Authoritative lot | Scanner contracts | min_oi=100 |
|---|---:|---:|---:|---|
| NMDC 75 CE, NSE_FO\|139549 |810000|6750|120|Pass|
| CANBK 125 CE, NSE_FO\|83051 |1086750|6750|161|Pass|
| GAIL 175 CE, NSE_FO\|91873 |266250|3550|75|Fail|

GAIL 175/180 Bear Call is the only previous FINAL candidate removed, at the original short-OI gate. The friction reduction is expected compliance with the ZIP contract-count semantics. NMDC and CANBK retain their relative EV ranking.

All 2,059 quotes in the 40 successful underlying snapshots have valid matched lot sizes and exact integral quantity/lot relationships. All successful normalized scans replay identically through the untouched original ZIP; aggregate funnel and combined ranking match and batch replay issues are empty.

Frontend DOM verified: NMDC 75/80, credit 0.97, RoR 24.2%, cushion 6.62%, EV -143; CANBK 125/130, credit 1.41, RoR 39.1%, cushion 5.59%, EV -150. Expanded frontend diagnostics display the same seven funnel counts. The 10 earnings-blocked stocks retain their existing behavior.

Runtime includes diagnostic capture/replay overhead and different process/cache conditions from the previous 107.1-second capture. Runtime differences are not isolated to normalization; no performance change was attempted.

## Tests and invariants

- Full Python suite: 197 passed, 6 existing dependency/deprecation warnings.
- Full Node suite: 233 passed.
- Full frontend suite: 68 passed across 12 files.
- Production frontend build: passed, existing large-chunk warning.
- Original ZIP scanner definitions: AST parity passes; original_calculations.py was not edited.
- Existing fixture behavior preserved; no fixture used in the live scan.
- No Angel One changes. No IV/VRP, credit, RoR, cushion, probability, EV, ranking, earnings or adjusted-history change.
- ZERO Upstox orders placed.

## Evidence

- [New live batch](batch-6390a4af-49d1-429c-b766-0f345ec5fa72.json)
- [Live OI and counterfactual verification](oi-normalization-live-validation.json)
- [Controlled old-snapshot replay](oi-normalization-replay.json)
- [Previous live baseline](batch-fc89a9a5-49aa-42d3-a0d2-539e93a4bdb1.json)
