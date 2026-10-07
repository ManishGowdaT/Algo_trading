# Signal, candle timing and entry reliability implementation plan

Date: 7 October 2026
Status: investigation and plan only. No production implementation in this task.

## 1. Objective and safety contract

Ensure a fresh, eligible strategy signal reaches one account-owned execution coordinator promptly, survives recoverable failures before order submission, and receives an explicit submitted, pending, filled, rejected, blocked or expired outcome. Prevent avoidable dropped signals, duplicate orders and entries driven by incomplete or unrelated candle events.

No system can guarantee an order during a broker outage, invalid session, database outage or unknown previous order outcome. The production requirement is reliable processing and safe recovery, with a visible reason whenever execution is withheld. Do not remove ownership checks, bypass recovery, assume a timeout means rejection, or blindly resubmit BUY/SELL.

“Without interruption” is therefore defined as: every eligible fresh signal is admitted once or ends in a durable, visible reason; recoverable pre-submit failures can resume while that signal remains valid; uncertain submissions are reconciled; open exposure continues to be managed. It does not mean forcing an order when account ownership, risk state, market data, persistence or broker outcome is uncertain.

Keep strategy formulas, CE precedence, configured quantities, SL/target/trailing calculations, cooldown durations, PAPER pricing convention, LIVE consent, API paths, frontend navigation and account isolation. Correct candle admission/timing and pre-submission retry behavior as explicit safety corrections. These corrections can legitimately remove premature/stale entries that the old code permitted; preserve valid closed-candle outputs rather than preserve those defects.

Existing open/unresolved position management must retain priority throughout implementation and deployment. Stop, logout and browser closure must retain their existing position-management guarantees.

## 2. Revisions and investigation boundaries

| Item | Verified value |
|---|---|
| Current local branch | `feature/multiuser2` |
| Current revision | `d7ff72e05ee5b37f1fd36771e11fc20319229f2a` |
| Comparison branch | `feature/new-multiuser` |
| Comparison revision | `30b763b1fb4140426508fb6be2620a6109316d03` |
| Locally recorded remote comparison ref | `origin/feature/new-multiuser` resolves to the same comparison revision |
| Initial working tree | Clean |

Compared the local refs without switching branches, fetching remote updates or running live broker operations. The remote ref is locally cached; this task does not establish the latest GitHub revision. The deployed Render commit/environment and individual incident broker orders are not independently verified.

Reviewed current and comparison signal-to-entry paths, plugin manifests, candle builders/backfill, lease acquisition/renewal, Python dispatch/fencing, historical-candle endpoints and trade-history timestamp rendering. The pasted document is incident context, not authorization to change production execution.

## 3. Findings and evidence

### F1 — High: quiet scanners retain an expired execution lease

`backend/services/executionLeaseService.js:6-7, 35-61` uses a 30-second lease and renews on demand through `executionContext()`. `RENEW_MS=5000` is a threshold; there is no five-second renewal scheduler here.

`strategyEngine.js:425-426` calls the account execution manager's `resume()` during Start. `positionExecution.js:200-225` enters `run()` and obtains a lease even when no position or intent exists. Its one-second reconciliation timer starts for exposure, not for an idle scanner. Following an exit, retirement stops that timer while the local account lease can remain cached.

If the next signal occurs more than 30 seconds after the last execution work, `executionContext()` tries to renew the cached expired token. The renewal query requires `leaseUntil > now`; it matches no record, clears the local token and throws `EXECUTION_LEASE_UNAVAILABLE`. A later attempt may acquire a new generation, but the initial signal has already encountered F2. Another strategy actively executing on the same account can keep the shared lease alive, explaining intermittent behavior.

Local reproduction used the actual lease-service methods with a simulated clock/database adapter: after 31 seconds without execution, the next admission returned the exact ownership-unavailable error; a following admission acquired generation 2. This verifies a code failure path, not the exact production incident.

Other possible ownership failures remain legitimate: a different process owns an unexpired lease, local/durable generations disagree, or ownership changes during an operation. Never treat all ownership errors as safe permission to retry.

The lease is account-scoped while execution managers are strategy-scoped. Implement one account renewal/acquisition lifecycle with single-flight serialization: simultaneous first access by two strategies in one process must not both increment the generation or invalidate the first strategy's token. Preserve the same owner/generation during renewal; generation advances only after a real ownership transfer/acquisition. Renewal errors must be classified separately from a legitimate other-owner conflict.

