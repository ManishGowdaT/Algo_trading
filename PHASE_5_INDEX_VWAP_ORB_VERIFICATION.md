# Phase 5 — Index VWAP ORB UI

Date: 16 October 2026

Status: Phase 5 implementation and code checks complete. Desktop/mobile visual acceptance remains pending because the browser tool reports: `Local browser use is disabled in Work settings`. No screenshot or browser acceptance is claimed.

## Scope delivered

- Dedicated `/strategies/index-vwap-orb` page using the existing StrategiesLayout, broker connection flow and mobile action component.
- Account-manifest-gated card and sidebar link, with duplicate plugin-card suppression. Manifest loading accepts the existing nested response and legacy root response.
- NIFTY, BANKNIFTY and SENSEX settings; ATM/ITM/OTM, offset depth, premium limits, quantity and live consent. Automatic expiry remains backend-controlled. Lot validation uses resolved contract metadata, with final backend validation before entry.
- Per-index retest tolerance and read-only opening range, pivot, buffer, target, daily limit, cutoff and 15:20 IST square-off rules.
- Validated account settings loading and explicit saving through the existing save queue. Account changes remount the page; asynchronous results are scope-checked. Editing is locked while saving, running or exposed. Start requires saved valid settings, current status and broker connectivity.
- Backend status polling; setup checkpoints, data errors, filled/reserved daily entries, automatic expiry and monitored option symbols.
- Stop and Exit use existing endpoints. Stopping does not hide held or unresolved exposure; its risk and Exit action remain visible.
- Regular 1M/5M candles, date selection, overlay toggles and chart fit. OR levels, VWAP, breakout/retest/pivot formation and confirmation, entry signal and index risk are rendered from backend diagnostics. Candle-close timestamps keep confirmation markers from implying earlier knowledge. Historical price data does not fabricate historical strategy diagnostics or fills.
- Separate option premium/quantity/P&L and selected-index trigger/SL/target displays. Missing premium quotes remain unavailable rather than being inferred from index moves.

## Files in this phase

Added:

- `algo-trading/src/pages/StrategiesPage/IndexVwapOrbPage.tsx`
- `algo-trading/src/components/chart/IndexOrbChart.tsx`
- `algo-trading/src/hooks/useIndexOrbAvailability.ts`
- `algo-trading/src/trading/indexVwapOrbUi.ts`
- `algo-trading/src/trading/indexVwapOrbUi.test.ts`

Integrated in existing frontend files:

- `algo-trading/src/router/AppRouter.tsx`
- `algo-trading/src/components/Layout/Sidebar.tsx`
- `algo-trading/src/pages/StrategiesPage/StrategiesPage.tsx`
- `algo-trading/src/trading/strategySettingsLifecycle.ts` — IndexVwapOrb-specific validation branch; existing strategy branches retained.

Existing backend/Python changes from Phases 1–4 were preserved and were not edited during Phase 5. No account provisioning, database migration, broker action or execution-policy change was performed.

## Verification

- Frontend Vitest: **10 files, 55 tests passed**, including four new configuration/exposure/overlay tests and existing settings lifecycle coverage.
- Production build: **passed**. Vite reports its bundle-size warning; bundle restructuring is outside this phase.
- ESLint on the new page, chart, availability hook, UI helpers and tests: **passed with no errors or warnings**.
- New tests cover invalid and unknown settings, per-index defaults, consent default, stopped exposure, metadata scoping, overlay date/index isolation, confirmation timestamps and 5M overlay end time.
- Endpoint payloads and diagnostic field names checked against existing backend source. No live testing was performed.

## Remaining acceptance

Desktop/mobile visual comparison, interactive account switching/reconnect, and actual chart rendering require browser access and an appropriately available test account. These checks are not established by the pure frontend tests. Phase 6 replay/paper acceptance and Phase 7 rollout remain separate work; neither was started. Real index volume validation and operational live acceptance remain the user's later testing work.
