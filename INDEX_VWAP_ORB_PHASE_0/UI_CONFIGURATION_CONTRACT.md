# Index VWAP ORB - selectable settings and modification flow

This is the implementation contract for the new strategy page. The page and runner are not yet implemented. User requirement: provide selectable options and editable settings in the familiar existing strategy flow.

## Existing behavior verified in source

`algo-trading/src/pages/StrategiesPage/HeikenashiPage.tsx` exposes Underlying Instrument, Order Quantity, Primary Timeframe, optional Confirmation Timeframe, Enable Live Trading, Strike Preference (ATM/ITM/OTM), Strike Offset Depth, Option Premium Filter (minimum/maximum) and Exit Condition Logic with strategy-specific settings. Its fields are disabled while `isRunning` is true. Changes are saved through the account-scoped settings queue and a new config is submitted on Start. Monitored CE/PE contracts and live execution state are displayed separately.

`FiveMinBreakoutPage.tsx` likewise exposes underlying, quantity and its own lookback/target/buffer/range settings, saves account-scoped configuration, and disables settings while running. Although it stores/sends strike and premium fields, it does not render the full strike/premium selector section shown in HeikenashiPage. Use the more complete Heikenashi option-settings section as the new page's reference.

Expiry is resolved automatically by `contractManager.js`; the inspected pages do not expose a manual expiry selector. There is no verified live settings hot-reload mechanism: Stop -> edit -> Start is the existing modification pattern.

## New page controls

| Control | Presentation and behavior |
|---|---|
| Broker connection/account | Existing provider, connection modal/status and selected account; no separate login |
| Underlying Instrument | NIFTY / BANKNIFTY / SENSEX dropdown |
| Strike Preference | ATM / ITM / OTM buttons, like Heikenashi |
| Strike Offset Depth | Increment/decrement for ITM/OTM; irrelevant while ATM |
| Option Premium Filter | Editable minimum and maximum; validate ordering and resolver behavior |
| Order Quantity | Editable; step/valid multiples come from resolved current contract metadata |
| Expiry | Show automatically selected expiry and resolved contracts; retain existing resolver policy |
| Retest Tolerance | Editable selected-index value, initialized to NIFTY 10 / BANKNIFTY 20 / SENSEX 30 points; persist separate values so switching indices does not overwrite another's tolerance |
| Enable Live Trading | Existing consent control and backend admission checks; defaults off |
| Session/rule summary | Show OR 09:15-09:30, 5M setup/1M execution, pivot 2+2, 2-point buffer, 2R, two-entry cap, 11:30 entry cutoff and 15:20 global EOD time |
| VWAP source | Show internally calculated selected-index session VWAP and data validity; a proxy is considered only after proven index-volume failure and separate validation |

This request authorizes editable configuration controls. It does not automatically replace the agreed strategy logic with arbitrary timeframe, discretionary exit, stop/target or daily-quota settings. Any later customization of these rules should be explicit. Global EOD is an engine/account policy, not an independent override in this strategy page.

## Running and modification behavior

Keep the selected settings visible while scanning. Match the existing pages by disabling trading-setting edits while running, with a clear instruction: Stop strategy to change settings. Stop disables new entries, not management of a held position. Edits apply to the next start/new entries; they never mutate an open position's contract, quantity or risk snapshot. If there is exposure or an unresolved order, contract-affecting changes remain blocked until reconciliation/closure. Do not permit Stop/edit/Start to bypass the two-entry daily counter.

If hot editing during active scanning is requested later, it needs explicit versioned application semantics and backend support; do not pretend saving a form changes an already running runner.

## UI flow and persistence

Strategies -> Index VWAP ORB -> choose index -> configure strike/premium/quantity/tolerance -> saved account-scoped settings ready -> Start -> show scan stage, monitored CE/PE, actual selected expiry, VWAP source and daily count. Keep desktop/mobile Start, Stop and Exit controls consistent with existing pages. Stop -> edit -> settings saved -> Start applies the new snapshot. No separate wizard or extra broker-connection flow.

Reuse `AccountSettingsSaveQueue`, `loadValidatedStrategySettings`, account-keyed settings and API-scope checks. Add server-side configuration allowlist/bounds in the implementation phase. UI-only validation is insufficient. Display saved configuration and currently running snapshot separately whenever they differ.

## Acceptance checks for implementation

- Every supported index can be selected and restores its tolerance and account-scoped settings.
- ATM/ITM/OTM, depth, premium bounds and valid quantity reach server validation and the execution resolver; no decorative nonfunctional controls.
- Connection, automatic expiry and monitored CE/PE reflect backend state.
- Controls remain visible while running; edits follow Stop/edit/Start and preserve held positions.
- Reload and account changes cannot leak settings or apply stale saves.
- Existing strategy pages and their behavior remain unchanged.
