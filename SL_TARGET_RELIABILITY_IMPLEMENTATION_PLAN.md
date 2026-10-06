# Strategy execution reliability implementation plan

Date: 5 October 2026
Status: implementation proposal; no trading code changed.

## Objective and compatibility contract

Resolve the nine reviewed defects while preserving strategy calculations, entry rules, quantities, configured exit thresholds, account isolation, PAPER/LIVE separation, and existing API routes. Production readiness is a release outcome demonstrated by tests and operational evidence; this plan is not a certification or a guarantee of execution at an exact price.

Two intentional behavior corrections must be reflected in the UI and API:

- Stop Strategy stops new entries. Existing positions remain monitored until confirmed closed. Manual Exit remains a separate action.
- Process recovery resumes management of unresolved orders and positions without enabling new entries. Browser refresh, status polling, tab closure, and application logout do not control position management.

Preserve existing response fields and introduce additive scanner, position, protection, quote-health, and reconciliation fields. Review every UI consumer rather than changing the meaning of `isRunning` silently. Preserve the current PAPER entry-price calculation for this release. Preserve historical records; do not rewrite old P&L or guess missing execution details.

## Required invariants

1. A position has one authorized execution owner and one serialized lifecycle across automatic exits, manual exit, reversal, trailing replacement, recovery, and broker events.
2. The persisted held instrument, account, execution mode, and remaining filled quantity determine broker actions. Current discovery results and newly submitted settings cannot replace them.
3. An acknowledged order is not a confirmed fill. A timeout is an unknown outcome, not proof of rejection.
4. No new order is submitted to resolve an unknown previous submission until reconciliation establishes that it is safe. Application intent IDs do not provide broker idempotency unless that capability is verified.
5. Closure requires verified fills or sufficiently complete broker reconciliation. Rejection text, missing data, and an empty response are not evidence of closure.
6. Open and unresolved positions retain durable identity and management state through stop, disconnect, database failures, and process replacement.
7. Read endpoints and frontend lifecycle events cannot acquire execution ownership or submit orders.

## Phase 0 — establish the baseline and broker contract

- Record deployed revisions, Node/Python versions, service instance counts, database topology, compute plans, account identity, and all unresolved positions/orders. Local source alone does not establish the deployed configuration.
- Capture deterministic fixtures for existing signal generation, indicator values, order parameters, configured exits, cooldowns, and successful UI flows. Obtain expected behavior from existing settings and code; flag inconsistencies separately rather than changing strategy logic during this work.
- Verify supported order types and varieties, tick and lot rules, product restrictions, order status vocabulary, partial-fill fields, cancellation semantics, order lookup, rate limits, timestamps, order validity, and session renewal for every enabled exchange/product against SmartAPI documentation and adapter responses.
- Treat correlation tags and broker idempotency as unverified until demonstrated. Do not assume protective stops and market sells form an OCO pair.
- Inventory and audit legacy open records before applying uniqueness constraints or enabling recovery. Missing account, instrument, mode, quantity, or exit settings require evidence or operator resolution.

Acceptance: written compatibility fixtures, verified broker capability matrix, deployment inventory, and an explicit list of unresolved legacy records.

## Phase 1 — durable execution records and diagnostics (issues 3, 4, 5, 9)

- Extend `backend/models/Trade.js` additively or introduce a linked position record. Store schema version, broker account, exchange/token/symbol/expiry/product, side, execution mode, entry-time configuration, resolved SL/target, trailing value and revision, requested/filled/remaining quantities, fill averages, and broker order identities.
- Add durable order intents for entry, exit, protection placement/replacement/cancellation with correlation identity, submission state, last broker evidence, and retry/reconciliation state. Persist the intent before submitting an order.
- Use conditional atomic updates and unique intent constraints. Use a transaction when a transition spans multiple documents and verify that the actual MongoDB deployment supports it. Database transactions cannot include the broker HTTP request.
- Record structured events with UTC timestamps and display IST to the user. Include position/intent/order IDs, last successful poll, quote age, skip reason, broker availability, and owner status; redact credentials.
- Add metrics/alerts for stalled polls, unprotected quantity, unresolved submissions, persistence failure, missing owner, and reconciliation backlog. Alert delivery must have bounded timeouts and must not block protection or monitoring.

Acceptance: migration is additive and repeatable; legacy completed trades still render; failed persistence cannot be silently translated into a completed trade.

## Phase 2 — serialized broker execution and reconciliation (issues 1, 4, 5, 9)