### F2 — High: an unsuccessful entry consumes the candle before execution succeeds

`backend/services/strategyEngine.js:717-736` sets `lastEntryTime` before awaiting `executeEntry()`. Errors are logged at line 742 without restoring a retryable signal state. The same candle can repeatedly log `SIGNAL GENERATED (YES)` at line 710 while the timestamp gate prevents another entry attempt.

The account path at line 763 routes into `positionExecution.js:456-502`, which verifies account context, leases/fencing, existing positions/intents, indexes and LIVE broker readiness. A failure before any broker mutation must be distinguished from an unresolved submission.

Local reproduction exercised the actual scanner listener and strategy plugin, using deterministic buffers and an entry fault: two qualifying events produced two YES logs, one entry attempt, and a retained `lastEntryTime` after the ownership exception.

### F3 — High: another timeframe's candle can wake a five-minute strategy

`backend/services/strategyEngine.js:746-755` verifies account/session identity and token but does not validate exchange, event interval or subscription role against the entry/held-position purpose. The account feed wrapper isolates accounts but also does not enforce strategy timeframe.

ModifiedHeikenAshi's manifest requires `FIVE_MINUTE`. A `ONE_MINUTE` event for the same account/token, such as a breakout scanner or a held-position builder, can nevertheless invoke its scan. The scan reads the latest buffer for both CE and PE rather than restrict evaluation to a matching immutable closed-candle snapshot.

The reproduction above deliberately delivered ONE_MINUTE events to ModifiedHeikenAshi and confirmed its FIVE_MINUTE entry evaluation ran. This is a confirmed routing defect. The screenshot alone cannot establish that this caused the particular 10:28 record.

### F4 — High: historical seed has no completed-candle admission or atomic merge

`backend/services/marketDataService.js:463-479` parses all returned current-day historical candles and directly assigns `builder.candles = parsed`. It does not filter `candleStart + interval <= trustedNow`, deduplicate against the live stream, or merge with candles finalized while the REST response was in flight.

`angel-one/app/main.py:498-538` queries a date from 09:15 through 15:30, including today's date. `angel_client.py:293-373` returns broker rows without a closed-candle filter. Whether a particular broker response includes the currently forming candle requires deployed response validation, but the admission gap is present in the code.

Combined with F3, a one-minute callback at 10:28 can evaluate a seeded 10:25 five-minute candle before its 10:30 close. Alternatively it can evaluate an older qualifying candle. Backfill can also overwrite newer live history or duplicate a timestamp when the active candle is subsequently appended.

### F5 — Medium: rate-limit/transient failures cause older-day warm-up substitution

`strategyEngine.js:272-307` catches every warm-up failure and immediately moves to the next earlier calendar date. The screenshot shows an October 6 request receiving 429 followed by successful October 5 warm-up. Another strategy shows the same older-day progression after 500.

A rate-limited trading day is not an empty/non-trading day. Substituting older history changes the initialization input to HA/EMA/JMA. The formulas are unchanged, but the resulting signals can differ. Prior descriptions of these warnings as merely optional need this qualification.

Warm-up requests use `callAngelApi()` with `timeoutMs=null`, so this Node transport has no explicit deadline. Deduplication is only per runner/side/token. Contract rotation and simultaneous strategies can generate duplicate history requests. `marketRequestBudget.js` is admitted only for LTP/index-LTP reads in `pythonApiClient.js:28-32`; it does not cover candle requests.

The 429 screenshot explicitly reports upstream access-rate denial. This supports rate limiting; it does not identify every caller consuming the entitlement or prove the correct limits are configured. The 500 message is intentionally sanitized in Python, so the original cause needs the correlated Python request log.

### F6 — Medium: aborted scan requests lack enough context for diagnosis

`pythonApiClient.js:34-37, 67` aborts requests with configured deadlines. The default is 5000 ms; the LIVE readiness check is also 5000 ms. Python ownership registration uses the configured deadline. Python account worker admission is bounded, and pressure can delay/reject requests.

`positionExecution.js:49-68` can propagate an ownership-registration timeout before creating an entry intent. LIVE readiness checks can also fail before submission. Some later failures involve already-durable intents and require reconciliation instead of retry.

`strategyEngine.js:742` prints only the error message, omitting request path, timing, signal key and submission stage. Therefore the screenshot's `This operation was aborted` cannot be attributed conclusively to a particular request. A Node abort does not prove the Python operation stopped.

