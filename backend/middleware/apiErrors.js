const { randomUUID } = require('node:crypto');

const INTERNAL_ERROR_MESSAGE = 'An unexpected server error occurred.';

function requestContext(req, res, next) {
  req.requestId = randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

function isSafeClientError(err) {
  if (err && err.name === 'InputValidationError') return true;
  const status = Number(err && (err.status || err.statusCode));
  return Number.isInteger(status) && status >= 400 && status < 500;
}

function getClientError(err, options = {}) {
  const statusValue = Number(err && (err.status || err.statusCode));
  const status = Number.isInteger(statusValue) && statusValue >= 400 && statusValue < 500
    ? statusValue
    : options.status || 500;
  const publicError = isSafeClientError(err);
  const message = publicError
    ? err.message
    : options.message || INTERNAL_ERROR_MESSAGE;
  return { status, message };
}

function logApiError(req, err) {
  const frames = typeof err.stack === 'string' ? err.stack.split('\n').slice(1).join('\n') : '';
  console.error(
    `[APIError] requestId=${req.requestId || 'unavailable'} method=${req.method} `
    + `type=${err.name || 'Error'} code=${err.code || 'none'}\n${frames}`
  );
}

function respondWithApiError(req, res, err, options = {}) {
  if (res.headersSent) return;
  const { status, message } = getClientError(err, options);
  if (status >= 500) logApiError(req, err);
  return res.status(status).json({
    status: status < 500 ? 'fail' : 'error',
    message,
    requestId: req.requestId,
  });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError && err.status === 400 && 'body' in err)) {
    return res.status(400).json({
      status: 'fail',
      message: 'Malformed JSON payload',
      requestId: req.requestId,
    });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      status: 'fail',
      message: 'Request body is too large.',
      requestId: req.requestId,
    });
  }

  return respondWithApiError(req, res, err);
}

module.exports = {
  INTERNAL_ERROR_MESSAGE,
  errorHandler,
  getClientError,
  requestContext,
  respondWithApiError,
};
