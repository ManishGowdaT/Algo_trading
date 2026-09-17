const { rateLimit } = require('express-rate-limit');

const windowMs = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const loginMax = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS || 10);
const registerMax = Number(process.env.AUTH_REGISTER_MAX_ATTEMPTS || 5);

const commonOptions = {
  windowMs,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    status: 'fail',
    message: 'Too many authentication attempts. Please try again later.',
  },
};

module.exports = {
  authLoginLimiter: rateLimit({ ...commonOptions, limit: loginMax }),
  authRegisterLimiter: rateLimit({ ...commonOptions, limit: registerMax }),
};
