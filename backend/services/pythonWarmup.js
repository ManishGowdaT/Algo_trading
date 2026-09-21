const config = require('../config');

function createPythonWarmup({
  baseUrl,
  timeoutMs,
  fetchImpl = fetch,
  logger = console,
}) {
  let warmupPromise = null;
  let inFlightPromise = null;

  async function probe() {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      const elapsedMs = Date.now() - startedAt;

      if (!response.ok) {
        logger.warn(
          `[PythonWarmup] Health request returned HTTP ${response.status} after ${elapsedMs}ms`
        );
        return false;
      }

      logger.info(`[PythonWarmup] Python health endpoint ready after ${elapsedMs}ms`);
      return true;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const failure = error.name === 'AbortError' || error.name === 'TimeoutError'
        ? 'timeout'
        : 'network_error';
      logger.warn(`[PythonWarmup] Health request ${failure} after ${elapsedMs}ms`);
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    start() {
      if (!warmupPromise) {
        inFlightPromise = probe();
        warmupPromise = inFlightPromise;
        inFlightPromise.finally(() => {
          inFlightPromise = null;
        });
      }
      return warmupPromise;
    },
    getInFlight() {
      return inFlightPromise;
    },
  };
}

const pythonWarmup = createPythonWarmup({
  baseUrl: config.API.ANGEL_ONE_API_BASE,
  timeoutMs: config.API.PYTHON_COLD_START_TIMEOUT_MS,
});

module.exports = pythonWarmup;
module.exports.createPythonWarmup = createPythonWarmup;
