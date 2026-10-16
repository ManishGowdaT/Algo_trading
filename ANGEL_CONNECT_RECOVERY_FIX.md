# Angel One Connect dialog recovery

16 October 2026 — main branch.

## Root cause

The header disabled Connect while Python readiness was false. When enabled, the provider awaited `/angel/credentials/status` before opening the credential dialog. The status endpoint decrypted the saved client ID; a changed encryption key caused AES-GCM authentication failure and HTTP 503. The provider caught this and returned with a context message that the header did not render. Thus the user saw no credential form or visible error. A failed status lookup also prevented the replacement endpoint from reaching its existing recovery checks.

## Changes

- Credential metadata now validates readability of all three saved fields. Unreadable setup returns `configured: true`, `recoveryRequired: true`, version and a secret-free explanation. It does not mutate/delete the record or pretend credentials are absent. Login decryption continues to fail closed.
- The existing replacement endpoint can now reach its application-password verification, consent, linked-client identity, connected-account, strategy, open-position, unresolved-intent and version checks even when old ciphertext cannot be read. Save still requires a valid current encryption configuration. No security gate was removed.
- Connect remains clickable during Python unavailability and shows a visible retry dialog. Credential status is refreshed on each click. Transport failures show that dialog rather than assuming missing credentials.
- Unreadable setup opens the existing credential form in recovery mode, including API key/client ID/TOTP/MPIN, consent and application password. Normal missing setup and MPIN-only saved-setup flows remain supported. User changes reset recovery/problem state.

## Validation

- Full Node suite: **212 passed**, zero failures (`tmp/connect-recovery-node-full.log`).
- Full frontend suite: **56 passed** (`tmp/connect-recovery-ui.log`).
- Production frontend build: **PASS**, existing bundle-size warning (`tmp/connect-recovery-build.log`).
- `git diff --check`: PASS.

New regressions cover key mismatch, tampered API-key ciphertext despite readable client ID, no metadata mutation/secret disclosure, stale-version rejection, replacement with valid current key, HTTP password/connected/exposure restrictions during recovery, visible unavailable-server feedback, retry success, first-time setup, saved setup, and recovery form password fields. All broker requests in tests were mocked; no real orders or credential changes occurred.

## Deployment and remaining configuration

Changes are local and not deployed. Commit/push main, redeploy Node on Render and frontend on Vercel. No Python code changed. Prefer restoring the original encryption key to retain saved setup. If replacing unreadable setup, a valid active server encryption key is still required; the user enters secrets only through the deployed HTTPS application. Recovery does not recover a lost key, certify current production settings, bypass account restrictions, or establish unattended-trading readiness.
