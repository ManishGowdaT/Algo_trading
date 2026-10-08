module.exports = {
  ENGINE: {
    BUFFER_SIZE: parseInt(process.env.BUFFER_SIZE || '100', 10),
    PROBE_INITIAL_DELAY_MS: parseInt(process.env.PROBE_INITIAL_DELAY_MS || '100', 10),
    PROBE_RETRY_INTERVAL_MS: parseInt(process.env.PROBE_RETRY_INTERVAL_MS || '150', 10),
    PROBE_MAX_ATTEMPTS: parseInt(process.env.PROBE_MAX_ATTEMPTS || '4', 10),
    IDLE_TIMEOUT_MS: parseInt(process.env.IDLE_TIMEOUT_MS || '900000', 10), // 15 minutes
  },
  MARKET: {
    OPEN_TIME: process.env.MARKET_OPEN_TIME || '09:15',
    CLOSE_TIME: process.env.MARKET_CLOSE_TIME || '15:40',
    TIMEZONE: process.env.MARKET_TIMEZONE || 'Asia/Kolkata',
  },
  API: {
    ANGEL_ONE_API_BASE: process.env.ANGEL_ONE_API_BASE || 'http://localhost:8000',
    ANGEL_ONE_PRIVATE_NETWORK: process.env.ANGEL_ONE_PRIVATE_NETWORK === 'true',
    TIMEOUT_MS: parseInt(process.env.API_TIMEOUT_MS || '5000', 10),
    PYTHON_COLD_START_TIMEOUT_MS: parseInt(process.env.PYTHON_COLD_START_TIMEOUT_MS || '60000', 10),
    // INTERNAL_SERVICE_KEY is canonical; retain this legacy alias for existing deployments.
    INTERNAL_SERVICE_KEY: process.env.INTERNAL_SERVICE_KEY || process.env.ANGEL_ONE_INTERNAL_SECRET || '',
  },
  LOGGING: {
    LEVEL: process.env.LOG_LEVEL || 'info', // 'info' | 'debug'
  }
};
