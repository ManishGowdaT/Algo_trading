const { randomUUID } = require('node:crypto');
const oauth = require('../services/upstoxOAuthService').createUpstoxOAuthService();
const spreadsPython = require('../services/spreadsPythonService').createSpreadsPythonService();

function appUserId(req) {
  const id = req.user && (req.user._id || req.user.id);
  return id && id.toString();
}

function observeCallback(req, res, next) {
  const requestId = req.requestId || randomUUID();
  console.info(`[SpreadsOAuth] requestId=${requestId} stage=callback_http_received hasAppCookie=${Boolean(req.cookies?.jwt)} hasAuthorizationHeader=${Boolean(req.headers?.authorization)}`);
  res.once('finish', () => console.info(`[SpreadsOAuth] requestId=${requestId} stage=callback_http_finished httpStatus=${res.statusCode}`));
  next();
}

function sendError(req, res, error) {
  const upstreamStatus = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
  // App authentication already passed route middleware. A downstream 401
  // concerns the Spread provider/service, never the user's app login.
  const status = upstreamStatus === 401 ? 409 : upstreamStatus;
  console.warn(`[SpreadsOAuth] requestId=${req.requestId || 'unavailable'} stage=connect_failed status=${status}`);
  return res.status(status).json({ status: 'fail', message: status >= 500 ? 'Upstox connection could not be completed. Please retry.' : error.message, ...(upstreamStatus === 401 ? { upstoxSessionUnavailable: true } : {}), requestId: req.requestId });
}

async function start(req, res) {
  try {
    const result = oauth.begin(appUserId(req));
    console.info(`[SpreadsOAuth] requestId=${req.requestId || 'unavailable'} stage=connect_started`);
    return res.set('Cache-Control', 'no-store').status(200).json(result);
  }
  catch (error) { return sendError(req, res, error); }
}

function status(req, res) {
  return res.set('Cache-Control', 'no-store').status(200).json({ ...oauth.status(appUserId(req)), data_mode: (process.env.SPREADS_DATA_MODE || 'fixtures').trim().toLowerCase() });
}

function returnUrl() {
  const value = process.env.UPSTOX_FRONTEND_RETURN_URL || 'http://localhost:5173/spreads';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid UPSTOX_FRONTEND_RETURN_URL');
  return url;
}

async function callback(req, res) {
  const requestId = req.requestId || randomUUID();
  console.info(`[SpreadsOAuth] requestId=${requestId} stage=callback_received hasAppUser=${Boolean(appUserId(req))} hasCode=${typeof req.query.code === 'string'} hasState=${typeof req.query.state === 'string'} providerError=${Boolean(req.query.error)}`);
  try {
    const result = await oauth.complete(appUserId(req), { state: req.query.state, code: req.query.code, providerError: req.query.error });
    const target = returnUrl();
    target.searchParams.set('upstox', 'connected');
    target.searchParams.set('expiresAt', new Date(result.expiresAt).toISOString());
    console.info(`[SpreadsOAuth] requestId=${requestId} stage=callback_completed connected=true`);
    return res.set('Cache-Control', 'no-store').redirect(303, target.toString());
  } catch (error) {
    console.warn(`[SpreadsOAuth] requestId=${requestId} stage=callback_failed status=${Number.isInteger(error.status) ? error.status : 502}`);
    const target = returnUrl();
    target.searchParams.set('upstox', 'error');
    target.searchParams.set('message', error.message || 'Upstox connection failed.');
    target.searchParams.set('requestId', requestId);
    return res.set('Cache-Control', 'no-store').redirect(303, target.toString());
  }
}

function disconnect(req, res) {
  return res.set('Cache-Control', 'no-store').status(200).json(oauth.disconnect(appUserId(req)));
}

function sendScanError(req, res, error) {
  const upstreamStatus = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 502;
  const status = upstreamStatus === 401 ? 409 : upstreamStatus;
  if (status >= 500) console.warn(`[SpreadsScan] requestId=${req.requestId || 'unavailable'} outcome=failed status=${status}`);
  return res.set('Cache-Control', 'no-store').status(status).json({
    status: 'fail',
    message: status >= 500 ? 'Spread scan could not be completed. Please retry.' : error.message,
    ...(upstreamStatus === 401 ? { upstoxSessionUnavailable: true } : {}),
    requestId: req.requestId,
  });
}

function scanAccess(req) {
  const mode = (process.env.SPREADS_DATA_MODE || 'fixtures').trim().toLowerCase();
  if (mode === 'fixtures') return { accessToken: null };
  if (mode !== 'upstox') throw Object.assign(new Error('Spread market-data mode is not configured.'), { status: 503 });
  const accessToken = oauth.accessToken(appUserId(req));
  if (!accessToken) throw Object.assign(new Error('Connect Upstox to scan.'), { status: 401 });
  return { accessToken, userId: appUserId(req) };
}

async function niftyExpiries(req, res) {
  try {
    return res.set('Cache-Control', 'no-store').json(await spreadsPython.getExpiries(scanAccess(req)));
  } catch (error) { return sendScanError(req, res, error); }
}

async function scanNifty(req, res) {
  try {
    const data = await spreadsPython.scanNifty(req.body || {}, scanAccess(req));
    return res.set('Cache-Control', 'no-store').json(data);
  } catch (error) { return sendScanError(req, res, error); }
}

async function underlyingExpiries(req, res) {
  try {
    return res.set('Cache-Control', 'no-store').json(
      await spreadsPython.getUnderlyingExpiries(req.params.symbol, scanAccess(req)),
    );
  } catch (error) { return sendScanError(req, res, error); }
}

async function scanUnderlying(req, res) {
  try {
    const data = await spreadsPython.scanUnderlying(req.params.symbol, req.body || {}, scanAccess(req));
    return res.set('Cache-Control', 'no-store').json(data);
  } catch (error) { return sendScanError(req, res, error); }
}

async function scanMultiple(req, res) {
  try {
    const data = await spreadsPython.scanMultiple(req.body || {}, scanAccess(req));
    return res.set('Cache-Control', 'no-store').json(data);
  } catch (error) { return sendScanError(req, res, error); }
}

async function discovery(req, res) {
  try {
    const options = { ...scanAccess(req), userId: appUserId(req) };
    const data = req.method === 'POST' ? await spreadsPython.discover(options) : await spreadsPython.getDiscovery(options);
    return res.set('Cache-Control', 'no-store').json(data);
  } catch (error) { return sendScanError(req, res, error); }
}

module.exports = { start, status, callback, disconnect, appUserId, oauth, returnUrl, sendError,
  niftyExpiries, scanNifty, underlyingExpiries, scanUnderlying, scanMultiple, sendScanError, scanAccess, observeCallback, discovery };
