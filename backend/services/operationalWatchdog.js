'use strict';

const notifyUrgent = require('./notificationService').notifyUrgent;

class OperationalWatchdog {
  constructor({ Position, OrderIntent, ExecutionLease, BrokerAccount, recovery, getRuntimePositions, notify = notifyUrgent, now = () => Date.now() } = {}) {
    this.Position = Position || require('../models/Position');
    this.OrderIntent = OrderIntent || require('../models/OrderIntent');
    this.ExecutionLease = ExecutionLease || require('../models/ExecutionLease');
    this.BrokerAccount = BrokerAccount || require('../models/BrokerAccount');
    this.recovery = recovery || require('./startupRecovery');
    this.getRuntimePositions = getRuntimePositions || (() => require('./strategyEngine').getRuntimePositionHealth());
    this.notify = notify;
    this.now = now;
    this.timer = null;
    this.running = null;
    this.activeAlerts = new Set();
    this.staleQuoteMs = Math.max(5_000, Number(process.env.STALE_POSITION_QUOTE_MS) || 20_000);
    this.unresolvedIntentMs = Math.max(30_000, Number(process.env.UNRESOLVED_INTENT_ALERT_MS) || 120_000);
  }

  async check() {
    if (this.running) return this.running;
    this.running = this.performCheck().catch(async error => {
      console.error(`[OperationalWatchdog] persistence/scan failure: ${require('./productionHardening').redact(error.message)}`);
      for (const account of require('./activeAccountService').listActiveAccounts()) {
        try {
          await this.notify('PERSISTENCE_FAILURE', { userId: account.userId, brokerAccountId: account.brokerAccountId, reason: 'Operational monitoring could not read durable state' });
        } catch (notifyError) {
          require('./productionHardening').increment('alert_delivery_failures_total');
          console.error(JSON.stringify({ type: 'alert_delivery_failed', event: 'PERSISTENCE_FAILURE', userId: account.userId,
            brokerAccountId: account.brokerAccountId, failureType: notifyError.name || 'error' }));
        }
      }
      throw error;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async alert(key, event, context, attributes = {}) {
    if (this.activeAlerts.has(key)) return;
    try {
      const delivery = await this.notify(event, { ...context, ...attributes });
      if (delivery?.delivered === false) {
        require('./productionHardening').increment('alert_delivery_failures_total');
        console.error(JSON.stringify({ type: 'alert_delivery_failed', event, userId: context.userId, brokerAccountId: context.brokerAccountId,
          reason: require('./productionHardening').redact(delivery.reason || 'unspecified') }));
      } else {
        this.activeAlerts.add(key);
      }
    } catch (error) {
      require('./productionHardening').increment('alert_delivery_failures_total');
      console.error(JSON.stringify({ type: 'alert_delivery_failed', event, userId: context.userId, brokerAccountId: context.brokerAccountId, failureType: error.name || 'error' }));
    }
  }

  async performCheck() {
    const now = this.now();
    const runtimePositions = this.getRuntimePositions();
    const [positions, intents, leases, accounts] = await Promise.all([
      this.Position.find({ status: { $ne: 'CLOSED' } }).select('userId brokerAccountId strategyId status executionSnapshot executionOwnerId executionOwnerGeneration lastQuoteAt protectiveOrderId protectiveStopPrice remainingQuantity').lean(),
      this.OrderIntent.find({ status: { $in: require('./executionLeaseService').unresolvedStates } }).select('userId brokerAccountId strategyId status updatedAt').lean(),
      this.ExecutionLease.find({ state: 'ACTIVE' }).select('userId brokerAccountId ownerId generation leaseUntil heartbeatAt').lean(),
      this.BrokerAccount.find({ status: { $in: ['SESSION_EXPIRED', 'SERVICE_UNAVAILABLE'] } }).select('userId _id status').lean(),
    ]);
    const known = new Set();
    const unscopedCount = positions.filter(item => !item.userId || !item.brokerAccountId).length
      + intents.filter(item => !item.userId || !item.brokerAccountId).length;
    if (unscopedCount) console.error(JSON.stringify({ type: 'unscoped_execution_records', count: unscopedCount, at: new Date(now).toISOString() }));
    for (const position of positions) {
      if (!position.userId || !position.brokerAccountId) continue;
      const scope = { userId: String(position.userId), brokerAccountId: String(position.brokerAccountId) };
      const prefix = `${scope.userId}:${scope.brokerAccountId}:`;
      if (!position.executionOwnerId || !position.executionOwnerGeneration) {
        known.add(`${prefix}MISSING_EXECUTION_OWNER`);
        await this.alert(`${prefix}MISSING_EXECUTION_OWNER`, 'MISSING_EXECUTION_OWNER', scope, { state: position.status });
      }
      const lease = leases.find(row => String(row.userId) === scope.userId && String(row.brokerAccountId) === scope.brokerAccountId);
      if (!lease || !lease.ownerId || lease.leaseUntil?.getTime() <= now) {
        known.add(`${prefix}EXECUTION_OWNER_LEASE_MISSING`);
        await this.alert(`${prefix}EXECUTION_OWNER_LEASE_MISSING`, 'MISSING_EXECUTION_OWNER', scope, { state: 'LEASE_MISSING' });
      }
      // Only the process holding the active lease is responsible for judging
      // its in-memory quote monitor. Other replicas must not infer staleness.
      const ownsLease = lease?.ownerId === require('./executionLeaseService').ownerId
        && lease.leaseUntil?.getTime() > now
        && position.executionOwnerId === lease.ownerId
        && position.executionOwnerGeneration === lease.generation;
      if (ownsLease) {
        const runtime = runtimePositions.find(item => item.userId === scope.userId && item.brokerAccountId === scope.brokerAccountId
          && item.positionId && String(item.positionId) === String(position._id));
        if (!runtime?.lastQuoteReceivedAt || now - runtime.lastQuoteReceivedAt > this.staleQuoteMs) {
          const key = `${prefix}${position._id}:STALE_POSITION_QUOTE`;
          known.add(key);
          await this.alert(key, 'STALE_POSITION_QUOTE', scope, { state: position.status, positionId: String(position._id) });
        }
      }
      if (position.status === 'UNPROTECTED' || (position.executionSnapshot?.executionMode === 'LIVE'
        && position.remainingQuantity > 0 && !position.protectiveOrderId)) {
        known.add(`${prefix}UNPROTECTED_EXPOSURE`);
        await this.alert(`${prefix}UNPROTECTED_EXPOSURE`, 'UNPROTECTED_EXPOSURE', scope, { state: position.status });
      }
    }
    for (const intent of intents) {
      if (!intent.userId || !intent.brokerAccountId || now - new Date(intent.updatedAt).getTime() < this.unresolvedIntentMs) continue;
      const scope = { userId: String(intent.userId), brokerAccountId: String(intent.brokerAccountId) };
      const key = `${scope.userId}:${scope.brokerAccountId}:UNRESOLVED_ORDER_INTENT`;
      known.add(key);
      await this.alert(key, 'UNRESOLVED_ORDER_INTENT', scope, { state: intent.status });
    }
    for (const account of accounts) {
      const scope = { userId: String(account.userId), brokerAccountId: String(account._id) };
      const key = `${scope.userId}:${scope.brokerAccountId}:BROKER_SESSION_FAILURE`;
      known.add(key);
      await this.alert(key, 'BROKER_SESSION_FAILURE', scope, { state: account.status });
    }
    for (const [userId, brokerAccountId, status] of this.recovery.listStates?.() || []) {
      if (status.status !== 'DEGRADED') continue;
      const context = { userId: String(userId), brokerAccountId: String(brokerAccountId) };
      const key = `${context.userId}:${context.brokerAccountId}:RECOVERY_FAILED`;
      known.add(key);
      await this.alert(key, 'RECOVERY_FAILED', context, { state: status.status, reason: require('./productionHardening').redact(status.message) });
    }
    for (const key of this.activeAlerts) if (!known.has(key)) this.activeAlerts.delete(key);
    const snapshot = { openPositions: positions.length, unresolvedIntents: intents.length, activeAlerts: this.activeAlerts.size,
      infrastructure: 'node-running', brokerDegradedAccounts: accounts.length, at: new Date(now).toISOString() };
    console.log(JSON.stringify({ type: 'runtime_metrics', ...snapshot, counters: require('./productionHardening').metricsSnapshot() }));
    return snapshot;
  }

  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.check().catch(error => console.error(`[OperationalWatchdog] scan failed: ${require('./productionHardening').redact(error.message)}`));
    this.timer = setInterval(() => this.check().catch(error => console.error(`[OperationalWatchdog] scan failed: ${require('./productionHardening').redact(error.message)}`)), intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { OperationalWatchdog, watchdog: new OperationalWatchdog() };
