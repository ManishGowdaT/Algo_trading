# Index VWAP ORB - Phase 0 readiness

Date: 16 October 2026. Reviewed repository HEAD: `6cef21cb5b8ca60c6ff6ffcaded7f085b9741d08`.

Status: Phase 0 COMPLETE for the design/build scope under the user's build-first instruction. Real broker-data validation is deferred to a later release gate; live eligibility remains false. No plug-in registered, account settings changed, strategy started or orders submitted. Files in this folder are planning artifacts, not runtime configuration.

## Scope and deliverables

- NIFTY, BANKNIFTY and SENSEX share the analyzer rules and existing account/broker connection flow.
- `rule-contract.v0.1.json` separates requirements supplied by the user from proposed interpretations and unresolved numeric/data policies.
- `DATA_FEASIBILITY.md` records the actual current data path and evidence still needed.
- Original UI evidence remains `output/nifty-vwap-orb/original-dashboard.jpg`. It was captured earlier in this chat with the broker offline, not re-certified as current broker status.
- Existing project plan/PDF remain unchanged. This audit supersedes assumptions with source findings below.

## Source audit

| Concern | Evidence | Phase 0 finding / later action |
|---|---|---|
| Existing interface | `BaseStrategy.js`, `strategyRegistry.js`, `strategyEngine.js` | Three discovered built-ins; option-centric scanning and one base timeframe. Add a compatible role/timeframe capability in Phase 1. |
| Connection and settings | `strategyRoutes.js`, `strategySettingsService.js`, frontend `FiveMinBreakoutPage.tsx` | Protected routes, verified account middleware, account-scoped save lifecycle. Reuse connection modal/provider and option settings. Actual settings endpoint: `/strategies/settings/:strategyName`. |
| History volume | `angel-one/app/services/angel_client.py:get_candles` | Reads only row indices 0-4; discards broker volume before it reaches Node. |
| Live volume | `backend/services/smartStream.js` tick decoding | Emits token, exchangeType, LTP, timestamp, sequenceNumber; no volume decoded. |
| Feed history and bars | `marketDataService.js` | Normalizes OHLC only; 200-bar cap; synthetic forward-filled gaps. Provenance and full-session storage are necessary for new strategy. |
| Chart history | `candleService.js` | All three index token mappings exist. Drops volume and caches current-day results for five minutes. Do not use as sole fresh strategy input. |
| Contract resolver | `contractManager.js` | Resolves ATM/ITM/OTM, automatic nearest expiry, account/session cache; SENSEX routes to BFO. Cached contracts can be returned after resolution failure. Revalidate metadata/freshness at admission. |
| Quantity discrepancy | `contractManager.js` versus frontend `FiveMinBreakoutPage.tsx` | Source constants differ (resolver: NIFTY 65/BANKNIFTY 30/SENSEX 20; page: 75/15/10). These are observed code values, not verified current exchange lot sizes. Use current instrument-master metadata in implementation. |
| Risk reference | `positionExecution.js` | Premium-based snapshots and strategy-name branches. Index levels require a generic reference-aware risk extension, not direct reuse as premium stops. |
| Trading clock | `marketSessionManager.js:getIstDate` | Adds host timezone offset before adding IST; behavior depends on host timezone. Replace with timezone-independent calculations and test multiple host zones during implementation. |
| Calendar | `marketSessionManager.js:isTradingDay` | Weekdays only; no exchange holiday/special-session calendar found in this path. Calendar validation is not complete. |
| Global EOD | `backend/config/index.js`, service search | Default market close is 15:40; no dedicated global square-off scheduler found in the inspected services. This default is not a square-off policy and must not become one implicitly. |

## Baseline checks

Frontend command: `npm test -- --reporter=dot` from `algo-trading`.

Result: 9 files / 51 tests passed, exit 0. Existing unit tests only; no visual parity or live broker validation implied.

Backend command: `node --test tests/tradingBaseline.test.js tests/marketDataIsolation.phase4.test.js tests/entryReliability.test.js tests/startupRecovery.phase6.test.js` from `backend`.

Result: 47 tests passed, zero failed/skipped, exit 0. `baseline-results.json` records the final outcome. Test fixtures use fake account identifiers and mock execution; console broker-restoration messages are test events, not evidence of a real connected account. Persistence-timeout alerts appear in recovery fault scenarios; they did not fail the suite. `backend-baseline.log` is a supplemental retained rerun of three suites, excluding startup recovery, not the full 47-test transcript.

No new implementation tests were added for a documentation-only phase. No live-account configuration dump, secrets or credentials were collected.

## Current rule lock (supersedes prior revisions)

See `LOCKED_EXECUTION_RULES.md` and contract revision 0.2.0. Primary VWAP is internally calculated from the selected index's 1M OHLCV. No normal futures/ETF proxy. Conditional proxy design is considered only after actual index volume failure evidence. No proxy is required to pass Phase 0 normally.

Retest defaults 10/20/30 and confirmed 5M retest -> subsequent confirmed 1M pivot remain. EOD is now 15:20 IST, superseding 15:30. No dedicated conflicting global square-off policy was found in repository services/config/examples. The 15:40 market-close default is not a square-off policy and was not changed. Deployed overrides are not certified by this source audit.

Remaining setup, pivot tie, cutoff, quota, settings, outage, protection, EOD and special-session behaviors are locked as implementation defaults in the rule-lock document. No runtime behavior was changed.

## Real-data validation attempt

Current dashboard was inspected again on 16 October 2026. It displays Connect Angel One broker and all index feeds Offline. No authenticated raw candle sample could be captured. This is a connection blocker, not failed index volume validation and not grounds to use futures. Reconnect through the existing application connection flow to permit read-only samples.

The read-only `validate_index_ohlcv.py` accepts sanitized raw SmartAPI index 1M rows, verifies identity/time/OHLCV and the full 09:15-11:30 morning window, and computes session VWAP internally. It is not connected to trading. Its unit fixtures are synthetic, not real volume evidence.

## Phase 0 acceptance ledger

| Gate | State |
|---|---|
| Workflow/account/connection/option settings audit | DONE |
| Versioned strategy and operational baseline | LOCKED - revision 0.2.0 |
| Frontend baseline | PASS - 51 tests |
| Selected backend baseline | PASS - 47 tests |
| Real NIFTY/BANKNIFTY/SENSEX 1M index OHLCV samples | PENDING - broker currently offline |
| Per-index actual volume and internal session VWAP validation | PENDING - no inference from stripped data |
| Original UI evidence | RETAINED |
| Holiday/special-session runtime support | Gap documented; implementation requires authoritative calendar |
| Global EOD policy | 15:20 locked; no dedicated source conflict found |

User-directed scope adjustment: Phase 0 is complete for design/build handoff. The user will test real broker data and execution later; those checks remain explicitly deferred and are required before live readiness, rather than blocking offline implementation. Existing PDF is a historical planning snapshot; this rule lock supersedes its unresolved decisions and older EOD/source wording. No broker test orders or live activation are authorized for the build. Automated unit/integration/regression checks remain required.
