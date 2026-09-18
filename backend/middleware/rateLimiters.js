const { rateLimit } = require('express-rate-limit');

const windowMs = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const loginMax = Number(process.env.AUTH_LOGIN_MAX_ATTEMPTS || 10);
const registerMax = Number(process.env.AUTH_REGISTER_MAX_ATTEMPTS || 5);

// TEMPORARY DIAGNOSTIC LOGGING: informational only; does not affect limiting.
const loginRequestCounts = new Map();
const authLoginDiagnostics = (req, res, next) => {
  const key = req.ip || 'unknown';
  const count = (loginRequestCounts.get(key) || 0) + 1;
  loginRequestCounts.set(key, count);
  console.log(
    `[AuthLoginDiagnostic] timestamp=${new Date().toISOString()} ip=${key} x-forwarded-for=${req.headers['x-forwarded-for'] || '(none)'} processCount=${count}`
  );
  next();
};

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
  authLoginDiagnostics,
  authLoginLimiter: rateLimit({ ...commonOptions, limit: loginMax }),
  authRegisterLimiter: rateLimit({ ...commonOptions, limit: registerMax }),
};
