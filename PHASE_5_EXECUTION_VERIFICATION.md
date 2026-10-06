# Phase 5 — execution coordination and durable positions

Date: 2026-10-06. Scope: Phase 5 only. Phase 6 has not started.

Git HEAD remains `30b763b1fb4140426508fb6be2620a6109316d03`. Earlier phases were already present as uncommitted changes. The file list below identifies Phase 5 edits, rather than attributing the entire working tree to Phase 5. No production deployment, live broker test, database migration or historical-data rewrite was performed.

## Implementation

The existing authenticated runner dispatches to `PositionExecution` using its verified account context. One owner manages each strategy's held position, with a common account execution queue across entry, manual/automatic/reversal exit, cancellation, protective stops and trailing replacement. Different accounts use separate queues, REST evidence and session identities.

Execution follows this sequence:

1. Verify account ownership/current session, strategy ownership, absence of existing exposure, required entry uniqueness index and LIVE session readiness.
2. Persist an immutable OrderIntent before broker mutation; save SUBMITTING before sending the request.
3. Dispatch through the existing account-verified Node → Python path with a finite timeout. Broker placement/cancellation cannot be generically retried after a possibly accepted request.
4. Reconcile account orderbook evidence using the exact broker order ID, instrument, direction, product and requested quantity. Protection additionally verifies its order type and trigger. WebSocket events are wake-up signals; they cannot supply unverified fill prices or quantities.
5. Materialize Position and Trade records from verified fills, using preallocated IDs and paired owner-validated links. Persist pending entry quantity, abandoned unfilled quantity, remaining exposure and cumulative exit evidence.
6. Cancel and verify outstanding BUY/protection before an exit or replacement. A fill that wins a cancellation race is consumed as evidence before another SELL is considered.
7. Persist verified Trade completion and Position closure before clearing runtime ownership. A failed completion write retains pending ownership and retries reconciliation/persistence, without sending another exit.

Timeouts, missing IDs and ambiguous responses remain unresolved. Similar symbol/quantity orders are never guessed to be the missing order. A broker ID that was never obtained requires explicit operator/broker reconciliation; this implementation intentionally does not fabricate it or blindly resubmit.

### Held positions and Stop

- Stop disables scanner entry work while retaining monitoring, reconciliation, held subscriptions and reversal callbacks for open/unresolved exposure.
- Manual exit uses the persisted held exchange, symbol, token and product, rather than a rotated scanner contract.
- Held candle builders and entry-time warm-up history are separate from scanner discovery/history. PE history cannot be replaced by rotated CE/PE scanner history.
- Known partial BUY fills remain monitored. Exit cancels the unfilled BUY remainder before selling only verified held quantity. An unresolved SELL prevents duplicate exit mutation.
- Protective rejection, expiry/disappearance, quantity/trigger mismatch and unavailable evidence are not reported as verified protection. Partial entries can remain explicitly unprotected/reconciliation-required while their BUY is pending; the held price monitor continues operating.
- Account-bound monitor callbacks are explicitly scoped and non-overlapping. Invalid/failed quote polling reports degraded monitoring. `lastQuoteReceivedAt` records receipt time, not an independently verified exchange timestamp.
- Existing manual broker routes use the same coordination foundation. Partial manual exit reprotects remaining managed exposure. Unmanaged manual orders receive durable intents without inventing strategy trades/positions.
- Original broker attempt IDs and response/request fields are preserved when returned by Python; execution status is additive. Raw cancellation response shape is preserved. The internal manual ledger strategy is excluded from existing strategy lists/counts.

## Compatibility

Phase 0 fixture values and baseline expectations were not changed. Strategy plugin/indicator/formula files were not edited. Intended quantities, configured SL/target/trailing formulas, CE/PE signal precedence, candle calculations, successful PAPER/LIVE behaviour and existing cooldown values remain covered by the baseline and new verified-context tests.

PAPER uses local simulated fill evidence and sends no live broker mutations. LIVE closes only from verified fill evidence. The planned safety corrections are explicit: Stop retains position management, unknown outcomes remain pending, partial fills use actual exposure, manual exits retain held identity, and protection must be verified.

The existing API paths, navigation, settings and start/exit controls are retained. The three implemented strategy pages retain the server's held/pending state after Stop and keep existing manual exit controls available for held reconciliation/pending states. No Phase 7 account/storage redesign was implemented.

The Phase 1 `SUBMITTING → CANCELLED` baseline regression discovered during integration was removed; the original assertion remains unchanged. Broker-confirmed cancellation is reached through acknowledged/unknown reconciliation states. Phase 2/4 test fixture changes supply real durable model records and preserve their existing expected outputs.

