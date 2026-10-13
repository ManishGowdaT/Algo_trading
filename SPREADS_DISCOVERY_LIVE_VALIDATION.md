# Phase 8 — Live validation evidence and remaining checks

Date: 2026-10-12 (Asia/Calcutta). Status: partial; authenticated Upstox discovery/candle/chain validation is pending browser login. No orders placed.

## Live evidence obtained

Fetched the actual official public Upstox NSE BOD gzip master through `UpstoxUniverseProvider` (no credentials sent). The implemented parser returned 219 unique option underlyings: 213 equities and 6 indices (`BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `NIFTY`, `NIFTYFPI`, `NIFTYNXT50`). No ambiguous symbols or rejected contract rows were reported for this downloaded file. This validates current public acquisition/schema parsing; it does not certify all instruments' quote liquidity, permissions or discovery eligibility.

Existing Node backend was running on 5000 and its public root returned HTTP 200. Started the existing Python service on 8000 and frontend development server on 5173 for validation. Both startup checks passed. Local settings remain live Upstox mode; no secrets changed or printed.

Opened the Spreads page in the in-app browser. Its mobile layout, discovery action section and original scanner controls were visible. Setup showed an aborted request rather than a verified connection. Account-scope hydration can cancel initial requests; added a single mounted-page retry for AbortError and server-reported data mode so the initial fixture default cannot misrepresent configured live mode after status succeeds. Added regression coverage. Shared auth/API helper and Angel workflow code remain unchanged.

Browser subsequently reached the Upstox login page and was left for user credential/OTP/MPIN entry. No credentials were extracted, entered or bypassed. Actual token acceptance, history/option data and discovery results have not been established in this validation phase.

## Regression evidence

- Full Python suite: 139 tests passed.
- Frontend suite after setup correction: 65 tests passed.
- Targeted Spread frontend ESLint passed.
- Full Node run: 231 tests, 229 passed and 2 existing held-position timestamp-monitor tests failed. Failures were in `positionExecution.phase5.test.js`, asserting degraded state but observing recovery text. No related trading implementation was changed. A focused rerun is recorded below; the full-run failure remains part of the evidence even if a rerun passes.
- Original ZIP formula/discovery oracle tests remain in the Python suite. Fixture parity is not evidence of live-input equivalence.

## Checks still required after browser connection

1. Confirm status/last-attempt reports a stored valid connection without app-login redirect.
2. Click Discover opportunities once; verify live NSE provenance, ranking timestamp, partial input errors, top-five/all results and no automatic spread scan.
3. Validate stock four-calendar-month daily closes/volumes against sanitized real inputs, including missing/zero volume and current-day candle behavior. Record adjustment/completeness uncertainty without claiming certification.
4. Verify actual option expiry/strike/contract lot identities, bid/ask/OI and normalized IV. Compare original discovery calculations against the identical captured finite inputs, not against unrelated Yahoo prices.
5. Select stock/index names, add to scanner, verify parameter preservation and explicit scan. Retain successful index results if stock earnings are unavailable; do not invent earnings/calendar gaps.
6. Test authenticated market-open and market-closed responses separately. Current validation cannot establish both states in a single closed-market session.
7. Confirm cache refresh/user isolation in real flow; offline tests already cover cache contract and authentication behavior.

Phase 8 cannot be marked complete until those authenticated/live checks have evidence. Browser sign-in is the immediate external dependency. Stock earnings source limitations and unrelated security findings remain as previously documented.

Focused backend rerun: all 37 tests passed, including the two held-monitor cases and Spread bridge/session/OAuth tests. The earlier full-run failures were not reproduced in this run; no unrelated trading code was edited. Frontend production build passed with the existing bundle-size warning. `git diff --check` passed.
