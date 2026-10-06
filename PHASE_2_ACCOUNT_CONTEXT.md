# Phase 2 — verified account context and Node dispatch

Date: 5 October 2026.

Scope: Phase 2 only. Phase 3 workers, concurrent account admission and multi-user LIVE rollout are not implemented or enabled.

Reviewed HEAD: `30b763b1fb4140426508fb6be2620a6109316d03`, branch `feature/multiuser2`. The approved Phase 0/1 work already existed as working-tree changes; it was preserved. No commit, database migration, deployment or live broker order was performed.

## Local acceptance

**Phase 2 local gate: passed. It is safe to begin local Phase 3 implementation after approval.** This is not approval to deploy multiple LIVE accounts. The singleton admission guard remains in place, including across logout for the lifetime of the Node/Python processes. This prevents account switching through the still-shared feed/event state.

| Verification | Result |
|---|---|
| Full backend `npm test` | 72 passed, 0 failed, 0 skipped |
| Full Python `python -m pytest -q` | 21 passed; four existing dependency/deprecation warnings |
| Phase 0 Node baseline | All 8 passed within the full suite; fixtures and expected outputs unchanged |
| Phase 0 Python singleton characterization | Passed within the full suite; unchanged |
| Phase 1 ownership/persistence | All 14 passed within the full Node suite |
| New Phase 2 Node tests | 21 passed |
| New Phase 2 Python tests | 6 passed, including actual HTTP Node transport → Python dispatch → fake broker |
| Frontend `npm test` | 29 passed across 5 test files |
| Frontend `npm run build` | Passed; existing large-chunk warning remains |
| `git diff --check` | Passed |

Socket-dependent Node/Python tests ran outside the restricted Windows sandbox. The frontend build initially hit a sandbox/OneDrive `EPERM` resolving `src/main.tsx`; the permitted retry passed. No frontend source or dependency files changed.

The existing startup-coordination test now supplies an authorized test account and waits for asynchronous context resolution. Two existing Python API tests supply private dispatch context; the margin validation tests bind a fake session. Their original response/validation assertions remain unchanged. No Phase 0 expected baseline was edited.

## Account-context flow

1. Existing JWT protection resolves `req.user` from the signed token and server-side User lookup. Request body user IDs and browser context headers do not confer authority.
2. `accountContext.middleware` resolves the default owned ANGEL_ONE BrokerAccount, or validates an optional `brokerAccountId` selector using an owner-filtered database query. Conflicting body/query selectors are rejected.
3. The resolver verifies the retained active-user guard, account ID, session ID and database generation counters. It creates a frozen context recognized by a private WeakSet: userId, brokerAccountId, brokerClientIdentity, sessionGeneration, ownerGeneration, sessionId and connection-admission state. PAPER/LIVE mode remains governed by the existing validated runner configuration; the browser cannot override dispatch authority through a mode header.
4. AsyncLocalStorage carries this context through controllers and service calls. Runner methods re-enter the context captured at Start, including callbacks invoked by EventEmitter, timers, recovery and order-related work. An inactive old runner is retired rather than rebound to a new session; an active stale runner is denied.
5. `requestPython` requires a verified context for every `/angel`, `/market` and `/instruments` request and rechecks owner/account/generation against MongoDB. No missing-context fallback to the global client exists. Only fixed infrastructure health/readiness paths are exempt.
6. The transport supplies its own private service key and verified owner/account/client/session/generation headers. It never forwards browser headers as account authority.
7. Python authenticates the internal service key first, then checks the context against the singleton's bound owner, account and session. Login/logout use a lifecycle barrier; ordinary requests can proceed concurrently within the current session. Waiting for the barrier does not occupy FastAPI's broker worker pool. The wait is bounded to 30 seconds.
8. Python login checks the submitted client code against the verified identity, binds the successful session, and returns an additive session ID. Node verifies the broker response identity, persists the generation/status, then retains the active context. Browser login responses still strip broker credentials and tokens.

### Connect/reconnect and duplicate ownership

- Node serializes connection lifecycle requests through a global admission queue while Python is a singleton. Same-account attempts therefore serialize too.
- Cross-process reservation uses owner, account, status, version and generation conditions. A `CONNECTING` reservation cannot be silently taken over.
- A candidate generation is the stored generation plus one. The reservation increments version; a successful or unknown outcome consumes the generation with an atomic increment. A definitive rejection restores prior status without decreasing generation or replacing the previously working session.
- An unknown transport outcome retains the account association, records SERVICE_UNAVAILABLE and clears local execution authority. It does not automatically adopt the possible remote session.
- The two Phase 1 unique ownership indexes must be present, non-sparse and non-partial before Node submits login. Normalized client identity is checked for an existing foreign owner before broker authentication; database uniqueness remains the race backstop.
- A fresh failed association is deleted only through the exact connection reservation; no Trade, Position, OrderIntent or historical record is deleted.
- Existing active runners/exposure block reconnect. Foreign unresolved LIVE/unknown legacy trades, durable positions and pending intents block singleton admission. Ambiguous legacy LIVE account ownership blocks Start; no account backfill is inferred.
- The admitted identity is retained after logout. A different real account cannot replace it in the same runtime while feeds are shared. This temporary restriction must be replaced deliberately in later isolation phases, not bypassed by restarting services while exposure is unresolved.

