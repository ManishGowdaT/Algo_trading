# Phase 6 — Discovery UI and select-to-scan

Added `DiscoveryPanel.tsx` to the existing protected Spreads page, between connection setup and scanner selection. Existing navigation/authentication, original scanner settings and calculations, backend APIs and Angel One workflow implementations are unchanged.

Discovery is explicit: Discover opportunities calls POST `/spreads/discover`; Check cached ranking calls GET `/spreads/trending`. Mounting the page/panel does not request discovery or launch scans. Separate busy refs prevent duplicate discovery and selection-add operations. Cached/stale refresh state is visible with manual check instructions; no polling or auto-scan loop is introduced.

The panel shows original ranked top-five and full-list views. Columns: rank, underlying, spot, daily change %, volume-shock ratio, RV21 annualized %, ATM IV annualized %, VRP ratio, original edge flag and score. Null IV/VRP display as Unavailable rather than zero. API order is retained; no new UI score or sorting substitutes for original discovery ranking. Explanatory text distinguishes observed change and percentile score from predicted returns.

Response timestamp, universe size/source, fixture/live note, provider-input errors and capability notes are visible. Empty responses state no rankable names were returned, rather than implying profitable spreads were evaluated. Discovery is enabled for connected Upstox or explicit fixture mode. Provider failures remain page-local errors.

Checkbox selection includes a combined limit of ten underlying names across existing scanner selection and new discovery picks. Existing scanner names are marked and disabled for duplicate addition. Add selected to scanner loads each name's available expiries through existing routes and defaults to existing nearest-target-DTE behavior. Successful additions remain if another symbol fails; a message identifies failed names. Discovery selection can be cleared independently. Adding or discovering never changes width, thresholds, DTE or starts a spread scan.

Stock discovery rows are available independently of earnings. The UI explains that exact stock spread scans may still report missing earnings inputs; it does not invent stock earnings. The old blanket “Edge Discovery unavailable” footer is replaced with the new workflow description.

Verification: all 63 frontend tests passed, including explicit discovery/no-auto-scan, cached endpoint action, selection/add callback, unknown IV display, combined ten-name limit and request-error visibility. Existing page tests cover scanner defaults, duplicate-submit prevention, automatic expiry, OAuth status separation and unchanged BANKNIFTY width. Targeted lint/build results are recorded after validation. These hook-harness tests do not claim real browser/mobile layout or live Upstox end-to-end validation; those remain phase 8.

No environments, scanner formulas, Node/Python behavior, service ports or order paths changed. Phase 6 UI is implemented; phase 7 covers full stock scan integration and mixed-result behavior.

Targeted Spread ESLint, TypeScript and production build passed. Restricted-sandbox Vite runs hit an EPERM realpath error on existing `src/main.tsx`; the approved build outside that restriction succeeded. Existing bundle-size warning remains. `git diff --check` passed.
