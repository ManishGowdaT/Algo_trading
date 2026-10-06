const { requestPython } = require('../services/pythonApiClient');
const activeAccountService = require('../services/activeAccountService');
const strategyEngine = require('../services/strategyEngine');
const config = require('../config');
const accounts = require('../services/accountContext');
const BrokerAccount = require('../models/BrokerAccount');
const { respondWithApiError } = require('../middleware/apiErrors');

function respondWithPythonTransportError(req, res, err) {
  const timedOut = err && err.name === 'AbortError';
  return respondWithApiError(req, res, err, {
    status: err.status || (timedOut ? 504 : 502),
    message: timedOut ? 'Python service request timed out.' : 'Python service is unavailable.',
  });
}

function safeSessionStatus(data) {
  return {
    connected: Boolean(data && data.status),
    clientCode: data && data.client_code
      ? `****${String(data.client_code).slice(-4)}`
      : null,
    message: data && data.message ? data.message : undefined,
  };
}

async function proxy(req, res, pythonPath, options = {}) {
  try {
    activeAccountService.assertActiveUser(req.user._id, req.accountContext?.brokerAccountId);
    const query = new URLSearchParams(req.query).toString();
    const path = query ? `${pythonPath}?${query}` : pythonPath;
    const executionMutation = (options.method || req.method) === 'POST' &&
      (/^\/angel\/orders(?:\/|$)/.test(pythonPath) || pythonPath === '/angel/positions/exit');
    const { response, data } = executionMutation
      ? await require('../services/executionGateway').dispatch(pythonPath, req.body, req.accountContext)
      : await requestPython(path, {
      method: options.method || req.method,
      body: options.hasBody === false ? undefined : req.body,
    });

    // The Node route is already protected by app authentication. A 401 from
    // Python therefore means the Angel One broker session is unavailable, not
    // that the application JWT expired. Keep it out of the frontend's app
    // login redirect path.
    if (req.accountContext) require('../services/productionHardening').audit('broker_request_completed', req.accountContext, {
      route: pythonPath.replace(/\/orders\/[^/]+\//, '/orders/:orderId/'), method: options.method || req.method,
      status: response.status, requestId: req.requestId,
    });
    if (response.status === 401) {
      return res.status(503).json({
        status: 'fail',
        message: data?.detail || data?.message || 'Angel One broker session is unavailable',
        brokerSessionUnavailable: true,
      });
    }
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(response.status).json(data);
  } catch (err) {
    if (req.accountContext) require('../services/productionHardening').audit('broker_request_transport_failure', req.accountContext, {
      route: pythonPath.replace(/\/orders\/[^/]+\//, '/orders/:orderId/'), method: options.method || req.method,
      failureType: err.name || 'transport', requestId: req.requestId,
    });
    return respondWithPythonTransportError(req, res, err);
  }
}

function sanitizeLoginResponse(data) {
  const connected = Boolean(data && data.status);
  const clientCode = data && data.client_code ? String(data.client_code) : '';
  return {
    status: connected,
    connected,
    clientCode: clientCode ? `****${clientCode.slice(-4)}` : null,
    message: data && data.message ? data.message : undefined,
  };
}

function redactLoginDiagnosticBody(data, credentials = []) {
  if (typeof data === 'string') {
    return credentials.reduce((text, credential) => credential ? text.split(credential).join('[REDACTED]') : text, data);
  }
  if (Array.isArray(data)) return data.map((value) => redactLoginDiagnosticBody(value, credentials));
  if (!data || typeof data !== 'object') return data;

  const sensitiveKeys = /api.?key|mpin|totp|secret|password|token|client.?code/i;
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    sensitiveKeys.test(key) ? '[REDACTED]' : redactLoginDiagnosticBody(value, credentials),
  ]));
}

