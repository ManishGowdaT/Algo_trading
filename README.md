# Angel One Algorithmic Trading Platform

This repository contains a full-stack Algorithmic Trading application integrated with the **Angel One SmartAPI**.

The application is structured into three main directories/services:

1. **`backend`**: Node.js Express server with MongoDB (stores users, user strategies, and mock/live trade execution histories).
2. **`angel-one`**: Python FastAPI microservice (handles direct SmartAPI connection, fetches real-time quotes, checks margins, and executes trades).
3. **`algo-trading`**: Vite + React + TypeScript frontend dashboard (displays strategy performance, active monitoring, and configuration controls).

---

## 🛠️ Prerequisites

Make sure you have the following installed on your machine:
- **Node.js** 24.x (the frontend and backend dependencies require Node 20.19+; use the pinned 24.x runtime)
- **Python** 3.12 (the Python service runtime is pinned to the version used for local validation)
- **MongoDB** (running locally on port `27017` or an active MongoDB Atlas URI)

---

## ⚙️ Configuration & Environment Setup

The service `.env` files contain application and internal-service settings. Example files are available at `backend/.env.example`, `angel-one/.env.example`, and `algo-trading/.env.example`. Keep real `.env` files local or in your hosting provider's secret store; never commit them. Enter Angel One account credentials through the application’s connection form after signing in.

### 1. Node.js Backend Configuration (`backend/.env`)
Create or edit `backend/.env` with:
```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/algo-trading
JWT_SECRET=replace-with-a-unique-random-secret
JWT_EXPIRES_IN=90d
JWT_COOKIE_EXPIRES_IN=90
CORS_ORIGIN=http://localhost:5173
NODE_ENV=development
ANGEL_ONE_API_BASE=http://localhost:8000
INTERNAL_SERVICE_KEY=replace-with-the-same-random-value-used-by-angel-one
```

Generate a new JWT secret for each environment rather than reusing an example value. With Node.js, run `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` and replace the placeholder above with the output. Use a separate random value for `INTERNAL_SERVICE_KEY`, and configure that same internal key in both backend and Python service.

The refresh cookie defaults to `SameSite=Lax`, which is appropriate when the frontend and API are same-site (including a same-origin proxy). If they are hosted on different sites, set `AUTH_REFRESH_COOKIE_SAME_SITE=none` on the Node service and keep both sites on HTTPS; `None` automatically requires `Secure`. Keep `CORS_ORIGIN` restricted to the exact frontend origin(s). The access-token cookie remains `Lax`; the frontend's normal bearer-token flow is unchanged.

### 2. Python FastAPI Configuration (`angel-one/.env`)
Create or edit `angel-one/.env` with the Python service settings:
```env
APP_ENV=development
APP_PORT=8000
CORS_ORIGINS=http://localhost:5173
INTERNAL_SERVICE_KEY=replace-with-the-same-value-used-by-the-node-backend
ANGEL_BASE_URL=https://apiconnect.angelone.in
```

Enter Angel One API key, Client ID, MPIN, and TOTP secret through the **Connect to Angel One** form after signing in. Do not store those account credentials in `.env` files.

`INTERNAL_SERVICE_KEY` is the canonical name for the shared Node/Python key. Existing deployments using `ANGEL_ONE_INTERNAL_SECRET` on Node or `INTERNAL_API_SECRET` on Python remain supported for compatibility; migrate those provider settings only after confirming the canonical key is configured in both services.

Optional backend alerting can be enabled with `ALERT_WEBHOOK_URL` in `backend/.env`. If it is not configured, alert events remain in backend logs.

### 3. Frontend Configuration (`algo-trading/.env`)
Create or edit `algo-trading/.env` with:
```env
VITE_API_BASE=http://localhost:5000/api/v1
VITE_ENABLE_LIVE_TRADING=false

```

Only public frontend configuration belongs in variables prefixed with `VITE_`: Vite embeds those values into the client build. Never put JWT, MongoDB, Angel One, webhook, or internal-service credentials in frontend environment variables. `VITE_API_URL` is still accepted as a legacy API-base alias; use `VITE_API_BASE` for new setups.

For production frontend builds, set `VITE_API_BASE` to the Node API's HTTPS URL (or a same-origin relative API path). The Vite production build rejects non-loopback HTTP API URLs to prevent mixed-content requests. The localhost URL above is for local development only.

---

## 🚀 How to Run the Project

Follow these steps to launch the entire project:

### Step 1: Start MongoDB
Ensure MongoDB is running locally:
```bash
# Example for Windows Command Prompt if MongoDB is installed as a service:
net start MongoDB
```

### Step 2: Set Up and Run the Node.js Backend (`backend`)
1. Navigate to the `backend` folder.
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Account registration creates the default strategies automatically. If you need a separate local seed account, add `ALLOW_DATABASE_SEED=true`, `SEED_EMAIL`, and a unique `SEED_PASSWORD` to your ignored `backend/.env` file, then run:
   ```bash
   node scripts/seed.js
   ```
   The seed command is disabled on production/Render, preserves existing users and strategies, and only creates the requested local account and any missing default strategies. It never resets an existing account's password. Never use production credentials for local development.
4. Start the backend:
   ```bash
   npm run dev
   ```
   The backend server will run on `http://localhost:5000`.

### Step 3: Set Up and Run the Python Backend (`angel-one`)
1. Navigate to the `angel-one` folder.
2. Create an isolated Python environment and install requirements:
   ```bash
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install -r requirements.txt
   ```
3. Start the FastAPI server:
   ```bash
   .venv\Scripts\python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```
   The Python microservice will run on `http://localhost:8000`.

### Step 4: Set Up and Run the React Frontend (`algo-trading`)
1. Navigate to the `algo-trading` folder.
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```
   The frontend will run on `http://localhost:5173`. Open this URL in your web browser.

---

## 🧪 Running Tests

### Frontend Tests
To run Vitest unit tests in the frontend:
```bash
cd algo-trading
npm run test
```

### Python backend Tests
To run Pytest tests in the Python microservice:
```bash
cd angel-one
.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.venv\Scripts\python.exe -m pytest
```

## Operations

See [PHASE_F_OPERATIONS.md](PHASE_F_OPERATIONS.md) for startup order, connection steps, verification commands, recovery guidance, and the pre-live checklist.
