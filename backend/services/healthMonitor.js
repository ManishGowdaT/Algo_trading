const EventEmitter = require('events');
const mongoose = require('mongoose');
const config = require('../config');
const { notifyUrgent } = require('./notificationService');
const activeAccountService = require('./activeAccountService');
const pythonWarmup = require('./pythonWarmup');

class HealthMonitorService extends EventEmitter {
  constructor() {
    super();
    this.checkTimer = null;
    this.lastHealthState = {
      pythonApi: false,
      pythonStatus: 'starting',
      mongoDb: false,
      lastCheck: null,
      rttMs: 0
    };
    this.lastOperationalState = null;
    this.checkPromise = null;
  }

  checkHealth() {
    if (this.checkPromise) return this.checkPromise;

    this.checkPromise = this.performHealthCheck().finally(() => {
      this.checkPromise = null;
    });
    return this.checkPromise;
  }

  async performHealthCheck() {
    const state = {
      pythonApi: false,
      pythonStatus: 'starting',
      mongoDb: false,
      lastCheck: new Date().toISOString(),
      rttMs: 0
    };

    // 1. Check MongoDB
    state.mongoDb = mongoose.connection.readyState === 1;

    // 2. Confirm Python liveness and authenticated readiness
    const startMs = Date.now();
    try {
      const startupProbe = pythonWarmup.getInFlight();
      if (startupProbe) {
        state.pythonApi = await startupProbe;
        if (!state.pythonApi) {
          state.pythonStatus = 'starting';
        }
      }

      if (state.pythonApi || !startupProbe) {
        const res = await fetch(`${config.API.ANGEL_ONE_API_BASE}/internal/ready`, {
          signal: AbortSignal.timeout(3000),
          headers: { 'X-Internal-Service-Key': config.API.INTERNAL_SERVICE_KEY },
        });
        if (res.ok) {
          state.pythonApi = true;
          state.pythonStatus = 'ready';
          state.rttMs = Date.now() - startMs;
        } else {
          state.pythonApi = false;
          state.pythonStatus = res.status === 401 || res.status === 403
            ? 'authentication_misconfigured'
            : res.status === 429
              ? 'edge_rate_limited'
              : 'unavailable';
          console.warn(
            `[HealthMonitor] Python readiness check returned HTTP ${res.status} after ${Date.now() - startMs}ms`
          );
        }
      }
    } catch (err) {
      state.pythonApi = false;
      state.pythonStatus = err.name === 'AbortError' || err.name === 'TimeoutError' ? 'timeout' : 'unavailable';
      const failure = state.pythonStatus === 'timeout' ? 'timeout' : 'network error';
      console.warn(`[HealthMonitor] Python readiness check ${failure} after ${Date.now() - startMs}ms`);
    }

    this.lastHealthState = state;

    const operational = state.pythonApi && state.mongoDb;
    if (this.lastOperationalState !== operational) {
      const label = operational ? 'HEALTHY' : 'DEGRADED';
      console.log(`[HealthMonitor] System health transition: ${label}`, state);
      notifyUrgent(operational ? 'SYSTEM_HEALTH_RESTORED' : 'SYSTEM_HEALTH_DEGRADED', {
        reason: operational ? 'Node, Python, and MongoDB checks are healthy' : 'Python API or MongoDB health check failed',
        accountLabel: activeAccountService.getActiveAccount()?.accountLabel,
        userId: activeAccountService.getActiveAccount()?.userId,
        clientCode: activeAccountService.getActiveAccount()?.clientCode,
      }).catch(err => console.error('[HealthMonitor] Health alert error:', err.message));
      this.lastOperationalState = operational;
    }

    if (!state.pythonApi || !state.mongoDb) {
      console.warn('[HealthMonitor] System Health Warning:', state);
      this.emit('health:warning', state);
    } else {
      this.emit('health:ok', state);
    }

    return state;
  }

  start(intervalMs = 15_000) {
    if (this.checkTimer) return;
    this.checkHealth();
    this.checkTimer = setInterval(() => this.checkHealth(), intervalMs);
  }

  stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  getStatus() {
    return this.lastHealthState;
  }
}

module.exports = new HealthMonitorService();