- Introduce an execution coordinator used by all order-producing paths in Node. Include manual broker routes in the concurrency review so they cannot unknowingly conflict with managed positions.
- Define explicit entry/exit intent states: prepared, submitting, acknowledged, partially filled, filled, rejected, cancelled, and outcome unknown. Keep broker protection status separate from position and scanner status.
- Retain broker order identity after the current four-check BUY or five-second SELL observation window. Continue reconciliation; never issue a new sell merely because confirmation was delayed.
- Track partial fills and remaining exposure. Protect filled entry quantity even while the remainder is unresolved. Exit only the reconciled remaining position quantity.
- Remove the Python adapter's generic alternate-placement retry after an ambiguous placement exception. A lost placement response requires reconciliation before another placement attempt.
- Route manual exit through the persisted held contract. Missing contract data produces an actionable unresolved state, never simulated live success.
- Normalize and validate broker-level success/error bodies even when HTTP status is 200. Verify cancellation terminal state and any fills before submitting a replacement or market exit. Recalculate remaining quantity after a cancel/fill race.
- Consume order updates continuously and supplement them with bounded periodic reconciliation, including after reconnect and startup. Deduplicate/reorder updates using broker evidence and prevent state regression from late events.
- Mark protection working only after broker confirmation. Handle rejection, cancellation, partial fill, full fill, and expiry. A failed replacement must not leave the cancelled stop labeled active. Re-arm protection only through the same coordinator.
- After a confirmed fill, retry persistence idempotently. Keep unresolved completion state visible until storage succeeds. On restart, reconcile the pre-existing durable intent with broker evidence.
- If the database is unavailable before an intent can be durably recorded, block new entries and conflicting submissions, retain confirmed broker protection, raise an urgent alert, and use the documented operator recovery procedure. Do not invent a successful exit. This limitation is part of the outage acceptance criteria.

Acceptance: lost acknowledgments, slow confirmations, duplicate events, partial fills, and cancel/fill races produce no blind resubmission or false closure in fault tests.

## Phase 3 — independent position management and recovery (issues 2, 3, 8)

- Extract position lifecycle ownership from `strategyEngine.js` into a position manager. Keep the strategy runner responsible for discovering opportunities and producing entry signals. Preserve existing endpoints through an adapter.
- Separate scanner subscriptions from held-position subscriptions. Retain the held contract's candle stream and warm-up history until the position is resolved; current ATM/ITM/OTM discovery may continue independently.
- Stop Strategy disables scanner entry authority and removes only scanner-owned subscriptions. Serialize stop/start against entry intents so an already-submitted BUY cannot be forgotten when Stop arrives.
- Make repeated Start requests idempotent; reject conflicting configuration changes for active positions. A new configuration applies to subsequent entries only.
- After database readiness, discover all unresolved positions/intents and acquire ownership. Repeat discovery periodically for records skipped during an outage. Reconcile broker account, orders, fills, and protection before granting execution authority.
- Restore saved breakout SL, target, trailing value, execution mode, and quantity. Resolve the actual held expiry/token, not the currently nearest expiry. Never infer LIVE/PAPER from the new Start request.
- Use a database lease/version and conditional ownership checks for process/deploy overlap. Stop broker submission when ownership is uncertain. A new owner reconciles old in-flight intents before acting; a lease alone does not prevent a delayed old broker request from completing.
- Recover position management with scanner entry authority disabled. Preserve existing authentication policy: if broker authentication is unavailable, show degraded management and reconcile once reconnect succeeds. Do not store MPIN/TOTP secrets as part of this change.

Acceptance: browser closure, Stop, strike rotation, duplicate Start, process kill, and overlapping deployment instances cannot discard an unresolved position or create two active execution paths.

## Phase 4 — bounded quotes and reliable fallback (issues 6, 7)

- Retain exchange, token, and nonempty trading symbol in fallback subscriptions. Align Node requests and Python validation with contract tests.
- Use a scheduler with one in-flight operation per monitored position. Configure bounded connect/request deadlines, cancellation, rate-limit handling, and capped retry delay. Quote fetches may retry; ambiguous broker mutations require reconciliation.
- Reject callbacks belonging to an old position generation, released owner, or already-completed position. Clearing an interval does not cancel an async callback already awaiting a response.
- Validate finite positive LTP and instrument identity. Record broker/exchange timestamp separately from local receipt time. Receiving a response now does not prove that its price is current; define and test a degraded policy when the source exposes no trustworthy quote timestamp.
- Preserve the intended monitoring cadence subject to verified broker limits and measured latency. Set explicit freshness and maximum-gap thresholds before release; expose violations rather than silently evaluating stale data.
- Log fallback HTTP failures and quote rejection reasons with rate limiting. Ensure a pending session-check promise cannot block all future session checks without a deadline.
- Serialize trailing replacements with exits so overlapping polls cannot cancel/recreate protection concurrently. Keep existing exit thresholds and cooldown rules covered by regression fixtures.

Acceptance: fallback produces valid ticks; slow requests never overlap per position; stale/missing/invalid data cannot produce a misleading healthy-monitor state or an invalid price decision.

## Phase 5 — UI compatibility and operations (all issues)

- Preserve routes, authentication flow, account isolation, strategy settings, and trade-history presentation. Update status consumers together with the additive backend fields.
- Show scanner stopped / position still managed after Stop. Keep Manual Exit available while a position is unresolved. Show uncertain fills and persistence failures as pending reconciliation rather than completed.
- Reopening any page reads the current persisted lifecycle without resubmitting Start. Application logout does not cancel management; explicit broker disconnect explains the resulting authentication limitation.
- Use always-on hosting for Node and Python, with external health monitoring. Render paid compute avoids inactivity spin-down; it does not remove the need for restart recovery. Browser traffic and keep-alive requests are not the production availability control.
- Define graceful shutdown: disable new entries, record lifecycle state, finish or classify in-flight operations, and release ownership safely. A force-kill must remain recoverable from durable intents and broker evidence.
- Prepare operator procedures for expired sessions, unknown orders, partial fills, database outage, rejected protection, and broker stop validity across sessions. Confirm actual broker validity; do not claim overnight protection from a stored order ID.

