# Phase 6 — offline replay and paper acceptance

Date: 16 October 2026. Rule version: 0.2.1.

## Result and scope

Offline code acceptance passed. Only Phase 6 tests, synthetic fixtures, an evidence generator and verification artifacts were added. No production implementation, strategy configuration, account availability, live consent, database data, broker connection, global square-off policy or earlier-phase report was changed in this phase. The supplied PDF was read, not edited. Phase 7 was not started.

This implements the PDF's Phase 6 replay/paper work within the user's instruction to defer live testing. These are synthetic completed-session replays and localhost broker simulations, not authenticated historical market sessions or a forward paper run against Angel One. Actual index-volume suitability and real completed-session chart evidence remain unverified; this report does not approve live rollout or establish profitability.

## Evidence and results

| Check | Result | Evidence |
| --- | --- | --- |
| Final Phase 6 backend suite | 28 passed; zero failures/skips | [Focused log](output/phase6/backend-focused.log) |
| Broad serial backend regression | 271 passed; zero failures/skips | [Regression log](output/phase6/backend-regression.log) |
| All frontend tests | 85 passed in 11 files | [Frontend log](output/phase6/frontend.log) |
| All Python tests | 68 passed | [Python log](output/phase6/python.log) |
| Frontend production build | Passed; bundle-size warning remains | [Build log](output/phase6/frontend-build.log) |
| ESLint on new frontend acceptance test | Passed with no findings | [Lint log](output/phase6/frontend-lint.log) |
| Deterministic evidence freshness | Generator `--check` passed | 42 session traces and 30 UI checkpoints |

The broad backend run included the initial 13 Phase 6 tests. The final focused run includes 15 additional fault/cutoff cases and the extended intraday listener replay. Counts overlap and must not be added together. The wider suites were not repeated after test-only additions; no production code changed between these runs.

Python emits existing Requests dependency and FastAPI lifecycle deprecation warnings. No dependency upgrades or unrelated cleanup were made.

## Replay coverage

[Replay evidence](output/phase6/replay-evidence.json) records fixture identity, rule version, index, direction, expected/actual entry count, evaluation times, state transitions, blockers and complete emitted signal diagnostics.

There are 42 combinations: three indices × LONG/SHORT × seven scenarios. Each fabricated session contains 375 one-minute OHLCV bars spanning the regular session. Every prefix is evaluated with the production normalizer and analyzer at its explicit close time. All six valid combinations emit exactly one signal; all 36 negative combinations emit none.

| Scenario | Acceptance assertion |
| --- | --- |
| Valid LONG and SHORT | One signal, exact breakout → later retest → later pivot formation → 2+2 confirmation → later entry sequence; exact 2R |
| No breakout | No entry throughout the completed session |
| No retest | No entry despite a breakout |
| Failed retest | Wrong-side retest close never produces entry |
| Failed VWAP | Volume-weighted adverse VWAP prevents entry |
| Missing opening bar | Data blocks entry |
| All-zero index volume | Data blocks entry without a proxy |
| Duplicate/out-of-order history | Identical overlaps deduplicate; reordered 1M input yields the same as-of signal |
| Late start | Backfill reconstructs the current result; an old signal is not re-entered at the next close; delay beyond 5 seconds expires it |
| Exact cutoff | All three indices and both directions permit a qualifying 11:30 close at the boundary and refuse it one millisecond later |

The prior Phase 2 suite additionally verifies conflicting duplicates/timeframes, future/forming candles, strict pivot ties, nonpositive risk and the current consumed-setup contract. The Phase 1 suites cover real stream normalization, routing, freshness and event isolation using fixtures.

## Actual runner, admission and paper execution

Six integrations exercise the existing account-scoped runner's `startUnderlyingDataLoop` and candle listener, production session restore/checkpoint/admission, prepared reference entry, persisted position risk, execution recovery and EOD monitoring. Both LONG and SHORT are tested for NIFTY, BANKNIFTY and SENSEX. Spot routing is NSE for NIFTY/BANKNIFTY and BSE for SENSEX; option contracts route to NFO or BFO respectively.

The fixture delivers closed 5M events before 1M at common boundaries. It replays the actual listener through 15:19, duplicates the signal close, and verifies that held exposure/cutoff never admit another entry. The execution manager is then replaced as on recovery, scanning stays stopped, and EOD monitoring closes at 15:20. Each case retains one counted entry, closes its position and leaves zero quantity. No broker order endpoint is called in these PAPER cases.

