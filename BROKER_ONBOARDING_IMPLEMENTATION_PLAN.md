# Saved broker setup and MPIN-only connection plan

Date: 7 October 2026
Status: initial secure setup and MPIN-only reconnection are implemented in the working tree. Manual-TOTP choice and credential deletion workflow remain for a later phase.

## Intended experience

1. Create the application account with email and password.
2. Immediately enter a protected broker setup step requesting Angel One client ID, SmartAPI API key, and TOTP setup secret. Explain what is saved and obtain explicit consent to storing the API key and authenticator secret encrypted. The TOTP secret is the setup key from the authenticator QR, not a six-digit expiring code.
3. Ask for MPIN to verify the broker setup. Generate the current TOTP in the Python service, authenticate with Angel One, and verify the returned client identity before marking setup verified.
4. Subsequent email/password logins show the saved account and connection status. If a usable broker session exists, use it. If a fresh connection is needed, request only MPIN and load the saved credentials on the server.
5. Offer manual-TOTP mode for users who do not consent to storing the authenticator secret. This mode asks for MPIN and a current TOTP at fresh connection.

App authentication and broker authentication remain distinct. A successful application login does not prove a broker session exists. No order or strategy starts as a side effect of signup or connection.

## Broker requirement and existing code

Angel One documents fresh SmartAPI login as client code + PIN + TOTP, with an API key in the request headers. Its documentation says sessions last until midnight unless logged out. MPIN-only refers to the app's screen: TOTP must still be generated and submitted by the backend. Do not promise an indefinite session or use refresh tokens to bypass a required fresh login.

Reference: https://smartapi.angelone.in/docs

Repository findings:

- `algo-trading/src/pages/RegisterPage/RegisterPage.tsx` currently registers and navigates directly to the dashboard.
- `algo-trading/src/shared/angel/AngelConnectionProvider.tsx` currently submits API key, client code, MPIN, and TOTP secret each time.
- `angel-one/app/main.py` accepts those fields through `LoginRequest`; `angel-one/app/services/angel_client.py` already generates TOTP from the secret during login.
- `backend/models/BrokerAccount.js` stores account identity, ownership and session generations, explicitly excluding secrets. Preserve this separation.
- `backend/controllers/brokerProxyController.js` already serializes connections, checks unique ownership, reserves connection state, verifies returned identity, and invokes durable exposure recovery. Reuse that path instead of introducing a second session adoption mechanism.

## Phase 1: Credential storage and security foundation

- Introduce a separate `BrokerCredential` model containing immutable user/account references, encrypted API key, optional encrypted TOTP secret, authentication mode, credential version, encryption key ID, format version, timestamps and verified state. Apply a unique index per broker account. Keep client ID in `BrokerAccount`; never persist MPIN or an expiring TOTP code.
- Use authenticated encryption (AES-256-GCM) with a fresh nonce per encryption and associated data binding user ID, broker account ID, credential version and field name. Store ciphertext, nonce and authentication tag. Reject any tampering or identity mismatch.
- Use a managed KMS-backed encryption service in production, or a deployment-managed encryption key outside MongoDB and source control with equivalent access control and rotation procedures. Do not derive encryption keys from JWT secrets or user passwords. Never fall back to plaintext when keys are missing.
- Only the narrowly scoped backend credential service can decrypt, immediately before an authorized broker connection. Python receives credentials through the existing protected internal connection; production transport must use TLS or an explicitly isolated private network. Do not add decrypted credentials to Python response payloads.
- Default schema projection excludes ciphertext and secrets. Public responses use explicit allowlists: masked client ID, account ID, setup/authentication mode, credential presence, verification and connection state. Never return saved keys or secrets to prefill browser fields.
- Prohibit credentials in browser storage, URLs, analytics, audit payloads and error details. Review HTTP request logging, exception reports and Python request-validation errors: framework validation errors can echo submitted input and must be sanitized at the boundary.
- Validate bounds and formats without logging rejected values. Normalize client ID and TOTP Base32 deliberately; validate setup-key encoding, but do not incorrectly reject current six-digit TOTP codes in manual mode. Keep MPIN as a string to preserve leading zeros.
- Use existing app authentication, origin protections and account ownership checks, with rate limits for setup, validation and connection per user/account and source address. Production requests require HTTPS.

