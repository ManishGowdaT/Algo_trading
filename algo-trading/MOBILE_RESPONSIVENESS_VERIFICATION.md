# Mobile UI verification

Baseline revision: `e1bd688a44b01874ff84f94151f033b3decca31c`.

## Scope

Changes are frontend presentation only: mobile CSS, responsive JSX classes,
touch labels, accessible names, navigation visibility and mobile chart selection.
All added CSS rules are within the existing `max-width: 767px` media query.
The viewport enables `viewport-fit=cover` to expose device safe-area insets.
No API paths, authentication/session code, trading handlers, strategy calculations,
settings effects, quantities, execution rules or backend files changed in this task.
The earlier backend breakout fixes remain separate existing work.

## Mobile layout

- Navigation remains visible on all authenticated routes.
- Navigation has a 64px content height plus the bottom safe area.
- Existing strategy/manual action bars sit above navigation, with at least 60px
  reserved for actions. Main content reserves both bars and safe-area spacing.
- Header, drawer, account sheet, broker modal and indicator sheet handle safe areas.
- Buttons/fields have at least 44px mobile targets. Checkbox controls keep their
  normal appearance inside 44px clickable labels; radio labels are at least 44px tall.
- Account access on mobile uses the existing tap-open navigation sheet.
- History keeps its desktop table and existing mobile cards. Filters, calendar,
  action grid and pagination fit phone widths. High-z-index time fields no longer
  draw over the mobile navigation.
- Mobile chart height is explicitly bounded to 280–420px so canvas initialization
  cannot expand it to the desktop fallback height. Calculations and chart data are unchanged.

## Verification results

- Existing frontend suite: **48 tests passed**, across 9 files.
- Production TypeScript/Vite build: **passed**. Existing bundle-size warning remains.
- Browser layout checks: **65 route/width combinations passed**, covering 13 routes
  at 360, 375, 390, 414 and 430px in Chrome with touch/mobile viewport emulation.
- Browser checks include target dimensions, document width, navigation/action-bar
  separation, populated history cards, large pagination, calendar, filter choices,
  chart indicator panel, account sheet and long strategy/contract names.
- Broker connect modal verified in a 360×400 short viewport; submit controls remain reachable.
- Synthetic 20px top / 34px bottom insets exercised the actual safe-area CSS rules;
  header and stacked bars retained the intended dimensions without overlap.
- Desktop comparison: **26 comparisons passed**, 13 routes at 1024 and 1440px,
  against the built baseline revision. Chart canvases were masked because their
  automatic fitting is timing-dependent; surrounding layout remained identical.
- Source comparison confirmed non-JSX code was unchanged in all 19 modified TSX files.
- Browser fixtures intercept all API requests and block external network traffic.
  Tests do not submit Start, Stop, Exit or order mutations to a real service.

This is browser emulation, not a physical phone test. Native iOS/Android keyboards,
notch behavior and chart gestures should receive a final check on actual devices.

## Changed UI files

- `index.html`
- `src/index.css`
- `src/components/Layout/DashboardLayout.tsx`
- `src/components/Layout/Header.tsx`
- `src/components/Layout/MobileBottomNav.tsx`
- `src/components/Layout/MobileStrategyActions.tsx`
- `src/components/Layout/Sidebar.tsx`
- `src/components/chart/ChartToolbar.tsx`
- `src/components/chart/TradingViewChart.tsx`
- `src/pages/DashboardPage/DashboardPage.tsx`
- `src/pages/LoginPage/LoginPage.tsx`
- `src/pages/RegisterPage/RegisterPage.tsx`
- `src/pages/StrategiesPage/DynamicStrategyPage.tsx`
- `src/pages/StrategiesPage/FiveMinBreakoutPage.tsx`
- `src/pages/StrategiesPage/HeikenashiPage.tsx`
- `src/pages/StrategiesPage/ManualTradingPage.tsx`
- `src/pages/StrategiesPage/ModifiedHeikenashiPage.tsx`
- `src/pages/StrategiesPage/StrategiesPage.tsx`
- `src/pages/StrategiesPage/StrategyPlaceholderLayout.tsx`
- `src/pages/TradesPage/TradesPage.tsx`
- `src/shared/angel/MpinModal.tsx`

Shared placeholder changes cover Ichimoku, VWAP/SMMA and expiry routes without
editing their page logic. There is no separate profile route in the current app.

## Browser check scripts

Added `tests/mobileResponsive.browser.cjs` and `tests/mobileDesktopComparison.browser.cjs`.
They use Playwright supplied externally; no application dependencies were changed.
Set `PLAYWRIGHT_MODULE` to the installed Playwright module path if it is not available
through normal Node module resolution. Chrome must be installed.

With the frontend running at `http://127.0.0.1:4179`, run from the repository root:

```powershell
node algo-trading/tests/mobileResponsive.browser.cjs
```

For desktop comparisons, build the current frontend and separately build the
baseline frontend from the revision above. Set `MOBILE_BASELINE_DIST` to that
baseline `dist` directory, then run:

```powershell
node algo-trading/tests/mobileDesktopComparison.browser.cjs
```

Screenshots and reports are written under `mobile-verification.local/`, which is
ignored by the frontend's existing `*.local` rule.