### F7 — Medium: displayed entry time is persistence time

`positionExecution.js:357-377` creates Trade when observed fills are materialized. Mongoose timestamps supply `createdAt`. `algo-trading/src/pages/TradesPage/TradesPage.tsx:227, 571` formats that timestamp using the browser's local timezone.

The new execution path at `strategyEngine.js:763` does not forward its `timingInfo` argument into `PositionExecution.entry()`. The persisted entry metadata has signal price/trend/config but lacks that timing trail. No reliable comparison of candle close, signal, submission, broker fill and persistence is currently available from this history row.

10:28 may represent an early/mismatched evaluation, a delayed closed-candle delivery, broker fill/reconciliation latency or delayed database persistence. Five-minute signals should be evaluated after the relevant close; actual broker fill time is not guaranteed to be precisely on a five-minute boundary. Never round timestamps to hide latency.

### F8 — Medium: tick-driven closure can arrive late or replay gap events

`marketDataService.js:255-335` closes a candle when the first tick from a later interval arrives. Sparse/delayed ticks can deliver a 10:25 close at 10:28. Gap filling emits synthetic candles without source/synthetic/age metadata that the scanner can use to withhold fresh entry authority.

This tick-driven behavior existed on the comparison branch. Do not add a timer that fabricates prices or new signals. Separate bar finalization from authority to submit a fresh order.

## 4. Branch comparison

| Area | feature/new-multiuser | Current branch | Conclusion |
|---|---|---|---|
| Entry execution | Runner directly submits LIVE BUY, checks orderbook up to four times, or simulates PAPER | Account coordinator, durable intents/positions, lease and Python generation fence | Current safety requirements add failure gates; F1 is avoidable lifecycle failure |
| Lease checks | No executionLeaseService/PositionExecution foundation | 30-second renewable durable lease | Older branch cannot demonstrate correct deploy-overlap safety |
| Signal timestamp gate | Candle marked handled before entry | Same pattern | F2 is inherited |
| Candle callback admission | Token check without timeframe/exchange check | Account/session isolation added; interval/exchange/purpose still unchecked | F3 is inherited and can also involve new held-role builders |
| History seed and first-next-tick closure | Direct seed and tick-driven close | Same core behavior with isolated feeds | F4/F8 are inherited |
| Warm-up date fallback | Catch failure and try older calendar dates | Same core pattern with account transport | F5 is inherited |
| Plugin calculations | HA/ModifiedHA indicator and signal implementations | No diff in these plugin files or indicators between compared revisions | Correct admission should preserve valid-input formulas |
| Execution timing logs | Direct entry path logs signal/send/confirmation/persistence stages | Verified-account path bypasses those legacy timing logs | F7 worsens incident visibility |

Do not copy the old entry function or disable leases to make trades appear. Older-branch success does not prove resilience, correct candle timing, or safe uncertain-order handling.

## 5. Implementation phases and acceptance gates

### Phase A — Capture evidence and compatibility fixtures

Changes: add production-path regressions for F1-F8 before functional changes; capture signal/input/config outcomes for all three strategies. Record incident deployment SHA, owner/generation/lease expiry, strategy/account, broker order IDs, signal candle and request IDs. Use sanitized fixtures with no credentials.

Fixtures must cover a flat scanner waiting over 30 seconds, exit followed by more than 30 seconds idle, simultaneous same-account strategies, cross-timeframe events, current-bar REST history, seeding while live candles close, stale/gap events, 429/500, and timeout before/after submission. Include PAPER and LIVE broker simulations.

Unchanged: all production behavior in this phase; existing Phase 0 expected outputs remain the contract. Invalid/incomplete-candle fixtures must be marked as planned safety corrections, not silently rewrite the baseline.

Acceptance: each regression reproduces its intended defect through actual methods; production incident hypotheses remain distinct from proven repository defects. Obtain the specific 10:28 Trade/OrderIntent and broker fill timestamps where access is available.

### Phase B — Repair account lease lifecycle and owner admission

Changes: introduce one bounded renewal task per locally active execution account, shared by its strategies and retained while exposure/intents require management. Acquire/register authority before declaring entry readiness. Renew before expiry with sufficient margin, independently of slow market/history requests, without changing generation on routine renewal.

Handle an expired local token inside admission: discard it, attempt conditional acquisition, reconcile account exposure/intents and register the accepted Python fence before mutation. If another process owns the lease, wait within signal validity or expire visibly. Revalidate immediately before every mutation. Preserve monotonically increasing generations and stale-owner rejection.