## Scoped endpoints and services

Existing browser API paths remain unchanged.

| Area | Phase 2 boundary |
|---|---|
| `/angel/login` | Authenticated owner association, normalized client identity, unique-index prerequisite, serialized reservation and verified response |
| `/angel/logout` | Owned account/session only; lifecycle serialization; disconnect status scoped to that record |
| `/angel/status` | Inactive/other callers receive disconnected status without querying or revealing the globally active user; owned selectors checked |
| Profile, margins, required margins, orderbook, positions | Verified owner/account context before Python dispatch |
| Simple orders | Verified account context; existing order payload and order semantics retained |
| Order cancellation | Account orderbook evidence must contain the order ID and matching variety before cancel; query strings cannot bypass the check |
| Broker position exit | Account positions must match exchange, symbol, token, product, direction and sufficient net quantity before exit |
| Market candles/LTP and option discovery | Verified context before broker calls |
| Chart market-data and index-LTP | Authorization precedes cache reads; chart LTP and candle caches include account/session keys |
| Contract discovery | Cache keys include account/session; dispatch uses current verified context |
| Strategy Start/Stop/manual Exit | Verified middleware context; runner key remains user+strategy; runner stores account/session context |
| Managed trade writes/recovery | New Trade records use the Phase 1 optional brokerAccountId; managed reads/updates include userId and brokerAccountId |
| Automatic/manual managed exits | Owned Trade must exist; LIVE held instrument must match before an exit can proceed |
| Session-token background polling | Resolves the admitted owned account; verifies returned user/session; never adopts an arbitrary Python active user |
| REST fallback and historical seeding | Explicit captured feed context or inherited verified runner context; no account-free transport |
| JWT/app logout, settings, trade history, overlays, reports | Existing user-owned behavior retained; no broker disconnect was added to app logout |
| `/health`, `/internal/ready`, startup warm-up | Infrastructure-only probes, no broker identity adoption or execution authority |

Python's legacy private GET/DELETE `/angel/orders` attempt-store operations are denied because their SQLite data has no ownership yet. Browser route names were not removed or renamed. These private unscoped operations must remain disabled until owned attempt storage is implemented in Phase 3.

## Compatibility captured

- Existing signal calculations, CE/PE decisions, entry quantity selection, successful PAPER/LIVE fills, SL/target/trailing formulas, cooldowns, and API path fixtures passed unchanged.
- Existing quantity/P&L discrepancy, candle timestamp mismatch, incomplete recovery, monitor Stop behavior and other unrelated Phase 0 findings were not corrected.
- A new managed PAPER test runs with real Node account context: entry 100, NIFTY default quantity 65, target quote 120, recorded P&L 1300 and existing target cooldown. Only the quote request reaches Python; no PAPER broker mutation occurs.
- A manual exit with no held position remains a harmless status response.
- New authorization denials are intentional Phase 2 compatibility changes: foreign/stale context, missing ownership evidence, ambiguous legacy account identity, and missing/mismatched LIVE exit instrument fail closed instead of executing or claiming completion.
- Broker reads now depend on MongoDB ownership validation. Authorization queries and pre-cancel evidence add work and latency; identical broker timing is not claimed.

## New isolation/failure tests

The Node tests cover default owned-account selection, known foreign IDs, forged/missing context, generation/disabled-account changes, background context propagation, cancel ownership, exit quantity/direction/product/instrument validation, cache isolation, connection serialization/error release, private status, blocked cross-user login, duplicate client ownership, required unique indexes, expired JWT/refresh tokens, body user-ID forgery, managed PAPER workflow, foreign strategy trade IDs, harmless empty exit, LIVE held identity, simultaneous same-account logins, definitive rejected reconnect and unknown login outcome.

The Python tests cover secret/context/client mismatch, an owned successful login/profile contract, foreign reads and mutations across nine paths, generation replay/stale session, reconnect/logout and admission after logout, unscoped attempt access denial, an in-flight request lifecycle barrier, and actual Node-to-Python HTTP dispatch with a fake broker. The integration test asserts the outbound cancellation reaches only the correct owner and order; it does not connect to Angel One.

The Phase 1 persistence tests still exercise actual Mongoose casting/middleware/query paths with controlled driver doubles. A real MongoDB deployment/replica set and real broker are not used by these local tests.

## Remaining globals and release risks

