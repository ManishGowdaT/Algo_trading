# Phase 0 — Trading Workflow and Compatibility Baseline

**Status:** Phase 0 investigation and baseline tests only. No production execution code, strategy rules, API routes, database schema, or frontend behavior was changed.

**Baseline revision:** `30b763b1fb4140426508fb6be2620a6109316d03` (`feature/multiuser2`)

**Reference:** `MULTI_USER_TRADING_IMPLEMENTATION_PLAN.md`, checked against the user-provided `multi_user_trading_implementation_plan.pdf` (7 pages; PDF text extraction was available). The existing plan and PDF are pre-existing untracked files; they were preserved.

## Single-user workflow captured

1. A user signs in through the React app. Authenticated requests reach the Node API.
2. The user supplies Angel One API key, client ID, MPIN and TOTP/session data. Node's broker proxy coordinates login with the Python service. Node stores one process-wide active-account record; Python owns one process-wide `BrokerSessionManager` and one Angel client. Connecting a different user replaces the earlier Python session.
3. The Node process starts broker/session readiness work. Shared market-data and order-update services own feed state and cache/subscription state.
4. The user starts a strategy. The controller checks the active account, validates the config, and obtains the runner keyed by `${userId}_${strategyName}`. The runner checks the broker connection, attempts to recover an open trade, discovers contracts, and starts its scanner/candle listeners and status state.
5. Heiken Ashi and Modified Heiken Ashi use the same bullish entry predicate: last two HA candles are green, both have no lower wick within 0.05, last JMA exceeds EMA, and last close exceeds JMA. Two red HA candles produce a bearish/reversal signal. Breakout uses the last completed candle window, validates a premium range, and enters only when the breakout candle closes above range high.
6. PAPER entry uses the signal price and sends no broker order. LIVE entry checks broker status, submits MARKET BUY, polls orderbook up to four times for completion, and uses the broker fill price. Both modes set position state and record a Trade. LIVE attempts a protective SELL SL order. Entry then starts a Node `setInterval` that polls LTP every second.
7. Exit monitoring checks Breakout range SL/entry-plus-target, Modified Heiken Ashi trailing SL/final target when `exitStrategy=TRAILING_SL`, and generic entry-minus-SL/entry-plus-target for the other branch. Trailing SL advances in configured steps. Successful PAPER exit records locally; successful LIVE exit cancels protection, submits MARKET SELL, listens for order updates and falls back to orderbook after five seconds. A successful exit records exit/P&L and enters cooldown.
8. Cooldown is one minute for Breakout exits, four minutes for SL, and two minutes for target or trailing-SL exits. Strategy status is polled by the frontend; the status request reads the runner and is not what creates its monitor interval.
9. Authenticated strategy/trade reads generally filter by the application user. Stop clears the runner/monitor state. Process-local sessions/runners are not durable across a restart; recovery is attempted when Start is called.

The visible Manual Trading Place Order and Order Book controls are not wired to order handlers in the inspected frontend. Several strategy screens are placeholders. Those are not treated as existing trading workflows.

## Expected outputs frozen by the fixture

`backend/tests/fixtures/trading-baseline.json` pins the reviewed revision, per-strategy config examples, default quantities, exit/cooldown constants, and strategy API route/method contract.

| Scenario | Captured expected result |
|---|---|
| HeikenAshi / ModifiedHeikenAshi bullish setup | Entry signal true only when the current six predicates pass |
| Two bearish HA candles | Reversal/exit signal true |
| Breakout close | Close strictly above valid range high; equal-to-high is not a breakout |
| Breakout protection | Plugin stop uses `rangeLow - bufferPoints`; target uses breakout close plus target points |
| PAPER entry | Uses signal price; writes `executionMode=PAPER`; no broker order calls |
| LIVE entry | Uses confirmed fill price; records `executionMode=LIVE`; emits BUY and protective SL with the selected quantity |
| Default quantity | SENSEX 20, NIFTY 65, BANKNIFTY 30, CRUDEOILM 1 |
| Generic SL/target | Entry 100, SL 70 for 30-point stop; target 120 for 20-point target |
| Modified trailing | Entry 100 → initial SL 70 → quote 120 moves SL to 90 → quote 90 exits as `Trailing SL` |
| Quantity discrepancy | LIVE NIFTY defaults to 65 for the order, while the current monitoring P&L display uses fallback quantity 10 when config quantity is absent |
| Cooldown | SL 4m; target/trailing SL 2m; Breakout 1m |
| Strategy API | Existing methods/paths remain authenticated; start/stop/manual exit have active-account guards |

These checks use deterministic in-memory quotes, model stubs and broker-response stubs. They never connect to Angel One or submit a real order.

## Existing shared/global account state and expected isolation failures

