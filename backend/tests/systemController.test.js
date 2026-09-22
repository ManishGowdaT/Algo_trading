const test = require('node:test');
const assert = require('node:assert/strict');
const healthMonitor = require('../services/healthMonitor');
const { health } = require('../controllers/systemController');

function responseCapture() {
  const result = { statusCode: null, body: null };
  return {
    result,
    status(statusCode) {
      result.statusCode = statusCode;
      return this;
    },
    json(body) {
      result.body = body;
      return this;
    },
  };
}

test('system health reports ready only when Python and MongoDB are both healthy', (t) => {
  const original = healthMonitor.getStatus;
  t.after(() => {
    healthMonitor.getStatus = original;
  });

  healthMonitor.getStatus = () => ({ pythonApi: true, mongoDb: true, lastCheck: '2026-09-21T00:00:00.000Z' });
  const healthyResponse = responseCapture();
  health({}, healthyResponse);
  assert.deepEqual(healthyResponse.result, {
    statusCode: 200,
    body: {
      ready: true,
      pythonApi: true,
      mongoDb: true,
      lastCheck: '2026-09-21T00:00:00.000Z',
    },
  });

  healthMonitor.getStatus = () => ({ pythonApi: false, mongoDb: true, lastCheck: null });
  const startingResponse = responseCapture();
  health({}, startingResponse);
  assert.equal(startingResponse.result.body.ready, false);

  healthMonitor.getStatus = () => ({
    pythonApi: false,
    pythonStatus: 'authentication_misconfigured',
    mongoDb: true,
    lastCheck: null,
  });
  const configurationResponse = responseCapture();
  health({}, configurationResponse);
  assert.equal(configurationResponse.result.body.pythonStatus, 'authentication_misconfigured');
});
