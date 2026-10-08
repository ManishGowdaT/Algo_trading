# Broker encryption deployment configuration

`BROKER_VAULT_MISSING_KEY_VERSION` means the requested encryption key version is absent from the configured JSON keyring. For a new credential save, this is the active version. It is a deployment configuration failure before credential persistence or Angel One authentication.

On Render, open the **Node backend service** (`algo-trading-backend-7x36`), then **Environment**. Configure both variables on that service, not the frontend or Python service:

```text
BROKER_CREDENTIAL_ACTIVE_KEY_VERSION=v1
BROKER_CREDENTIAL_ENCRYPTION_KEYS={"v1":"YOUR_EXISTING_BASE64_32_BYTE_KEY"}
```

The placeholder above must be replaced with the actual secret. In the Render value fields, enter `v1` and the JSON object respectively, without surrounding shell quotes. If your existing keyring uses another version name, set the active version to that exact name instead. Keep all existing key entries: replacing an existing key makes credentials encrypted with it unreadable.

Save the environment settings and redeploy the Node backend with the code changes. In its shell, from the backend directory, run:

```sh
node scripts/checkBrokerEncryption.js
```

Success prints `Broker encryption configuration is valid. No secrets were displayed.` Failure exits with status 1 and an actionable diagnostic, without printing keys. This validates encryption settings only; it does not contact MongoDB or Angel One. Then retry credential setup and check the new request's log if another error appears.

Do not share encryption keys, API keys, MPINs, or authenticator secrets in logs or support messages. A valid local `.env` does not configure the deployed Render service.
