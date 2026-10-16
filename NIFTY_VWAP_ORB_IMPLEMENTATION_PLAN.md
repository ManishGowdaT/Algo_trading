# Index VWAP + Opening Range + 1M Execution — implementation plan

Prepared 16 October 2026. Scope: planning and a visual explanation; no strategy enabled, broker settings changed, or orders submitted.

Scope correction: this strategy supports NIFTY, BANKNIFTY and SENSEX with the same account connection and option configuration flow as the existing strategies. NIFTY is only the illustration, not a restriction.

| Selected underlying | Spot signal exchange | CE/PE execution exchange |
|---|---|---|
| NIFTY | NSE | NFO |
| BANKNIFTY | NSE | NFO |
| SENSEX | BSE | BFO, following contractManager's resolved instrument |

Use instrument-master contract metadata as authoritative; do not copy inconsistent legacy UI exchange or lot-size constants. Broker connection is shared through the existing account/session provider; no separate strategy login or new credentials form. Preserve connection modal/status, reconnect handling and selected-account isolation.

Baseline operation matches existing pages: choose one underlying for a running strategy instance. Changing underlying while running must not silently replace the held contract or risk reference. Stop new scans and reconcile exposure before applying a new underlying; keep held-position monitoring tied to its immutable snapshot. Pending setups/overlays are scoped by underlying. Daily maximum remains two entries total per account/strategy/IST date across all three choices, so switching indices cannot reset the cap. Simultaneous multi-index operation is outside this baseline and would need separate instance IDs plus an explicitly shared admission policy.

## 1. Strategy interpretation

This is a selectable NIFTY, BANKNIFTY or SENSEX underlying signal strategy that buys CE for a bullish setup and PE for a bearish setup. It is not the existing option-premium range breakout and not the VWAP + SMMA placeholder.

1. Build opening range from the three completed 5M bars starting 09:15, 09:20 and 09:25 IST. Freeze highest wick and lowest wick at 09:30. Use the half-open interval [09:15,09:30); never include the 09:30-start bar in the range.
2. Wait for a subsequent completed 5M bar to close strictly above OR high or strictly below OR low. No entry on breakout alone.
3. Wait for a later retest/rejection. LONG: low <= OR high + tolerance and close >= OR high. SHORT: high >= OR low - tolerance and close <= OR low. No candle-colour filter.
4. Confirm a 1M swing with two candles on each side. A pivot is usable only once both right-side bars have closed. A later completed 1M close must break the confirmed swing high for LONG or swing low for SHORT.
5. Require entry close above session VWAP for LONG or below it for SHORT. Equality fails the VWAP filter.
6. Entry reference is that completed 1M close. LONG stop = retest low - 2 points of the selected index; SHORT stop = retest high + 2. Require finite positive risk. LONG target = entry + 2R; SHORT target = entry - 2R.
7. Accept at most two entries per IST trading day, one position for this strategy/account at a time. Stop new admission after 11:30. Maintain existing exposure through the configured global square-off time.
8. No strategy-generated discretionary exit. Generic position management owns SL, TP, manual exit and EOD. Contract resolver owns strike, expiry, lot size and quantity.

LONG example: OR high 25,150; later retest low 25,140 and close 25,155; confirmed 1M swing high 25,165; later 1M close 25,170 above VWAP. Stop 25,138; risk 32; target 25,234. These are NIFTY levels, never CE premium prices. SHORT mirror: OR low 25,000; retest high 25,010, close 24,995; swing low 24,985; entry 24,980 below VWAP; stop 25,012; risk 32; target 24,916. Examples are illustrative, not historical trades.

## 2. Current workflow and implementation evidence

