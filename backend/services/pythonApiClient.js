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

function diagnosticBody(data) {
  if (!data || typeof data !== 'object') return data;
  const redacted = { ...data };
  for (const key of ['jwt_token', 'refresh_token', 'feed_token', 'api_key']) {
    if (key in redacted) redacted[key] = '[REDACTED]';
  }
  return redacted;
}

async function requestPython(path, { method = 'GET', body, signal, userId, diagnosticLabel } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.API.TIMEOUT_MS);

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

    if (diagnosticLabel) {
      console.log(
        `[TEMP ${diagnosticLabel}] Python response timestamp=${new Date().toISOString()} `
        + `status=${response.status} body=${JSON.stringify(diagnosticBody(data))}`
      );
    }

    return { response, data };
  } catch (err) {
    if (diagnosticLabel) {
      console.log(
        `[TEMP ${diagnosticLabel}] Python request error timestamp=${new Date().toISOString()} `
        + `type=${err.name} message=${err.message}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
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
