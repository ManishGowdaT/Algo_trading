# Supplementary earnings-date source

Added Yahoo/yfinance NSE earnings dates only, using `<NSE symbol>.NS`. Upstox continues to supply all price history and option-chain inputs. This is the user's explicit additional-provider authorization; no Yahoo price/option fetch is added.

The adapter follows original ZIP acquisition: `get_earnings_dates(limit=24)` plus calendar fallback if no future date was returned. It calls the unchanged original date/gap helper over supplied Upstox closes, then the original earnings penalty remains in the scanner. Today is excluded by the original `today < event <= expiry` rule. Same-day calendar dates are valid source responses, not silently converted to future events.

Historical and calendar availability is checked; missing source data never becomes zero gap or a false event flag. At least one historical event in the three-year window must overlap supplied closes; a future event or nonempty calendar response is required. This checks usable inputs, not complete three-year coverage. Source coverage and Upstox corporate-action adjustment equivalence remain explicitly uncertified.

Source dates use a bounded 128-entry, 15-minute process-local cache; expiry-specific calculations are performed against current input history. No new database, queue or key is required. Added `yfinance>=0.2.66,<0.3` to Python requirements and installed it locally. Index and synthetic fixture behavior are unchanged. Stock expiry selection now indicates an earnings lookup will occur during scanning instead of declaring all live stocks unsupported.

Live public source checks on 2026-10-13: TATAELXSI.NS returned 25 earnings-date rows and a calendar date of 2026-10-13; TECHM.NS returned 25 rows and calendar date 2026-10-15. No Upstox credentials were sent to Yahoo. These checks validate date availability for two symbols; they are not an authenticated end-to-end stock scan or universal NSE coverage claim.

Tests cover original gap/penalty inputs, calendar fallback/today boundary, source caching, missing historical dates and safe failures. Existing stock integration tests cover contract quantities and original EV ranking. Yahoo failures remain actionable per-stock errors and do not erase index successes. No formulas or Angel One trading implementation changed.

Restart Python after installing requirements. No `.env` changes needed. Original earnings-date API reference: https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.get_earnings_dates.html ; calendar: https://ranaroussi.github.io/yfinance/reference/api/yfinance.Ticker.calendar.html .

Verification: full Python suite (144 tests) passed, followed by an additional passing live-mode/mock-source integration regression; nine earnings/stock targeted tests passed. All 67 frontend tests passed. Source status/note is shown in per-underlying scan details. No authenticated real stock spread scan is claimed by these source checks.
