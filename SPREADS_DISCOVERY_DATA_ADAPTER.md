# Phase 3 — Discovery data adapter

Implemented a separate `discovery_adapter.py`, leaving the existing three-year spread history adapter, scan routes, original calculations, UI and Angel One workflow code unchanged.

`DiscoveryDataAdapter.get_history` requests four calendar months through the requested IST date using the existing read-only V3 daily-candle transport. Month subtraction clamps to a valid day, including leap February. Dates are explicit; Yahoo's `4mo` acquisition is adapted to Upstox's inclusive date-range API, not represented as an identical provider dataset.

Reference: https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/ documents `days/1`, inclusive to_date and OHLC/close/volume fields. Transport cache/throttling/user-token isolation remain inherited from the existing provider transport. No new host or API path is allowed.

The discovery input contract retains chronologically sorted bars within the requested range, independently missing Close/Volume, adjustment/volume/completeness capabilities, and requested start/end. Eligibility uses the original discovery checks (30 rows, 22 non-missing closes, 22 non-missing volumes), not the 270-close spread-scan gate. No financial formulas are added to the adapter. Actual scoring still belongs to the unchanged engine and phase-4 orchestration.

Missing volume is not invented, and zero remains zero so the original zero-average rule returns shock zero. No futures-volume proxy is substituted for indices. Corporate-action adjustment and candle completeness stay explicitly unverified for live data and are not new blocking gates. Invalid timestamps/nonnumeric fields are normalized at the provider boundary; no claims of Yahoo/Upstox exact input equivalence are made.

`get_atm_chain` uses provider option contracts, the original nearest-14-calendar-day expiry picker and DTE>=3 restriction. It preserves first-encountered expiry order for equal-distance ties and returns None if no usable expiry exists. Existing Upstox chain normalization supplies bid/ask, OI and IV percentage-to-decimal conversion to the original cleaner/ATM median calculation. Discovery does not request earnings or silently insert stock earnings values.

`FixtureDiscoveryDataAdapter` uses the existing synthetic Upstox-shaped provider, filters its longer fixture history to the discovery range and labels input capabilities as fixtures. No live broker request was made during implementation.

Tests cover date bounds/month-end/leap-year handling, daily request shape, chronology, original discovery gates, independent missing close/volume, zero volume, expiry ties/exclusion, fixture history and IV units, absent earnings dependency and malformed provider payloads. Seven adapter tests pass; combined discovery/provider/engine regression verification is recorded with the phase completion.

Phase 3 definition of done met: history and option-chain discovery inputs can be loaded independently from spread scanning, with source limitations explicit and offline tests. No discovery endpoint/UI or six-worker pipeline is introduced yet; those remain phases 4–6.
