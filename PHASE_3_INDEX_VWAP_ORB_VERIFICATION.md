# Index VWAP ORB - Phase 3 verification

Scope: Phase 3 of the end-to-end PDF: account-scoped settings/availability and durable daily admission. No frontend, Python, indicator/signal logic, EOD scheduler, broker order transport or existing strategy configuration was changed in this phase. Existing earlier-phase workspace changes were preserved.

## Delivered

- Dedicated configuration validation for NIFTY/BANKNIFTY/SENSEX, quantity, strike preference/depth, premium bounds, per-index tolerance and live consent. Defaults retain tolerance 10/20/30 and live consent false. Unknown fields, arbitrary timeframe/risk/target/quota overrides and invalid values are rejected. Fixed 2R, pivot length 2, stop buffer 2, daily cap 2 and session times are included in manifest rule metadata.
- `StrategyAvailability` gives explicit user/account-specific settings availability, disabled by default. Registry sync skips non-enabled users for this new strategy; manifest responses filter it for unavailable accounts. Settings and status access are gated. Existing strategies retain their existing availability.
- Idempotent missing-Strategy provisioning handles both existing and newly created users. It does not change their passwords, existing strategy settings, consent or running state. No public enable-all endpoint exists.
- `StrategySession` has a unique user/account/strategy/IST-date index and persists rule version, per-index checkpoints, processed close/signal identity, daily ledger, reserved request/metadata, linked intent and active intent. Daily quota is shared across underlying changes and execution modes.
- `indexVwapOrbSession` restores all account/strategy session ledgers before new admission; pending older-day exposure is not discarded by a date rollover. No in-memory daily counter is authoritative.
- Existing execution leases and account validation protect mutations, with versioned compare-and-swap for the session record. The full signal/config/contract request and deterministic intent identity are committed in the same atomic reservation update. A separate OrderIntent is then created and marked prepared; this service never submits it.
- First nonzero fill consumes one daily entry. Additional partial fills do not increment again. Confirmed zero-fill cancellation/rejection or proven pre-submit failure releases reserved capacity; unknown submissions, submitted failures and orphan reservations retain it. A filled entry stays active until a terminal order and closed zero-quantity position are verified. Consumed setup/signal identities remain deduplicated even after rejection.
- Two completed entries prohibit a third, including after reconnect/restart/index changes. One pending/exposed entry per strategy/account is enforced independently of the daily cap. Contract identity/type/exchange, expiry, strike and instrument-derived lot multiple are checked before preparing an intent. Freshness/cutoff is checked again after admission reads so a delayed callback cannot use an old signal.
- Settings writes are blocked while this new strategy runs or has unresolved exposure/reservations. Account/session validation and checkpoint ordering reject stale callbacks.
- The underlying runner restores session state, invokes the pure analyzer, persists checkpoints and reports daily counts/signals in shadow mode. It does not reserve/submit orders automatically yet; Phase 4 must connect the prepared-intent service to reference-aware risk management.

## Crash and concurrency semantics

This design does not require cross-document MongoDB transactions. A single-document atomic reservation contains the complete request before the OrderIntent write. A crash between writes leaves an unresolved reserved slot; it is not silently freed or retried. A crash after intent creation is reconciled from that same deterministic intent ID. Reconciliation only reads durable order/position evidence and never calls the broker submission path.

Unique indexes are verified for admission. The deterministic session ID also prevents duplicate daily documents in initialization races. CAS version conflicts fail closed, and the existing execution lease is validated before mutation and intent creation. Orphan reservations require later explicit recovery/operator resolution; they are not guessed away. The ledger is bounded to 64 attempts/day, while filled/reserved capacity remains two. An ambiguous broker outcome cannot be made exactly-once by this ledger alone; later execution must retain existing intent/fencing/reconciliation controls.

## Provisioning and execution boundary

An explicit command is provided (from backend):

`node scripts/provisionIndexVwapOrb.js --user USER_ID --account BROKER_ACCOUNT_ID --enable-settings`

It verifies account ownership, installs additive new-model indexes and creates only missing availability/Strategy rows. It leaves explicitly disabled availability disabled. It does not start scanning, reset settings/consent or enable live trading. **This command was not run against the user's database; no account was enabled in this phase.**

Live starts are explicitly rejected for IndexVwapOrb. Its generic position-entry method is also blocked until Phase 4 reference-aware risk support is added. The phase-3 prepare service is internal, paper-only preparation and has no broker transport. There is no public order endpoint added. The existing UI and its account settings queues were not modified; browser account-switch cleanup remains the established flow.

Phase 2's historical verification stated that this strategy was unsupported by configuration validation. Phase 3 intentionally replaces that boundary with validated/gated shadow settings while keeping executable trading blocked.

## Automated validation

Final focused regression command (from backend):

`node --test tests/indexVwapOrb.phase3.test.js tests/indexVwapOrb.phase2.test.js tests/underlyingCandles.phase1.test.js tests/inputValidation.test.js tests/accountContext.phase2.test.js tests/accountOwnership.phase1.test.js tests/tradingBaseline.test.js tests/entryReliability.test.js tests/databaseSecurity.test.js`

Result: **95 passed; zero failed/skipped**. Includes Phase 3 config, gated provisioning, settings isolation/lock, concurrent duplicate admission, first partial-fill counting, two-entry limit across indices, service reload/lease reacquisition/reconnect, orphan/unknown outcome retention, confirmed rejection release, missing indexes, invalid lot metadata, stale signal, checkpoint ordering, CAS conflict, stale generation and explicit live/generic execution rejection.

Broader regression also included `positionExecution.phase5.test.js` and `executionGateway.phase5.test.js`: **134 passed; zero failed/skipped**. A later metadata-validation/settings-lock refinement was covered by the final focused run; existing execution transport was unchanged by that refinement.

Tests use real Mongoose models/validation with the existing in-memory collection boundary and simulated broker service. The Phase 3 test adapter removes Mongoose document-array parent references at the mocked BSON boundary. No real broker orders, live-market data, actual account provisioning or production MongoDB transaction/replica tests were performed. `git diff --check` passed.

## Next phase

Phase 4 must consume the already prepared intent through existing execution ownership, persist index-reference risk alongside option fills, reconcile quotas after fill/exit, and implement generic SL/TP/EOD protection/recovery. It must not create a second independent entry intent or convert spot points into premium stop prices. UI implementation remains Phase 5.