| Remaining path | Restriction / later requirement |
|---|---|
| Python BrokerSessionManager/client/health thread | Still one runtime session; Phase 3 worker isolation required |
| Python SQLite OrderStore | Writes remain singleton-local; private list/clear denied; ownership migration is Phase 3 |
| smartStream and orderUpdateService | Global credentials/sockets/events; account concurrency remains disabled; Phase 4 required |
| MarketDataService maps/builders/subscriptions/fallback | Still one admitted account; reset on verified reconnect/logout; per-account services and stale-event handling are Phase 4 |
| Runner/session event broadcasts | Existing broadcasts remain; only one account can execute; account event routing and durable execution belong to later phases |
| Notification fallback/webhook | Existing global delivery infrastructure remains; Phase 7 isolation required before rollout |
| Frontend localStorage/origin JWT | Unchanged; user/account settings and stale callback isolation are Phase 7 |
| In-memory admission/queues/context | No distributed execution lease or automatic restart adoption; multi-instance production remains gated |
| Broker evidence requests | Pre-cancel orderbook reads can consume the account's request budget and add latency; account budgets/load verification are mandatory later gates |
| MongoDB dependency | Ownership validation fails closed during DB outage; position protection/reconciliation during outage remains a later reliability/recovery gate |
| Interrupted CONNECTING/unknown sessions | No automatic takeover or inferred legacy ownership; operator reconciliation/restart recovery must be completed before LIVE rollout |

No claim of safe simultaneous account trading, complete restart recovery, exactly-once broker effects, or production readiness is made by this phase. The Phase 0 singleton characterization tests still intentionally pass; the underlying singleton was not replaced.

### Accepted external RELEASE GATES — still open

- Angel One approval for the application's multi-account arrangement, API-key/account pairing, entitlements, account/session/API/WebSocket limits and broker policies.
- Static IP, deployed SDK request headers and actual egress/IP requirements.
- Render plan/always-on behavior, exact production Node/Python topology, replica counts and worker routing.
- Real deployed MongoDB ownership-index audit, supported transaction topology, backup/restore and migration evidence.
- Inventory/reconciliation of existing live positions/orders and ambiguous legacy ownership; no blind adoption.
- Real account cancellation, partial fill, orderbook/position shapes and failures; bounded broker capability validation requires separate authorization.
- Later phase feed/worker/execution/recovery/security/load/soak gates before multi-user LIVE rollout.

These were accepted as release gates by the user. They do not block local Phase 3 development, and have not been marked complete here.

## Files changed in Phase 2

Paths below are relative to the repository root. Pre-existing Phase 0/1 changes, including `backend/models/Trade.js`, are not counted as new Phase 2 edits.

| File | Change |
|---|---|
| `backend/services/accountContext.js` | New verified context, ownership resolver, admission, reservation support and unique-index prerequisites |
| `backend/services/brokerOwnership.js` | New order/position evidence checks |
| `backend/services/pythonApiClient.js` | Mandatory private account dispatch headers and validation |
| `backend/services/activeAccountService.js` | Additive active account ID/generation metadata |
| `backend/controllers/brokerProxyController.js` | Owned connect/logout/status and serialized connection lifecycle |
| `backend/controllers/chartController.js` | Account/session LTP cache key |
| `backend/routes/brokerProxyRoutes.js` | Broker/data context middleware |
| `backend/routes/chartRoutes.js` | Context middleware before chart reads |
| `backend/routes/strategyRoutes.js` | Context middleware for Start/Stop/Exit |
| `backend/services/candleCache.js` | Account/session candle cache keys |
| `backend/services/contractManager.js` | Account/session discovery cache keys |
| `backend/services/marketDataService.js` | Verified background session context and session reset |
| `backend/services/strategyEngine.js` | Captured runner context, owned persistence/recovery and exit authorization |
| `backend/tests/startupCoordination.test.js` | Authorized fixture for existing concurrent-check assertion |
| `backend/tests/accountContext.phase2.test.js` | 21 new local context/isolation/compatibility tests |
| `angel-one/app/services/account_dispatch.py` | New singleton authorization/lifecycle boundary; no workers |
| `angel-one/app/main.py` | Enforce private verified dispatch and bind login session identity |
| `angel-one/tests/test_account_dispatch_phase2.py` | 6 new dispatch/barrier/HTTP integration tests |
| `angel-one/tests/test_login_rate_limit.py` | Private context headers; original rate-limit assertion retained |
| `angel-one/tests/test_margins_required.py` | Authorized fake session fixture; original validation assertions retained |
| `PHASE_2_ACCOUNT_CONTEXT.md` | This implementation, verification and gate report |

## Schema/migration and rollback

No Phase 2 schema migration or historical backfill was added or executed. Phase 2 consumes the approved Phase 1 BrokerAccount identity/status/version/generation fields and optional Trade brokerAccountId. Historical trade IDs and values are preserved. The approved Phase 1 ownership indexes must be audited and installed before broker admission; connection fails closed if they are absent.

Before rollback, disable new entries and reconcile/drain active positions and unresolved intents. Retain account associations and history. Revert Node/Python dispatch together only after no active account requires the verified path; mixed old/new services fail closed and must not route to an arbitrary global session. Restarting to clear temporary singleton admission is not a substitute for exposure reconciliation. No rollback, deployment or Phase 3 work was performed.
