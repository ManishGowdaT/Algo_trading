# Index VWAP ORB - Phase 4 verification

Scope: reference-based risk and execution from the end-to-end PDF. Phase 0's final 15:20 IST square-off and index-first VWAP directions apply. No frontend, account provisioning, live enablement, unrelated strategy-rule changes or real broker testing.

## Implemented

- Generic `referenceRisk` helper defines spot identity, direction, index entry/SL/2R target, signal time/rule version, held option metadata and an absolute 15:20 IST deadline. Risk validation rejects mismatched instruments/levels. Deadline and original thresholds persist across restarts; option fills never replace index levels.
- Position snapshot has an optional strict `referenceRisk` subdocument. Legacy positions with no reference metadata retain premium-based behavior. Option average entry, exit fills and P&L remain premium-based. Position/Trade retain reference-trigger evidence separately; Trade exit reasons now accept EOD.
- The runner prepares through Phase 3's durable reservation/intent service and executes that exact prepared intent. It does not create a second independent BUY. Contract/lot/expiry validation remains at admission; fresh premium and premium-range checks precede submission. LIVE additionally requires the account's separate `liveExecutionEnabled` flag and verifiable required-margin/available-funds responses. Default is false; no flag was enabled.
- PAPER entry/exit uses timestamped option quotes instead of index signal values. LIVE uses existing submit, orderbook observation, execution leases, quantity reconciliation and coordinated exit code.
- Generic execution's one-second position watcher evaluates reference risk independently of scanner lifecycle. Spot quotes are resolved through the existing Python index catalogue and explicitly require broker timestamps; no ambiguous index search fallback or guessed spot symbol is used for risk decisions. EOD evaluation does not require a spot price. A held reference position does not start the old premium-threshold runner monitor.
- LONG exits when fresh spot <= index SL or >= target; SHORT reverses those inequalities. Threshold decisions persist before option quote/SELL work. Manual, SL, target and EOD use the same account execution coordinator; unresolved SELL prevents duplicate submission.
- At/after the persisted 15:20 deadline, pending buys are reconciled/cancelled and confirmed filled quantity is liquidated. Partial entry remainder is accounted for before SELL. A recovered overdue position remains due immediately, including next-day recovery. Scanning Stop retains position monitoring. No existing application's market-close configuration was changed.
- Reference-risk recovery restores the original snapshot and deliberately does not require fictitious premium stop/target fields. It does not start a discretionary reversal scanner. Proven unsubmitted PREPARED entries are failed durably during recovery rather than replayed. Unknown/attempted submission outcomes remain subject to existing reconciliation.
- Missing/stale/mismatched spot data withholds threshold exits, marks execution degraded and sends the existing urgent alert. Broker failures do not mark positions closed. EOD/manual exits remain retryable only through coordinated reconciliation.

## Protection semantics

Index SL/TP is software-managed. This phase never submits index levels as premium stops, and never guesses a conversion via delta. The platform has no approved separate option-premium emergency-stop policy for this strategy, so such positions remain explicitly UNPROTECTED in broker-protection status while software monitoring runs. No false broker-native protection claim is made. This limitation remains visible in status and is a live-readiness consideration. Existing strategies retain their protective orders and behavior.

The generic risk helper/deadline watcher applies only to positions with persisted reference-risk metadata. It does not introduce square-off to unrelated strategies. Normal-session deadline is fixed at 15:20 IST per the locked contract. Authoritative exchange holiday/special-session scheduling remains a broader calendar integration gap recorded in Phase 0; no unverified calendar was added here.

## Configuration/availability boundary

Phase 3's default-off live gate is retained and made explicit with `liveExecutionEnabled: false`. Existing provisioning enables settings only, not live execution. The generic legacy `entry()` method continues rejecting this strategy so callers must use the reservation-linked reference entry path. No public endpoint to enable live execution was added. No user's database was modified or provision command run.

Prior Phase 2/3 verification reports describe the historical analyzer/admission-only boundaries. Phase 4 intentionally replaces those runner-path restrictions with reference-aware execution, while retaining account live gating and all existing permission/consent checks.

## Automated checks and limits

New Phase 4 backend tests use the existing simulated broker and in-memory collection fixture. They cover LONG/SHORT trigger directions; premium-vs-index snapshots/P&L; stopped-scanner EOD; stale/mismatched spot; concurrent manual/EOD; stopped-runner recovery; mocked account-gated LIVE entry/sell without an index-priced stop; absent margin response failure; and EOD cancellation of a partial BUY with SELL only for verified filled quantity. The simulated LIVE transport is local test code, not a real broker test. Its happy-path margin adapter is stubbed; absent margin evidence is tested to fail closed. Actual response-shape suitability is deferred to user broker validation.

Python regression: 38 passed across `test_index_risk_quote_phase4.py`, `test_quote_freshness.py`, `test_account_dispatch_phase2.py` and `test_candle_volume_phase1.py`. Existing deprecation warnings remain unchanged. The new index endpoint's `requireFresh` opt-in preserves legacy argument/response behavior by default.

An initial parallel backend run passed 124/125, with an existing timing-sensitive status-message assertion in `positionExecution.phase5.test.js` observing 'Broker session restored' instead of 'degraded'. No unrelated test or status behavior was edited to hide this. A serial regression rerun is used for the final result below.

Final checks: serial backend regression passed **126 tests, zero failures/skips** across Phase 1-4 strategy tests plus position execution, execution gateway, startup recovery, baseline and entry reliability. After subsequent small trigger-evidence/metadata refinements and additional recovery coverage, the final Phase 2-4 focused run passed **37 tests, zero failures/skips**. `git diff --check` passed. These results certify the tested code paths, not live broker behavior.

No real market-data capture, production MongoDB fault test, actual account activation or broker order was performed. Live readiness remains unverified pending the user's later validation. UI work remains Phase 5.
