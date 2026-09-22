const config = require('../config');

function getHeaders() {
  if (!config.API.INTERNAL_SERVICE_KEY) {
    throw new Error('INTERNAL_SERVICE_KEY is not configured');
  }

  return {
    'Content-Type': 'application/json',
    'X-Internal-Service-Key': config.API.INTERNAL_SERVICE_KEY,
  };
}

async function requestPython(path, { method = 'GET', body, signal, userId, timeoutMs = config.API.TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(`${config.API.ANGEL_ONE_API_BASE}${path}`, {
      method,
      headers: {
        ...getHeaders(),
        ...(userId ? { 'X-Active-User-Id': String(userId) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || controller.signal,
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (path === '/angel/login') {
      // TEMPORARY DIAGNOSTIC LOGGING: remove after SmartAPI rate-limit investigation.
      const outcome = response.ok ? 'success' : 'http_error';
      const retryAfter = response.headers.get('retry-after') || 'none';
      const contentType = response.headers.get('content-type') || 'unknown';
      console.log(
        `[TEMP AngelLoginDiagnostic] Node-to-Python ${outcome} timestamp=${new Date().toISOString()} `
        + `status=${response.status} contentType=${contentType} retryAfter=${retryAfter}`
      );
    }

    return { response, data, text };
  } catch (err) {
    if (path === '/angel/login') {
      // TEMPORARY DIAGNOSTIC LOGGING: remove after SmartAPI rate-limit investigation.
      const outcome = err.name === 'AbortError' ? 'timeout' : 'error';
      console.log(
        `[TEMP AngelLoginDiagnostic] Node-to-Python ${outcome} timestamp=${new Date().toISOString()} `
        + `type=${err.name} message=${err.message}`
      );
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function requestPythonJson(path, options = {}) {
  const { response, data } = await requestPython(path, options);
  if (!response.ok) {
    const message = typeof data === 'string' ? data : JSON.stringify(data);
    const error = new Error(`Python API Error [${response.status}]: ${message}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

module.exports = { requestPython, requestPythonJson };
