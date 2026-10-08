# Live Instrument Search and Chart Implementation Plan

Date: 7 October 2026  
Status: implemented on the current working branch; automated checks and desktop/mobile preview passed. Production broker feed behavior still requires validation during market hours.

## 1. Objective

Add a protected Search page where a user can search supported Angel One stocks, indices, and option contracts, select an instrument, and view its current live quote and chart. Use the existing TradingView-style chart component (built with Lightweight Charts) and the app's authenticated, account-scoped backend to obtain Angel One data.

The first release is for market data and chart viewing. Searching must never place or prepare an order. Show the quote timestamp and a clear disconnected, stale, closed-market, or unavailable state; do not present a cached price as live.

## 2. Repository findings

- The frontend has no dedicated instrument-search route or page today. Protected routes are declared in `algo-trading/src/router/AppRouter.tsx`, and navigation is in `algo-trading/src/components/Layout/Sidebar.tsx`.
- The Python service already exposes authenticated-by-service `/angel/search`, `/market/ltp`, and `/market/candles` APIs. `/instruments/index-options` currently enumerates index options from its instrument master.
- `backend/routes/brokerProxyRoutes.js` protects broker reads with app authentication and account context. It proxies market candles, LTP, and index-option enumeration. There is no Node route yet for `/angel/search`.
- `backend/services/marketDataService.js` already holds one account-scoped SmartAPI WebSocket session, subscribes/unsubscribes by exchange and token, caches LTP, and builds candles. Reuse this service rather than opening one socket per search result or browser tab.
- `algo-trading/src/components/chart/TradingViewChart.tsx` renders custom Lightweight Charts candlestick data. The existing chart data route is index-oriented; selected-instrument candle history must use the broker candle API or a new appropriately scoped chart endpoint.
- Angel One WebSocket subscriptions require exchange type and instrument token. Search results therefore need verified exchange, trading symbol, and symbol token fields before quote streaming can start.

## 3. Scope and behavior

1. Search across supported cash-market stocks and indexes, and supported derivative instruments. Initial results should include exchange, trading symbol, display name when available, instrument type, and token internally. Never accept a token by itself from the browser as sufficient instrument identity.
2. Selecting a result displays the last traded price, broker quote time/source where available, and an intraday candle chart with selectable supported intervals.
3. Start a live subscription only for the selected instrument (plus any explicitly visible watchlist entries in a later phase). Stop the previous subscription on selection change, page exit, account/session switch, or logout.
4. Use historical candles to seed the chart, then update the active candle from live ticks. Deduplicate and order bars by canonical timestamp. Clearly mark incomplete/current candles.
5. Isolate every search result, quote, feed subscription, cache entry, and history request to the authenticated user and active broker account/session generation.

Out of scope for the first release: order entry, portfolio/watchlist persistence, multi-symbol heatmaps, option-chain analytics, TradingView's hosted data feed, and unrestricted global-market coverage.

## 4. Implementation phases

### Phase A — Instrument search API

- Add a broker-proxy route for `/angel/search`, using existing app auth, account-context middleware, and market-read limiting.
- Validate and normalize the search query and allowlisted exchanges. Apply an input length bound, rate limit, and small per-account cache/debounce-friendly behavior; never cache results across accounts.
- Normalize Python/Angel One response variants into a stable instrument shape. Verify all fields required by the live feed. Handle no results, ambiguous results, stale instrument masters, broker-session loss, and rate-limit responses explicitly.
- Extend instrument-master lookup so supported stocks can be resolved by symbol/token as needed; keep the existing index-options enumeration for derivatives. Avoid broad REST calls per keystroke.

### Phase B — Selected-instrument market data

- Add or extend authenticated backend endpoints for selected-instrument candle history and quote snapshots, validating that the requested exchange/token/symbol tuple resolves to an instrument returned by the account's permitted search/instrument source.
- Route subscriptions through the existing account market-data service. Introduce a bounded subscription registry for user-requested chart feeds, with reference counts and ownership metadata so chart cleanup cannot unsubscribe a strategy or open-position feed sharing the same token.
- Publish ticks to the requesting authenticated client through an account-scoped stream (prefer the existing app WebSocket transport if one exists; otherwise add a narrowly scoped authenticated socket/SSE channel). Do not expose Angel One feed tokens or broker credentials to the browser.
- Seed the chart with historical candles, merge in ticks safely, and expose exchange timestamp/quote freshness. Respect Angel One historical API rate limits and WebSocket subscription quotas; fetch history on selection and interval change, not on every tick.

