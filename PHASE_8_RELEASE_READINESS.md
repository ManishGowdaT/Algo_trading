# Phase 8 Production Hardening and Release Gates

This document records repository-enforced hardening and the operational checks that require access to the deployed environment. Phase 8 does not enable multi-user LIVE trading.

## Repository changes

- Node and Python fail startup in production if the shared service key is shorter than 32 characters. Node also requires MongoDB, explicit HTTPS CORS origins, a secure Node-to-Python URL, and TLS-enabled MongoDB (`mongodb+srv://` or `mongodb://...?tls=true`). Plain HTTP Node-to-Python traffic is accepted only with `ALLOW_PRIVATE_HTTP_SERVICE=true` and a loopback, RFC1918, or `.internal` host. The deployment must ensure that hostname is reachable only on a private network.
- Python requires HTTPS for Angel One and browser origins in production. Broker gateway audit events include verified user, account, session generation, route, status, duration and request ID; they never include request bodies or headers containing credentials. Node emits similarly scoped structured audit records. The Python local order-attempt store removes credential-named fields and redacts credential-shaped values before writing.
- Admission bounds: Node caps total in-flight HTTP work at 1,000 by default (configurable up to 10,000), Python has at most 32 account workers and 8 concurrent reads per account, and the Node quote budget allows 4 simultaneous quote reads per account and 16 total in one Node process. HTTP route limits are authenticated-user scoped. These are process-local; deployment must constrain replicas or supply shared rate-limit storage before relying on a fleet-wide quota.
- The operational watchdog reports account-scoped missing/stale execution owners, stale position quotes, unprotected exposure, aged unresolved intents, recovery degradation, broker session failure and monitoring/persistence scan failure. Infrastructure health stays separate in the existing system health response. Audit logs and alert events are also emitted to standard output for the platform log collector.
- SIGTERM/SIGINT enters drain mode, rejects new broker login and strategy Start requests, stops scanner entries, and leaves existing position managers running during the drain window. It does not log broker sessions out or clear account feeds before process termination. The next process must complete the existing lease and durable recovery process before it can mutate broker state.
- Account offboarding is an explicit service operation. It requires an owned account, a disconnected broker, no unresolved Position, LIVE Trade, or OrderIntent; it disables the account by versioned update and retains trade/order history. It does not delete the user, account, historical trades or audit records.

## Limits and known boundaries

- API keys, MPIN, TOTP, JWT and broker session tokens are not modeled in the MongoDB schemas. Credentials exist in request/process memory. Production database and disk encryption at rest are provider settings and are not established by repository code. The Python SQLite order-attempt database is local service state; it is not a cross-instance recovery authority and must not be treated as a backup of MongoDB execution records.
- Node's HTTP rate limiters, quote budget and metrics counters are process-local. Python's worker caps are per Python process. Until shared limits are installed, keep Node and Python replica counts within the tested topology and do not scale horizontally based on assumptions.
- A deployment cannot guarantee an unprotected position remains monitored after the old process is killed. LIVE rollout requires verified broker-side protection and a successful owner/recovery handoff. A forced termination during broker/network/DB failure remains a degraded state requiring reconciliation; do not infer a fill or P&L.
- MongoDB transactions used by ownership and execution paths require a replica set. The repository cannot prove the deployed MongoDB topology, backup retention, point-in-time recovery, TLS configuration or restore quality.

## Graceful shutdown and rolling deploy procedure

1. Confirm the replacement build passed Phase 0–8 regression, Python, Node and frontend suites and that all durable indexes exist.
2. Confirm broker-side protective orders are healthy for every LIVE open position; inspect all UNKNOWN, PARTIALLY_FILLED, CANCEL_PENDING and RECONCILIATION_REQUIRED intents.
3. Begin a single-instance rolling deploy. The old Node process stops new strategy entries and drains HTTP while continuing to manage known positions. Do not overlap uncoordinated execution owners; the account lease is the mutation fence.
4. Wait for the replacement health probe, database recovery scan, account recovery and feed readiness. Confirm entries remain stopped until a user explicitly starts them.
5. Compare open broker positions/orders with durable Position and OrderIntent records by user/account. Halt rollout on any missing owner, stale quote, unprotected exposure, cross-account event or unknown order.
6. If readiness fails, roll back the application artifact. Do not delete or rewrite additive records/indexes; keep the lease/recovery fence enabled and continue broker/operator reconciliation.

## Backup, restore, and account offboarding

- Use the MongoDB provider's encrypted automated backups and point-in-time recovery. Before a release, capture a provider snapshot and record its restore point. Restore into an isolated non-production replica set, run schema/index checks, `startupRecovery.initialize()`, and compare user/account ownership, open positions, unresolved intents, order fills, protective orders and trade history against the source snapshot.
- A database restore is not broker truth. Before execution resumes, query each verified broker account and reconcile orders, fills and protective state. Preserve UNKNOWN state where evidence is incomplete; never synthesize P&L.
- Offboarding sequence: stop new entries; reconcile and close/resolve all exposure and intents; disconnect the broker using the normal account path; run `accountOffboarding.offboardAccount` with the verified owned account context; verify status `DISABLED`; verify old trades/intents remain readable only by their owner. If anything is unresolved, the operation returns a conflict and retains the account.
- Rollback of offboarding requires an operator-reviewed account re-enable and normal broker reconnect/recovery. Do not delete account history or directly reactivate a stale session.

## Required external release gates

- Angel One approval for the intended multi-client product use, per-client API/session/WebSocket/orderbook limits, account entitlements, static IP allowlisting, market-data/order permissions and production credential handling.
- Render service plan confirms no inactivity spin-down, enough CPU/memory, a termination grace period compatible with `GRACEFUL_SHUTDOWN_MS`, private networking for any opted-in private HTTP gateway, TLS at the public edge, and a deliberate Node/Python instance count.
- Production MongoDB is a TLS-enabled replica set with encryption at rest, unique indexes, tested backups and a successful isolated restore exercise. Confirm network allowlists and secret-manager access.
- Run actual multi-account PAPER soak and browser-free SL/target monitoring for more than 30 minutes. LIVE validation requires explicit broker and operator approval with a bounded account, no unprotected exposure, and a rehearsed rollback. This repository run cannot validate real Render logs/events, provider backup restoration, static IP, or Angel One behavior.

## Rollback and release stop conditions

Disable new account admissions or new strategy starts per the deployment's release switch, roll back the code artifact, and retain additive data and leases. Do not automatically stop the old position manager, clear recovery state, or mark unresolved work failed. Stop expansion and require operator reconciliation after any cross-user activity, false closure, stale quote, missing lease owner, unprotected exposure, failed restore, or unresolved order after a deploy.