Use database-confirmed expiry and explicit clock-skew margins. Bound heartbeat overlap and database timeout. Loss of renewal immediately withholds new mutations and marks affected account authority degraded; recovery must not automatically restore entries from stale signals. Coordinate with existing drain/handoff so renewal lasts through management drain and stops only after quiescence/release. Never release another process's lease.

Unchanged: one execution coordinator per account/position, account ownership validation, persisted exposure, trading calculations and PAPER/LIVE semantics. This also applies to PAPER's durable execution authority.

Acceptance: scanner waits 5+ minutes then its first eligible signal works without a sacrificial failure; first post-exit signal works; no duplicate account heartbeat; Mongo outage, delayed heartbeat and old/new overlap cannot produce two valid owners or broker mutations. Force-kill and Python restart require reconciliation/fence confirmation.

### Phase C — Replace consumed-candle handling with durable signal decisions

Changes: define an additive SignalDecision ledger, or an equivalently durable decision linked to the existing OrderIntent. Use a unique account/user/strategy/instrument/exchange/timeframe/closed-candle/direction identity. Session and execution generations annotate decisions rather than create new identities for the same signal. Capture an immutable contract/config/input snapshot and retain existing CE priority.

Separate evaluated, queued, blocked-before-submission, intent-prepared, submitting, unresolved, filled, rejected and expired outcomes. A boolean return from entry is insufficient. Link the signal to exactly one durable intent before broker mutation. Replace timestamp-only `lastEntryTime` suppression with decision-state admission and bounded per-account scheduling.

Retry a valid decision only when evidence proves no broker mutation was submitted. Once an intent is PREPARED/SUBMITTING/UNKNOWN, use the existing intent reconciliation path before deciding on any mutation. Broker rejection must have an explicit terminal policy, not unlimited retries. Timed-out submission stays unresolved. Stop/consent change cancels queued new-entry decisions; unresolved exposure remains managed.

Define explicit configurable signal age/slippage admission limits, measured from canonical candle close. Proposed values must be validated in PAPER before approval; do not silently allow unlimited delayed entries or auto-start on restart. A stale queued signal expires with a reason. Reconnect/strike rotation must not retarget an old decision to a new instrument.

Unchanged: signal predicate, quantities, CE precedence, position protection/exit rules, cooldown durations and LIVE consent requirements. A fresh signal is still blocked by existing exposure or unresolved broker state.

Acceptance: transient pre-submit lease/status failure followed by readiness results in one BUY while valid; duplicate/late events and restarts never duplicate BUY; two users never share decisions; unknown BUY never resubmits; decisions expire deterministically and reveal why no trade occurred.

Signal validity must use the immutable strategy/account/instrument/config decision snapshot. A session reconnect or strike rotation cannot silently mutate that snapshot. Resumption is allowed only when the original instrument is still valid and a fresh quote passes the approved age/slippage checks. A failed validation expires the decision with a reason and waits for the next fresh signal.

### Phase D — Correct event routing and completed-candle admission

Changes: events carry explicit exchange/token/interval/role/session, bar-open/bar-close, delivery time, source and synthetic classification. Entry callbacks accept only the manifest's effective input timeframe and scanner purpose; held-position callbacks follow their own existing reversal timeframe. Breakout must continue using its existing ONE_MINUTE range input despite its strategy name.

Reject wrong-exchange, wrong-timeframe, stale-session and unrelated-role entry events. Evaluate immutable closed-bar snapshots using the event's cutoff; prevent CE or PE history beyond that cutoff from entering calculations. Keep CE priority when both qualify for the same legitimate evaluation window.

For paired CE/PE strategies, define a per-account/strategy evaluation watermark. Do not evaluate a pair until the required closed candle is available for each leg at the same interval and close boundary; do not let whichever token reports first combine a new CE bar with an older or still-open PE bar. Preserve CE-before-PE only when both signals are calculated from that same eligible pair snapshot. Keep strategy scanner bars distinct from held-position reversal bars.

Filter REST seed to completed bars using timezone-aware interval boundaries, a trusted clock and an explicit policy for delayed broker data. Normalize IST/UTC consistently, validate/sort/deduplicate by exchange/token/interval/time and atomically merge with live closed candles. Keep the active candle separate. Reconcile overlap deterministically; uncertain/conflicting historical input withholds fresh entry until verified. Do not emit historical/gap catch-up as fresh signals. Preserve existing gap data for calculation where baseline compatibility requires it, with freshness/source metadata controlling order authority. Never infer an OHLC candle close from the arrival time of an unrelated token's tick.

