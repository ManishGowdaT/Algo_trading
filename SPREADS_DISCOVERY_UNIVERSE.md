# Phase 2 — NSE F&O universe

Implemented `angel-one/app/services/spreads/universe.py` without changing existing routes, scanner math, UI or Angel One workflows.

Source: fixed public Upstox NSE BOD instrument master, `https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz`, documented at https://upstox.com/developer/api-documentation/instruments/. This file supplies option `underlying_key`, `underlying_symbol`, `underlying_type`, expiry and instrument identities. No access token is sent to the public assets host. The existing authenticated API transport allowlist remains unchanged.

The adapter selects NSE_FO CE/PE rows with expiry on or after today's IST date and positive lot size, validates NSE cash/index underlying identities, deduplicates contracts and groups underlyings. Futures, other exchanges, expired options and malformed records are excluded. Underlyings are deterministically sorted; repeated symbol identities with conflicting keys are excluded and reported rather than guessed. Optional NSE cash/index listing records supply display names; valid option rows already contain underlying identities.

Returned metadata: source, as_of, size, items, ambiguous_symbols, rejected_contracts and note. Each item contains symbol, instrument_key, kind, segment, name, sorted expiries and contract_count. Contract count is an availability metric, not a score or liquidity recommendation. BOD availability does not certify permission, suspension status, intraday liquidity or usable quotes; later data phases handle actual provider responses.

This explicitly replaces Yahoo core/most-active/top-gainer universe sourcing with all eligible NSE option underlyings. It applies no invented rupee price threshold, volume threshold, top-gainer rank or 40-name cap. Original discovery calculations remain separate and unchanged.

Downloader has fixed URL, timeout, no redirect following, compressed/decompressed size limits and safe errors. No fabricated fallback universe is returned on a failed download. `FixtureUniverseProvider` provides explicitly labeled offline synthetic inputs. Caching/API integration belongs to phase 5, not this phase.

Eight offline tests cover indices/stocks, duplicates, expiry dates and epoch milliseconds, ambiguity, malformed/expired records, synthetic provenance, fixed-host token-free fetching and failed downloads. No live instrument download or broker request was performed. Phase 2 adapter definition of done is met; connecting it to discovery endpoints/UI remains for later phases.
