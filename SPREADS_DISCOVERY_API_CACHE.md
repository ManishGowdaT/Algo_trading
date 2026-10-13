# Phase 5 — Discovery API and cache

2026-10-13 loading fix: HTTP discovery routes now return the single-flight refresh state immediately instead of holding a request for the full universe. The explicit UI action polls GET every three seconds (within the existing 30-request/minute Spread budget), displays history/IV progress, and stops at completion or a 200-second UI deadline. The internal cache's default blocking API is retained for existing callers/tests. Empty completed results do not automatically restart on progress GET; POST starts a fresh attempt. This supersedes the earlier HTTP wait behavior described below. Formula/threshold/ranking behavior is unchanged.

Implemented the Node-to-private-Python discovery API and bounded process-local cache. React discovery controls remain phase 6; no UI or scanner calculation change is made here.

## Routes and ownership

- Node GET `/api/v1/spreads/trending`: cached discovery ranking, refreshed when stale.
- Node POST `/api/v1/spreads/discover`: explicit refresh, waits for results.
- Private Python GET `/spreads/trending`, POST `/spreads/discover`: require the existing internal key, server-owned `X-Spreads-User-Id` and live Upstox token when in live mode.

Node routes use existing app authentication/rate limiting. Owner identity comes from authenticated `req.user`, not request bodies or user query selectors. Node forwards it only through the private header. Upstox tokens remain server-side and existing provider-401/app-login isolation remains intact. No Upstox order paths are added.

Response keeps original `updated`, `refreshing`, `top` (first five), `all` and `universe`; adds per-stage `errors`, per-symbol `capabilities`, `data_mode` and `data_note`. Universe source distinguishes synthetic fixtures from Upstox NSE BOD. Recursive serialization removes non-finite floats. An all-failed refresh returns empty results and explicit errors; it is not presented as a successful live recommendation.

## Cache lifecycle

Original discovery TTL is 900 seconds. Cache identity includes app owner, mode and SHA256 token fingerprint. No plaintext token is stored as a cache key. Successful output is defensively copied and LRU entries are bounded to 64. Four simultaneous refresh keys are admitted; requests for one key share a single refresh task. This is in-memory admission, not a queue service or database.

Fresh GET uses the cached response. Stale GET serves prior results with `refreshing=true` and starts refresh. Cold GET waits for its initial result. POST forces refresh even when fresh and waits for any already-running refresh. Empty refresh preserves prior ranking and its timestamp, matching the original; newly reported errors remain visible. Safe failure metadata preserves existing ranking without leaking upstream exception text. Token changes and different owners cannot read another key's results.

Python waits up to 180 seconds for an explicit/cold request; timeout leaves the bounded refresh running so a retry joins it rather than duplicating work. Worker provider calls receive a 170-second cooperative deadline. Discovery bridge timeout is at least 190 seconds; existing 60-second scan bridge behavior is unchanged. The public BOD master downloader retains its separate bounded 30-second HTTP timeout. Cancellation does not forcibly kill synchronous HTTP calls. No startup discovery or recurring scanner is added.

## Validation

Offline tests cover fixture end-to-end private routes, internal-key/live-token/owner requirements, original response fields, per-user/token/mode isolation, TTL expiry, force refresh, single-flight concurrency, stale responses, defensive copies, entry bounds, empty/failing refresh and timeout retry. Node tests cover fixed discovery paths, private owner headers, mandatory owner context, authenticated route placement and rejection of forged body credentials.

No real broker fetch or live comparison was made. Data acquisition/scoring retain phases 2–4. Unchanged existing Angel One authentication, strategy/order implementations and scanner formulas remain separate.

Files: `discovery_cache.py`, additions to Python `api.py`, Node Spread bridge/controller/routes, and dedicated tests. No Redis, queue, new database, new process, or new environment setting is required.

Phase 5 implemented. Next: phase 6 discovery UI and select-to-scan interaction.

Full regression verification: 135 Python tests and 231 Node backend tests passed. Existing Python dependency/deprecation warnings remain. `git diff --check` passed; no live broker calls were made by these fixture/mock checks.
