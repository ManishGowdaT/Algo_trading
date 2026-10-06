# Phase 4 confirmed findings: fixes and local verification

## Scope and revision

Reviewed and fixed only the confirmed Phase 4 feed/context/readiness/cleanup/polling findings. Phase 5 has not started.

Git HEAD remains `30b763b1fb4140426508fb6be2620a6109316d03`. Earlier phase implementation is already present as uncommitted changes; this report lists files edited in this fix request, rather than attributing the entire working-tree diff to this request. The Phase 4 section of `MULTI_USER_TRADING_IMPLEMENTATION_PLAN.md` and the Phase 0 compatibility contract were reread. Baseline fixture values and expected outputs were not changed.

## Findings resolved

| Finding | Fix | Production-path evidence |
|---|---|---|
| Verified context was cloned and rejected by authorization | Retain the exact immutable, verified context object; reject unverified constructor input | Real ownership resolution, token request, candle backfill and quote HTTP dispatch; forged context/foreign account denied before transport |
| Cold Start could register a listener before its feed existed | Await feed initialization; register the listener before subscriptions; await recovery and initial contract setup; gate scanning until initialization completes; safely unwind failed/cancelled startup | Two simultaneous cold Starts, listener registration while contract HTTP response is held, unavailable-token failure, Stop during initialization |
| Background candle closure lost verified account scope | Bind callbacks to the retained context; check current active owner/session generation; contain sync/async listener errors | Real binary decoder → candle builder → router → real Heiken Ashi plugin outside request scope, including A callback invoked while B scope is active |
| Feed cleanup could prevent completed exit/Stop state clearing | Missing/retired generation cleanup is idempotent; remove local references before socket send; catch cleanup errors in the runner | Successful PAPER exit with a socket send failure and after feed reset; saved price remains correct, activeTradeId and exitInProgress clear; Stop after reset |
| Pending subscription/backfill could outlive unsubscribe/reset; protective reconciliation leaked held references | Reserve pending router/service subscriptions before asynchronous work, cancel matching references, reject destroyed-session completions, discard detached backfill, release position reference on protective fill | Delayed token/backfill HTTP responses, reset/unsubscribe/immediate unsubscribe, real protective-orderbook dispatch and reference cleanup |
| Background session checking bypassed the account singleflight guard | Guard the whole background status/token sequence with the same per-account promise used by subscription initialization and public checks | Hold the real status response while a subscription starts; no concurrent token request for that account |
| Actual HTTP 429/non-success was silently ignored; budgets absent | Handle response.ok/status/Retry-After; account-local logged exponential backoff; finite positive quote validation; bounded account/global quote admission in transport | Real HTTP 429/503, actual five-second fallback transport timeout, logging assertions, A failure with B polling, real account-budget rejection before HTTP dispatch |
| Tests mocked the failing boundaries | Add tests using real accountContext, router, engine, plugins, stream implementations and requestPython | Persistence is represented at the model boundary, Python responses come from a localhost HTTP simulator, and external WebSockets are simulated at their socket boundary; authorization, initialization, callback binding, cleanup and HTTP transport are not replaced |

## Compatibility

The strategy plugins, signal formulas, entry/exit conditions, quantity calculation, SL/target/trailing calculations, cooldown values, PAPER/LIVE semantics, API paths, frontend files and database schemas were not edited in this request.

The intended execution changes are startup readiness/cancellation, account context delivery, cleanup reliability and bounded quote/fallback transport. Quote traffic above the local budgets is refused with status 429 instead of queued without bounds. Background fallback leaves reserved capacity for position monitoring. Successful quote batches reset fallback backoff; one account's broker backoff is not copied into another account.

Closed-candle callbacks retain synchronous initial delivery, including each fill-forward gap candle and its corresponding buffer length. A dedicated test verifies OHLC/time outputs and that callback routing does not defer all gap events until the buffer contains the final gap.

## Local request budgets

The current Node process admits at most four LTP/index-LTP reads per account per rolling second and sixteen across all accounts, with the same concurrency caps. Background fallback is admitted only below three account requests and twelve global requests, reserving capacity for monitoring. Admission has no waiting queue and never automatically retries broker mutations. These are local safety budgets, not claims about Angel One permissions or published quotas.

Budgets are process-local. Multiple Node replicas would need deployment-level coordination before LIVE rollout; the accepted production topology/broker quota gates remain open. Candle/instrument requests and orders are not put into this quote budget, and order execution behavior is unchanged.

## Files changed in this request

- `backend/services/marketDataService.js`
- `backend/services/strategyEngine.js`
- `backend/services/pythonApiClient.js`
- `backend/services/marketRequestBudget.js` — new
- `backend/tests/startupCoordination.test.js` — test contexts now use the real mint function; existing assertions retained
- `backend/tests/feedProductionPaths.phase4.test.js` — new, fourteen tests
- `PHASE_4_FIX_VERIFICATION.md` — new, this report

No Python, frontend source, production environment configuration, schema or baseline fixture file was edited in this request.

## Verification results

| Run | Result |
|---|---|
| Full Node: backend `npm test` (normal teardown, no force-exit) | 97 passed; 0 failed/cancelled/skipped |
| Explicit Phase 0–4 Node regression selection | 69 passed; 0 failed/cancelled/skipped |
| Full Python: angel-one `python -m pytest -q` | 32 passed |
| Full frontend: algo-trading `npm test` | 5 files / 29 tests passed |
| Frontend production build: algo-trading `npm run build` | Passed |
| `git diff --check` | Passed |

The explicit regression selection included tradingBaseline, accountOwnership.phase1, tradeOwnership.phase1, phase1MongoosePersistence, accountContext.phase2, brokerStatusCompatibility.phase3, startupCoordination, marketDataIsolation.phase4 and feedProductionPaths.phase4. The full Python run includes its existing Phase 0/2/3 broker/session regressions.

Existing Python dependency/deprecation warnings and the frontend bundle-size warning remain. They were not addressed as unrelated changes.

## Acceptance and release gates

All eight confirmed Phase 4 findings are resolved and the local compatibility/isolation tests pass. Phase 4 local acceptance passes. It is safe to begin local Phase 5 implementation after user approval; Phase 5 was not started here.

This is not approval for multi-user LIVE production trading. Angel One multi-account permission, API/session/WebSocket limits, static/public egress IP, market-data entitlements, Render/deployed topology, and real outstanding position/order evidence remain the previously accepted external RELEASE GATES. No live broker credentials, real trades or production deployment were exercised by this verification.

Rollback must preserve verified account boundaries. Use a reviewed snapshot of this working tree and disable new Starts while restoring a compatible account-aware version; do not restore the known broken context clone, shared feeds or stale-generation cleanup paths. Broker exposure must be reconciled before any production rollback, under the existing release gates.
