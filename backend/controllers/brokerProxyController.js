const { requestPython } = require('../services/pythonApiClient');
const activeAccountService = require('../services/activeAccountService');
const strategyEngine = require('../services/strategyEngine');
const config = require('../config');
const accounts = require('../services/accountContext');
const BrokerAccount = require('../models/BrokerAccount');
const brokerCredentialVault = require('../services/brokerCredentialVault');
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
    let suppliedCredentials = null;
    if (req.body?.useSavedCredentials === true) {
      const saved = await brokerCredentialVault.get(req.user._id);
      if (!saved) throw accounts.denied('Complete secure broker setup before connecting.', 409);
      if (typeof req.body?.mpin !== 'string' || !req.body.mpin.trim() || req.body.mpin.length > 64) {
        throw accounts.denied('Enter your Angel One MPIN.', 400);
      }
      suppliedCredentials = { ...saved, mpin: req.body.mpin };
    } else {
      // Compatibility for existing clients. New UI saves credentials once and
      // connects through the saved-credentials path.
      suppliedCredentials = req.body || {};
    }
    const clientId = String(suppliedCredentials?.clientCode || '').trim().toUpperCase();
    if (!clientId || clientId.length > 64 || !/^[A-Z0-9_-]+$/.test(clientId)) throw accounts.denied('A valid client ID is required.', 400);
    if (req.body?.useSavedCredentials === true && (!suppliedCredentials?.mpin || String(suppliedCredentials.mpin).length > 64)) throw accounts.denied('Enter your Angel One MPIN.', 400);
    const pythonUrl = new URL(config.API.ANGEL_ONE_API_BASE);
    if (process.env.NODE_ENV === 'production' && pythonUrl.protocol !== 'https:' && !config.API.ANGEL_ONE_PRIVATE_NETWORK) {
      throw Object.assign(new Error('Broker credential transport must use HTTPS or an explicitly isolated private network.'), { status: 503 });
    }
    return await accounts.exclusive(`connect:${requestedUserId}:${clientId}`, async () => {
    if (req.body?.useSavedCredentials === true) {
      const fresh = await brokerCredentialVault.get(req.user._id);
      if (!fresh || fresh.version !== suppliedCredentials.version || fresh.clientCode !== clientId) {
        throw accounts.denied('Saved broker credentials changed. Please retry.', 409);
      }
    }
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
      body: {
        apiKey: suppliedCredentials.apiKey,
        clientCode: clientId,
        mpin: suppliedCredentials.mpin,
        totpSecret: suppliedCredentials.totpSecret,
      },
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
      return res.status(response.status).json(req.body?.useSavedCredentials === true
        ? redactLoginDiagnosticBody(data, [suppliedCredentials.apiKey, suppliedCredentials.totpSecret, suppliedCredentials.mpin])
        : data);
    }
    const sanitized = sanitizeLoginResponse(data);
    if (req.body?.useSavedCredentials === true && sanitized.message) {
      sanitized.message = redactLoginDiagnosticBody(sanitized.message,
        [suppliedCredentials.apiKey, suppliedCredentials.totpSecret, suppliedCredentials.mpin]);
    }
    sanitized.brokerAccountId = String(record._id);
    if (sanitized.connected) {
      if (!data.session_id || String(data.client_code).toUpperCase() !== clientId) throw accounts.denied('Broker login identity could not be verified.');
      const saved = await BrokerAccount.updateOne(reservation,
        { $set: { status: 'CONNECTED', connectedAt: new Date() }, $inc: { sessionGeneration: 1, version: 1 } });
      if (saved.modifiedCount !== 1) throw accounts.denied('Broker connection ownership changed.');
      if (req.body?.useSavedCredentials === true && !await brokerCredentialVault.markVerified(req.user._id, record._id, suppliedCredentials.version)) {
        await BrokerAccount.updateOne({ _id: record._id, userId: requestedUserId, sessionGeneration: generation },
          { $set: { status: 'SERVICE_UNAVAILABLE' }, $inc: { version: 1 } });
        throw accounts.denied('Saved broker credentials changed during connection. Please reconnect.');
      }
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
    if (req.body?.useSavedCredentials === true && !err.status) {
      return respondWithApiError(req, res, err, { status: 503, message: 'Saved broker credentials are unavailable. Check the secure storage configuration.' });
    }
    return respondWithPythonTransportError(req, res, err);
  }
};

exports.saveCredentials = async (req, res) => {
  try {
    const allowedFields = new Set(['apiKey', 'clientCode', 'totpSecret', 'consent', 'currentPassword']);
    if (!req.body || Object.keys(req.body).some((field) => !allowedFields.has(field))) {
      throw accounts.denied('Broker setup request contains unsupported fields.', 400);
    }
    const userId = req.user._id;
    const proposedClientId = String(req.body?.clientCode || '').trim().toUpperCase();
    return await accounts.exclusive(`connect:${userId}:${proposedClientId}`, async () => {
    const current = await brokerCredentialVault.metadata(userId);
    if (current.configured) {
      if (!req.body?.currentPassword) throw accounts.denied('Re-enter your application password to replace saved broker credentials.', 403);
      const User = require('../models/User');
      const user = await User.findById(userId).select('+password');
      if (!user || !await user.comparePassword(String(req.body.currentPassword))) throw accounts.denied('Application password is incorrect.', 403);
    }
    if (req.body?.consent !== true) throw accounts.denied('Consent is required to encrypt and save broker credentials.', 400);
    const linked = await BrokerAccount.findOne({ userId, broker: 'ANGEL_ONE' }).select('brokerClientId status').lean();
    if (linked && linked.brokerClientId !== proposedClientId) {
      throw accounts.denied('Disconnect and safely remove the existing broker account before changing its client ID.', 409);
    }
    if (current.configured && linked) {
      if (['CONNECTED', 'CONNECTING', 'DISABLED'].includes(linked.status) || activeAccountService.getActiveAccount(userId, linked._id)) {
        throw accounts.denied('Disconnect the broker before replacing saved setup.', 409);
      }
      await strategyEngine.assertAccountCanSwitch(userId);
      const scope = { userId, brokerAccountId: linked._id };
      const [position, intent] = await Promise.all([
        require('../models/Position').findOne({ ...scope, status: { $ne: 'CLOSED' } }).select('_id').lean(),
        require('../models/OrderIntent').findOne({ ...scope, $or: [
          { status: { $in: require('../services/executionLeaseService').unresolvedStates } },
          { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
        ] }).select('_id').lean(),
      ]);
      if (position || intent) throw accounts.denied('Broker setup replacement is blocked while exposure is unresolved.', 409);
    }
    const saved = await brokerCredentialVault.save(userId, req.body, current.version);
    return res.status(200).json({ status: 'success', ...saved });
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ status: 'fail', message: err.message });
    return respondWithApiError(req, res, err, { status: 503, message: 'Secure broker credential storage is unavailable.' });
  }
};

exports.credentialStatus = async (req, res) => {
  try {
    return res.status(200).json(await brokerCredentialVault.metadata(req.user._id));
  } catch (err) {
    return respondWithApiError(req, res, err, { status: 503, message: 'Secure broker credential storage is unavailable.' });
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
