const assert = require('node:assert/strict');
const test = require('node:test');
const {
  errorHandler,
  getClientError,
  requestContext,
  respondWithApiError,
} = require('../middleware/apiErrors');

function mockResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('unexpected server errors do not expose the original exception message', () => {
  const req = { method: 'GET', requestId: 'request-123' };
  const res = mockResponse();
  const error = new Error('Mongo connection string contains a secret');

  respondWithApiError(req, res, error);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.message, 'An unexpected server error occurred.');
  assert.equal(res.body.requestId, 'request-123');
  assert.equal(JSON.stringify(res.body).includes('secret'), false);
});

test('intentional client errors preserve status and readable message', () => {
  const error = Object.assign(new Error('Unsupported strategy.'), { status: 400, name: 'InputValidationError' });
  assert.deepEqual(getClientError(error), { status: 400, message: 'Unsupported strategy.' });
});

test('Python transport failures can retain their safe timeout status and message', () => {
  const result = getClientError(new TypeError('internal socket detail'), {
    status: 504,
    message: 'Python service request timed out.',
  });
  assert.deepEqual(result, { status: 504, message: 'Python service request timed out.' });
});

test('request context assigns a response-correlatable identifier', () => {
  const req = { method: 'GET' };
  const res = mockResponse();
  let continued = false;

  requestContext(req, res, () => { continued = true; });

  assert.equal(typeof req.requestId, 'string');
  assert.equal(res.headers['X-Request-ID'], req.requestId);
  assert.equal(continued, true);
});

test('malformed JSON and oversized bodies keep their established client statuses', () => {
  const req = { method: 'POST', requestId: 'request-456' };
  const malformed = mockResponse();
  errorHandler(Object.assign(new SyntaxError('parser details'), { status: 400, body: {} }), req, malformed, () => {});
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.message, 'Malformed JSON payload');

  const oversized = mockResponse();
  errorHandler(Object.assign(new Error('body details'), { type: 'entity.too.large', status: 413 }), req, oversized, () => {});
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.body.message, 'Request body is too large.');
});
