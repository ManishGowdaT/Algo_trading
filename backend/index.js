const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();
// Force reload on .env change
const authRoutes = require('./routes/authRoutes');
const tradeRoutes = require('./routes/tradeRoutes');
const strategyRoutes = require('./routes/strategyRoutes');
const chartRoutes = require('./routes/chartRoutes');
const brokerProxyRoutes = require('./routes/brokerProxyRoutes');

const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());
app.use(cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : 'http://localhost:3000',
    credentials: true
}));

// Route Middlewares
app.use('/api/v1/users', authRoutes);
app.use('/api/v1/trades', tradeRoutes);
app.use('/api/v1/strategies', strategyRoutes);
app.use('/api/v1/chart', chartRoutes);
app.use('/api/v1', brokerProxyRoutes);

// Root Route
app.get('/', (req, res) => {
    res.send('Option-Algo Backend API is running...');
});

// JSON Body Parser Error Handler
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ status: 'fail', message: 'Malformed JSON payload' });
    }
    next(err);
});


// Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('DB connection successful!'))
    .catch(err => console.error('DB connection error:', err));

const marketDataService = require('./services/marketDataService');
const healthMonitor = require('./services/healthMonitor');

const port = process.env.PORT || 5000;
app.listen(port, () => {
    console.log(`App running on port ${port}...`);
    healthMonitor.start();
    // Auto-poll Python wrapper for active session tokens
    setInterval(() => {
        marketDataService.autoInitSession();
    }, 10000);
});
