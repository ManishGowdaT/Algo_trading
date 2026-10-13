# NIFTY Spread Terminal

Adaptation of the supplied spread-terminal ZIP. The original US engine and page are preserved as `original_us_screener.py` and `templates/original-us.html`; the running app uses Upstox only. No Yahoo fallback or synthetic quotes.

Fill in `UPSTOX_CLIENT_ID` (API key) and `UPSTOX_CLIENT_SECRET` (API secret) in the local `.env` file first. The app automatically loads this file from its own directory. Existing PowerShell environment variables take precedence; clear old values if switching to `.env`. Restart after changing credentials. `.env` is ignored by Git; `.env.example` is a blank template.

Run with Python 3.12+ in PowerShell:

```powershell
cd spread-terminal
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8001
```

Register that exact redirect URI in your Upstox developer app. Open http://127.0.0.1:8001, click Connect Upstox, complete broker login, select NIFTY expiry, and SCAN. Credentials must be configured locally, never pasted into chat or committed.

This is a local single-user research app. Tokens remain in process memory behind an HttpOnly session cookie; restarting requires reconnecting. Authorization failures require reconnecting. Bind to loopback on port 8001 only. Public deployment needs a separate authentication and session architecture.

Contracts supply expiry and lot size. Only OTM short legs with an exact selected hedge width are paired. Both legs need positive, uncrossed bid/ask quotes and minimum OI; sell bid quantity and buy ask quantity must cover one lot. Credit = short bid − long ask. Max profit = credit × lot; max loss = (width − credit) × lot. Return/risk = credit ÷ (width − credit). Fees and slippage are excluded. No claim is made about probability, EV, quote freshness, broker margin, or guaranteed fills. Empty results are valid.

Official API references: https://upstox.com/developer/api-documentation/authentication/ , https://upstox.com/developer/api-documentation/get-option-contracts/ , https://upstox.com/developer/api-documentation/get-pc-option-chain/

Tests: `python -m unittest -v test_terminal`