### Phase C — Search page and chart

- Add a protected `/search` page and sidebar item.
- Build a debounced search input with loading, empty, and error states; render keyboard-accessible instrument results with exchange/type labels.
- On selection, show instrument identity and live quote with connection/freshness status. Load candle history and reuse `TradingViewChart` with symbol-appropriate title, interval controls, and responsive layout.
- On interval changes, request a new candle seed, rebuild/merge chart data, and preserve selected instrument. On result/account changes, dispose timers/listeners/subscriptions and ignore late responses from stale requests.
- Keep trading and chart-data concerns separate: Search has no order buttons and cannot start a strategy implicitly.

### Phase D — Validation and rollout

- Backend coverage: auth required; active account required; user/account cache isolation; valid and invalid exchange/query; normalized search response; broker 401/429/5xx handling; invalid symbol identity rejected; subscription reference-count cleanup; quote freshness and candle merge ordering.
- Frontend coverage: debounce, result selection, empty/error states, stale-response cancellation, live tick update, timeframe reload, account switch cleanup, and mobile layout.
- Verify PAPER/no-order behavior in a test environment, then run manual broker-connected validation with one liquid stock and one option during market hours. Confirm quote timestamp advances, candles update once per tick interval, cleanup releases only this page's subscription, and no order endpoint is called.
- Roll out behind a feature flag or restricted route first. Monitor Angel One 429s, active WebSocket subscriptions, stale-quote duration, and search latency before enabling broadly.

## 5. Acceptance criteria

- A signed-in user with a connected Angel One account can search supported instruments and select a result without a broker order being created.
- The selected instrument's quote updates from that account's Angel One feed and displays a trustworthy quote timestamp/freshness state.
- Historical candles load and the chart incorporates subsequent live ticks without duplicate or out-of-order bars.
- Switching symbols, accounts, or leaving the page removes only this page's feed reference; strategy and position feeds continue uninterrupted.
- One user's search, cache, stream, and quote are never visible to another user or broker account.
- Rate limits, feed loss, disconnected sessions, and stale data are visible and do not silently masquerade as live prices.

## 6. Decisions to settle during implementation

- Whether the initial searchable universe includes all Angel One cash-market scrips or a smaller supported exchange set.
- Which authenticated browser transport already exists for pushing ticks; reuse it if present, otherwise choose SSE or WebSocket based on the app's deployment topology.
- Whether stock instrument metadata comes from Angel One's search API, a refreshed instrument master, or both. Search and chart identity must use a consistent verified token source.
- Which chart intervals to expose initially, based on intervals supported by both the app's candle builder and Angel One historical endpoint.

## 7. Constraints and risks

- Angel One live streaming is token-based and subject to connection/subscription limits; one client subscription per keystroke or browser tab is not acceptable.
- The browser must never receive broker JWT, feed token, API key, or internal service credentials.
- Quote REST polling is not a substitute for streaming at scale and can hit per-client rate limits. Use WebSocket for ongoing live updates and REST for initial snapshots/history or controlled fallback.
- Render free-instance spin-down can interrupt backend streams independently of the frontend. Continuous live charting requires the relevant backend/Python services to be hosted on instances that remain available; this feature cannot make a suspended process stream data.
- Angel One data availability, exchange trading hours, and broker entitlement determine which instruments can actually produce live quotes.

## 8. Implementation record

- Added cached, bounded stock/index/derivative search and verified token resolution using Angel One's six-hour instrument-master cache. Expired or malformed futures/options are excluded.
- Added account-authenticated Node search and live SSE routes. Browser streams are capped per account/process and to the app access-token lifetime; symbol/token identity is checked against the current master before feed subscription.
- Added an isolated `chart` feed role in the existing per-account market service. Its reference count shares the broker socket while cleanup preserves scanner/position subscribers. Fallback REST ticks never create chart bars, and chart bars align to the exchange opening time.
- Added bounded historical candle seeding, a verified one-time timestamped quote snapshot for inactive symbols, incremental stream parsing/cancellation, and visible waiting/stale/fallback/disconnect states.
- Added the protected Search page, desktop/mobile navigation, six intervals, and a live update path in the custom Lightweight Charts component. Search cannot call order endpoints.
- Validation run: frontend production build; all frontend unit tests; all backend Node tests; all Python tests; focused Python instrument search/account-dispatch tests; focused desktop/mobile browser flow. No live broker order was placed. Production feed correctness, exchange entitlement, and hosting uptime remain deployment checks.