exports.login = async (req, res) => {
  try {
    const requestedUserId = req.user._id.toString();
    const clientId = String(req.body?.clientCode || '').trim().toUpperCase();
    if (!clientId || clientId.length > 64 || !/^[A-Z0-9_-]+$/.test(clientId)) throw accounts.denied('A valid client ID is required.', 400);
    return await accounts.exclusive(`connect:${requestedUserId}:${clientId}`, async () => {
    if (accounts.selector(req)) await accounts.owned(requestedUserId, accounts.selector(req));
    let record = await BrokerAccount.findOne({ userId: requestedUserId, broker: 'ANGEL_ONE' }).lean();
    if (record && (record.brokerClientId !== clientId || record.status === 'DISABLED')) throw accounts.denied('This user is linked to a different or disabled broker account.');
    if (record?.status === 'CONNECTING') throw accounts.denied('Broker connection is already in progress; reconcile interrupted attempts before retrying.');
    const other = await BrokerAccount.findOne({ broker: 'ANGEL_ONE', brokerClientId: clientId }).lean();
    if (other && String(other.userId) !== requestedUserId) throw accounts.denied('Broker account is already linked to another user.', 403);
    await accounts.verifyOwnershipIndexes();
    let created = false;
    if (!record) {
      try { record = (await BrokerAccount.create({ userId: requestedUserId, brokerClientId: clientId })).toObject(); created = true; }
      catch (err) { if (err.code === 11000) throw accounts.denied('Broker account association conflicts with another connection.', 409); throw err; }
    }
    const current = activeAccountService.getActiveAccount(requestedUserId, record._id);
    // A reconnect must not invalidate an active runner/held exposure.
    // Reconnecting the already-linked broker account is recovery, not an
    // account switch. Durable position recovery below will stop entry scanning
    // and rebuild management under the newly verified session.
    if (current && String(current.brokerAccountId) !== String(record._id)) {
      await strategyEngine.assertAccountCanSwitch(requestedUserId);
    }
    const generation = record.sessionGeneration + 1;
    const reserved = await BrokerAccount.findOneAndUpdate({ _id: record._id, userId: requestedUserId,
      sessionGeneration: record.sessionGeneration, ownerGeneration: record.ownerGeneration, version: record.version, status: record.status },
    { $set: { status: 'CONNECTING' }, $inc: { version: 1 } }, { returnDocument: 'after', runValidators: true }).lean();
    if (!reserved) throw accounts.denied('Broker connection changed. Please retry.');
    const context = accounts.mint({ ...reserved, sessionGeneration: generation }, null, true);
    const reservation = { _id: record._id, userId: requestedUserId, sessionGeneration: record.sessionGeneration, version: reserved.version, status: 'CONNECTING' };

    let response, data;
    try {
    ({ response, data } = await requestPython('/angel/login', {
      method: 'POST',
      body: { ...req.body, clientCode: clientId },
      context,
      timeoutMs: config.API.PYTHON_COLD_START_TIMEOUT_MS,
    }));
    } catch (err) {
      // Unknown login outcome: retain association; never adopt an unverified session.
      await BrokerAccount.updateOne(reservation,
        { $set: { status: 'SERVICE_UNAVAILABLE' }, $inc: { sessionGeneration: 1, version: 1 } });
      activeAccountService.clearActiveAccount(requestedUserId, record._id);
      throw err;
    }
    require('../services/productionHardening').audit('broker_login_completed', context, { status: response.status, requestId: req.requestId });
    if (!response.ok || !data?.status) {
      if (created) await BrokerAccount.deleteOne(reservation);
      else await BrokerAccount.updateOne(reservation,
        { $set: { status: record.status }, $inc: { version: 1 } });
      return res.status(response.status).json(data);
    }
    const sanitized = sanitizeLoginResponse(data);
    sanitized.brokerAccountId = String(record._id);
    if (sanitized.connected) {
      if (!data.session_id || String(data.client_code).toUpperCase() !== clientId) throw accounts.denied('Broker login identity could not be verified.');
      const saved = await BrokerAccount.updateOne(reservation,
        { $set: { status: 'CONNECTED', connectedAt: new Date() }, $inc: { sessionGeneration: 1, version: 1 } });
      if (saved.modifiedCount !== 1) throw accounts.denied('Broker connection ownership changed.');
      require('../services/marketDataService').resetAccountSession(record._id);
      activeAccountService.setActiveAccount({
        userId: requestedUserId,
        email: req.user.email,
        clientCode: data.client_code,
        sessionId: data.session_id,
        brokerAccountId: record._id,
        sessionGeneration: generation,
        ownerGeneration: record.ownerGeneration,
      });
      // Restore and reconcile existing exposure after the verified session is
      // available. A recovery failure keeps the account degraded and blocks
      // new strategy starts; broker login itself remains usable.
      try {
        const recoveryContext = await accounts.resolve(requestedUserId, record._id);
        await require('../services/startupRecovery').recoverAccount(recoveryContext);
      } catch (recoveryError) {
        console.error(`[StartupRecovery] Post-login recovery remains pending for account ${record._id}: ${recoveryError.message}`);
      }
    }
    return res.status(response.status).json(sanitized);
    });
  } catch (err) {
    return respondWithPythonTransportError(req, res, err);
  }
};
exports.logout = async (req, res) => {
  try {
    const requestedUserId = String(req.user._id);
    const selected = accounts.selector(req);
    const ownedRecord = await accounts.owned(requestedUserId, selected);
    return await accounts.exclusive(`connect:${requestedUserId}:${ownedRecord.brokerClientId}`, async () => {
    const context = await accounts.resolve(req.user._id, accounts.selector(req));
    const { response, data } = await requestPython('/angel/logout', { method: 'POST', context });
    require('../services/productionHardening').audit('broker_logout_completed', context, { status: response.status, requestId: req.requestId });
    if (!response.ok) return res.status(response.status).json(data);
    require('../services/marketDataService').resetAccountSession(context.brokerAccountId);
    activeAccountService.clearActiveAccount(context.userId, context.brokerAccountId);
    await BrokerAccount.updateOne({ _id: context.brokerAccountId, userId: context.userId, sessionGeneration: context.sessionGeneration },
      { $set: { status: 'DISCONNECTED' } });
    return res.status(response.status).json(data);
    });
  } catch (err) {
    return respondWithPythonTransportError(req, res, err);
  }
};

