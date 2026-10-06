const EventEmitter = require('events');
const mongoose = require('mongoose');
const config = require('../config');
const pythonWarmup = require('./pythonWarmup');
const notifyUrgent = require('./notificationService').notifyUrgent;
const activeAccountService = require('./activeAccountService');

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
    this.accountOperationalStates = new Map();
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
      this.lastOperationalState = operational;
    }
    await this.notifyAccountHealth(operational, state);

    if (!state.pythonApi || !state.mongoDb) {
      console.warn('[HealthMonitor] System Health Warning:', state);
      this.emit('health:warning', state);
    } else {
      this.emit('health:ok', state);
    }

    return state;
  }

  async notifyAccountHealth(operational, state) {
    const accounts = activeAccountService.listActiveAccounts();
    const activeKeys = new Set(accounts.map(account => `${account.userId}:${account.brokerAccountId}`));
    for (const key of this.accountOperationalStates.keys()) {
      if (!activeKeys.has(key)) this.accountOperationalStates.delete(key);
    }
    await Promise.all(accounts.map(async account => {
      const key = `${account.userId}:${account.brokerAccountId}`;
      if (this.accountOperationalStates.get(key) === operational) return;
      this.accountOperationalStates.set(key, operational);
      const event = operational ? 'SYSTEM_HEALTH_RESTORED' : 'SYSTEM_HEALTH_DEGRADED';
      const reason = operational
        ? 'Node, Python, and MongoDB checks are healthy'
        : `Python status: ${state.pythonStatus}; database ${state.mongoDb ? 'ready' : 'unavailable'}`;
      try {
        await notifyUrgent(event, { userId: account.userId, brokerAccountId: account.brokerAccountId, reason });
      } catch (err) {
        console.error(`[HealthMonitor] Account-scoped health alert failed for ${key}:`, err.message);
      }
    }));
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
