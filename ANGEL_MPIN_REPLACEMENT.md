# Broker setup verified by Angel One MPIN

User-authorized change, 16 October 2026: remove website-password reauthentication from the Connect form.

The UI now submits newly entered API key, client ID, TOTP setup secret, consent and MPIN to `/angel/login` with `persistCredentials: true`. Existing saved setup continues to use MPIN-only login. The website password is not collected or sent by this form.

The new path validates inputs and the active encryption configuration before calling Python. Under the existing account connection lock it checks ownership, disabled/connected state, active strategy/account switching, open positions and unresolved order intents. It verifies broker login success, returned client identity and session ID before encrypting and saving the replacement with version compare-and-set. Failed broker login never overwrites saved setup. MPIN is never persisted. A persistence failure does not activate a session and marks the account unavailable. Broker rate limits still apply. The old password-based credentials endpoint remains available for compatibility; the new UI no longer uses it.

Regression coverage includes a single UI login request with no application password, recovery form field removal, authenticated access, consent, unresolved exposure rejection, broker login rejection with unchanged saved credential version, successful broker-verified replacement, and provider-error secret redaction. Broker interactions in tests are mocked; no real login, order or production credential mutation was performed.

Deployment: push main and redeploy BOTH Node and Vercel together. Deploy Node first, because the frontend's new persistence flag requires the updated backend. No Python change is required. The server still needs a valid encryption key; this flow does not recover an old lost key.

This supersedes the website-password requirement described in `ANGEL_CONNECT_RECOVERY_FIX.md` for the new Connect UI flow.
