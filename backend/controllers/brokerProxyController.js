const { requestPython } = require('../services/pythonApiClient');
const activeAccountService = require('../services/activeAccountService');
const strategyEngine = require('../services/strategyEngine');
const config = require('../config');

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
    activeAccountService.assertActiveUser(req.user._id);
    const query = new URLSearchParams(req.query).toString();
    const path = query ? `${pythonPath}?${query}` : pythonPath;
    const { response, data } = await requestPython(path, {
      method: options.method || req.method,
      body: options.hasBody === false ? undefined : req.body,
    });

    // The Node route is already protected by app authentication. A 401 from
    // Python therefore means the Angel One broker session is unavailable, not
    // that the application JWT expired. Keep it out of the frontend's app
    // login redirect path.
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
    const status = err.status || (err.name === 'AbortError' ? 504 : 502);
    return res.status(status).json({ status: 'error', message: err.message });
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
    // TEMPORARY DIAGNOSTIC LOGGING: remove after SmartAPI rate-limit investigation.
    console.log(
      `[TEMP AngelLoginDiagnostic] Node request timestamp=${new Date().toISOString()} `
      + `activeUserId=${requestedUserId}`
    );
    const current = activeAccountService.getActiveAccount();
    if (current && current.userId !== requestedUserId) {
      await strategyEngine.assertAccountCanSwitch(current.userId);
      strategyEngine.stopUserRunners(current.userId);
    }

    const { response, data } = await requestPython('/angel/login', {
      method: 'POST',
      body: req.body,
      userId: requestedUserId,
      timeoutMs: config.API.PYTHON_COLD_START_TIMEOUT_MS,
    });
    console.log(
      `[TEMP AngelLoginDiagnostic] Node response timestamp=${new Date().toISOString()} `
      + `activeUserId=${requestedUserId} status=${response.status} `
      + `body=${JSON.stringify(redactLoginDiagnosticBody(data, Object.values(req.body || {}).filter((value) => typeof value === 'string')))}`
    );
    if (!response.ok) return res.status(response.status).json(data);
    const sanitized = sanitizeLoginResponse(data);
    if (sanitized.connected) {
      activeAccountService.setActiveAccount({
        userId: requestedUserId,
        email: req.user.email,
        clientCode: data.client_code,
        sessionId: data.session_id,
      });
    }
    return res.status(response.status).json(sanitized);
  } catch (err) {
    const status = err.status || (err.name === 'AbortError' ? 504 : 502);
    return res.status(status).json({ status: 'error', message: err.message });
  }
};
exports.logout = async (req, res) => {
  try {
    activeAccountService.assertActiveUser(req.user._id);
    const { response, data } = await requestPython('/angel/logout', { method: 'POST' });
    if (!response.ok) return res.status(response.status).json(data);
    activeAccountService.clearActiveAccount();
    return res.status(response.status).json(data);
  } catch (err) {
    const status = err.status || (err.name === 'AbortError' ? 504 : 502);
    return res.status(status).json({ status: 'error', message: err.message });
  }
};

exports.status = async (req, res) => {
  try {
    const { response, data } = await requestPython('/angel/status');
    if (response.status === 401) return res.status(200).json(safeSessionStatus(null));
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json({
      ...data,
      clientCode: data.clientCode || null,
      connected: Boolean(data.connected),
      activeUserId: data.active_user_id || activeAccountService.getActiveAccount()?.userId || null,
    });
  } catch (err) {
    return res.status(err.status || 502).json({ status: 'error', message: err.message });
  }
};

exports.forwardGet = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'GET', hasBody: false });
exports.forwardPost = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'POST' });
exports.forwardDelete = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'DELETE', hasBody: false });