| Layer | Current source | What it does / implication |
|---|---|---|
| Application | README.md | React/Vite -> Node/Express/Mongo -> Python/FastAPI -> Angel SmartAPI |
| User journey | algo-trading/src/router/AppRouter.tsx; pages/StrategiesPage/StrategiesPage.tsx | Protected dashboard, strategy cards, individual pages, dynamic plug-in route, Trades and Search |
| Familiar strategy controls | algo-trading/src/pages/StrategiesPage/FiveMinBreakoutPage.tsx | Account-keyed settings, validated save queue, broker checks, Start/Stop, checkpoints, polling and mobile controls; use as UX reference |
| Generic plug-in page | algo-trading/src/pages/StrategiesPage/DynamicStrategyPage.tsx | Discovers manifests, but initializes SENSEX/quantity 20 and lacks equivalent account settings lifecycle; not ready for this strategy unchanged |
| Discovery | backend/services/strategyRegistry.js | Loads plug-in classes at startup; exact engineVersion 1.0.0; seeds missing per-user Strategy rows for all existing users |
| Interface | backend/trading/strategies/BaseStrategy.js | Single-timeframe manifest examples and option-centric analyze context; no enforced multi-stream schema |
| Validation/settings | backend/utils/inputValidation.js; services/strategySettingsService.js; models/StrategySettings.js | Strategy allowlist currently recognizes built-ins; settings scoped by user/account/strategy with optimistic versioning |
| Runner | backend/services/strategyEngine.js | Resolves contracts, scans CE/PE candles, constructs plug-in instances during scans; candle listener filters option token, exchange, interval and role |
| Feed | backend/services/marketDataService.js | Account/session-isolated feeds, interval candle builders, REST fallback and candle-closed events; foundation for spot subscriptions |
| Spot history | backend/services/candleService.js | NIFTY/BANKNIFTY NSE and SENSEX BSE index token mappings already exist; output strips volume; today's history cache can last five minutes, unsuitable as sole fresh 1M decision source |
| Orders/risk | backend/services/positionExecution.js; executionGateway.js; executionLeaseService.js | Durable intent, ownership, fill and recovery infrastructure. Held snapshot currently uses premium-based stops/targets and strategy-name branches |
| Charts | algo-trading/src/components/chart/TradingViewChart.tsx | Regular candles, markers, price lines, EMA/JMA series; extend with named VWAP series and time-bounded strategy overlays |
| Session clock | backend/services/marketSessionManager.js | Market-hours events and weekday checks; market close notification alone is not confirmed pre-close liquidation |

Current user flow: sign in -> connect/select broker account -> choose strategy -> save configuration -> Start -> Node runner resolves CE/PE -> account market data -> plug-in evaluation -> execution admission/lease -> durable order intent -> Python broker order -> fill reconciliation -> position protection/monitor -> exit -> Trades/dashboard overlays.

Preserved new flow: same account connection -> same strategy card layout -> Index VWAP ORB page with familiar settings and controls -> Start -> spot 1M/5M evaluation -> existing CE/PE resolver and execution gateway -> same monitor, position status and trade history. Analysis moves to spot; user navigation and execution ownership remain familiar.

## 3. Decisions to settle before live implementation

The pasted text references an analyzer, but no NiftyVwapOrb analyzer was supplied or found in the strategy files inspected. Treat that text as requirements, not proof of implemented behavior.

### A. VWAP volume source — blocking correctness decision

Session VWAP requires an explicit price/volume series. An index value is not itself a directly traded instrument; verify what the selected broker feed actually supplies for each of NIFTY, BANKNIFTY and SENSEX index volume. Do not invent volume, substitute equal weights, forward-fill it, or call a simple average VWAP. Existing chart history formatting omits volume regardless of upstream availability.

Phase 0 must capture sample broker OHLCV and document source, meaning, reset and availability. Proposed formula, subject to specification approval: sum(((H+L+C)/3)*barVolume)/sum(barVolume), from session-open completed 1M bars only. Aggregate cumulative tick volume into increments correctly. Missing/zero/invalid volume or incomplete session history blocks this strategy. A futures/ETF proxy is a strategy change, requiring an explicit choice and chart labelling, not a hidden fallback.