## Additive schema/index changes

| Record | Phase 5 additions |
|---|---|
| OrderIntent | Purpose; immutable execution metadata and result/target IDs; optional order variety; stored broker response for API compatibility; entry uniqueness index |
| Position | Entry intent link; immutable execution config/product snapshot; pending/abandoned entry quantities; average entry price; active trailing stop; cumulative exit evidence; completion-pending flag and exit reason |
| Strategy | `internalExecutionOnly`, default false, for the hidden manual execution ledger |

Position document/query paths validate integer/nonnegative quantity accounting. Lifecycle increments/unsets cannot bypass those constraints; existing immutable snapshot/ownership hooks remain active. Historical IDs, trades and snapshots are not rewritten.

`uniq_unresolved_entry_per_strategy` is a unique partial index over user/account/strategy/purpose for nonterminal ENTRY intents. Entries fail closed when the required index is absent. The new `backend/scripts/phase5ExecutionIndex.js` defaults to a read-only duplicate audit; `--apply` creates that index additively after the audit. It does not drop indexes or modify documents. It was not run against a production database. MongoDB partial-index support, actual installed indexes and duplicate/legacy exposure audit remain deployment release gates. Multiple held records found during explicit Start are refused instead of arbitrarily adopting one.

## Tests and final results

| Run | Result |
|---|---|
| Full Node `npm test`, normal teardown, no force-exit | 131 passed; 0 failed/cancelled/skipped |
| Explicit Phase 0–5 Node selection | 103 passed; 0 failed/cancelled/skipped |
| Full Python `python -m pytest -q` | 37 passed |
| Full frontend `npm test` | 6 files / 36 tests passed |
| Frontend `npm run build` | Passed TypeScript and Vite production build |
| `git diff --check` | Passed; Git reports existing LF/CRLF normalization warnings |

The explicit selection includes tradingBaseline, accountOwnership.phase1, tradeOwnership.phase1, phase1MongoosePersistence, accountContext.phase2, brokerStatusCompatibility.phase3, startupCoordination, marketDataIsolation.phase4, feedProductionPaths.phase4, positionExecution.phase5 and executionGateway.phase5. Python includes the existing Phase 0/2/3 session/isolation regressions plus five mutation-once tests. Existing frontend strategy/rules/money/history tests pass, plus seven Stop-state tests.

New Node tests cover:

- All three strategies in PAPER and LIVE, intended quantity, thresholds, persistence and cooldowns.
- Concurrent/double entry, double exit and manual-versus-automatic exit.
- Unknown BUY/SELL outcomes and refusal to guess/repeat mutations.
- Partial entry/exit fills, cumulative evidence and partial manual exit/reprotection.
- Rejected BUY clearing empty pending runtime; protective rejection and expiry.
- Protective cancel/fill races; trailing replacement and trailing-fill cooldown.
- Intent write failure before mutation; closure-write failure after verified exit retaining ownership.
- Stop during submitted BUY; actual monitor execution after Stop, including partial pending BUY.
- Held instrument and warm-up history after strike rotation; real plugin reversal after Stop.
- Real order-feed parsing, stale/foreign rejection and duplicate wake-ups using REST evidence.
- Two-user concurrent execution, ownership denial, overlapping instrument tokens and separate request budgets.
- Mongoose lifecycle update paths, missing uniqueness index, manual API response compatibility and cancellation of working manual orders.

The tests use real Node services, account authorization, Mongoose casting/middleware/saves, feed setup, timers/callbacks and HTTP transport. External broker sockets/HTTP and the Mongo collection boundary are deterministic substitutes. They do not prove live broker behaviour or real MongoDB server atomicity/index installation. The existing Python gateway/worker isolation suite covers its account dispatch separately; no real Angel One orders were sent.

Sandbox runs encountered Windows EPERM/file/socket access restrictions and a stalled Python launch. Authorized normal runs outside the sandbox completed successfully. A new DB-failure test was narrowed to inject failure specifically on the closure write after state-sync writes were added; its completion-pending and one-SELL assertions were preserved. Existing Python dependency/deprecation warnings and the frontend bundle-size warning remain unrelated observations.

## Files changed in Phase 5

Production/backend:

- `backend/services/positionExecution.js` — new position owner/coordinator and reconciliation manager.
- `backend/services/executionGateway.js` — new manual broker mutation adapter and pending-intent monitoring.
- `backend/services/strategyEngine.js` — verified execution dispatch, serialized Start, held monitoring/history, Stop and status integration.
- `backend/services/pythonApiClient.js` — shared per-account/session orderbook singleflight and one-second request budget, including frontend reads.
- `backend/controllers/brokerProxyController.js` — broker mutations dispatched through the execution gateway.
- `backend/controllers/strategyController.js` — hide internal ledger records from existing strategy reads/counts.
- `backend/models/OrderIntent.js` — additive execution fields/index and immutable metadata.
- `backend/models/Position.js` — additive held/completion/partial-fill state and quantity guards.
- `backend/models/phase1Lifecycle.js` — verified rejection/cancellation transition support, while preserving the original SUBMITTING guard.
- `backend/models/Strategy.js` — internal ledger flag.
- `backend/scripts/phase5ExecutionIndex.js` — additive audit/install tool.

Python:

- `angel-one/app/services/angel_client.py` — single mutation attempt; no endpoint retry or post-mutation calling-convention retry.
- `angel-one/app/main.py` — placement exceptions retain UNKNOWN outcomes in existing account-owned attempt history.
- `angel-one/tests/test_mutation_once_phase5.py` — five SDK mutation-once regressions.

Node tests/infrastructure:

- `backend/tests/positionExecution.phase5.test.js` — eleven production execution regressions.
- `backend/tests/executionGateway.phase5.test.js` — twenty-three integration/compatibility/isolation regressions.
- `backend/tests/helpers/mongooseMemory.js` — real Mongoose persistence-path collection boundary with targeted failure injection.
- `backend/tests/helpers/executionFixture.js` — verified two-account local HTTP/feed execution fixture.
- `backend/tests/accountContext.phase2.test.js` — durable model fixture and plugin fixture compatibility; baseline outputs retained.
- `backend/tests/feedProductionPaths.phase4.test.js` — cleanup fixture uses real durable execution records; baseline outputs retained.

Frontend/documentation:

- `algo-trading/src/pages/StrategiesPage/HeikenashiPage.tsx`
- `algo-trading/src/pages/StrategiesPage/ModifiedHeikenashiPage.tsx`
- `algo-trading/src/pages/StrategiesPage/FiveMinBreakoutPage.tsx`
- `algo-trading/src/trading/strategyStopStatus.ts`
- `algo-trading/src/trading/strategyStopStatus.test.ts`
- `PHASE_5_EXECUTION_VERIFICATION.md`

Captured Node/Python run logs are in `tmp/phase5-node-full.log`, `tmp/phase5-regressions.log` and `tmp/phase5-python-full.log`. Earlier phase files shown by Git status are not all Phase 5 edits. No baseline JSON expectations were edited.

## Remaining scope and RELEASE GATES

| Item | Status/limit |
|---|---|
| Restart discovery, durable leases, owner handoff and rolling deploy recovery | Phase 6, not implemented here. Resume remains explicit Start; no global startup adoption was added. |
| Process topology | Execution queues/owners are process-local. Require one Node execution writer until distributed fencing/handoff is verified. No multi-replica LIVE safety claim. |
| Legacy/ambiguous live exposure | Must be reconciled before deployment; legacy trades are not guessed or falsely closed. No Phase 5 live migration was performed. |
| Broker outcome with no returned order ID | Held unresolved; operator/broker correlation is required. No blind retry or fabricated P&L. |
| Real database and backups | Verify MongoDB version, indexes, duplicate audit, database transaction/atomicity behaviour and backup/restore on the actual deployment. |
| Angel One | Multi-account approval, own-account API/session/rate/WebSocket limits, entitlements, static IP and broker policy remain accepted external release gates. |
| Render/deployment | Always-on hosting, actual plan/topology, private Node/Python service access, networking/IP and browser-free soak remain accepted external release gates. Free-service spin-down is not solved by this code. |
| Real quotes/fills/protection | Validate actual broker orderbook field/status/trigger/quantity contracts and cancellation/late/partial fills. LTP receipt time does not prove exchange quote freshness when the broker provides no independently verified source timestamp. |
| External/manual broker-terminal mutations | Live reconciliation/operational procedures must cover activity outside this application's managed route coordination; mock tests do not certify it. |
| Production rollout | Full LIVE multi-user rollout remains gated on later phases and external production checks. Local test success is not production approval. |

## Rollback and acceptance

Disable new entries first. Keep the compatible account-scoped position owner managing all open/unresolved exposure. Do not roll back execution code while pending intents, broker orders or held positions would lose their owner. Close or transfer them with verified broker evidence first. Retain additive schema, indexes, history and IDs. Do not delete unresolved records or restore global execution/session paths. Take a reviewed backup/snapshot before applying the deployment index operation.

**Phase 5 local acceptance passes for the verified repository/test scope. It is safe to start local Phase 6 development after user approval. It is not approval for multi-user LIVE production deployment. Phase 6 was not started.**
