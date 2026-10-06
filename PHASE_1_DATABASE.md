# Phase 1 — Additive ownership and durable records

**Scope:** local Phase 1 database/repository foundation only. Trading execution, strategy rules, existing HTTP routes, Python broker sessions, frontend flows, and account-specific sockets are not wired to these records in this phase. Do not treat this work as multi-user LIVE readiness.

## Schema additions

- `BrokerAccount` records bind one application `userId` to one normalized Angel One `brokerClientId`. Unique indexes enforce one linked broker account per application user and one application owner per broker client code. Only safe status and generation metadata is stored; API keys, MPIN/TOTP secrets, and session tokens are excluded.
- `StrategySettings` stores one versioned configuration per `{userId, brokerAccountId, strategyId}`.
- `Position` stores an immutable entry-time execution snapshot, account/strategy/trade ownership, quantities, lifecycle state, protection metadata, generation numbers, reconciliation health, an intent revision, and an optimistic version.
- `OrderIntent` stores an immutable broker request snapshot, account/strategy ownership, optional position/trade links, idempotency key, state, fills, broker IDs, generations, and reconciliation metadata. Entry intents can exist before their trade/position is created. Intent rows are retained as audit history.
- Existing `Trade` records gain optional `brokerAccountId` and optional immutable execution snapshot fields plus a non-unique owner/account query index. Existing trade IDs and documents are not rewritten.

## Migration

Run from `backend/` after setting `MONGO_URI` for the target environment:

```powershell
node scripts/phase1OwnershipMigration.js
```

The script calls Mongoose `createIndexes()` only. It does not use `syncIndexes`, alter existing documents, backfill uncertain account ownership, delete data, or replace historical IDs. Re-running it is safe. It creates indexes on the new Phase 1 collections and the additive Trade index. Index creation still needs to be run and observed against a backed-up target database before deployment; the repository tests do not prove production database availability or index-build behavior.

## Ownership boundary

`backend/services/accountRepository.js` requires the authenticated `userId` and `brokerAccountId` in every record lookup/update/delete filter. It validates account, strategy, trade, and position relationships before creating child records. State transitions require status/version checks, and Mongoose query middleware re-reads and validates cross-field quantities before applying a versioned compare-and-set update. Same-status position updates can persist quote, protection, and reconciliation metadata. Position/order snapshots reject nested document and query updates. Cross-user known-ID requests return no record. Order intents cannot be deleted. A position can be deleted only when it is flat, closed, and has no linked order intents; deletion and position-linked intent creation/linking use a MongoDB transaction and bump the position intent revision so concurrent operations conflict. If transactions are unavailable, those operations fail closed. Generation counters advance atomically and cannot be assigned arbitrary lower values through the repository.

This repository is a Phase 1 persistence boundary, not an integration into current controllers or execution paths. Existing trade APIs continue their existing user-scoped behavior. All new account-owned API paths must call this repository and must derive `userId` from authenticated server context rather than request body fields.

## Rollback

Stop new code from writing Phase 1 collections, deploy the previous application revision, and retain the new collections and added Trade fields/index for investigation. Do not drop collections or indexes during a live rollback; they are additive and contain durable ownership/audit data. Any later destructive cleanup requires a separately reviewed backup and migration plan.

## Local verification

The tests cover schema compatibility with legacy Trade documents, owner-filtered operations using known foreign IDs, reference ownership, compare-and-set lifecycle changes, monotonic generation increments, and position/order quantity invariants. Persistence-path tests run real Mongoose model queries and document validation with the MongoDB driver collection stubbed, so they exercise Mongoose casting and middleware but do not replace replica-set transaction tests, MongoDB integration testing, or production index verification.

Phase 1 acceptance requires unchanged Phase 0 fixtures, full Node and Python suites, new ownership tests, and single-user compatibility checks. Broker, Render, deployment, network/IP, and live position/order checks remain the explicitly accepted external release gates before multi-user LIVE rollout.
