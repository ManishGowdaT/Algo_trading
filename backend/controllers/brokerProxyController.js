const { requestPython } = require('../services/pythonApiClient');

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

exports.login = async (req, res) => {
  try {
    const { response, data } = await requestPython('/angel/login', {
      method: 'POST',
      body: req.body,
    });
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(response.status).json(sanitizeLoginResponse(data));
  } catch (err) {
    const status = err.status || (err.name === 'AbortError' ? 504 : 502);
    return res.status(status).json({ status: 'error', message: err.message });
  }
};
exports.logout = (req, res) => proxy(req, res, '/angel/logout', { method: 'POST' });

exports.status = async (req, res) => {
  try {
    const { response, data } = await requestPython('/angel/status');
    if (response.status === 401) return res.status(200).json(safeSessionStatus(null));
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json({
      ...data,
      clientCode: data.clientCode || null,
      connected: Boolean(data.connected),
    });
  } catch (err) {
    return res.status(err.status || 502).json({ status: 'error', message: err.message });
  }
};

exports.forwardGet = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'GET', hasBody: false });
exports.forwardPost = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'POST' });
exports.forwardDelete = (pythonPath) => (req, res) => proxy(req, res, pythonPath, { method: 'DELETE', hasBody: false });
