const test = require('node:test');
const assert = require('node:assert/strict');
const { createPythonWarmup } = require('../services/pythonWarmup');

function createLogger() {
  const messages = [];
  return {
    messages,
    info: (message) => messages.push(message),
    warn: (message) => messages.push(message),
  };
}

test('startup warm-up calls the public health endpoint once and accepts a delayed healthy response', async () => {
  const logger = createLogger();
  let calls = 0;
  const warmup = createPythonWarmup({
    baseUrl: 'https://python.example/',
    timeoutMs: 1000,
    logger,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://python.example/health');
      assert.equal(options.method, 'GET');
      assert.ok(options.signal instanceof AbortSignal);
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { ok: true, status: 200 };
    },
  });

  const first = warmup.start();
  const second = warmup.start();
  assert.equal(first, second);
  assert.equal(warmup.getInFlight(), first);
  assert.equal(await first, true);
  assert.equal(warmup.getInFlight(), null);
  assert.equal(calls, 1);
  assert.match(logger.messages[0], /ready after \d+ms/);
});

test('startup warm-up records a non-success HTTP response without retrying', async () => {
  const logger = createLogger();
  let calls = 0;
  const warmup = createPythonWarmup({
    baseUrl: 'https://python.example',
    timeoutMs: 1000,
    logger,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503 };
    },
  });

  assert.equal(await warmup.start(), false);
  assert.equal(calls, 1);
  assert.match(logger.messages[0], /HTTP 503/);
});

test('startup warm-up records a timeout and does not retry', async () => {
  const logger = createLogger();
  let calls = 0;
  const warmup = createPythonWarmup({
    baseUrl: 'https://python.example',
    timeoutMs: 10,
    logger,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      calls += 1;
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  assert.equal(await warmup.start(), false);
  assert.equal(calls, 1);
  assert.match(logger.messages[0], /timeout/);
});
