# Phase 7 — Stock scan integration and mixed results

Verified the discovery → stock selection → expiry loading → explicit spread scan path using synthetic NSE stock/index fixtures. Added upfront `scan_availability` metadata to expiry responses and selected-stock UI messages. Discovery and expiry selection remain available for stocks; live stock exact scan availability is explicitly false under the current Upstox-only earnings adapter. Indices and stock fixtures remain scan-capable subject to actual history/quotes and original filters.

Contract enrichment now matches expiry, underlying identity, option side, strike AND quoted instrument key. It no longer selects the first contract sharing a strike. Contradictory/missing leg identities or lot sizes produce unavailable per-lot monetary fields with `lot_size_status=unavailable`; original candidates, EV and ranking are retained. Correct matched stock contracts provide actual contract quantities to separately computed INR amounts. Fixture stock quantities remain synthetic, not certified live lot sizes.

Mixed scans preserve successful index candidates, original rounded-EV combined sort, successful funnels/meta and per-symbol errors. Missing stock earnings never becomes `earnings=false` or zero historical gap. Stock discovery does not require earnings; the original spread event layer does. No earnings provider or new database/queue is introduced in this phase.

Offline regression coverage includes discovery to RELIANCE expiry/scan, stock lot identities/amount availability, missing stock earnings alongside a successful NIFTY scan, invalid contract/quote identity, live availability metadata, and React discovery-stock addition without parameter changes or auto-scan. Relaxed test-only width/filters produce fixture stock candidates; production defaults are unchanged.

Files affected: existing private Spread API candidate enrichment/expiry response, React selected-stock availability display, new stock integration Python tests and existing page tests. Scanner formula definitions, discovery ranking, original thresholds/defaults and Angel One trading implementations are unchanged. No live provider request or order was made.

Phase 7 integration is implemented with the provider limitation explicit. Exact live stock spread calculations still require a real source for the original earnings calendar and historical gaps; this phase cannot certify unavailable inputs. Phase 8 remains real Upstox validation and broader browser/regression verification.

Validation completed: 139 Python tests, 64 frontend tests, targeted Spread ESLint and production frontend build passed. Existing dependency/deprecation and bundle-size warnings remain. `git diff --check` passed.