If timely boundary finalization needs a scheduler, add it only after proving how final prices/completion are established. Never fabricate an OHLC close from a timer. Delayed data must be repaired/reconciled rather than advertised as a fresh on-time candle.

Unchanged: OHLC and HA/EMA/JMA calculations for complete, valid input; existing held subscriptions, immediate quote-based SL/target/trailing monitoring and account isolation. Entry timing corrections are explicit, reviewed behavior changes.

Acceptance: ONE_MINUTE events cannot initiate ModifiedHA/FIVE_MINUTE entries; five-minute 10:25 bar cannot authorize entry at 10:28; delayed 10:20 closure is timestamped as such and subject to age policy; incomplete seed rejected; late REST cannot erase live candles; duplicate/out-of-order bars cannot repeat an entry; breakout ONE_MINUTE behavior remains compatible.

Historical timing policy must distinguish a candle that is complete by exchange time from one that is merely present in an API response. Obtain Angel One's deployed response behavior for today's candle. If the source cannot establish completion, withhold that bar from entry evaluation until a later verified response or finalized live stream confirms it.

### Phase E — Bound historical traffic and make warm-up deterministic

Changes: implement account/session/instrument/interval/date single-flight history fetch and bounded caches used by scanner seed, warm-up and charts. Share only responses proven safe to share under broker entitlement and data ownership rules; otherwise scope cache entries by verified account/session. Retain explicit account context. Validate ownership before serving account-scoped cache data. Cache verified empty market-day responses separately from transport/broker failures.

Add endpoint-specific per-entitlement and global budgets at the Python outbound broker boundary, with bounded priority queues and distributed coordination if more than one gateway can serve an entitlement. Confirm the actual Angel One limit scope and all concurrent consumers before setting values; reserve capacity rather than running at the documented ceiling. Incoming HTTP and concurrency limits are not substitutes for broker rate limits. Reserve management/order-reconciliation capacity; history/chart work cannot consume it. Apply deadlines across Node queue/transport and Python worker/SDK calls; propagate a durable idempotency/correlation key so a Node abort alone cannot trigger duplicate downstream work.

Honor Retry-After where present; back off with jitter for read-only 429/temporary failures within a finite budget. A 429/500 must not automatically move warm-up to an older date. Advance to older dates only on verified non-trading/empty-history outcomes under the existing market calendar policy. Warm-up remains account/instrument scoped and keeps held-position history separate from scanner rotation.

Set a visible WARMING_UP/DATA_DEGRADED entry readiness gate when required verified history is unavailable. Resume eligible current entries once ready; do not change active position monitoring or replay expired historical signals. Avoid reducing indicator history silently to bypass errors.

Market calendar decisions must use the configured exchange/underlying timezone and an authoritative trading calendar. A verified empty response on a holiday may advance the existing previous-trading-day lookup; a transport error, rate limit, session error or server error may not. Do not advance by a fixed calendar offset and label it the previous trading day without this validation.

Unchanged: historical date-selection semantics when broker data is available, strategy lookback/formulas, instrument selection rules and all order retry safety constraints.

Acceptance: simultaneous strategies and charts requesting the same history produce one outbound request per cache miss; sustained/burst quotas are obeyed; 429 does not substitute an older trading day; B keeps operating when A is rate limited; history timeouts do not exhaust management capacity; auth/session changes invalidate appropriate caches and queued work.

Before LIVE release, derive measurable admission-latency, quote-age, queue-wait, recovery-time and alert-delivery objectives from staging/PAPER measurements and broker limits. A service-level target must never override a risk gate or signal expiry. Record p50/p95/p99 and maximums by stage and account; do not promise broker acknowledgement/fill latency controlled by Angel One.

### Phase F — Expose signal, execution and persistence outcomes accurately

Changes: forward timingInfo into the verified execution path. Add optional timestamps for canonical bar open/close, signal detection, decision admission, intent preparation, submit, acknowledgement, broker fill, reconciliation and materialization. Record only timestamps supported by evidence; explicitly label observed fill time when the broker supplies no fill timestamp.

