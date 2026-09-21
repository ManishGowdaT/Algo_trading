const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const dotenv = require('dotenv');
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
// Render terminates the public connection before forwarding requests to Node.
// Trust only that single proxy hop so authentication limits use the real client IP.
app.set('trust proxy', 1);

// Middleware
app.use(createSecurityHeaders());
app.use(requestContext);
app.use(express.json());
app.use(cookieParser());
const corsOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
app.use(cors({
    origin: corsOrigins,
    credentials: true
}));

// Route Middlewares
app.use('/api/v1/users', authRoutes);
app.use('/api/v1/trades', tradeRoutes);
app.use('/api/v1/strategies', strategyRoutes);
app.use('/api/v1/chart', chartRoutes);
app.use('/api/v1', brokerProxyRoutes);
app.use('/api/v1/system', systemRoutes);

// Root Route
app.get('/', (req, res) => {
    res.send('Option-Algo Backend API is running...');
});

// Keep malformed request errors actionable while preventing unexpected
// internal exceptions from being returned to API clients.
app.use(errorHandler);


// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('DB connection successful!'))
    .catch(err => console.error('DB connection error:', err));

const marketDataService = require('./services/marketDataService');
const healthMonitor = require('./services/healthMonitor');
const pythonWarmup = require('./services/pythonWarmup');

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`App running on port ${port}...`);
    // Wake the independently sleeping Python service without delaying Node startup.
    pythonWarmup.start();
    healthMonitor.start();
    // Auto-poll Python wrapper for active session tokens
    setInterval(() => {
        marketDataService.autoInitSession();
    }, 10000);
});
