# Phase 4 — Exact discovery orchestration

Implemented `angel-one/app/services/spreads/discovery.py`. No API routes, UI actions, background tasks, environment settings or Angel One workflow code were changed.

`discover(universe, adapter)` consumes the phase-2 symbol/key entries and phase-3 data adapter. Default parameters match the ZIP: VRP threshold 1.20, shock threshold 1.5, six workers and IV shortlist 10. History stage uses six-worker ThreadPoolExecutor and collects results in input order, independent of completion order. The original history metrics helper applies raw shock thresholds while preserving rounded display values and unrounded spot/RV intermediates.

Stage two selects the first ten records in stable descending rounded-shock order, requests only their nearest-14-day chains via the discovery adapter and computes the existing original nearest-three-per-side ATM IV median. It then runs the existing original pandas threshold/ranking/rounding/null-cleaning logic. No new score, alphabetical tie-breaker, earnings requirement or zero replacement for unknown IV is introduced.

History failures drop only the affected name. Missing usable IV, absent expiry and provider chain failures retain history-stage rows with IV/VRP unknown. Ranking includes names outside the shortlist exactly as the original does. Empty eligible history produces an empty ranking and skips option requests. Provider status/errors and capability metadata are returned separately and never influence score calculations. Unexpected upstream exception strings are not logged or returned.

`DiscoveryResult` contains `items`, per-stage `errors` and per-symbol `capabilities`. `edge_discovery` returns the original list-shaped result, and `trending_scan` is its compatibility alias. These are Python functions, not newly exposed HTTP endpoints. Cache/trending payload and authenticated APIs remain phase 5.

Each worker receives its own copied context so existing request deadlines propagate to transport calls. Six workers are bounded per discovery invocation, as in the source. This phase does not claim a global multi-request worker cap or an API response deadline; single-refresh admission and API lifecycle belong to phase 5. Executor shutdown waits for running work and does not forcibly kill a synchronous HTTP call.

Verification: original ZIP `edge_discovery` is executed offline against the same history/ATM inputs and complete fixture-ranked outputs are compared. Added tests cover six-worker concurrency, top-ten acquisition, equal rounded-shock ties, mixed history/IV failures, unknown IV preservation, missing intermediate fields, empty pipelines, secret-free errors and deadline context. Combined orchestration/baseline/adapter/audit tests: 30 passed.

Original baseline/calculation source fixtures retain their hashes; scanner formulas, defaults, Bull Put/Bear Call logic and EV ranking are unchanged. No broker requests or orders were made. Live provider dataset equivalence remains unverified and is not claimed by offline parity.

Phase 4 definition of done met: provider-neutral two-stage orchestration executes preserved calculations, with original shortlist/error semantics and reference-test evidence. Ready for phase 5: discovery API and cache.

Full Python regression suite also passed: 131 tests. Existing dependency/deprecation warnings remain.