Keep createdAt and historical IDs unchanged. Add timestamps to existing API payloads compatibly. Preserve the current history display initially; an optional later display correction can show verified fill time with a clearly labeled fallback, but must not relabel persistence time as broker fill or round entry to a candle boundary. Use UTC storage and explicit IST operational display.

Log redacted account/strategy/signal/intent/request/owner identities, request route, deadline, duration and decision outcome. Separate SIGNAL_MATCHED from ENTRY_ADMITTED and BUY_SUBMITTED. Explain duplicate, lease wait, warming-up, stale signal, pending order, rejection and unknown outcomes. Reuse existing scoped notifications/metrics and rate-limit repeated alerts.

Unchanged: API paths, normal frontend workflow, historical trades and performance calculations. Never put keys, JWTs, MPIN or TOTP into decision records/logs.

Acceptance: every YES signal has a traceable admission outcome; every abort identifies its request/stage; timing can distinguish 10:28 detection, submission, fill and DB creation; health and errors remain isolated per account.

### Phase G — Regression, soak, deployment and rollback

Run full Node, Python, frontend and Phase 0-8 regressions after implementation, serially, with normal teardown. Add real Mongoose persistence/index tests and production Node-to-Python paths; do not mock away ownership, event registration, deadlines or transport.

Load scenarios: multiple strategies on A plus B, same tokens/timeframes across accounts, concurrent charts/warm-up/rotation, long flat scanners, repeated exit/cooldown/re-entry, clock skew, sparse ticks, 429 storms, 500/timeouts, database disruption, Python/Node restart and rolling old/new owners. Run at least a full market-session PAPER soak including browser closure; report account count, request rates, latency percentiles, queue saturation and alert outcomes. Validate selected LIVE cases only after external release gates.

Release separate reviewed changes in dependency order with additive schema/index migrations. Preflight duplicate signal keys before installing unique indexes; retain existing IDs/history. Do not rewrite active position snapshots or migrate ownership with guessed account data. Treat the decision ledger as an append-only audit of outcomes; enforce unique idempotency at the durable order-intent boundary as well, so a database retry cannot create two mutations. Define retention, indexes, encryption/access controls and bounded storage growth before rollout.

Deploy first to isolated staging/PAPER. During broker-compatible staging, require zero duplicate mutations, zero wrong-account events/orders, zero entries from unfinished bars and zero permanently lost fresh decisions after recoverable pre-submit failure. Measure healthy eligible-signal admission latency against an approved target; distinguish infrastructure, queue and broker latency. Shadow-evaluate the corrected candle gate against captured complete bars and compare strategy outputs before enabling corrected admission. Any changed outputs must be attributable only to rejected incomplete, stale, wrong-timeframe or mismatched-pair inputs. Run a canary with new entries disabled first, then PAPER, then controlled LIVE only after every external release gate and real-account approval is satisfied.

Rollback: stop new-entry admission, keep exposure management/reconciliation and current leases active through safe handoff, drain queued unsubmitted decisions, preserve every unresolved intent and additive record. Roll back only to a version compatible with the active durable state and fencing contract. If no compatible version exists, deploy a forward repair with entries withheld. Never roll back to the older direct-order branch over current unresolved positions. Do not delete ledgers/intents or reset generations to clear errors.

Unchanged: existing protection/recovery responsibilities, account isolation and execution evidence requirements during release/rollback.

Acceptance: all local regressions and realistic soak pass; restart/drain tests prove management continuity; incident logging confirms the fixes on the deployed revision; external broker/deployment gates are completed before claiming LIVE readiness.

## 6. Required new production-path tests