## Phase 2: Broker onboarding API

Proposed protected endpoints (final names may follow existing route conventions):

| Endpoint | Behavior |
| --- | --- |
| `GET /broker/setup` | Return only saved-account metadata, setup state and masked client ID |
| `POST /broker/setup` | Save an owner-scoped encrypted pending setup using an idempotency key |
| `POST /broker/connect` | Accept MPIN and optional manual TOTP; resolve account identity and load credentials on the server |
| `PATCH /broker/setup` | Stage replacement credentials after recent app-password reauthentication; validate before activation |
| `DELETE /broker/setup` | Remove saved credentials through an exposure-aware revocation process after recent reauthentication |

- Register the app first; make broker onboarding resumable across reloads and later logins. A broker outage must not require creating a second app account or leave a user unable to sign in. Represent incomplete setup clearly.
- Separate the pending setup from ownership verification. Reserve existing unique broker ownership using the established ownership rules; do not treat possession of a typed client ID as verified account control. Bound abandoned pending reservations and provide expiry/cleanup that cannot remove connected accounts or accounts with durable exposure.
- A failed broker verification leaves setup pending and returns a sanitized, actionable error. Never set `CONNECTED` or `verified` until the returned broker identity is checked.
- Existing broker-login behavior deletes newly created accounts on definitive login failure. Adapt this intentionally for onboarding rather than accidentally deleting a saved draft or orphaning its credentials.
- Handle partial writes with a MongoDB transaction where supported, or explicit staged state and recoverable idempotency when transactions are unavailable. Verify required unique indexes before accepting setup. Duplicate client ownership must fail closed.
- Saved-credential connect accepts no browser-supplied API key, secret, user ID or replacement client identity. Avoid spreading request bodies into broker calls; build an explicit allowlisted payload.
- Use the same connection serialization, compare-and-set reservations, owner/session generation fences, timeout behavior and exposure-recovery path as current login. Fence asynchronous responses using credential version as well; a result using replaced credentials cannot become active.

## Phase 3: Signup and returning-user screens

- Redirect new registrations to `/broker-setup`. Display steps: application account, broker setup, broker verification.
- Provide clear client ID/API key/setup-secret instructions, masked secret inputs with accessible reveal controls, consent text, manual-TOTP alternative, loading and retry states.
- Submit sensitive values once; clear them from component state after save or failure handling. Returning users see masked metadata and a `Connect` action requesting MPIN only in stored-secret mode.
- Fetch setup state on authenticated app login. Resume pending onboarding, show a connected dashboard when the session is usable, or show reconnection when expired/unavailable. Gate broker-dependent actions using verified connection state rather than mere onboarding completion.
- Clear MPIN immediately after connection completes or fails, and on cancel, account change and logout. Prevent duplicate submissions; cancel/ignore late responses when app identity changes.
- Provide Settings actions to replace API key/TOTP secret, switch authentication mode and remove saved credentials. Require recent password reauthentication for changes and explicit confirmation of replacing/removing the authenticator secret.

## Phase 4: Session, rotation and exposure safety

- Saving setup makes connection convenient; it does not persist a valid trading session across process restarts. A restart or broker invalidation can require MPIN again. Do not persist MPIN for unattended daily login.
- Preserve existing exposure recovery and fail-closed strategy admission. Returning app login or broker reconnection must not automatically resume entry scanning.
- Credential rotation must stage and verify the replacement, then atomically activate its version. Coordinate active sockets and account generation changes through existing recovery procedures. Never overwrite credentials during active connection admission without fencing old work.
- Removal or client-account replacement cannot strand held positions or unresolved order intents. Reject destructive removal while management requires the credentials; require explicit reconciliation/closure before revocation. API-key revocation at the broker can still invalidate a session and must be surfaced immediately.
- Clarify UI semantics: app sign-out, broker disconnect, and deleting saved setup are different operations. Keep saved setup across app sign-out; preserve the application's defined handling of active background exposure rather than silently stopping it.
- Use actual broker error/session evidence for refresh and expiry handling. Do not rely solely on a hardcoded midnight timer or blindly retry failed login attempts.

## Phase 5: Migration and deployment