exports.offboard = async (req, res) => {
  try {
    const result = await require('../services/accountOffboarding').offboardAccount(req.accountContext);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return respondWithPythonTransportError(req, res, err);
  }
};

exports.status = async (req, res) => {
  try {
    const record = await accounts.owned(req.user._id, req.query?.brokerAccountId);
    const active = activeAccountService.getActiveAccount(req.user._id, record._id);
    if (!active) return res.status(200).json({ ...safeSessionStatus(null), brokerAccountId: String(record._id) });
    const context = await accounts.resolve(req.user._id, req.query?.brokerAccountId);
    const { response, data } = await requestPython('/angel/status', { context });
    require('../services/productionHardening').audit('broker_status_read', context, { status: response.status, requestId: req.requestId });
    if (response.status === 401) return res.status(200).json({ ...safeSessionStatus(null), brokerAccountId: String(record._id) });
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json({
      ...data,
      clientCode: data.clientCode || null,
      connected: Boolean(data.connected),
      activeUserId: context.userId,
      brokerAccountId: context.brokerAccountId,
    });
  } catch (err) {
    if (err?.status === 404 && !req.query?.brokerAccountId) {
      return res.status(200).json(safeSessionStatus(null));
    }
    return respondWithPythonTransportError(req, res, err);
  }
};

exports.forwardGet = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'GET', hasBody: false });
exports.forwardPost = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'POST' });
exports.forwardDelete = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'DELETE', hasBody: false });
