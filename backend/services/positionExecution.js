const crypto = require('node:crypto');
const mongoose = require('mongoose');
const accounts = require('./accountContext');
const Position = require('../models/Position');
const OrderIntent = require('../models/OrderIntent');
const Trade = require('../models/Trade');
const Strategy = require('../models/Strategy');
const { requestPython } = require('./pythonApiClient');
const executionLeases = require('./executionLeaseService');

const terminal = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'FAILED']);
const instances = new WeakMap();
const owners = new Map();
const books = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const statusOf = order => String(order?.orderstatus || order?.status || '').toLowerCase();
const unresolved = message => Object.assign(new Error(message), { code: 'RECONCILIATION_REQUIRED', status: 409 });
async function coordinate(context, callback) {
  const key = `execution-account:${context.userId}:${context.brokerAccountId}`;
  return accounts.exclusive(key, callback);
}
const pendingEntry = { $or: [{ status: { $nin: [...terminal] } }, { filledQuantity: { $gt: 0 }, positionId: { $exists: false } }] };

// One process-local execution owner; cross-process startup leases belong to Phase 6.
class PositionExecution {
  constructor(runner, dependencies = {}) {
    this.runner = runner;
    this.context = accounts.assertVerified(runner.accountContext);
    this.key = `${this.context.userId}:${this.context.brokerAccountId}:${runner.strategyName}`;
    this.positionId = null;
    this.entryIntentId = null;
    this.recoveryIntentId = null;
    this.strategyId = null;
    this.heldSubscription = null;
    this.timer = null;
    this.polling = false;
    this.feed = dependencies.feed || require('./marketDataService');
    this.leaseToken = null;
    this.fencedLeaseGeneration = null;
    this.suspended = false;
  }