| Scenario | Expected result |
|---|---|
| Start with no position; first signal after 31 seconds and five minutes | Valid ownership acquired/maintained; no first-attempt lease drop |
| Exit, retire monitor, wait, receive another signal | One new entry with correct configuration/cooldown |
| Pre-submit ownership/fence/readiness failure, then recovery | Same valid decision remains retryable; exactly one intent/order |
| Timeout after POST may have reached broker | UNKNOWN/SUBMITTING retained; reconciliation; no second BUY |
| Duplicate signal across callbacks, reconnect and Node restart | Unique durable decision/intent prevents duplication |
| A/B same token and simultaneous account renewals | Independent leases, decisions, feeds and orders |
| One-minute event delivered to ModifiedHA five-minute listener | No fresh entry evaluation from that event |
| Held-role candle or wrong exchange delivered to scanner | No unrelated entry; held reversal management stays functional |
| Partial current-day REST bar at 10:28 | 10:25 FIVE_MINUTE bar excluded until verified completion |
| Late REST seed while live close arrives | Atomic merge; no lost/duplicated closed candle |
| Sparse tick delivers an old close at 10:28 | Correct close timestamp/source; enforce age policy |
| Ghost/gap candles after reconnect | Calculation compatibility preserved; no historical entry replay |
| October 6 429/500; October 5 available | Failure does not silently substitute October 5 as previous trading day |
| Multi-strategy/chart history burst | Single-flight/cache/budget/backoff; management priority maintained |
| Old/new owner overlap and delayed old callback | Stale generation rejected; no cross-owner mutation |
| Start/Stop/consent/session changes with queued decisions | No stale new submission; unresolved exposure still reconciled |
| Simultaneous first lease access from two strategies in one process | One account owner and generation; neither strategy invalidates the other's fresh token |
| CE/PE close events arrive in opposite orders or at different delays | Evaluate only a matched boundary pair; preserve CE precedence inside that pair |
| Clock skew, daylight/date boundary, DST input and market holiday | Same verified completed-bar and previous-trading-day decision across Node/Python |
| Python receives a request after Node timeout | Correlation/idempotency prevents duplicate broker call; outcome is reconciled |
| Historic trades lacking timing fields | Existing data readable, timestamps accurately labeled |
| DB failure before/after intent write and broker acknowledgement | No mutation without durable intent; unresolved state preserved |

## 7. Verification completed for this plan

Read-only branch/source comparison and two isolated reproductions described above completed. Reproduction adapters simulated clock/database or candle buffers/entry fault; they did not call Angel One or establish real broker quota/incident facts.

Ran:

```text
cd backend
node --test tests/tradingBaseline.test.js tests/breakoutProductionCandles.test.js tests/positionExecution.phase5.test.js tests/startupRecovery.phase6.test.js
```

Result: 51 passed, 0 failed, 0 skipped; normal completion in approximately 43 seconds. These existing tests validate relevant compatibility/recovery behavior but do not cover the reproduced idle-lease/timeframe failures. Full Node/Python/frontend/Phase 0-8 suites were not run for this documentation-only task and no LIVE behavior was validated.

## 8. External checks and source references

- Deployed incident: correlate Render Node/Python revision, Events/Deploys, service/process count, lease records, timestamps, OrderIntents, broker orderbook/fills and historical responses for 7 October around 10:28-10:35 IST. Without these, the precise 10:28 cause and aborted request remain unverified.
- SmartAPI's published table lists historical getCandleData limits of 3/second, 150/minute and 5000/hour. Treat these as documentation inputs requiring entitlement/scope confirmation; enforce all windows and leave capacity margin. Verify effective client/API-key/IP sharing and other running applications. Source: https://smartapi.angelone.in/docs (rate-limit table; reviewed 7 October 2026). The direct /docs/RateLimit page returned an authorization restriction during this investigation.
- Render documents Free web-service spin-down after 15 minutes without inbound traffic. Current screenshots show active scanner/metrics during the displayed errors, so sleep is not proven as their immediate cause. Use always-on Node and Python services and verified graceful shutdown/topology before LIVE reliability approval. Source: https://render.com/docs/free. Deployment overlap guidance: https://render.com/docs/platform-maintenance.
- Verify Mongo index installation, backups/restore, clock synchronization, process/session routing, secret configuration and alert delivery. Keep the existing Angel One multi-account approval, static-IP/entitlement, deployed quotes, real-account restart and browser-free monitoring release gates.

## 9. Completion checklist for future implementation

- [ ] Reproduction/compatibility fixtures reviewed and added.
- [ ] Idle scanner/post-exit lease lifecycle repaired and overlap fenced.
- [ ] Durable signal outcomes and bounded safe pre-submit retry implemented.
- [ ] Correct timeframe/exchange/role and completed-bar admission verified.
- [ ] Historical merge/dedup and stale/gap admission verified.
- [ ] History budgets, single-flight, deadlines and deterministic warm-up verified.
- [ ] Every signal/abort/order has redacted correlation and truthful timestamps.
- [ ] Full regressions, multiple-user isolation and market-session PAPER soak pass.
- [ ] Controlled deployment/rollback/recovery tests pass with active exposure.
- [ ] External LIVE release gates completed and deployment incident verified.

Approval of this plan is not a claim of completed fixes or production LIVE readiness.
