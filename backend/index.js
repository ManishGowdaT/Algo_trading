const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const dotenv = require('dotenv');
const hardening = require('./services/productionHardening');
const createSecurityHeaders = require('./middleware/securityHeaders');
const { errorHandler, requestContext } = require('./middleware/apiErrors');

dotenv.config();
// Force reload on .env change
const authRoutes = require('./routes/authRoutes');
const tradeRoutes = require('./routes/tradeRoutes');
const strategyRoutes = require('./routes/strategyRoutes');
const chartRoutes = require('./routes/chartRoutes');
const brokerProxyRoutes = require('./routes/brokerProxyRoutes');
const systemRoutes = require('./routes/systemRoutes');

const app = express();
let draining = false;
// Render terminates the public connection before forwarding requests to Node.
// Trust only that single proxy hop so authentication limits use the real client IP.
app.set('trust proxy', 1);

// Middleware
app.use(createSecurityHeaders());
app.use(requestContext);
// Admit/reject before body parsing so saturated service instances do not spend
// CPU and memory buffering requests that cannot be processed.
app.use(cookieParser());
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
app.use(cors({
    origin: corsOrigins,
    credentials: true
}));
app.use(require('./middleware/globalRequestBudget').globalRequestBudget.middleware);
app.use(express.json());
app.use((req, res, next) => {
    if (draining && (req.path === '/api/v1/angel/login' || /\/start\/?$/.test(req.path))) {
        return res.status(503).json({ status: 'fail', code: 'SERVICE_DRAINING', message: 'New account connections and strategy starts are temporarily unavailable.' });
    }
    return next();
});

// Route Middlewares
app.use('/api/v1/users', authRoutes);
app.use('/api/v1/trades', tradeRoutes);
app.use('/api/v1/strategies', strategyRoutes);
app.use('/api/v1/chart', chartRoutes);
app.use('/api/v1/instruments', require('./routes/instrumentSearchRoutes'));
app.use('/api/v1/spreads', require('./routes/spreadRoutes'));
app.use('/api/v1', brokerProxyRoutes);
app.use('/api/v1/system', systemRoutes);

// Root Route
app.get('/', (req, res) => {
    res.send('Option-Algo Backend API is running...');
});

// Keep malformed request errors actionable while preventing unexpected
// internal exceptions from being returned to API clients.
app.use(errorHandler);


const marketDataService = require('./services/marketDataService');
const healthMonitor = require('./services/healthMonitor');
const pythonWarmup = require('./services/pythonWarmup');
const watchdog = require('./services/operationalWatchdog').watchdog;
let autoInitTimer = null;
let signalHandlersInstalled = false;
const DRAIN_MS = Math.max(5_000, Number(process.env.GRACEFUL_SHUTDOWN_MS) || 25_000);

async function gracefulShutdown(signal = 'manual', { exit = false } = {}) {
    if (draining) return;
    const result = await require('./services/gracefulShutdown').drainRuntime({
        server, signal, timeoutMs: DRAIN_MS, logger: console,
        beginDrain: () => { draining = true; },
        stopNewEntries: () => require('./services/strategyEngine').stopAllForShutdown(),
        finishHandoff: () => require('./services/strategyEngine').finishShutdownHandoff(),
        stopHealthServices: () => {
            healthMonitor.stop(); watchdog.stop(); pythonWarmup.stop?.();
            if (autoInitTimer) { clearInterval(autoInitTimer); autoInitTimer = null; }
        },
    });
    if (exit) {
        // Do not logout broker sessions, clear held-position feeds, or close Mongo
        // ahead of the manager. The replacement process recovers from durable state.
        process.exitCode = 0;
        setTimeout(() => process.exit(0), 100).unref?.();
    }
}

function installSignalHandlers() {
    if (signalHandlersInstalled) return;
    signalHandlersInstalled = true;
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
        gracefulShutdown(signal, { exit: true }).catch(error => {
            console.error(`[Shutdown] ${signal} drain failed: ${hardening.redact(error.message)}`);
            process.exitCode = 1;
            setTimeout(() => process.exit(1), 100).unref?.();
        });
    });
}

const port = process.env.PORT || 5000;
let server;
let recoveryEventsAttached = false;
async function start() {
    const configErrors = hardening.validateProductionConfig();
    if (configErrors.length) throw new Error(`Unsafe production configuration: ${configErrors.join('; ')}`);
    await mongoose.connect(process.env.MONGO_URI);
    console.log('DB connection successful!');
    await require('./services/startupRecovery').initialize();
    if (!recoveryEventsAttached) {
        recoveryEventsAttached = true;
        mongoose.connection.on('disconnected', () => require('./services/startupRecovery').databaseUnavailable());
        mongoose.connection.on('connected', () => {
            if (server) require('./services/startupRecovery').databaseRestored();
        });
    }
    server = app.listen(port, () => {
        console.log(`App running on port ${port}...`);
        pythonWarmup.start();
        healthMonitor.start();
        watchdog.start();
        autoInitTimer = setInterval(() => {
            if (healthMonitor.getStatus().pythonApi) marketDataService.autoInitSession();
        }, 10000);
        autoInitTimer.unref?.();
        installSignalHandlers();
    });
    return server;
}

if (require.main === module) {
    start().catch(err => {
        console.error(`[StartupRecovery] Database readiness/recovery initialization failed: ${err.message}`);
        process.exitCode = 1;
    });
}

module.exports = { app, start, gracefulShutdown, isDraining: () => draining };