External verification: [official Angel One SmartAPI documentation](https://smartapi.angelone.in/docs), checked 16 October 2026, defines historical records as timestamp/OHLC/volume. Its NIFTY-token example has volume zero. This supports making volume validation a feasibility gate; it does not prove all NIFTY candles always have zero volume.

### B. Underlying risk versus option protection — blocking engine decision

Do not submit 25,138 as a CE stop price or compare PE premium to 24,916. Extend generic risk metadata with reference instrument and direction. Monitor spot thresholds: LONG exit when spot <= stop or >= target; SHORT exit when spot >= stop or <= target. Sell the held CE/PE through existing exit-intent execution. Persist spot signal entry separately from actual option fill and option P&L.

An underlying threshold is a software trigger, not a broker-native option stop. A separately configured premium emergency stop may provide broker-side protection, but requires a deliberate account risk policy; no guessed conversion via delta. On loss of fresh spot data, block entries, flag degraded protection, reconcile orders and apply the agreed generic outage policy. Underlying-index 2R is not a guaranteed option-premium 2R or realized currency return.

### C. Ambiguous strategy details — proposed baseline, requiring rule lock

- Retest timeframe: use a later completed 5M candle, followed by 1M confirmation. The pasted specification does not explicitly fix retest timeframe.
- Tolerance: numeric index-point value still missing; validate separately for each underlying rather than assuming one tolerance fits all three. Expose a bounded validated field and do not invent a live default.
- Retest penetration: supplied inequality permits deep excursions before recovery. Preserve it unless a maximum penetration rule is explicitly added.
- Pivot selection: latest confirmed pivot formed after the retest; entry bar must be later than pivot confirmation. Define equal-high/low ties consistently. An alternative using a pivot formed before retest changes opportunities and must be chosen explicitly.
- Retest anchor: use the accepted retest candle extremum, freeze it for that setup. Specify replacement, expiration and invalidation rules before coding; do not add automatic VWAP or structure exits.
- New opposite breakout: proposed invalidation of the pending setup and creation of a fresh opposite setup; open position still exits only through generic risk management.
- Boundary: allow a bar whose close time is exactly 11:30 only if order admission occurs by 11:30:00 IST; a delayed event cannot submit later. Explicitly define timestamps as bar-open plus duration to avoid accidentally entering on an 11:30-start candle.
- Trade count: scope = user + broker account + strategy + IST date. Count one entry when any quantity first fills; additional fills of the same intent do not count again. Reserve capacity atomically before submission; unresolved submissions retain their reservation. Confirmed unfilled rejection/cancellation releases it. Partial fills count as one entry.
- One-position rule is per strategy/account, matching existing execution scope. Any account-wide cross-strategy restriction is a separate global policy.
- Global EOD time is not specified in the request and a dedicated square-off scheduler was not established by the inspected session code. Audit existing operations; implement a generic durable scheduler if absent. Do not confuse market-close events with successful liquidation.

## 4. Phased delivery

### Phase 0 — lock rules and establish baseline

Deliver a versioned rule contract resolving section 3; record broker candle timestamp/volume semantics; record current account settings, execution paths and existing checks without copying credentials. Verify holidays and session schedule behavior. Obtain at least one real completed morning session for each of NIFTY, BANKNIFTY and SENSEX with full 1M OHLCV and corresponding option data for validation.

Exit gate: VWAP source is valid and documented; retest/pivot/tolerance/cutoff/EOD rules agreed; original account UI screenshot retained; baseline checks recorded. Do not activate live mode while these remain unresolved.

### Phase 1 — generic underlying multi-timeframe data

Extend BaseStrategy requirements compatibly with instrument role and multiple timeframes, e.g. UNDERLYING_CANDLES at ONE_MINUTE and FIVE_MINUTE. Keep existing manifests functional. Subscribe the selected NIFTY, BANKNIFTY or SENSEX spot instrument through the account feed; derive aligned 5M OHLCV from complete 1M bars or validate consistency with broker 5M bars. Backfill from 09:15 for late starts; do not use previous-day bars in OR/VWAP. Preserve OHLCV, source, close timestamp, completeness and freshness. Avoid duplicate history/live overlap and reject gaps or out-of-order input until repaired. Adapt runner event routing to admit underlying token/exchange events without weakening user/account/session filters.

Files: BaseStrategy.js, marketDataService.js, candleService.js/candleCache.js, strategyEngine.js and Python candle normalization if upstream drops volume.

Exit gate: exact three-bar OR at 09:30; no partial bars; no duplicate volume; same session results after late start; stale data blocks entries; existing option-only strategies behave as before.

### Phase 2 — pure analyzer and plug-in adapter

Add backend/trading/strategies/indexVwapOrb.js and plugins/indexVwapOrbPlugin.js with ID IndexVwapOrb. Analyzer accepts immutable completed candle histories, explicit as-of time, locked rules and optionally serialized setup state; produces a deterministic result with no broker calls. Do not depend on long-lived plug-in instance memory because the current scan loop creates instances repeatedly.

Lifecycle: BUILDING_OR -> WAITING_BREAKOUT -> WAITING_RETEST -> WAITING_1M_CONFIRMATION -> SIGNAL_READY. Runner adds admission/exposure states. Preserve event ordering and pivot knowledge time; never identify a pivot using bars beyond evaluation time. Signal contains direction, reference instrument, signal bar close time, setup ID, OR levels, VWAP/source, retest/pivot timestamps, entry reference, SL, TP, risk points, rule version and failed reasons; isExit stays false.

Exit gate: deterministic fixtures for both sides, breakout without retest never enters, retest on wrong side never enters, two-right-bar pivot delay enforced, exact 2R and positive risk verified, no fabricated candle-colour filter.

### Phase 3 — durable session admission and account registration

Add IndexVwapOrb to validated configuration with underlying enum NIFTY/BANKNIFTY/SENSEX; fixed 2R, swing length 2 and stop buffer 2 are displayed as locked rules. Keep execution quantity/expiry/strike policy in their existing layer. Introduce a durable session record keyed by user/account/strategy/IST date with unique index, setup checkpoint, processed candle/signal keys and entry reservations/counters. Integrate atomic reservation with existing leases/order intents; a non-transactional counter increment followed by an order submit is insufficient. Restore count and pending intents on restart before resuming entries. Session reset must not discard unresolved exposure.

Use registry's idempotent missing-record sync, but account for its all-users behavior: gate this plug-in to the intended account for rollout. Do not bulk enable strategies, overwrite old settings or consent, or reset accounts. Ensure new-user provisioning supports the plug-in. Account/session changes clear UI scope and reject stale callbacks.

Exit gate: third daily entry blocked under concurrent scans, reconnect and process restart; duplicate events cannot create another entry; uncertain submit cannot free capacity; wrong account cannot read or mutate settings/status.

### Phase 4 — generic reference-based risk and execution

Extend Position/Trade/order-intent snapshots with risk reference type, reference token, direction, spot entry/stop/target, data timestamps and rule version. Preserve premium fill prices and P&L. Map LONG to buy CE and SHORT to buy PE via contractManager; reuse instrument-master lot/expiry metadata and existing liquidity/margin/quote checks. Do not hardcode lot size from existing UI constants.

Extend positionExecution and generic monitoring to evaluate spot risk, retain premium emergency protection only under agreed policy, and persist enough metadata for full restart recovery. Retain underlying subscriptions while exposed after 11:30 and after scanner Stop. Add/reuse a global EOD scheduler with reconciliation, partial-fill handling and idempotent exit intents. Show exit pending until broker confirmation; stop scanning must not falsely show a held position as closed.

Exit gate: CE/PE exits trigger on the correct spot inequality, option premiums never mixed with index points, concurrent target/EOD/manual events produce one sell intent, partial fills and recovery preserve risk, lost data is visible and handled.

### Phase 5 — same UI journey and chart overlays

Add a card/sidebar entry and /strategies/index-vwap-orb page using existing StrategiesLayout, account settings lifecycle, broker checks, live consent, responsive controls and polling conventions. Prefer a dedicated page matching FiveMinBreakoutPage until DynamicStrategyPage has equivalent scope/settings behavior. Prevent duplicate card discovery if the page is explicitly registered.

Keep the familiar layout: header/actions -> settings -> live checkpoints -> position summary/logs. Settings include the same NIFTY/BANKNIFTY/SENSEX selector, broker connection/account controls, strike mode ATM/ITM/OTM and depth, premium range controls where used by the existing resolver, expiry handling, quantity and live-trading consent as the existing strategies. Preserve existing expiry behavior; if it is automatic today, do not invent a new mandatory expiry-selection step. Show the approved underlying-specific tolerance. Show OR window, entry cutoff, pivot length, buffer, daily cap and 2R as read-only rules. Do not offer irrelevant premium-range lookback, discretionary candle exits, or minimum RR.

Monitor checkpoints: broker connected; spot 1M/5M ready; volume/VWAP ready; OR locked; breakout closed; retest held; pivot confirmed; entry admissible; contracts ready. Display entries used/reserved out of two and precise waiting/blocking reason. Keep monitoring state distinct from execution states such as POSITION_UNPROTECTED, EXIT_PENDING and RECONCILIATION_REQUIRED.

Chart retains current toolbar, normal candles, timeframe/date controls and overlay toggles. Add OR high/low from 09:30 onward, shaded opening window, named VWAP line, breakout/retest/pivot/entry markers, spot SL/target after entry and 11:30 cutoff. Use the same backend diagnostics for chart and decisions. Mark 5M events at their close/knowledge time on a 1M chart; show pivot formation and confirmation separately. Historical overlays require a completed replay, never imply a real order fill. In position/trade cards distinguish selected-index trigger levels from option entry/premium/quantity/currency P&L.

Exit gate: desktop/mobile visual comparison preserves workflow; account switching never leaks settings, counters or overlays; Stop/Exit behavior matches existing protected-position semantics; refresh reloads saved validated configuration and status.

Verify all three underlying selections, NSE/NFO versus BSE/BFO routing, resolver expiry/strike/lot metadata, premium filters, broker disconnect/reconnect, underlying changes, and account switching. Volume feasibility is evaluated per index; valid data for one does not enable another with missing volume. Apply replay, admission, risk and rollout gates to all three supported indices.

### Phase 6 — replay and paper acceptance

Replay completed sessions sequentially through the same analyzer and runner gates. Include no-breakout, no-retest, failed retest, failed VWAP, simultaneous timeframe close, both sides, missing opening bars, zero volume, duplicate/out-of-order events, late start, cutoff boundary, restart after two fills, broker rejection/timeout, partial fill and EOD recovery. Paper fills must use option quotes with timestamps and explicit assumptions; spot points cannot stand in for premium P&L.

Run relevant existing backend execution/account/feed/recovery suites and frontend settings/account-isolation suites, plus new meaningful analyzer/session/risk tests. Verify UI overlays against the decision trace. Report sample coverage and observed behavior; a clean paper run does not establish profitability.

Exit gate: no unexpected entries, exact rule trace for every entry, no unresolved exposure, restart/counter checks pass and existing strategies regress cleanly.

### Phase 7 — account-scoped rollout and operations

Deploy behind an account/strategy feature gate initially stopped, with live consent off. Reconcile existing exposure first. Start with shadow evaluation, then paper operation, then user-controlled live activation after readiness review. Monitor stale data, volume validity, blocked reasons, daily reservations/fills, signal-to-submit delay, protective status, exit acknowledgements and EOD completion. Roll back by blocking new admissions while preserving held-position monitoring and reconciliation.

Exit gate: target account can see/save/start/stop using the established flow; no other account is silently activated; operational runbook and rollback are verified. Scheduling estimates should follow Phase 0 because feed validity and risk-engine scope determine most effort.

## 5. Visual evidence and limitation

Original capture: output/nifty-vwap-orb/original-dashboard.jpg, taken from the running localhost dashboard on 16 October 2026. The user is signed in, but broker connection is offline and the NIFTY chart is empty. No authentic candle screenshot or historical setup could be verified from that screen. The accompanying overlay is explicitly illustrative and uses the numeric LONG example above. Replace it with a verified completed-session chart annotation during Phase 0 once valid chart data is available.

Illustration: output/nifty-vwap-orb/illustrative-strategy-overlay.png. This generated image is a conceptual storyboard, not a plot to scale: its drawn candles/right-hand axis are not numerically consistent with the callouts, and its pivot drawing does not independently prove the 2+2 confirmation. Use the written numeric example and rule sequence as authoritative. It must not be used to validate a historical signal or fill. A genuine annotated chart remains pending valid market data.

## 6. Recommended implementation order

Rules/data feasibility -> closed spot streams -> deterministic analyzer -> durable admission -> reference-based position risk/EOD -> familiar UI/overlays -> replay/paper -> account-scoped activation. Do not treat adding a manifest/card as a working trading integration: current validation, runner routing and risk snapshots all require changes.


## Configuration clarification - selectable options

Source review confirms HeikenashiPage exposes ATM/ITM/OTM, offset depth, premium min/max, quantity, underlying and live consent. Fields are visible but disabled while running; modification follows Stop -> edit -> saved settings -> Start. Index VWAP ORB will match that behavior, with editable per-index tolerance defaults 10/20/30 and automatic resolved expiry displayed. Full field/persistence/exposure semantics: INDEX_VWAP_ORB_PHASE_0/UI_CONFIGURATION_CONTRACT.md. This is an implementation requirement, not a claim that the new page already exists.

## Authoritative Phase 0 lock - revision 0.2.0

Latest user direction supersedes earlier open questions: internally compute session VWAP from actual selected-index 1M OHLCV; no normal futures/ETF design. Proxy considered only after actual index-volume failure evidence. EOD is 15:20 IST; repository audit found no dedicated global square-off conflict (15:40 market-close setting remains unchanged). Full locked setup/admission/outage/EOD rules are in INDEX_VWAP_ORB_PHASE_0/LOCKED_EXECUTION_RULES.md. Real index validation remains pending broker reconnection; offline/stripped data is not a volume failure.