| Area | Current behavior observed | Expected multi-user isolation failure |
|---|---|---|
| `backend/services/activeAccountService.js` | One module-level `activeAccount`; `assertActiveUser` only admits that user | User B cannot trade while A is the active account; B login changes shared ownership |
| `angel-one/app/main.py`, `angel-one/app/services/broker_session.py` | One module-global `angel` manager, one `_client`, one `_active_user_id`; successful connect replaces and logs out old client | B login invalidates A's broker session; logout/status/session-info are not owner-scoped |
| `backend/services/strategyEngine.js` | Runner keys include user and strategy, but all runners call the global Python broker; manager broadcasts session-lost/restored to all runners | One user's session event changes another runner's broker-ready state; broker commands lack account context |
| `backend/services/marketDataService.js`, smart stream/order update modules | Singleton session/feed state, cache/subscription maps and event emitters | Token collisions or shared socket/order events can cross accounts; disconnect/cache cleanup is global |
| `backend/services/contractManager.js` | Cached contract discovery uses shared broker context | One user's session/data may populate or invalidate another user's contract cache |
| Python `OrderStore` | Shared local SQLite order-attempt store without user/account ownership | List/clear operations are not a per-user history boundary |
| Other state | Notification fallback, chart/candle caches, frontend localStorage and global health/session state include shared or unscoped state | Account-specific events/settings can be exposed, overwritten, or broadcast across users |

The added characterization tests explicitly prove two current gaps: a second application user is rejected by the single active-account guard, and a process-wide broker session-lost event sets both mock users' runners to `brokerReady=false`. The Python test proves that connecting user B logs out the fake client previously connected for user A. These tests **pass because they describe the current behavior**; they are not proof of multi-user isolation.

Shared components that appear safely shareable after review include pure indicator functions, immutable strategy plugin definitions, market schedule/configuration, and a public immutable instrument catalog. Mutable session, execution, event, timer, cache, position and recovery state requires account ownership.

## Discrepancies and compatibility risks found

1. **Monitor P&L quantity differs from entry quantity.** Entry selects `config.quantity || INDEX_CONFIG[underlying].qty || 10`, but monitor P&L and several exit/recovery paths use `config.quantity || 10`. The test captures a NIFTY 65-unit order with an LTP +6 display P&L of ₹60 (10 units), instead of ₹390. Phase 0 records this; no correction is made.
2. **Breakout timestamp field mismatch.** The plugin's completed-candle window reads `candle.ts`; normalized market-data candles use `time` in the existing path. Breakout may therefore report “Completed candle window unavailable” depending on which candle source reaches it.
3. **Accepted config fields are not uniformly consumed.** UI and validation accept timeframe/confirmation/strike/exit settings that the active plugins/runner do not all use. Defaults and ignored fields need a separate, explicit compatibility decision.
4. **Reversal and exit mode semantics differ from some displayed controls.** The HA plugin produces the reversal signal independently of several UI exit-mode selections; the runner's candle listener may act on that result.
5. **Recovery is incomplete.** Open-trade recovery occurs during a later Start, is process-local, and does not restore all trailing/protective/exit configuration. Restart safety is not established by this baseline.
6. **Frontend status traffic is not the runner's timer owner.** The source creates the position monitor from `executeEntry` in the Node runner. This is distinct from proving that hosting keeps a sleeping/terminated process alive; deployment and real incident logs were not in scope for this phase.

## Nine execution/reliability issues carried into the baseline

These are Phase 0 findings to preserve for later work, not fixes made in this phase. They match the nine-issue table in the implementation plan.

| Issue | Current code behavior/findings | Phase 0 test coverage |
|---|---|---|
| Manual exit false success | `manualExit()` can pass no matching contract to `executeExit()`; its non-LIVE-or-missing-contract branch sets success and can clear state without a broker SELL. | Not invoked with a missing contract; preserve as a required negative test for Phase 5. |
| Stop removes monitor | Runner stop clears the monitor interval and active runner references, including when an open position exists. | Timer lifecycle not altered; recovery scenario left for Phase 5/6 tests. |
| Incomplete restart recovery | Recovery is in-memory/Start-triggered and does not reconstruct the full original exit snapshot/trailing state. | No process restart simulated in Phase 0. |
| Ambiguous/duplicate submissions | Broker acknowledgment can be ambiguous while retries/restarts lack a durable order intent/reconciliation record. | Broker stubs cover one successful LIVE order only; duplicate/timeout/partial-fill cases are deferred. |
| Assumed protective status | Protective-order placement ID is treated as protection without an independent verified working status/filled quantity check. | Fixture asserts the current protective order payload/ID flow; reject/partial/cancel race not simulated. |
| Invalid REST fallback | The global market-data fallback can issue an LTP request with an empty symbol when the intended held instrument context is absent. | Not invoked by the strategy entry/monitor fixture. |
| Overlap, missing timeouts, stale quotes | Async work runs from repeating timers without explicit per-position overlap protection; the engine's broker helper passes `timeoutMs: null`; quote age/freshness is not validated. | Monitor callback is deterministic; timeout, overlap and stale-feed scenarios deferred. |
| Contract rotation breaks reversal | Discovery/rotation may change CE/PE identity while an open position and reversal listener need the held contract identity. | Not exercised by Phase 0 fixture. |
| Lost DB trade state | Exit cleanup proceeds after a caught DB lookup/update error or missing Trade, so runtime state can be cleared without a durable closed record. | Successful in-memory trade persistence covered; database failure scenario deferred. |

