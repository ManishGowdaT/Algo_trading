const config = require('../config');
const accountContext = require('./accountContext');
const orderbooks = new Map();
const hardening = require('./productionHardening');

function getHeaders() {
  if (!config.API.INTERNAL_SERVICE_KEY) {
    throw new Error('INTERNAL_SERVICE_KEY is not configured');
  }

  return {
    'Content-Type': 'application/json',
    'X-Internal-Service-Key': config.API.INTERNAL_SERVICE_KEY,
  };
}

async function requestPythonTransport(path, { method = 'GET', body, signal, context, timeoutMs = config.API.TIMEOUT_MS, ownershipChecked = false, backgroundQuote = false, executionOwner } = {}) {
  const brokerPath = /^\/(angel|market|instruments)(\/|\?|$)/.test(path);
  const fencePath = path === '/internal/execution-fence';
  if (brokerPath) {
    context = context || accountContext.current();
    await accountContext.validate(context);
    if (context.connecting && path !== '/angel/login') throw accountContext.denied();
    if (!ownershipChecked) await require('./brokerOwnership').validateMutation(path.split('?')[0], method, body, context);
  } else if (!['/health', '/internal/ready'].includes(path) && !fencePath) {
    throw accountContext.denied('Unsupported Python dispatch path.', 403);
  }
  const quoteRead = method === 'GET' && /^\/market\/(?:ltp|index-ltp)(?:\?|$)/.test(path);
  const releaseBudget = quoteRead
    ? require('./marketRequestBudget').acquire(`${context.userId}:${context.brokerAccountId}`, Date.now(), backgroundQuote) : null;
  if (quoteRead && !releaseBudget) {
    throw Object.assign(new Error('Local quote request budget exhausted'), { status: 429 });
  }
  const controller = new AbortController();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    if (brokerPath) hardening.increment('python_gateway_requests_total');
    const response = await fetch(`${config.API.ANGEL_ONE_API_BASE}${path}`, {
      method,
      headers: {
        ...getHeaders(),
        ...(brokerPath ? {
          'X-Active-User-Id': context.userId,
          'X-Broker-Account-Id': context.brokerAccountId,
          'X-Broker-Client-Id': context.brokerClientIdentity,
          'X-Session-Generation': String(context.sessionGeneration),
          'X-Owner-Generation': String(context.ownerGeneration),
          'X-Broker-Session-Id': context.sessionId || '',
        } : {}),
        ...((brokerPath && executionOwner) ? {
          'X-Execution-Owner-Id': executionOwner.ownerId,
          'X-Execution-Lease-Generation': String(executionOwner.generation),
        } : {}),
        ...(fencePath ? {
          'X-Active-User-Id': context.userId,
          'X-Broker-Account-Id': context.brokerAccountId,
          'X-Broker-Client-Id': context.brokerClientIdentity,
          'X-Session-Generation': String(context.sessionGeneration),
          'X-Owner-Generation': String(context.ownerGeneration),
          'X-Broker-Session-Id': context.sessionId || '',
        } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal || controller.signal,
    });

    const text = await response.text();
    if (brokerPath && !response.ok) hardening.increment(response.status === 429 ? 'python_gateway_rate_limited_total' : 'python_gateway_errors_total');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (path === '/angel/login') {
      const outcome = response.ok ? 'success' : 'http_error';
      const retryAfter = response.headers.get('retry-after') || 'none';
      console.log(
        `[BrokerGateway] login outcome=${outcome} status=${response.status} retryAfter=${retryAfter}`
      );
    }

    return { response, data, text };
  } catch (err) {
    if (brokerPath) hardening.increment('python_gateway_transport_errors_total');
    if (path === '/angel/login') {
      const outcome = err.name === 'AbortError' ? 'timeout' : 'error';
      console.log(
        `[BrokerGateway] login outcome=${outcome} type=${err.name}`
      );
    }
    throw err;
  } finally {
    if (releaseBudget) releaseBudget();
    if (timeout) clearTimeout(timeout);
  }
}

async function requestPython(path, options = {}) {
  if (path.split('?')[0] !== '/angel/orderbook' || (options.method || 'GET') !== 'GET') return requestPythonTransport(path, options);
  const context = options.context || accountContext.current();
  await accountContext.validate(context); // Cached data still requires current ownership.
  const key = `${context.userId}:${context.brokerAccountId}:${context.sessionGeneration}:${context.sessionId}`;
  let record = orderbooks.get(key);
  if (record?.promise) return record.promise;
  if (!options.freshOrderbook && record?.result && Date.now() - record.at < 1000) return record.result;
  if (record && Date.now() - record.at < 1000) await new Promise(resolve => setTimeout(resolve, 1000 - (Date.now() - record.at)));
  await accountContext.validate(context);
  record = orderbooks.get(key);
  if (record?.promise) return record.promise;
  record = { at: Date.now(), promise: null };
  orderbooks.set(key, record);
  // Drop retired generations, without evicting an in-flight request.
  for (const [oldKey, old] of orderbooks) if (oldKey !== key && !old.promise && Date.now() - old.at > 60000) orderbooks.delete(oldKey);
  record.promise = requestPythonTransport(path, { ...options, context }).then(async result => {
    await accountContext.validate(context);
    record.result = result; return result;
  }).finally(() => { record.promise = null; });
  return record.promise;
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

async function registerExecutionOwner(context, executionOwner) {
  await accountContext.validate(context);
  return requestPythonTransport('/internal/execution-fence', {
    method: 'POST', context, executionOwner,
    body: { ownerId: executionOwner.ownerId, generation: executionOwner.generation },
    timeoutMs: config.API.TIMEOUT_MS,
  });
}

module.exports = { requestPython, requestPythonJson, registerExecutionOwner };