  scope() { return { userId: this.context.userId, brokerAccountId: this.context.brokerAccountId }; }
  async run(callback) {
    if (this.suspended) throw unresolved('Execution manager was suspended for recovery.');
    return coordinate(this.context, () => accounts.run(this.context, async () => {
      if (this.suspended) throw unresolved('Execution manager was suspended for recovery.');
      try {
        await accounts.validate(this.context);
        await this.prepareOwnership();
      } catch (error) {
        // This gate runs before callback work and before OrderIntent creation.
        // Marking it lets the scanner retain a still-fresh signal for a later
        // admission attempt without ever retrying an ambiguous broker submit.
        error.executionAdmissionFailure = true;
        throw error;
      }
      const owner = owners.get(this.key);
      if (owner && owner !== this && owner.hasExposure()) throw unresolved('Position already has an execution owner.');
      owners.set(this.key, this);
      try { return await callback(); }
      catch (error) { this.degraded(error); throw error; }
    }));
  }
  async prepareOwnership() {
    if (this.suspended) throw unresolved('Execution manager was suspended for recovery.');
    this.leaseToken = await executionLeases.executionContext(this.context);
    if (this.fencedLeaseGeneration !== this.leaseToken.generation) {
      const { response, data } = await require('./pythonApiClient').registerExecutionOwner(this.context, this.leaseToken);
      if (!response.ok || data?.ownerGeneration !== this.leaseToken.generation) {
        this.leaseToken = null;
        throw unresolved('Python broker worker did not confirm the current execution owner.');
      }
      this.fencedLeaseGeneration = this.leaseToken.generation;
    }
    await executionLeases.assertCurrent(this.leaseToken);
    await this.claimDurableRecords();
    return this.leaseToken;
  }
  async claimDurableRecords() {
    const token = this.leaseToken;
    const scope = this.scope();
    const positions = await Position.find({ ...scope, status: { $ne: 'CLOSED' } });
    for (const position of positions) {
      if (position.executionOwnerId === token.ownerId && position.executionOwnerGeneration === token.generation) continue;
      const updated = await Position.updateOne({ ...scope, _id: position._id, version: position.version }, {
        $set: { executionOwnerId: token.ownerId, executionOwnerGeneration: token.generation }, $inc: { version: 1 },
      });
      if (updated.matchedCount !== 1) throw unresolved('Position ownership changed while acquiring the execution lease.');
    }
    const positionIds = positions.map(position => position._id);
    const intents = await OrderIntent.find({ ...scope, $or: [
      { status: { $in: executionLeases.unresolvedStates } },
      { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
      ...(positionIds.length ? [{ positionId: { $in: positionIds } }, { resultPositionId: { $in: positionIds } }] : []),
    ] });
    for (const intent of intents) {
      if (intent.executionOwnerId === token.ownerId && intent.executionOwnerGeneration === token.generation) continue;
      const updated = await OrderIntent.updateOne({ ...scope, _id: intent._id, version: intent.version }, {
        $set: { executionOwnerId: token.ownerId, executionOwnerGeneration: token.generation }, $inc: { version: 1 },
      });
      if (updated.matchedCount !== 1) throw unresolved('Order ownership changed while acquiring the execution lease.');
    }
  }
  async savePosition(position) {
    await executionLeases.assertCurrent(this.leaseToken);
    if (position.executionOwnerId !== this.leaseToken.ownerId || position.executionOwnerGeneration !== this.leaseToken.generation) throw unresolved('Position is fenced to another execution owner.');
    return position.save();
  }
  async saveIntent(intent) {
    await executionLeases.assertCurrent(this.leaseToken);
    if (intent.executionOwnerId !== this.leaseToken.ownerId || intent.executionOwnerGeneration !== this.leaseToken.generation) throw unresolved('Order intent is fenced to another execution owner.');
    return intent.save();
  }
  hasExposure() { return Boolean(this.positionId || this.entryIntentId || this.recoveryIntentId); }
  clearEmptyEntry() {
    this.entryIntentId = null;
    this.recoveryIntentId = null;
    Object.assign(this.runner, { pendingEntryQuantity: 0, remainingQuantity: 0, completionPending: false,
      positionState: 'NONE', exitInProgress: false, isExiting: false });
    this.runner.state = !this.runner.isRunning ? 'STOPPED' : this.runner.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
    this.runner.message = 'Entry did not fill; no position was opened.';
    this.retire();
  }
  degraded(error) {
    this.runner.positionState = 'RECONCILIATION_REQUIRED';
    this.runner.state = 'RECONCILIATION_REQUIRED';
    this.runner.message = `Reconciliation required: ${error.message}`;
    this.runner.exitInProgress = false;
    this.runner.isExiting = false;
    if (this.hasExposure()) this.watch();
    const persistenceFailure = /mongo|mongoose|buffering timed out|database|write concern|transaction/i.test(`${error?.name || ''} ${error?.message || ''}`);
    if (persistenceFailure) require('./notificationService').notifyUrgent('PERSISTENCE_FAILURE', {
      userId: this.context.userId, brokerAccountId: this.context.brokerAccountId,
      strategyName: this.runner.strategyName, state: this.runner.positionState,
      reason: 'Durable execution state could not be confirmed; broker mutations remain fenced.',
    }).catch(alertError => console.error(`[PositionExecution] Persistence alert delivery failed (${alertError.name || 'error'}).`));
  }
  watch() {
    if (this.timer || this.suspended) return;
    this.timer = setInterval(async () => {
      if (this.suspended) return;
      if (this.polling) return;
      this.polling = true;
      try { await this.reconcile(); }
      catch (error) { this.degraded(error); }
      finally { this.polling = false; }
    }, 1000);
  }
  retire() {
    if (this.hasExposure()) return false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.orderUpdates && this.orderListener) this.orderUpdates.removeListener('order:update', this.orderListener);
    this.orderUpdates = this.orderListener = null;
    if (owners.get(this.key) === this) owners.delete(this.key);
    const prefix = `${this.context.userId}:${this.context.brokerAccountId}:`;
    if (![...owners.values()].some(owner => owner.context.userId === this.context.userId && owner.context.brokerAccountId === this.context.brokerAccountId && owner.hasExposure())) {
      for (const key of books.keys()) if (key.startsWith(prefix)) books.delete(key);
    }
    return true;
  }
  suspendForRecovery() {
    this.suspended = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.orderUpdates && this.orderListener) this.orderUpdates.removeListener('order:update', this.orderListener);
    this.orderUpdates = this.orderListener = null;
    if (this.runner.monitorInterval) clearInterval(this.runner.monitorInterval);
    this.runner.monitorInterval = null;
    if (this.heldSubscription && this.runner.activeTradeContract) {
      this.runner.releaseFeed(this.runner.activeTradeContract.exchange, this.runner.activeTradeContract.symboltoken,
        this.runner.getBaseTimeframe(), 'position');
    }
    this.heldSubscription = null;
    if (owners.get(this.key) === this) owners.delete(this.key);
  }
  async quiesceForShutdown(timeoutMs = 5_000) {
    // Prevent another polling cycle, let any already admitted reconciliation
    // finish under its current lease, and then remove this manager's callbacks.
    this.suspended = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.runner.monitorInterval) clearInterval(this.runner.monitorInterval);
    this.runner.monitorInterval = null;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while ((this.polling || this.runner.monitorInFlight) && Date.now() < deadline) await sleep(10);
    if (this.polling || this.runner.monitorInFlight) return false;
    if (this.orderUpdates && this.orderListener) this.orderUpdates.removeListener('order:update', this.orderListener);
    this.orderUpdates = this.orderListener = null;
    if (this.heldSubscription && this.runner.activeTradeContract) {
      this.runner.releaseFeed(this.runner.activeTradeContract.exchange, this.runner.activeTradeContract.symboltoken,
        this.runner.getBaseTimeframe(), 'position');
    }
    this.heldSubscription = null;
    if (owners.get(this.key) === this) owners.delete(this.key);
    return true;
  }
  async strategy() {
    if (!this.strategyId) {
      const strategy = await Strategy.findOne({ userId: this.context.userId, name: this.runner.strategyName });
      if (!strategy) throw unresolved('Owned strategy record is missing.');
      this.strategyId = strategy._id;
    }
    return this.strategyId;
  }
  async resume() {
    const strategy = await Strategy.findOne({ ...{ userId: this.context.userId }, name: this.runner.strategyName });
    if (!strategy) return;
    this.strategyId = strategy._id;
    return this.run(async () => {
      const positions = await Position.find({ ...this.scope(), strategyId: this.strategyId, status: { $ne: 'CLOSED' } });
      if (positions.length > 1) throw unresolved('Multiple durable held positions require explicit ownership reconciliation before Start.');
      const position = positions[0];
      const intent = await OrderIntent.findOne({ ...this.scope(), strategyId: this.strategyId, purpose: 'ENTRY', ...pendingEntry });
      const unresolvedIntents = await OrderIntent.find({ ...this.scope(), strategyId: this.strategyId, $or: [
        { status: { $nin: [...terminal] } }, { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
      ] }).sort({ createdAt: 1 });
      this.positionId = position?._id || null;
      this.entryIntentId = intent?._id || position?.entryIntentId || null;
      this.recoveryIntentId = !position && !intent && unresolvedIntents.length ? unresolvedIntents[0]._id : null;
      if (!position && !intent) {
        const legacy = await Trade.findOne({ ...this.scope(), strategyId: this.strategyId, exitPrice: { $exists: false } });
        if (legacy) throw unresolved('Legacy exposure has no verified durable held instrument; operator reconciliation is required.');
        if (!this.recoveryIntentId) return;
        // Reconcile every standalone intent, in order. Any unknown outcome or
        // unlinked fill withholds authority rather than skipping to READY.
        for (const pending of unresolvedIntents) {
          this.recoveryIntentId = pending._id;
          await this.reconcileLocked({ freshBrokerEvidence: true });
        }
        return;
      }
      this.watch();
      return this.reconcileLocked({ freshBrokerEvidence: true });
    });
  }
  async book(force = false) {
    const key = `${this.context.userId}:${this.context.brokerAccountId}:${this.context.sessionGeneration}:${this.context.sessionId}`;
    let record = books.get(key);
    if (record?.promise) return record.promise;
    if (!force && record?.data && Date.now() - record.at < 1000) return record.data;
    if (force && record && Date.now() - record.at < 1000) await sleep(1000 - (Date.now() - record.at));
    record = books.get(key);
    if (record?.promise) return record.promise;
    record = { at: Date.now(), promise: null };
    books.set(key, record);
    record.promise = (async () => {
      const { response, data } = await requestPython('/angel/orderbook', { context: this.context, timeoutMs: 5000, freshOrderbook: force,
        ...(this.leaseToken ? { executionOwner: this.leaseToken } : {}) });
      if (!response.ok || data?.status === false || !Array.isArray(data?.data)) throw unresolved('Broker orderbook unavailable.');
      await accounts.validate(this.context);
      record.data = data.data;
      return record.data;
    })().finally(() => { record.promise = null; });
    return record.promise;
  }
  async intent(purpose, request, position = null, target = null, metadata = undefined) {
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) throw unresolved('Order quantity is invalid.');
    const id = new mongoose.Types.ObjectId();
    const result = await OrderIntent.create({
      _id: id, ...this.scope(), strategyId: await this.strategy(), purpose,
      idempotencyKey: crypto.randomUUID(), requestedQuantity: request.quantity,
      remainingQuantity: request.quantity, requestSnapshot: request,
      ...(position ? { positionId: position._id, tradeId: position.tradeId } : {}),
      ...(purpose === 'ENTRY' ? { resultTradeId: new mongoose.Types.ObjectId(), resultPositionId: new mongoose.Types.ObjectId() } : {}),
      ...(target ? { targetIntentId: target._id, brokerOrderId: target.brokerOrderId } : {}),
      executionMetadata: metadata, sessionGeneration: this.context.sessionGeneration,
      ownerGeneration: this.context.ownerGeneration,
      executionOwnerId: this.leaseToken?.ownerId,
      executionOwnerGeneration: this.leaseToken?.generation || 0,
    });
    return result;
  }
  async submit(intent, path = '/angel/orders/simple') {
    const lease = await this.prepareOwnership();
    // Write failure here means there has been no broker mutation.
    intent.status = 'SUBMITTING'; intent.attemptCount = 1; intent.submittedAt = new Date();
    await this.saveIntent(intent);
    const request = intent.requestSnapshot.toObject ? intent.requestSnapshot.toObject() : intent.requestSnapshot;
    const { action, ...payload } = request;
    let result;
    try {
      await executionLeases.assertCurrent(lease);
      result = await requestPython(path, { context: this.context, executionOwner: lease, method: 'POST', timeoutMs: 5000,
        ownershipChecked: action === 'CANCEL',
        body: action === 'CANCEL' ? { variety: request.variety || 'NORMAL' } : { ...payload, transactiontype: action } });
    } catch (error) {
      intent.status = 'UNKNOWN'; intent.lastErrorMessage = 'Broker submission outcome is unknown';
      await this.saveIntent(intent);
      throw unresolved('Broker submission outcome is unknown; no retry was submitted.');
    }
    const broker = result.data?.item?.response || result.data;
    intent.brokerResponse = result.data;
    const id = broker?.data?.orderid || broker?.orderid;
    if (result.response.ok && id) {
      intent.brokerOrderId = String(id); intent.status = 'ACKNOWLEDGED'; intent.acknowledgedAt = new Date();
    } else if (result.response.ok && broker?.status === false && broker?.errorcode && broker?.outcome !== 'UNKNOWN') {
      intent.status = 'REJECTED'; intent.remainingQuantity = 0; intent.completedAt = new Date();
    } else {
      intent.status = 'UNKNOWN'; intent.lastErrorMessage = 'No verified broker acknowledgement';
    }
    // If this write fails, SUBMITTING remains durable and blocks another mutation.
    await this.saveIntent(intent);
    return intent;
  }
  async observe(intent, book) {
    if (terminal.has(intent.status)) return intent;
    if (!intent.brokerOrderId) return intent; // Similar symbol/quantity is not identity evidence.
    const order = book.find(item => String(item.orderid || item.orderId) === String(intent.brokerOrderId));
    if (!order) return intent;
    const request = intent.requestSnapshot;
    for (const field of ['exchange', 'tradingsymbol', 'symboltoken', 'producttype']) {
      if (String(order[field] || '') !== String(request[field])) throw unresolved('Order evidence instrument/account scope does not match its intent.');
    }
    if (Number(order.quantity) !== intent.requestedQuantity) throw unresolved('Broker order quantity does not match its intent.');
    if (intent.purpose !== 'CANCEL' && order.transactiontype !== request.action) throw unresolved('Order direction mismatch.');
    if (intent.purpose === 'PROTECT' && (order.ordertype !== request.ordertype || Number(order.triggerprice) !== request.triggerprice)) {
      throw unresolved('Protective order trigger/type differs from the persisted intent.');
    }
    const status = statusOf(order);
    let filled = Number(order.filledshares ?? order.filledquantity ?? order.filledQuantity);
    if (!Number.isFinite(filled) && ['complete', 'executed'].includes(status) && Number(order.quantity) === intent.requestedQuantity) filled = intent.requestedQuantity;
    if (!Number.isInteger(filled) || filled < 0 || filled > intent.requestedQuantity) throw unresolved('Broker fill quantity is invalid or missing.');
    if (filled < intent.filledQuantity) return intent; // Ignore late/regressive evidence.
    const price = Number(order.averageprice || order.averageFillPrice);
    if (filled > 0 && (!Number.isFinite(price) || price <= 0)) throw unresolved('Broker fill price is missing.');
    intent.lastReconciledAt = new Date();
    if (intent.purpose === 'CANCEL') {
      if (['cancelled', 'canceled', 'expired'].includes(status)) {
        intent.status = 'CANCELLED'; intent.remainingQuantity = 0; intent.completedAt = new Date();
      }
      // A fill wins the race; the target intent accounts for its quantity.
      else if (['complete', 'executed'].includes(status)) {
        intent.status = 'CANCELLED'; intent.remainingQuantity = 0; intent.completedAt = new Date();
      }
    } else {
      intent.filledQuantity = filled;
      if (filled > 0) intent.averageFillPrice = price;
      if (['cancelled', 'canceled', 'expired', 'rejected'].includes(status)) {
        intent.status = status === 'rejected' ? 'REJECTED' : 'CANCELLED'; intent.remainingQuantity = 0; intent.completedAt = new Date();
      } else if (filled === intent.requestedQuantity && ['complete', 'executed'].includes(status)) {
        intent.status = 'FILLED'; intent.remainingQuantity = 0; intent.completedAt = new Date();
      } else {
        intent.remainingQuantity = intent.requestedQuantity - filled;
        intent.status = filled > 0 ? 'PARTIALLY_FILLED' : 'ACKNOWLEDGED';
      }
    }
    await this.saveIntent(intent);
    return intent;
  }
  async ownedPosition() {
    if (!this.positionId) return null;
    const position = await Position.findOne({ ...this.scope(), _id: this.positionId, strategyId: await this.strategy() });
    if (!position) throw unresolved('Owned durable position is missing.');
    return position;
  }
  async persistTradeState(position) {
    await executionLeases.assertCurrent(this.leaseToken);
    const result = await Trade.updateOne({ ...this.scope(), _id: position.tradeId, strategyId: position.strategyId },
      { $set: { positionState: position.status, protectiveOrderId: position.protectiveOrderId,
        protectiveStopPrice: position.protectiveStopPrice, lastBrokerSyncAt: new Date() } });
    if (result.matchedCount !== 1) throw unresolved('Trade state persistence requires reconciliation.');
  }
  async materialize(entry) {
    if (entry.filledQuantity <= 0) return null;
    const metadata = entry.executionMetadata;
    const config = metadata.config;
    const price = entry.averageFillPrice;
    const stop = metadata.strategyName === '5minBreakout' ? metadata.stopLoss
      : price - (Number(config.initialSlPoints && metadata.strategyName === 'ModifiedHeikenAshi' && config.exitStrategy === 'TRAILING_SL'
        ? config.initialSlPoints : config.slPoints) || 30);
    const snapshot = { executionMode: config.liveTradingConsent ? 'LIVE' : 'PAPER', quantity: entry.requestedQuantity,
      underlying: config.underlying || 'SENSEX', ...Object.fromEntries(['exchange', 'tradingsymbol', 'symboltoken', 'producttype'].filter(key => key !== 'producttype').map(key => [key, entry.requestSnapshot[key]])),
      entryPrice: price, stopLoss: Number.isFinite(stop) && stop > 0 ? stop : undefined, target: price + (Number(config.targetPoints) || 20),
      producttype: entry.requestSnapshot.producttype,
      ...Object.fromEntries(['exitStrategy', 'initialSlPoints', 'trailingStopPoints', 'finalTargetPoints', 'targetPoints', 'slPoints'].filter(key => config[key] !== undefined).map(key => [key, config[key]])) };
    await executionLeases.assertCurrent(this.leaseToken);
    let trade = await Trade.findOne({ ...this.scope(), _id: entry.resultTradeId });
    if (!trade) trade = await Trade.create({ _id: entry.resultTradeId, ...this.scope(), strategyId: entry.strategyId,
      index: snapshot.underlying, premium: snapshot.tradingsymbol, qty: entry.filledQuantity, buyPrice: price,
      executionMode: snapshot.executionMode, entryOrderId: entry.brokerOrderId, positionState: 'UNPROTECTED', executionSnapshot: snapshot });
    let position = await Position.findOne({ ...this.scope(), _id: entry.resultPositionId });
    const pending = terminal.has(entry.status) ? 0 : entry.requestedQuantity - entry.filledQuantity;
    const abandoned = terminal.has(entry.status) ? entry.requestedQuantity - entry.filledQuantity : 0;
    if (trade.qty !== entry.filledQuantity || trade.buyPrice !== price) {
      await executionLeases.assertCurrent(this.leaseToken);
      trade.qty = entry.filledQuantity; trade.buyPrice = price; await trade.save();
    }
    if (!position) position = await Position.create({ _id: entry.resultPositionId, ...this.scope(), strategyId: entry.strategyId,
      tradeId: trade._id, entryIntentId: entry._id, executionSnapshot: snapshot, executionConfig: config,
      remainingQuantity: entry.filledQuantity, pendingEntryQuantity: pending, abandonedEntryQuantity: abandoned,
      averageEntryPrice: price, activeTrailingSl: metadata.strategyName === 'ModifiedHeikenAshi' ? price - (Number(config.initialSlPoints) || 30) : undefined,
      status: 'UNPROTECTED', sessionGeneration: this.context.sessionGeneration, ownerGeneration: this.context.ownerGeneration,
      executionOwnerId: this.leaseToken.ownerId, executionOwnerGeneration: this.leaseToken.generation });
    else if (position.status !== 'CLOSED') {
      const initialTrailing = (position.averageEntryPrice || position.executionSnapshot.entryPrice) - (Number(config.initialSlPoints) || 30);
      if (metadata.strategyName === 'ModifiedHeikenAshi' && position.activeTrailingSl === initialTrailing) {
        position.activeTrailingSl = price - (Number(config.initialSlPoints) || 30);
      }
      position.remainingQuantity = entry.filledQuantity - position.filledExitQuantity;
      position.pendingEntryQuantity = pending; position.abandonedEntryQuantity = abandoned; position.averageEntryPrice = price;
      await this.savePosition(position);
    }
    this.positionId = position._id;
    if (!entry.positionId) {
      const linked = await OrderIntent.findOneAndUpdate({ ...this.scope(), _id: entry._id, version: entry.version,
        positionId: { $exists: false }, tradeId: { $exists: false } },
      { $set: { positionId: position._id, tradeId: trade._id }, $inc: { version: 1 } }, { returnDocument: 'after', runValidators: true });
      if (!linked) throw unresolved('Entry-to-position link could not be persisted.');
    }
    this.sync(position, metadata.trendSide);
    this.runner.heldWarmupCandles = structuredClone(metadata.warmupCandles || []);
    this.runner.heldSide = metadata.trendSide === 'BEARISH' ? 'pe' : 'ce';
    return position;
  }
  sync(position, trend) {
    const runner = this.runner; const held = position.executionSnapshot;
    runner.activeTradeId = String(position.tradeId); runner.activeTradePremium = held.tradingsymbol;
    runner.activeTradeContract = { exchange: held.exchange, tradingsymbol: held.tradingsymbol, symboltoken: held.symboltoken };
    runner.entryPrice = position.averageEntryPrice || held.entryPrice;
    runner.config = { ...position.executionConfig, quantity: position.remainingQuantity || held.quantity };
    runner.stopLoss = held.stopLoss; runner.target = held.target;
    runner.activeTrailingSl = position.activeTrailingSl ?? null; runner.protectiveOrderId = position.protectiveOrderId || null;
    runner.remainingQuantity = position.remainingQuantity; runner.pendingEntryQuantity = position.pendingEntryQuantity;
    runner.completionPending = position.completionPending;
    runner.protectiveStopPrice = position.protectiveStopPrice ?? held.stopLoss;
    runner.positionState = position.status; runner.state = position.status === 'PROTECTED' ? 'POSITION_PROTECTED'
      : position.status === 'UNPROTECTED' || position.status === 'OPEN' ? 'POSITION_UNPROTECTED' : position.status;
    if (trend) runner.trend = trend;
    if (this.heldSubscription !== String(position._id)) {
      runner.subscribeHeldPosition(runner.activeTradeContract); this.heldSubscription = String(position._id);
      const feed = this.feed;
      const interval = runner.getBaseTimeframe();
      if (typeof feed.subscribe === 'function') feed.subscribe(held.exchange, held.symboltoken, interval, null,
        { role: 'position', tradingsymbol: held.tradingsymbol, buildCandles: true })
        .catch(error => {
          if (String(this.positionId) !== String(position._id)) return;
          this.heldSubscription = null; this.degraded(error);
        });
    }
    if (!runner.monitorInterval && position.remainingQuantity > 0) runner.startMonitorLoop();
    this.watch();
    this.attachEvents();
  }
  attachEvents() {
    if (this.orderUpdates || this.eventsPromise || typeof this.feed.getOrderUpdateService !== 'function') return;
    this.eventsPromise = accounts.run(this.context, async () => {
      const stream = await this.feed.getOrderUpdateService();
      if (!this.hasExposure()) return;
      this.orderUpdates = stream;
      this.orderListener = (data, identity) => {
        if (this.suspended || !identity || identity.userId !== this.context.userId || identity.brokerAccountId !== this.context.brokerAccountId
          || identity.sessionId !== this.context.sessionId || identity.sessionGeneration !== this.context.sessionGeneration || this.polling) return;
        this.polling = true;
        this.run(async () => {
          const owned = await OrderIntent.findOne({ ...this.scope(), strategyId: this.strategyId, brokerOrderId: String(data.orderid || data.orderId || '') });
          if (owned) await this.reconcileLocked(); // Events only wake verified REST reconciliation.
        }).catch(error => this.degraded(error)).finally(() => { this.polling = false; });
      };
      stream.on('order:update', this.orderListener);
    }).catch(error => { if (this.hasExposure()) this.degraded(error); }).finally(() => { this.eventsPromise = null; });
  }
  async entry(contract, signalPrice, trendSide) {
    try {
      return await this.run(async () => {
      if (!this.runner.isRunning || !this.runner.brokerReady || this.hasExposure()) return;
      const strategyId = await this.strategy();
      const existing = await Position.findOne({ ...this.scope(), strategyId, status: { $ne: 'CLOSED' } });
      const pending = await OrderIntent.findOne({ ...this.scope(), strategyId, purpose: 'ENTRY', ...pendingEntry });
      if (existing || pending) {
        this.positionId = existing?._id || null; this.entryIntentId = pending?._id || existing?.entryIntentId;
        throw unresolved('Existing position or unresolved BUY requires reconciliation.');
      }
      const config = structuredClone(this.runner.config);
      const indexes = await OrderIntent.collection.indexes();
      if (!indexes.some(index => index.name === 'uniq_unresolved_entry_per_strategy' && index.unique
        && index.key?.userId === 1 && index.key?.brokerAccountId === 1 && index.key?.strategyId === 1
        && index.partialFilterExpression?.purpose === 'ENTRY')) throw unresolved('Durable entry uniqueness index is not installed; new entry withheld.');
      const defaults = { SENSEX: 20, NIFTY: 65, BANKNIFTY: 30, CRUDEOILM: 1 };
      const quantity = config.quantity || defaults[config.underlying || 'SENSEX'] || 10;
      if (config.liveTradingConsent) {
        const status = await requestPython('/angel/status', { context: this.context, timeoutMs: 5000 });
        if (!status.response.ok || !status.data?.connected) throw unresolved('Broker session readiness could not be verified; entry withheld.');
      }
      if (!this.runner.isRunning) return;
      const intent = await this.intent('ENTRY', { action: 'BUY', exchange: contract.exchange,
        symboltoken: contract.symboltoken, tradingsymbol: contract.tradingsymbol, quantity, ordertype: 'MARKET', producttype: 'CARRYFORWARD' },
      null, null, { config, strategyName: this.runner.strategyName, signalPrice, trendSide, stopLoss: this.runner.stopLoss,
        warmupCandles: structuredClone(this.runner.previousDayCandles?.[trendSide === 'BEARISH' ? 'pe' : 'ce'] || []) });
      this.entryIntentId = intent._id; this.watch();
      this.runner.pendingEntryQuantity = quantity;
      if (!this.runner.isRunning) {
        intent.status = 'FAILED'; intent.remainingQuantity = 0; intent.lastErrorMessage = 'Entry stopped before broker submission';
        await this.saveIntent(intent); this.entryIntentId = null; this.runner.pendingEntryQuantity = 0; this.retire(); return;
      }
      if (!config.liveTradingConsent) {
        intent.status = 'SUBMITTING'; await this.saveIntent(intent); intent.status = 'FILLED';
        intent.filledQuantity = quantity; intent.remainingQuantity = 0; intent.averageFillPrice = signalPrice; await this.saveIntent(intent);
      } else {
        await this.submit(intent);
        for (let i = 0; i < 4 && !terminal.has(intent.status); i++) {
          await this.observe(intent, await this.book(true));
          if (!terminal.has(intent.status)) await sleep(1000);
        }
      }
      const position = await this.materialize(intent);
      if (!position && terminal.has(intent.status)) { this.clearEmptyEntry(); return; }
      if (!terminal.has(intent.status)) throw unresolved('BUY remains open, partially filled or unknown.');
      if (position) await this.protect(position, this.initialStop(position));
      return { accepted: true, status: this.entryIntentId ? 'MANAGED' : 'COMPLETED' };
      });
    } catch (error) {
      if (error.executionAdmissionFailure && !this.entryIntentId && !this.positionId) {
        return { accepted: false, retryableBeforeSubmit: true, reason: error.code || 'EXECUTION_ADMISSION_UNAVAILABLE' };
      }
      throw error;
    }
  }
  async cancel(target, position, book) {
    await this.observe(target, book);
    if (terminal.has(target.status)) return true;
    if (!target.brokerOrderId) throw unresolved('Cannot cancel an order with unknown broker identity.');
    let cancel = await OrderIntent.findOne({ ...this.scope(), targetIntentId: target._id, purpose: 'CANCEL', status: { $nin: [...terminal] } });
    if (!cancel) {
      cancel = await this.intent('CANCEL', { ...target.requestSnapshot.toObject(), action: 'CANCEL' }, position, target);
      await this.submit(cancel, `/angel/orders/${encodeURIComponent(target.brokerOrderId)}/cancel`);
    }
    const fresh = await this.book(true);
    await this.observe(target, fresh); await this.observe(cancel, fresh);
    if (!terminal.has(target.status)) throw unresolved('Cancellation is not confirmed; replacement/exit withheld.');
    return true;
  }
  async applyExits(position, intents) {
    const evidence = intents.filter(intent => ['EXIT', 'PROTECT'].includes(intent.purpose) && intent.filledQuantity > 0)
      .map(intent => ({ intentId: String(intent._id), quantity: intent.filledQuantity, price: intent.averageFillPrice }));
    const exited = evidence.reduce((sum, item) => sum + item.quantity, 0);
    const opened = position.executionSnapshot.quantity - position.pendingEntryQuantity - position.abandonedEntryQuantity;
    if (exited > opened || exited < position.filledExitQuantity) throw unresolved('Conflicting exit fill evidence.');
    position.exitEvidence = evidence; position.filledExitQuantity = exited; position.remainingQuantity = opened - exited;
    if (position.remainingQuantity === 0) { position.completionPending = true; position.status = 'EXIT_PENDING'; }
    await this.savePosition(position);
  }
  async protect(position, stopPrice) {
    if (position.remainingQuantity <= 0) return false;
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
      position.status = 'UNPROTECTED'; await this.savePosition(position); this.sync(position);
      throw unresolved('Protective stop price is invalid; exposure remains managed.');
    }
    if (position.executionSnapshot.executionMode === 'PAPER') {
      position.status = 'PROTECTED'; position.protectiveStopPrice = stopPrice; await this.savePosition(position); await this.persistTradeState(position); this.sync(position); return true;
    }
    const protection = await OrderIntent.findOne({ ...this.scope(), positionId: position._id, purpose: 'PROTECT', status: { $nin: [...terminal] } });
    if (protection) {
      const book = await this.book(); await this.observe(protection, book);
      if (protection.requestedQuantity === position.remainingQuantity && protection.requestSnapshot.triggerprice === stopPrice
        && protection.status === 'ACKNOWLEDGED' && book.some(order => String(order.orderid) === protection.brokerOrderId
          && ['open', 'trigger pending', 'pending', 'validation pending'].includes(statusOf(order)))) {
        position.status = 'PROTECTED'; position.protectiveOrderId = protection.brokerOrderId;
        position.protectiveStopPrice = stopPrice; await this.savePosition(position); await this.persistTradeState(position); this.sync(position); return true;
      }
      await this.cancel(protection, position, book);
      const intents = await OrderIntent.find({ ...this.scope(), positionId: position._id });
      await this.applyExits(position, intents);
      if (!position.remainingQuantity) { await this.finish(position, intents, this.protectiveReason(position, intents)); return false; }
    }
    const intent = await this.intent('PROTECT', { action: 'SELL', ...this.held(position), quantity: position.remainingQuantity,
      ordertype: 'SL', triggerprice: stopPrice }, position);
    await this.submit(intent); await this.observe(intent, await this.book(true));
    if (intent.status === 'REJECTED') {
      position.status = 'UNPROTECTED'; await this.savePosition(position); this.sync(position); throw unresolved('Protective order was rejected.');
    }
    if (intent.status !== 'ACKNOWLEDGED') throw unresolved('Protection requires broker verification.');
    position.protectiveOrderId = intent.brokerOrderId; position.protectiveStopPrice = stopPrice;
    const order = (await this.book()).find(item => String(item.orderid) === intent.brokerOrderId);
    if (!order || !['open', 'trigger pending', 'pending'].includes(statusOf(order))) throw unresolved('Protective order is not confirmed active.');
    position.status = 'PROTECTED'; await this.savePosition(position); await this.persistTradeState(position); this.sync(position); return true;
  }
  held(position) {
    const snapshot = position.executionSnapshot;
    return { exchange: snapshot.exchange, tradingsymbol: snapshot.tradingsymbol, symboltoken: snapshot.symboltoken, producttype: snapshot.producttype || 'CARRYFORWARD' };
  }
  initialStop(position) {
    return position.executionSnapshot.stopLoss;
  }
  protectiveReason(position, intents = []) {
    const config = position.executionConfig;
    const filled = intents.find(intent => intent.purpose === 'PROTECT' && intent.filledQuantity > 0);
    const trigger = filled?.requestSnapshot.triggerprice ?? position.protectiveStopPrice;
    return this.runner.strategyName === 'ModifiedHeikenAshi' && config.exitStrategy === 'TRAILING_SL'
      && trigger > (position.averageEntryPrice || position.executionSnapshot.entryPrice) - (Number(config.initialSlPoints) || 30)
      ? 'Trailing SL' : 'SL';
  }
  async reconcileLocked({ freshBrokerEvidence = false } = {}) {
    let entry = this.entryIntentId && await OrderIntent.findOne({ ...this.scope(), _id: this.entryIntentId });
    if (!entry && !this.positionId && this.recoveryIntentId) {
      const pending = await OrderIntent.findOne({ ...this.scope(), _id: this.recoveryIntentId });
      if (!pending) throw unresolved('Persisted unresolved order intent disappeared during recovery.');
      const book = await this.book(true);
      await this.observe(pending, book);
      if (pending.targetIntentId) {
        const target = await OrderIntent.findOne({ ...this.scope(), _id: pending.targetIntentId });
        if (!target) throw unresolved('Cancellation target is missing during recovery.');
        await this.observe(target, book);
        if (target.filledQuantity > 0) throw unresolved('An unmanaged order fill needs verified position ownership before automated management.');
      }
      if (!terminal.has(pending.status)) throw unresolved('An order without a durable held-position link remains unresolved.');
      if (pending.filledQuantity > 0) throw unresolved('A filled order has no durable held-position snapshot; automated recovery will not guess risk settings.');
      this.recoveryIntentId = null; this.retire(); return null;
    }
    if (!entry && !this.positionId) return null;
    let position = await this.ownedPosition();
    if (position?.status === 'CLOSED') { this.complete(position, position.exitReason); return null; }
    if (entry && entry.executionMetadata.config.liveTradingConsent && !terminal.has(entry.status)) {
      await this.observe(entry, await this.book(freshBrokerEvidence));
    }
    if (entry) {
      position = await this.materialize(entry);
      if (!position) {
        if (terminal.has(entry.status)) this.clearEmptyEntry();
        else throw unresolved('BUY has no verified fill yet.');
        return null;
      }
    }
    const intents = await OrderIntent.find({ ...this.scope(), positionId: position._id });
    let liveOrders = null;
    if (position.executionSnapshot.executionMode === 'LIVE') {
      liveOrders = await this.book(freshBrokerEvidence);
      for (const intent of intents) if (!terminal.has(intent.status)) await this.observe(intent, liveOrders);
    }
    await this.applyExits(position, intents);
    if (!position.remainingQuantity) {
      const reason = intents.some(intent => intent.purpose === 'EXIT' && intent.filledQuantity > 0)
        ? position.exitReason || 'Manual' : this.protectiveReason(position, intents);
      await this.finish(position, intents, reason); return null;
    }
    const protection = intents.find(intent => intent.purpose === 'PROTECT' && !terminal.has(intent.status));
    if (position.executionSnapshot.executionMode === 'LIVE') {
      const isOpenBrokerOrder = order => order && ['open', 'trigger pending', 'pending'].includes(statusOf(order));
      const order = protection && liveOrders.find(item => String(item.orderid) === protection.brokerOrderId);
      const protectionVerified = protection?.status === 'ACKNOWLEDGED'
        && protection.requestedQuantity === position.remainingQuantity && isOpenBrokerOrder(order);
      const unresolvedProtection = intents.filter(intent => intent.purpose === 'PROTECT' && !terminal.has(intent.status))
        .some(intent => !isOpenBrokerOrder(liveOrders.find(item => String(item.orderid) === intent.brokerOrderId)));
      position.status = protectionVerified ? 'PROTECTED' : 'UNPROTECTED';
      if (intents.some(intent => ['EXIT', 'CANCEL'].includes(intent.purpose) && !terminal.has(intent.status))
        || (entry && !terminal.has(entry.status)) || unresolvedProtection) position.status = 'RECONCILIATION_REQUIRED';
      await this.savePosition(position);
    }
    await this.persistTradeState(position);
    this.sync(position);
    if (position.executionSnapshot.executionMode === 'LIVE' && !position.pendingEntryQuantity
      && !intents.some(intent => ['PROTECT', 'EXIT', 'CANCEL'].includes(intent.purpose))) {
      await this.protect(position, this.initialStop(position));
    }
    return position;
  }
  async reconcile() { return this.run(() => this.reconcileLocked()); }
  async exit(reason, paperPrice, requestedQuantity = null) {
    return this.run(() => this.exitLocked(reason, paperPrice, requestedQuantity));
  }
  async exitLocked(reason, paperPrice, requestedQuantity = null) {
      let position = await this.reconcileLocked();
      if (!position) {
        if (this.entryIntentId) throw unresolved('Unknown BUY must be reconciled before exit.');
        if (this.runner.activeTradeId) throw unresolved('Held instrument has no durable position record.');
        return;
      }
      const entry = await OrderIntent.findOne({ ...this.scope(), _id: position.entryIntentId });
      if (entry && !terminal.has(entry.status)) {
        await this.cancel(entry, position, await this.book());
        position = await this.materialize(entry);
      }
      const intents = await OrderIntent.find({ ...this.scope(), positionId: position._id });
      const pendingExit = intents.find(intent => intent.purpose === 'EXIT' && !terminal.has(intent.status));
      if (pendingExit) throw unresolved('Existing SELL is unresolved; no duplicate exit submitted.');
      if (position.executionSnapshot.executionMode === 'LIVE') {
        for (const protection of intents.filter(intent => intent.purpose === 'PROTECT' && !terminal.has(intent.status))) {
          await this.cancel(protection, position, await this.book());
        }
        await this.applyExits(position, await OrderIntent.find({ ...this.scope(), positionId: position._id }));
        if (!position.remainingQuantity) return this.finish(position, await OrderIntent.find({ ...this.scope(), positionId: position._id }), this.protectiveReason(position));
      }
      position.status = 'EXIT_PENDING'; position.exitReason = reason; await this.savePosition(position);
      const quantity = requestedQuantity ?? position.remainingQuantity;
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > position.remainingQuantity) throw unresolved('Requested exit quantity exceeds persisted exposure.');
      const partialRequested = quantity < position.remainingQuantity;
      const intent = await this.intent('EXIT', { action: 'SELL', ...this.held(position), quantity, ordertype: 'MARKET' }, position);
      if (position.executionSnapshot.executionMode === 'PAPER') {
        if (!Number.isFinite(paperPrice) || paperPrice <= 0) throw unresolved('Paper exit price is invalid.');
        intent.status = 'SUBMITTING'; await this.saveIntent(intent); intent.status = 'FILLED';
        intent.averageFillPrice = paperPrice; intent.filledQuantity = intent.requestedQuantity; intent.remainingQuantity = 0; await this.saveIntent(intent);
      } else {
        await this.submit(intent); await this.observe(intent, await this.book(true));
      }
      const all = await OrderIntent.find({ ...this.scope(), positionId: position._id });
      await this.applyExits(position, all);
      if (partialRequested && intent.status === 'FILLED' && position.remainingQuantity) {
        position.status = 'UNPROTECTED'; await this.savePosition(position); await this.protect(position, position.protectiveStopPrice || position.executionSnapshot.stopLoss);
        return intent;
      }
      if (position.remainingQuantity || all.some(item => item.purpose === 'EXIT' && !terminal.has(item.status))) throw unresolved('SELL remains open, partially filled or unknown.');
      await this.finish(position, all, reason);
      return intent;
  }
  async trailing(stopPrice) {
    return this.run(async () => {
      const position = await this.reconcileLocked();
      if (!position) return false;
      const protectedNow = await this.protect(position, stopPrice);
      if (protectedNow) { position.activeTrailingSl = stopPrice; await this.savePosition(position); this.sync(position); }
      return protectedNow;
    });
  }
  async finish(position, intents, reason) {
    if (position.remainingQuantity || position.pendingEntryQuantity || intents.some(intent => !terminal.has(intent.status))) throw unresolved('Outstanding broker orders prevent completion.');
    const quantity = position.filledExitQuantity;
    const price = position.exitEvidence.reduce((sum, item) => sum + item.price * item.quantity, 0) / quantity;
    if (!Number.isFinite(price) || price <= 0 || !quantity) throw unresolved('No verified fill evidence for closure.');
    const trade = await Trade.findOne({ ...this.scope(), _id: position.tradeId, strategyId: position.strategyId });
    if (!trade) throw unresolved('Trade persistence record is missing.');
    trade.qty = quantity; trade.buyPrice = position.averageEntryPrice || position.executionSnapshot.entryPrice;
    trade.exitPrice = price; trade.exitReason = reason; trade.pnl = (price - trade.buyPrice) * quantity;
    await executionLeases.assertCurrent(this.leaseToken);
    trade.positionState = 'CLOSED'; trade.lastBrokerSyncAt = new Date(); await trade.save();
    position.completionPending = false; position.status = 'CLOSED'; position.exitReason = reason; position.reconciliationHealth = 'HEALTHY';
    await this.savePosition(position); // Do not clear runtime ownership until both writes succeed.
    this.runner.lastCompletedTrade = trade.toObject(); this.complete(position, reason);
  }
  complete(position, reason) {
    const runner = this.runner;
    const held = position.executionSnapshot;
    // Held exposure can be smaller after partial fills/exits. Restore the
    // immutable entry configuration before the scanner admits another trade.
    runner.config = structuredClone(position.executionConfig);
    runner.releaseFeed(held.exchange, held.symboltoken, 'ONE_MINUTE', 'position');
    runner.releaseFeed(held.exchange, held.symboltoken, runner.getBaseTimeframe(), 'position');
    for (const field of ['activeTradeId', 'activeTradePremium', 'activeTradeContract', 'entryPrice', 'activeTrailingSl', 'entryOrderId', 'protectiveOrderId', 'protectiveStopPrice', 'stopLoss', 'target', 'rangeSide']) runner[field] = null;
    runner.heldWarmupCandles = null; runner.heldSide = null;
    runner.positionState = 'NONE'; runner.exitInProgress = false; runner.isExiting = false;
    runner.remainingQuantity = 0; runner.pendingEntryQuantity = 0; runner.completionPending = false;
    runner.exitTriggered = false; runner.exitReasonStored = null; runner.exitRetryCount = 0; runner.lastExitAttemptTime = 0;
    if (runner.monitorInterval) clearInterval(runner.monitorInterval); runner.monitorInterval = null;
    const minutes = runner.strategyName === '5minBreakout' ? 1 : reason === 'SL' ? 4 : ['Target', 'Trailing SL'].includes(reason) ? 2 : 0;
    runner.cooldownUntil = minutes ? Date.now() + minutes * 60000 : null;
    runner.state = !runner.isRunning ? 'STOPPED' : minutes ? 'COOLDOWN' : runner.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
  this.positionId = null; this.entryIntentId = null; this.recoveryIntentId = null; this.heldSubscription = null; this.retire();
  }
}
function forRunner(runner, dependencies) {
  if (!instances.has(runner)) instances.set(runner, new PositionExecution(runner, dependencies));
  return instances.get(runner);
}
function ownerFor(context, positionId, intentId = null) {
  return [...owners.values()].find(owner => owner.context.userId === context.userId && owner.context.brokerAccountId === context.brokerAccountId
    && owner.context.sessionId === context.sessionId && owner.context.sessionGeneration === context.sessionGeneration
    && (positionId ? String(owner.positionId) === String(positionId) : intentId && String(owner.entryIntentId) === String(intentId)));
}
module.exports = { forRunner, PositionExecution, terminal, unresolved, coordinate, ownerFor };