- Existing users without saved credentials are prompted once to complete setup; retain their existing broker account IDs, ownership, trade records and session generations. Do not claim verification from existing client ID alone.
- Keep the old full-credential connection endpoint during a bounded compatibility period; apply its current ownership protections and sanitization. Ensure old frontend deployments cannot weaken the saved-credential path.
- Deploy encryption keys/KMS permissions and verify index readiness before enabling encrypted writes. Add readiness checks that reject setup/connect when the credential vault is unavailable without blocking unrelated application access.
- Roll out using an environment feature flag, initially for test accounts. Verify stored ciphertext, masked metadata and broker-connected behavior before broader enablement.
- Document encrypted backup handling, key rotation and recovery. Losing the decryption key requires users to re-enter setup; MongoDB backups alone must not allow decryption. Rollback disables onboarding without deleting encrypted records or active account state.
- Keep Node and Python available on appropriate hosting; saving credentials cannot prevent hosting suspension.

## Tests and release acceptance

- Authentication/ownership: user A cannot read, decrypt, connect, update or delete B's credentials; forged account IDs and duplicated client claims are rejected.
- Encryption: ciphertext contains no plaintext; tampering, wrong associated data and missing/old keys fail closed; rotation decrypts supported prior versions without cross-account fallback.
- Secret handling: API responses, Python validation errors, logs and audit events disclose no API key, setup secret, MPIN or broker tokens. No secret enters localStorage/sessionStorage or URLs.
- Lifecycle: first signup, resumable setup, broker failure, successful verification, later MPIN-only connect, optional manual TOTP, invalid MPIN/TOTP, broker rate limiting, outages and expired sessions.
- Concurrency: duplicate saves, duplicate connect, credential replacement during connect, logout/account changes during requests and partial database failure cannot activate stale sessions or orphan credentials.
- Exposure: reconnection retains existing recovery behavior; rotation/removal respects open positions and unresolved intents; no signup/connect endpoint submits an order or auto-starts a strategy.
- Frontend: mobile/desktop onboarding, keyboard accessibility, masked saved fields, retry states, cancellation and secret clearing.
- Final release gate: a consenting new user completes setup once, signs out and signs in, sees saved masked details, and connects using only MPIN in the UI. Broker receives a freshly generated TOTP. Check a real test account during market hours without placing trades; verify deployment vault permissions, clock synchronization and error redaction.

## Delivery order

1. Credential vault, schema/indexes, redaction and focused security tests.
2. Pending setup, saved-credential connect and session fencing.
3. Signup onboarding, returning-user MPIN dialog and Settings management.
4. Migration, desktop/mobile lifecycle checks and controlled broker validation.
5. Gradual rollout with monitoring for setup failures, login errors, vault failures and reconnect latency using metadata-only telemetry.

Implementation must not begin with plaintext storage as a temporary shortcut. The user's MPIN-only preference selects stored-secret mode with explicit consent; manual-TOTP mode remains available.

## Implementation record

- New registrations are directed to a first-time broker setup prompt. Existing users without saved setup see the same setup form on first connect.
- API key, client ID, and authenticator setup secret are stored in a dedicated credential document using AES-256-GCM, a fresh nonce for each field, and user/field/credential-version authenticated data. The encryption key comes from a deployment key ring; missing or invalid key configuration fails closed. Secrets are excluded from default database projections and API responses.
- MPIN is sent only during the connect request and is not persisted. After setup, the UI asks only for MPIN; the backend loads the saved credentials and the Python service generates the TOTP for Angel One.
- Replacing saved credentials requires application-password reauthentication and explicit consent. The connected client ID cannot be changed through this path. Production broker credential transport requires HTTPS or an explicit private-network setting.
- Verification review corrected the POST/PUT setup route mismatch, removed the vault dependency from the existing broker status endpoint, sequenced setup lookup after account-scope restoration, and cleared the modal on user change. Credential replacement now rejects active sessions and unresolved exposure, and stale credential versions cannot overwrite newer setup. Saved-login errors redact secrets.
- Verification: 202 existing backend tests, 6 credential security/API tests, 51 frontend unit tests, and 54 Python tests passed. Desktop/mobile browser checks passed for signup setup, MPIN-only reconnect, invalid MPIN, secret clearing, browser storage, and the existing Search page. The production build passed. A pre-existing React Fast Refresh lint rule in the connection provider and the existing bundle-size warning remain. A live Angel One session and deployment secret configuration were not exercised.