## Mandatory verification and release gates

Use isolated mocks/fault injection first, then PAPER integration tests and broker adapter validation. Never exercise order-producing tests against production accounts automatically.

| Original issue | Required acceptance scenario |
|---|---|
| 1 | Rotate discovered contracts after entry, then Manual Exit; exactly the held instrument and remaining quantity are used. Missing identity never reports closure. |
| 2 | Stop during an open position and during an in-flight entry; new entries stop, every acknowledged/unknown order remains tracked, SL/target management continues. |
| 3 | Kill/restart at every lifecycle transition; restore all unresolved records with the same thresholds, trailing level, account, mode, quantity, and held expiry; scanning remains disabled. |
| 4 | Broker accepts a BUY/SELL but the response is lost or confirmation is delayed; reconcile the original order without blind replacement. Repeat with partial fills. |
| 5 | Protective order is rejected, expires, partially fills, or fills during cancellation; status and remaining exposure follow broker evidence. |
| 6 | Disconnect the broker stream; fallback supplies valid ticks/candles and restores reversal evaluation. Return 400/401/429/500 and verify visible degradation. |
| 7 | Delay/hang quote and session requests; test stale, missing, zero, NaN and mismatched quotes; enforce deadlines and one in-flight poll. |
| 8 | Change discovery strike/expiry while holding the old contract; its candle stream and reversal evaluation remain active. |
| 9 | Fail database writes before submission, after acknowledgment, after fill and during closure; no false completion, lost durable intent or fabricated P&L. |

Also require:

- Deterministic successful-path regression for all three strategies, PAPER and LIVE adapters, indicators, signals, configured exits, cooldowns, API responses, and UI controls.
- Duplicate Start/Exit calls, concurrent manual and automatic exits, duplicate/out-of-order broker events, reconnect bursts, and old/new process overlap.
- A browser-free PAPER run exceeding 30 minutes, with both SL and target crossings, followed by full-session soak testing at expected maximum load. Monitor from outside the app browser.
- Confirm owner and quote-health metrics meet the agreed monitoring budget and broker rate limits. Record maximum observed quote gap and exit-submission latency separately from broker fill latency.
- Existing backend/Python tests, frontend build, and database/account-isolation checks pass. Tests must assert observable outcomes, not merely internal implementation details.

## Deployment order and rollback

1. Release additive schema, diagnostics, and broker normalization behind disabled execution flags.
2. Run read-only reconciliation observation. Compare intended state with broker evidence; observation has no order authority.
3. Enable the new lifecycle for PAPER and complete fault tests, browser-free runs, and soak gates.
4. Resolve legacy open records and validate broker capabilities. Perform the initial live cutover only with no unresolved live positions/orders, unless an explicit, audited ownership transfer has been proven.
5. Enable narrowly scoped LIVE operation only after release acceptance and explicit authorization for live validation. Expand after reconciled results and clean operational evidence.
6. Never let old and new position managers submit orders for the same position. Feature flags select one owner; they do not run both paths in parallel.

Rollback first disables new entries while the compatible position manager continues managing existing exposure. Do not revert to the old monitor while positions created by the new lifecycle remain unresolved. Preserve additive fields and intents; reconcile/close or safely transfer ownership before code rollback. Define an emergency broker/operator procedure if the new manager itself cannot manage exposure.

## Delivery boundaries

Suggested review units: (1) baseline and schema, (2) broker normalization/intents, (3) execution coordinator and protection reconciliation, (4) position manager/recovery, (5) quote scheduler/fallback, (6) UI compatibility and operations, (7) release evidence. Each unit includes its relevant tests; none independently authorizes live rollout.

Primary existing files: `backend/services/strategyEngine.js`, `backend/services/marketDataService.js`, `backend/services/pythonApiClient.js`, `backend/services/orderUpdateService.js`, `backend/services/contractManager.js`, `backend/models/Trade.js`, `backend/index.js`, strategy and broker controllers, `angel-one/app/services/angel_client.py`, `angel-one/app/services/broker_session.py`, `angel-one/app/main.py`, and the three strategy pages.

## Primary references

- SmartAPI order and market-data contracts: https://smartapi.angelone.in/docs
- MongoDB transactions and deployment requirements: https://www.mongodb.com/docs/v8.0/data-modeling/enforce-consistency/transactions/
- MongoDB unique index migration constraints: https://www.mongodb.com/docs/v8.0/core/index-unique/
- Render service availability behavior: https://render.com/docs/faq and https://render.com/docs/free

Broker capabilities, deployed topology, timing budgets, and release evidence remain implementation gates. Production-ready status must be withheld until those gates pass.