[Paper evidence](output/phase6/paper-evidence.json) records each accepted backend signal, observed timestamped option quotes, quantity, mode, exit reason, remaining quantity and actual resulting trade P&L.

Explicit fill assumptions: synthetic option LTP 100 at entry and 115 at EOD, immediate full fills of quantity 10, zero slippage/fees and no liquidity model. The resulting gross P&L is 150 in each fixture. SHORT denotes a bearish index setup buying a PE; it does not denote selling an option. Index reference entry is 121 for LONG or 179 for SHORT, and those index values are never used as premium fill prices. This fixed outcome is a test assertion, not a return estimate. Lot size 10 is fabricated test metadata, not a current exchange lot specification.

## Failure, restart and counter matrix

- All three indices: confirmed no-fill rejection frees the reservation and creates no trade.
- All three indices: dropped localhost response simulates an ambiguous submission. The intent remains UNKNOWN, capacity remains reserved and a repeat call cannot send another buy. This is response-loss/transport-failure coverage, not an actual broker timeout measurement.
- All three indices: a 4/10 partial fill counts once. EOD cancels the unfilled six and sells exactly four, leaving the position closed with zero quantity.
- Existing Phase 3 suite: partial-fill accounting, two fills followed by third-entry refusal, module restart, reconnect and index switching preserve the shared daily cap. Unknown submissions do not free quota; confirmed unfilled rejections do. Foreign accounts and stale checkpoints/owners fail closed.
- Existing Phase 4 and generic execution/recovery suites: immutable reference risk, stopped-runner monitoring, stale/mismatched quotes, missing margin, competing exits, recovery admission, partial exits, unknown buys/sells and account isolation.

Deliberately ambiguous fault fixtures are expected to remain quarantined for reconciliation, rather than being falsely declared flat. The no-unresolved-exposure acceptance assertion applies to completed paper and confirmed partial-fill exit cases; ambiguity tests explicitly assert the unresolved state and duplicate-entry fence. Operational resolution of a real broker ambiguity remains untested.

## UI diagnostic parity

Thirty generated checkpoints cover breakout, retest, pre-confirmation, pivot confirmation and entry across all index/direction pairs. The frontend tests consume captured production-analyzer output and verify:

- OR values and 09:30 start; VWAP equals backend diagnostics.
- No signal entry/SL/target before a candidate exists.
- Entry, SL and target equal the backend signal and begin at signal knowledge time.
- Pivot formation and confirmation remain separate markers with exact backend timestamps.
- Markers never exceed the latest visible candle close.
- Another index or date cannot inherit the overlay diagnostics.

These are presentation-data tests. They do not substitute for canvas rendering or desktop/mobile interaction review. Phase 5's browser visual gate remains pending because local browser access is disabled. No browser screenshot is claimed here.

## Added files and reproduction

- `backend/tests/helpers/indexOrbReplay.js` — deterministic synthetic sessions and sequential replay helpers.
- `backend/tests/indexVwapOrb.phase6.test.js` — runner/paper/fault/cutoff acceptance tests.
- `backend/scripts/indexOrbPhase6Evidence.js` — offline evidence generation and stale-evidence check.
- `algo-trading/src/trading/fixtures/indexOrbPhase6Trace.ts` — generated test-only analyzer checkpoints.
- `algo-trading/src/trading/indexVwapOrbPhase6.test.ts` — UI overlay parity tests.
- `output/phase6/` — JSON traces and test/build logs.
- This report.

Run from the repository root:

```powershell
node backend/scripts/indexOrbPhase6Evidence.js --check
node --test --test-concurrency=1 backend/tests/indexVwapOrb.phase6.test.js
npm --prefix algo-trading test -- --reporter=dot
```

To deliberately regenerate synthetic fixtures, omit `--check`. To record fresh paper evidence, set `INDEX_ORB_PHASE6_EVIDENCE` to an output JSON path before the focused test run and remove that environment variable afterward. The test uses only the in-memory persistence fixture and its authenticated localhost broker simulator; simulated execution flags never provision a real account.

## Remaining external acceptance

Before claiming complete real-market Phase 6 acceptance: replay verified completed-session Angel One OHLCV for each index, validate actual index volume, use timestamped option-market samples with declared fill assumptions, complete the browser visual gate and review operational reconciliation evidence. These were intentionally not fetched or executed during this offline phase. The supplied plan's live/rollout gate remains closed.