The later phase tests must cover the deferred failure cases before any production multi-user rollout. Phase 0 intentionally makes no attempt to correct these existing behaviors.

## Broker documentation checked

The [official SmartAPI documentation](https://smartapi.angelone.in/docs) currently states:

- Login uses the Angel One client code, PIN and TOTP with the API key; a session remains active until midnight unless logged out.
- One client code can have up to three concurrent market WebSocket connections, with up to 1,000 token/mode subscriptions per connection. The socket expects a heartbeat every 30 seconds.
- The documented limits include login at 1 request/second, order book at 1 request/second, LTP at 10 requests/second, and an aggregate 9 requests/second across place/modify/cancel order APIs. The page says limits are calculated per client code.
- New static-IP-based API keys validate the source IP for place, modify and cancel order requests.
- Successful order placement returns an order ID without guaranteeing the final status; orderbook/individual-order status and cancellation are distinct follow-up operations.

These constraints support treating feeds, broker credentials and budgets as account-scoped. They do not prove that Angel One has approved this application’s intended multi-account use, define all account/API-key pairing rules for this deployment, or guarantee fills/cancel outcomes. Angel One support confirmation and controlled non-production validation remain outstanding.

## Repository-verifiable deployment and recovery assumptions

- **Topology:** `backend/index.js` is the Node/Express API process. It calls Python through `ANGEL_ONE_API_BASE`, defaulting to `http://localhost:8000`; Python exposes FastAPI from `angel-one/app/main.py`. `angel-one/uvicorn.command.txt` shows a local `uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload` command. There is no Render manifest, container definition, or checked-in production start configuration in this repository. Therefore the project indicates a Node API plus Python broker/data service, but cannot prove whether Render currently runs them as one host, two services, or an external Python endpoint.
- **Node state:** strategy runner instances live in an in-process `Map` keyed by user and strategy; account state, market data/feed services, order events, contract/cache state and intervals are module singletons. A process restart discards these objects. There is no repository evidence of a distributed lease or shared runner ownership for multiple Node instances.
- **Python state:** `angel-one/app/main.py` creates one module-global `BrokerSessionManager`; the manager owns one Angel client, one active user/session id and one 60-second health thread. Its state is process-local. Python shutdown stops that health thread; no multi-account session registry or cross-process persistence is present.
- **SDK import side effect:** importing the installed `SmartApi.smartConnect` module attempts an `api.ipify.org` lookup at class definition time. In this environment DNS is unavailable, so it logs an error and continues; this did not block tests or cause the TestClient stall. The inspected SDK code then assigns fixed public/local IP constants in its `finally` block. Production egress identity and request headers must be verified against the deployed SDK version and Angel One static-IP policy.
- **Startup:** Node listens first, then starts Python warm-up and health monitoring and polls Python session-token initialization every 10 seconds while Python is healthy. Python is expected to be started separately; Node does not spawn the Python server in `backend/index.js`.
- **Stop and unresolved positions:** strategy `stop()` clears the monitor interval and in-memory active trade/order/protection/threshold references while leaving the MongoDB Trade record. It does not close the broker position. That means a stopped runner no longer monitors the open position.
- **Restart recovery:** recovery runs only after the user later starts that strategy. It looks up the latest Trade without `exitPrice`; in LIVE mode it queries broker positions. If a matching broker position remains, it restores selected trade fields and starts monitoring, but not the full original thresholds/trailing progress. A failed broker position query is caught and the DB trade is treated as still open. If the broker reports no positive net quantity, the code marks the trade `RECOVERY_CLEANUP`, sets exit to buy price and P&L to zero. Recovery is therefore not automatic at process startup and can synthesize a zero-P&L closure when DB and broker state disagree.
- **Orders:** successful LIVE placement IDs are stored in the Trade and protective order ID; final order state is handled by order update plus orderbook fallback in runtime paths. No durable order-intent ledger, process-start reconciliation worker, or cross-process ownership mechanism is present. Python's local SQLite OrderStore is also process/local-file state and has no account owner column.

These are source-level assumptions only. Actual Render service topology, instance count, plan, restart/deploy events, environment variables, public/static egress IP, and live unresolved orders/positions require production access.

## External verification items still open

| Item | What cannot be established from this repository |
|---|---|
| Angel One multi-account permission | Written confirmation that this application may concurrently serve multiple separately authenticated client codes, and any onboarding/compliance/consent requirements. The public docs describe credentials and API calls but do not approve this deployment's multi-user product use. |
| API key/client-code pairing | Whether each end user must create/register their own API key, permitted key/account associations, key activation requirements, app ownership restrictions, and whether cross-user server-side use is allowed. |
| Session lifecycle | Exact production session expiry/renewal/re-login expectations for each account, concurrent login behavior, and whether logout/session revocation affects other sessions under any account/device policy. Public docs state a session lasts until midnight unless logged out, but deployment-specific behavior needs confirmation. |
| API/request limits | Confirm current quotas and enforcement for each endpoint and client code, burst behavior, shared application/network limits, and whether limits vary by API plan. Current public docs list login 1/s, orderbook 1/s, LTP 10/s, and aggregate place/modify/cancel 9/s per client code. |
| WebSocket limits | Confirm current market-feed and order-status connection caps, heartbeat expectations, subscription quotas, and whether limits are per client code, API key, or app. Public SmartAPI docs state up to three connections per client code and 1,000 token/mode subscriptions per market-feed socket. |
| Deployment/IP requirements | Render service count/topology/plan, process instance count, service sleep/restart behavior, deploy overlap, persistent-disk use, outbound IP stability, static-IP registration with Angel One, and whether current API keys require a registered static IP. No Render deployment manifest is in the repo. |
| Live operational state | Current deployed commit/configuration, unresolved broker orders/positions, recent session expiry/restart incidents, DB persistence/backups, and the actual Python service endpoint/ownership model. Requires Render, database, broker, and operator access. |
| Market-data entitlement | Whether each client code/account has required exchange/product entitlements and any per-account feed restrictions for the intended strategies. |

Public documentation links inform the listed limits; these are not substitutes for Angel One support confirmation or production-environment checks.

## Files added in Phase 0

- `backend/tests/fixtures/trading-baseline.json` — revision-bound compatibility values and current route contract.
- `backend/tests/tradingBaseline.test.js` — signal predicates, breakout rules, route contract, account singleton/broadcast characterization, PAPER/LIVE entry, quantity, SL/target/trailing behavior and cooldowns.
- `angel-one/tests/test_broker_session_singleton_baseline.py` — fake-client proof that Python currently replaces the first user's global session when a second connects.
- `PHASE_0_BASELINE.md` — this workflow, shared-state inventory, expected outputs and discrepancy record.

No Phase 1 work has started. No production code, UI, API implementation, schema, trading logic, dependency or deployment configuration was changed.

## Verification record

- Focused Node baseline: `node --test tests/tradingBaseline.test.js` — **8 passed, 0 failed**.
- Full backend suite: `npm test` — **37 passed, 0 failed** when rerun with localhost access enabled. The initial sandboxed attempt was blocked by `EACCES` in three existing localhost integration tests; those tests passed in the approved rerun.
- New Python broker-session characterization: `python -m pytest -q tests/test_broker_session_singleton_baseline.py` — **1 passed**.
- Full Python suite: `python -m pytest -vv` — **15 passed**. The sandbox stall affected the existing `tests/test_login_rate_limit.py::test_login_returns_clear_429_for_provider_rate_limit` and the two existing `tests/test_margins_required.py` cases, all of which call Starlette `TestClient`. A stack dump from the login test showed `TestClient` waiting in Windows asyncio `socketpair()` during its AnyIO portal setup because sandbox local socket creation was denied. The Python broker health thread was idle in its normal event wait. With local socket access enabled, all tests completed; no test or production code change was needed.
- SmartAPI official docs checked for login/session lifetime, WebSocket limits/heartbeat, API rate limits, static-IP order requirements, and order status/cancel behavior (link above).
- Render deployed revision/topology, real open orders/positions, incident logs, public/static egress IP, and Angel One support confirmation were not accessible from this workspace and remain unverified.
- Broker documentation/capability checks, deployed revision/topology, open orders/positions and operator-confirmed deployment evidence remain external prerequisites from the plan; this local workspace cannot establish them.

## Phase gate

The local compatibility-test and source-inventory work is complete. Backend and Python suites pass. Overall Phase 0 acceptance still requires a decision on the recorded strategy discrepancies and access to the external broker/deployment evidence listed above. Those external items have not yet been accepted as release gates, so do not begin Phase 1. This document does not certify live-trading readiness or multi-user safety.
