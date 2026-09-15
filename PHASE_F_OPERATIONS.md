# Phase F Operations Guide

This guide covers starting and checking the existing three-service application. It does not change strategy, candle, indicator, or order behavior.

## Service order

1. Start MongoDB.
2. Start the Python Angel One service on port 8000.
3. Start the Node backend on port 5000.
4. Start the React frontend on port 5173.

The frontend communicates with Node. Node is the only service the browser should call for broker operations.

## Environment files

Copy each `.env.example` to `.env` in its own service directory and replace placeholder values. Never commit `.env` files.

The Angel One API key, Client ID, MPIN, and TOTP secret are entered in the application connection form. They must not be placed in environment files or frontend code.

`INTERNAL_SERVICE_KEY` must have the same strong random value in `backend/.env` and `angel-one/.env`.

`ALERT_WEBHOOK_URL` is optional. If it is empty, alerts remain in backend logs.

## Start commands

### Python service

```powershell
cd angel-one
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### Node backend

```powershell
cd backend
npm install
npm run dev
```

### Frontend

```powershell
cd algo-trading
npm install
npm run dev
```

## Connection procedure

1. Sign in to the application user account.
2. Open the Angel One connection form.
3. Enter API key, Client ID, MPIN, and TOTP secret.
4. Confirm that the UI shows the masked Client ID and Connected state.
5. Start the strategy using the existing controls.

If the broker session expires, enter the credentials again through the same form. Existing strategy and trade logic is not changed by this process.

## Verification commands

```powershell
cd angel-one
python -m pytest

cd ..\algo-trading
npm run build

cd ..
node backend/scripts/test_ws_simulation.js
node backend/scripts/test_e2e_simulation.js
```

## Pre-live checklist

- MongoDB is reachable.
- Python health endpoint responds at `http://localhost:8000/health`.
- Node backend is reachable at `http://localhost:5000`.
- Frontend is using the Node API base URL.
- Broker status is Connected.
- Correct account, underlying, expiry, quantity, and strategy settings are selected.
- Live trading consent is intentionally enabled only when required.
- Market data is receiving ticks.
- Logs and optional alerts are available.

## Sensitive-data check

Logs and responses must never contain MPIN, TOTP secret, JWT token, feed token, or API secret. Client IDs shown to the frontend should remain masked.

## Recovery

After a service restart, check health endpoints, reconnect Angel One through the form, confirm the displayed broker state, and review backend logs before starting or continuing live operation. MongoDB trade history must not be deleted as part of recovery.
