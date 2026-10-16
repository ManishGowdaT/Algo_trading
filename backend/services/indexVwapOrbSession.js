const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Session = require('../models/StrategySession');
const OrderIntent = require('../models/OrderIntent');
const Position = require('../models/Position');
const accounts = require('./accountContext');
const leases = require('./executionLeaseService');
const availability = require('./indexVwapOrbAvailability');
const { validate } = require('../utils/indexVwapOrbConfig');
const { sessionBounds } = require('./underlyingCandleStream');
const { RULE_VERSION } = require('../trading/strategies/indexVwapOrb');
const terminal = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'FAILED']);
function blocked(code) { return Object.assign(new Error(code), { status: 409, code }); }
function id(text) { return new mongoose.Types.ObjectId(crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)); }
const scope = (context, strategyId) => ({ userId: context.userId, brokerAccountId: context.brokerAccountId, strategyId });

async function guarded(context, callback) {
  accounts.assertVerified(context);
  return accounts.exclusive(`index-orb-session:${context.userId}:${context.brokerAccountId}`, async () => {
    await accounts.validate(context);
    await availability.assertEnabled(context);
    const lease = await leases.executionContext(context);
    await leases.assertCurrent(lease);
    const strategy = await availability.ensureStrategy(context.userId);
    return callback(strategy, lease);
  });
}
async function indexes() {
  const installed = await Session.collection.indexes();
  if (!installed.some(index => index.name === 'uniq_strategy_session_ist_date' && index.unique
    && index.key.userId === 1 && index.key.brokerAccountId === 1 && index.key.strategyId === 1 && index.key.istDate === 1)) {
    throw blocked('STRATEGY_SESSION_INDEX_MISSING');
  }
}
async function getDay(context, strategyId, now) {
  const istDate = sessionBounds(now).date;
  const query = { ...scope(context, strategyId), istDate };
  let row = await Session.findOne(query).lean();
  if (!row) {
    try { row = (await Session.create({ ...query, _id: id(`${context.userId}:${context.brokerAccountId}:${strategyId}:${istDate}`), ruleVersion: RULE_VERSION })).toObject(); }
    catch (error) { if (error.code !== 11000) throw error; row = await Session.findOne(query).lean(); }
  }
  if (!row) throw blocked('STRATEGY_SESSION_UNAVAILABLE');
  return row;
}
async function save(context, lease, row, changes) {
  await accounts.validate(context); await leases.assertCurrent(lease);
  if ((row.executionOwnerGeneration || 0) > lease.generation) throw blocked('STRATEGY_SESSION_FENCED');
  const updated = await Session.findOneAndUpdate({ ...scope(context, row.strategyId), _id: row._id, version: row.version ?? 0 },
    { $set: { ...changes, executionOwnerGeneration: lease.generation }, $inc: { version: 1 } }, { returnDocument: 'after', runValidators: true }).lean();
  if (!updated) throw blocked('STRATEGY_SESSION_VERSION_CONFLICT');
  return updated;
}
async function reconcileRow(context, lease, row) {
  let changed = false; let activeIntentId = row.activeIntentId;
  const entries = structuredClone(row.entries.map(entry => ({ ...entry, intentId: String(entry.intentId) })));
  for (const entry of entries) {
    const intent = await OrderIntent.findOne({ ...scope(context, row.strategyId), _id: entry.intentId, purpose: 'ENTRY' }).lean();
    if (!intent) continue; // Orphan reservation is durable and withheld, never silently freed.
    if (intent.executionMetadata?.strategySessionId !== String(row._id)
      || intent.executionMetadata?.signal?.signalId !== entry.signalId) throw blocked('ENTRY_RESERVATION_IDENTITY_MISMATCH');
    if (!Number.isSafeInteger(intent.filledQuantity) || !Number.isSafeInteger(intent.requestedQuantity)
      || intent.filledQuantity > intent.requestedQuantity || intent.filledQuantity < (entry.filledQuantity || 0)) throw blocked('CONFLICTING_ENTRY_FILL_EVIDENCE');
    if (intent.filledQuantity > 0 && entry.state !== 'COUNTED') {
      if (entry.state === 'RELEASED') throw blocked('LATE_FILL_AFTER_RELEASE_REQUIRES_RECONCILIATION');
      entry.state = 'COUNTED'; changed = true;
    }
    if (entry.filledQuantity !== intent.filledQuantity) { entry.filledQuantity = intent.filledQuantity; changed = true; }
    const confirmedUnfilled = ['CANCELLED', 'REJECTED'].includes(intent.status)
      || (intent.status === 'FAILED' && intent.attemptCount === 0 && !intent.submittedAt && !intent.brokerOrderId);
    if (confirmedUnfilled && intent.filledQuantity === 0 && intent.remainingQuantity === 0) {
      if (entry.state !== 'RELEASED') { entry.state = 'RELEASED'; changed = true; }
      if (String(activeIntentId) === String(entry.intentId)) { activeIntentId = null; changed = true; }
    } else if (intent.filledQuantity > 0 && terminal.has(intent.status) && intent.remainingQuantity === 0) {
      const position = await Position.findOne({ ...scope(context, row.strategyId), entryIntentId: intent._id,
        status: 'CLOSED', remainingQuantity: 0 }).lean();
      if (position && String(activeIntentId) === String(entry.intentId)) { activeIntentId = null; changed = true; }
    }
  }
  const entriesFilled = entries.filter(entry => entry.state === 'COUNTED').length;
  if (entriesFilled > 2) throw blocked('DAILY_ENTRY_LEDGER_CONFLICT');
  return changed || row.entriesFilled !== entriesFilled ? save(context, lease, row, { entries, entriesFilled, activeIntentId }) : row;
}
async function restoreLocked(context, strategy, lease, now) {
  await indexes();
  const rows = await Session.find(scope(context, strategy._id)).lean();
  for (const row of rows) await reconcileRow(context, lease, row);
  const day = await getDay(context, strategy._id, now);
  const unresolvedDay = await Session.findOne({ ...scope(context, strategy._id), activeIntentId: { $ne: null } }).lean();
  const exposure = await Position.findOne({ ...scope(context, strategy._id), status: { $ne: 'CLOSED' } }).lean();
  const pending = await OrderIntent.findOne({ ...scope(context, strategy._id), purpose: 'ENTRY', $or: [
    { status: { $nin: [...terminal] } }, { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
  ] }).lean();
  return { day, blocked: Boolean(unresolvedDay || exposure || pending), consumedSetupIds: day.entries.map(entry => entry.setupId),
    entriesFilled: day.entriesFilled, entriesReserved: day.entries.filter(e => ['RESERVED', 'INTENT_PREPARED'].includes(e.state)).length };
}
async function restore(context, now = Date.now()) {
  return guarded(context, (strategy, lease) => restoreLocked(context, strategy, lease, now));
}
async function checkpoint(context, underlying, data, now = Date.now()) {
  return guarded(context, async (strategy, lease) => {
    await availability.assertEnabled(context);
    if (!['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(underlying) || !Number.isFinite(data.asOf)) throw blocked('INVALID_CHECKPOINT');
    const row = await getDay(context, strategy._id, now);
    if (sessionBounds(data.asOf).date !== row.istDate || data.asOf < (row.checkpoints?.[underlying]?.asOf ?? 0)
      || (data.processedClose !== undefined && (!Number.isFinite(data.processedClose)
        || data.processedClose < (row.checkpoints?.[underlying]?.processedClose ?? 0)))) throw blocked('STALE_CHECKPOINT');
    return save(context, lease, row, { checkpoints: { ...row.checkpoints, [underlying]: structuredClone(data) } });
  });
}
async function prepareEntry(context, { signal, config, contract, now = Date.now() }) {
  const requestedAt = Date.now();
  return guarded(context, async (strategy, lease) => {
    await availability.assertEnabled(context);
    config = validate(config);
    now += Math.max(0, Date.now() - requestedAt);
    const validatedAt = Date.now();
    if (config.liveTradingConsent) await availability.assertLiveExecution(context);
    const { open, date } = sessionBounds(now); const cutoff = open + 135 * 60000;
    if (!signal?.isEntry || signal.strategyId !== availability.NAME || signal.ruleVersion !== RULE_VERSION
      || signal.underlying !== config.underlying || !['LONG', 'SHORT'].includes(signal.direction)
      || typeof signal.setupId !== 'string' || typeof signal.signalId !== 'string'
      || !Number.isFinite(signal.signalClosedAt) || signal.signalClosedAt > now || now - signal.signalClosedAt > 5000
      || sessionBounds(signal.signalClosedAt).date !== date || now > cutoff) throw blocked('INVALID_OR_EXPIRED_ENTRY_SIGNAL');
    const risk = signal.direction === 'LONG' ? signal.entryPrice - signal.stopLoss : signal.stopLoss - signal.entryPrice;
    const target = signal.entryPrice + (signal.direction === 'LONG' ? 2 : -2) * risk;
    if (![signal.entryPrice, signal.stopLoss, signal.takeProfit, signal.riskPoints].every(n => Number.isFinite(n) && n > 0)
      || Math.abs(risk - signal.riskPoints) > 1e-8 || Math.abs(target - signal.takeProfit) > 1e-8) throw blocked('INVALID_SIGNAL_RISK');
    const lot = contract?.lotsize ?? contract?.lot_size ?? contract?.lotSize;
    if (!Number.isSafeInteger(lot) || lot <= 0 || config.quantity % lot !== 0
      || contract.underlying !== config.underlying || typeof contract.expiry !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(contract.expiry) || !Number.isFinite(Date.parse(`${contract.expiry}T00:00:00Z`))
      || contract.expiry < date || !Number.isFinite(contract.strike) || contract.strike <= 0
      || contract.exchange !== (config.underlying === 'SENSEX' ? 'BFO' : 'NFO')
      || contract.option_type !== (signal.direction === 'LONG' ? 'CE' : 'PE')
      || !contract.symboltoken || !contract.tradingsymbol) throw blocked('INVALID_RESOLVED_OPTION_CONTRACT');
    const intentIndexes = await OrderIntent.collection.indexes();
    if (!intentIndexes.some(index => index.name === 'uniq_unresolved_entry_per_strategy' && index.unique)) throw blocked('ENTRY_UNIQUENESS_INDEX_MISSING');
    const restored = await restoreLocked(context, strategy, lease, now);
    const row = restored.day;
    if (row.entries.some(entry => entry.signalId === signal.signalId || entry.setupId === signal.setupId)) throw blocked('DUPLICATE_ENTRY_SIGNAL');
    if (restored.blocked) throw blocked('ENTRY_OR_EXPOSURE_UNRESOLVED');
    if (restored.entriesFilled + restored.entriesReserved >= 2) throw blocked('DAILY_ENTRY_LIMIT');
    if (row.entries.length >= 64) throw blocked('DAILY_ATTEMPT_LIMIT');
    const admissionNow = now + Math.max(0, Date.now() - validatedAt);
    if (admissionNow > cutoff || admissionNow - signal.signalClosedAt > 5000) throw blocked('INVALID_OR_EXPIRED_ENTRY_SIGNAL');
    const intentId = id(`${context.userId}:${context.brokerAccountId}:${signal.signalId}`);
    const request = { action: 'BUY', exchange: contract.exchange, symboltoken: String(contract.symboltoken),
      tradingsymbol: contract.tradingsymbol, quantity: config.quantity, ordertype: 'MARKET', producttype: 'CARRYFORWARD' };
    const metadata = { strategyName: availability.NAME, config, signal: structuredClone(signal), ruleVersion: RULE_VERSION,
      strategySessionId: String(row._id), executionReadiness: 'REFERENCE_RISK',
      referenceRisk: require('./referenceRisk').snapshotFromSignal(signal, contract),
      trendSide: signal.direction === 'LONG' ? 'BULLISH' : 'BEARISH' };
    const reservation = { signalId: signal.signalId, setupId: signal.setupId, underlying: config.underlying, intentId,
      state: 'RESERVED', filledQuantity: 0, request, metadata, reservedAt: new Date(now) };
    const reserved = await save(context, lease, row, { entries: [...row.entries, reservation], activeIntentId: intentId });
    // Entire admission/request is already durable in one CAS above. A crash here leaves
    // a held reservation. No broker transport is allowed from this service.
    await leases.assertCurrent(lease); await accounts.validate(context);
    const intent = await OrderIntent.create({ _id: intentId, ...scope(context, strategy._id),
      idempotencyKey: crypto.createHash('sha256').update(signal.signalId).digest('hex'), purpose: 'ENTRY',
      requestSnapshot: request, requestedQuantity: config.quantity, remainingQuantity: config.quantity,
      executionMetadata: metadata, resultTradeId: new mongoose.Types.ObjectId(), resultPositionId: new mongoose.Types.ObjectId(),
      sessionGeneration: context.sessionGeneration, ownerGeneration: context.ownerGeneration,
      executionOwnerId: lease.ownerId, executionOwnerGeneration: lease.generation });
    await save(context, lease, reserved, { entries: reserved.entries.map(entry => String(entry.intentId) === String(intentId)
      ? { ...entry, state: 'INTENT_PREPARED' } : entry) });
    return intent;
  });
}
module.exports = { prepareEntry, restore, checkpoint, indexes };
