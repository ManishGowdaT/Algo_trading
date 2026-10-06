const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

const authWindowMs = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const loginMax = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS || 10);
const registerMax = Number(process.env.AUTH_REGISTER_MAX_ATTEMPTS || 5);

const apiWindowMs = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60 * 1000);
const brokerReadMax = Number(process.env.BROKER_READ_MAX_REQUESTS || 300);
const marketReadMax = Number(process.env.MARKET_READ_MAX_REQUESTS || 600);
const orderPlacementMax = Number(process.env.ORDER_PLACEMENT_MAX_REQUESTS || 60);
const strategyStartMax = Number(process.env.STRATEGY_START_MAX_REQUESTS || 30);
const strategyReadMax = Number(process.env.STRATEGY_READ_MAX_REQUESTS || 240);
const tradeReadMax = Number(process.env.TRADE_READ_MAX_REQUESTS || 120);
const tradeWriteMax = Number(process.env.TRADE_WRITE_MAX_REQUESTS || 120);
const angelLoginWindowMs = Number(process.env.ANGEL_LOGIN_RATE_LIMIT_WINDOW_MS || authWindowMs);
const angelLoginMax = Number(process.env.ANGEL_LOGIN_MAX_ATTEMPTS || 10);

function userKeyGenerator(req) {
  const userId = req.user && (req.user._id || req.user.id);
  if (userId) return `user:${userId.toString()}`;

  // All current uses are mounted after authentication. Keep the fallback safe
  // if a limiter is ever reused on a public route, including IPv6 clients.
  return `ip:${ipKeyGenerator(req.ip || 'unknown')}`;
}

function createUserRateLimiter({ windowMs = apiWindowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: userKeyGenerator,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      status: 'fail',
      message: message || 'Too many requests. Please wait a moment and try again.',
    },
    handler: (req, res, _next, options) => {
      require('../services/productionHardening').increment('http_rate_limited_total');
      const retryAfterSeconds = Number(res.getHeader('Retry-After')) || undefined;
      const userId = req.user && (req.user._id || req.user.id);
      console.warn(
        `[RateLimit] route=${req.path} userId=${userId ? userId.toString() : 'unknown'} brokerAccountId=${req.accountContext?.brokerAccountId || 'unresolved'} `
        + `retryAfterSeconds=${retryAfterSeconds || 'unknown'}`
      );
      return res.status(options.statusCode).json({
        status: 'fail',
        code: 'APPLICATION_RATE_LIMITED',
        message: options.message.message,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
        ...(req.requestId ? { requestId: req.requestId } : {}),
      });
    },
  });
}

const authOptions = {
  windowMs: authWindowMs,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'fail',
    message: 'Too many authentication attempts. Please try again later.',
  },
};

module.exports = {
  authLoginLimiter: rateLimit({ ...authOptions, limit: loginMax }),
  authRegisterLimiter: rateLimit({ ...authOptions, limit: registerMax }),
  angelLoginLimiter: createUserRateLimiter({
    windowMs: angelLoginWindowMs,
    limit: angelLoginMax,
    message: 'Too many Angel One connection attempts. Please wait before trying again.',
  }),
  brokerReadLimiter: createUserRateLimiter({ limit: brokerReadMax }),
  marketReadLimiter: createUserRateLimiter({ limit: marketReadMax }),
  orderPlacementLimiter: createUserRateLimiter({
    limit: orderPlacementMax,
    message: 'Too many order placement requests. Please wait before placing another order.',
  }),
  strategyStartLimiter: createUserRateLimiter({
    limit: strategyStartMax,
    message: 'Too many strategy start requests. Please wait before starting another strategy.',
  }),
  strategyReadLimiter: createUserRateLimiter({ limit: strategyReadMax }),
  tradeReadLimiter: createUserRateLimiter({ limit: tradeReadMax }),
  tradeWriteLimiter: createUserRateLimiter({ limit: tradeWriteMax }),
  createUserRateLimiter,
};
