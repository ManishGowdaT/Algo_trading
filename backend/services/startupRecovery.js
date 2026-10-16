const Position = require('../models/Position');
const OrderIntent = require('../models/OrderIntent');
const Strategy = require('../models/Strategy');
const Trade = require('../models/Trade');
const ExecutionLease = require('../models/ExecutionLease');
const activeAccounts = require('./activeAccountService');
const accounts = require('./accountContext');
const leases = require('./executionLeaseService');
const marketData = require('./marketDataService');

const states = new Map();
let databaseReady = false;
let scanPromise = null;
let globalGateMessage = '';
function key(userId, brokerAccountId) { return `${String(userId)}:${String(brokerAccountId)}`; }
function setState(userId, brokerAccountId, status, message = '') {
  const row = { userId: String(userId), brokerAccountId: String(brokerAccountId), status, message, updatedAt: new Date().toISOString() };
  states.set(key(userId, brokerAccountId), row); return { ...row };
}
function getState(userId, brokerAccountId) { const state = states.get(key(userId, brokerAccountId)); return state ? { ...state } : { status: 'READY', message: '' }; }

async function scanDatabase() {
  const unresolved = await leases.discoverUnresolved();
  globalGateMessage = unresolved.unscopedCount
    ? `${unresolved.unscopedCount} unresolved record(s) lack verified user/account ownership; operator reconciliation is required.` : '';
  if (globalGateMessage) console.error(`[StartupRecovery] Global execution gate: ${globalGateMessage}`);
  for (const account of unresolved) {
    const contextState = activeAccounts.getActiveAccount(account.userId, account.brokerAccountId);
    setState(account.userId, account.brokerAccountId, contextState ? 'RECOVERING' : 'WAITING_FOR_BROKER_SESSION',
      contextState ? 'Reconciling persisted exposure before execution is allowed.' : 'Reconnect this broker account to reconcile persisted exposure.');
  }
  const known = new Set(unresolved.map(item => key(item.userId, item.brokerAccountId)));
  for (const [id, state] of states) {
    if (!known.has(id) && ['WAITING_FOR_BROKER_SESSION', 'RECOVERING'].includes(state.status)) states.delete(id);
  }
  databaseReady = true;
  // Any active session after Mongo restoration gets a fresh account-scoped
  // discovery and reconciliation pass. Fail closed per account.
  const connected = activeAccounts.listActiveAccounts();
  await Promise.allSettled(connected.map(async item => {
    if (known.has(key(item.userId, item.brokerAccountId))) {
      const context = await accounts.resolve(item.userId, item.brokerAccountId);
      await recoverAccount(context);
    }
  }));
  return unresolved.length;
}

async function initialize() {
  await ExecutionLease.createIndexes();
  await leases.ensureIndexes();
  await scanDatabase();
  return true;
}

async function recoverAccount(context) {
  context = accounts.assertVerified(context);
  const accountKey = key(context.userId, context.brokerAccountId);
  if (!databaseReady) throw Object.assign(new Error('Database recovery scan is not complete.'), { status: 503, code: 'RECOVERY_NOT_READY' });
  setState(context.userId, context.brokerAccountId, 'RECOVERING', 'Reconciling broker orders, fills and protection.');
  try {
    await accounts.validate(context);
    const scope = { userId: context.userId, brokerAccountId: context.brokerAccountId };
    const [positions, intents, legacyTrades] = await Promise.all([
      Position.find({ ...scope, status: { $ne: 'CLOSED' } }).select('strategyId').lean(),
      OrderIntent.find({ ...scope, $or: [
        { status: { $in: leases.unresolvedStates } },
        { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
      ] }).select('strategyId').lean(),
      Trade.find({ ...scope, executionMode: 'LIVE', exitPrice: { $exists: false } }).select('strategyId').lean(),
    ]);
    const strategyIds = [...new Set([...positions, ...intents, ...legacyTrades].map(row => String(row.strategyId)).filter(Boolean))];
    if (!strategyIds.length) { states.delete(accountKey); return { status: 'READY', recovered: 0 }; }
    // Strategy is app-user scoped (not broker-account scoped); enforce the
    // exact user and prove each discovered ID belongs to that same user.
    const strategyDocs = await Strategy.find({ userId: context.userId, _id: { $in: strategyIds } }).select('_id name internalExecutionOnly').lean();
    if (strategyDocs.length !== strategyIds.length) throw new Error('Persisted exposure references a missing or foreign strategy; ownership was not guessed.');
    const engine = require('./strategyEngine');
    let recovered = 0;
    for (const strategy of strategyDocs) {
      let runner = engine.getRunner(`${context.userId}_${strategy.name}`);
      if (runner.accountContext && (runner.accountContext.brokerAccountId !== context.brokerAccountId
        || runner.accountContext.sessionId !== context.sessionId
        || runner.accountContext.sessionGeneration !== context.sessionGeneration)) {
        if (runner.isRunning) runner.stop();
        require('./positionExecution').forRunner(runner, { feed: marketData }).suspendForRecovery();
        runner = engine.replaceForRecovery(context.userId, strategy.name);
      }
      runner.userId = context.userId; runner.accountContext = context; runner.isRunning = false; runner.feedScanReady = false;
      const position = await Position.findOne({ ...scope, strategyId: strategy._id, status: { $ne: 'CLOSED' } }).lean();
      const intent = await OrderIntent.findOne({ ...scope, strategyId: strategy._id, $or: [
        { status: { $in: leases.unresolvedStates } },
        { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
      ] }).sort({ createdAt: -1 }).lean();
      const snapshotConfig = position?.executionConfig || intent?.executionMetadata?.config;
      if (position) {
        const snapshot = position.executionSnapshot;
        if (!snapshot || !position.executionConfig
          || !Number.isFinite(snapshot.quantity) || snapshot.quantity < 1
          || !Number.isFinite(snapshot.entryPrice) || snapshot.entryPrice <= 0
          || (!snapshot.referenceRisk && (!Number.isFinite(snapshot.stopLoss) || snapshot.stopLoss <= 0
            || !Number.isFinite(snapshot.target) || snapshot.target <= 0))
          || !snapshot.exchange || !snapshot.tradingsymbol || !snapshot.symboltoken
          || !['PAPER', 'LIVE'].includes(snapshot.executionMode)) {
          throw new Error('Persisted position snapshot is incomplete; recovery will not guess instrument, mode, quantity, or risk thresholds.');
        }
        if (snapshot.referenceRisk) require('./referenceRisk').reason(snapshot, null, snapshot.referenceRisk.squareOffAt);
      }
      if (snapshotConfig) runner.config = structuredClone(snapshotConfig);
      const execution = require('./positionExecution').forRunner(runner, { feed: marketData });
      const resumeResult = await execution.resume();
      if (['RECONCILIATION_REQUIRED', 'EXIT_PENDING', 'UNPROTECTED'].includes(resumeResult?.status)
        && !(position?.executionSnapshot.referenceRisk && resumeResult?.status === 'UNPROTECTED')) {
        throw new Error(`Recovered position is ${resumeResult.status}; broker execution authority remains withheld until reconciliation and protection are verified.`);
      }
      const recoveredPosition = await Position.findOne({ ...scope, strategyId: strategy._id, status: { $ne: 'CLOSED' } }).lean();
      if (recoveredPosition) {
        // The persisted thresholds are authoritative on restart. Strategy
        // calculations remain untouched for ordinary new entries.
        runner.stopLoss = recoveredPosition.executionSnapshot.referenceRisk?.stop ?? recoveredPosition.executionSnapshot.stopLoss;
        runner.target = recoveredPosition.executionSnapshot.referenceRisk?.target ?? recoveredPosition.executionSnapshot.target;
        runner.activeTrailingSl = recoveredPosition.activeTrailingSl ?? null;
        runner.protectiveOrderId = recoveredPosition.protectiveOrderId || null;
        runner.protectiveStopPrice = recoveredPosition.protectiveStopPrice ?? null;
        // The broker session and order reconciliation succeeded above. Recovery
        // runners do not call start(), so restore the broker-ready gate here.
        runner.brokerReady = true;
        // Restore the existing held-candle exit evaluator without enabling
        // discovery, scanner timers or new entries.
        await accounts.run(context, async () => {
          await marketData.ensureReady();
          if (!recoveredPosition.executionSnapshot.referenceRisk) await runner.startScanLoop();
        });
      }
      // Recovery never starts scanner timers or permits fresh entries.
      runner.isRunning = false;
      runner.feedScanReady = false;
      recovered += 1;
    }
    const standalone = await OrderIntent.findOne({ userId: context.userId, brokerAccountId: context.brokerAccountId,
      positionId: { $exists: false }, $or: [
        { status: { $in: leases.unresolvedStates } }, { filledQuantity: { $gt: 0 } },
      ] }).select('_id').lean();
    if (standalone) throw new Error('Standalone order exposure remains unresolved; recovery cannot become READY.');
    states.delete(accountKey);
    console.log(`[StartupRecovery] Account ${context.brokerAccountId} reconciled ${recovered} strategy manager(s); entries remain stopped.`);
    return { status: 'READY', recovered };
  } catch (error) {
    setState(context.userId, context.brokerAccountId, 'DEGRADED', error.message || 'Recovery could not be verified.');
    console.error(`[StartupRecovery] Account ${context.brokerAccountId} recovery withheld: ${error.message}`);
    throw error;
  }
}

async function assertStrategyStartAllowed(context) {
  if (!databaseReady) throw Object.assign(new Error('Database recovery is not ready; strategy start is withheld.'), { status: 503, code: 'RECOVERY_NOT_READY' });
  if (globalGateMessage) throw Object.assign(new Error(globalGateMessage), { status: 409, code: 'RECOVERY_REQUIRED' });
  const state = getState(context.userId, context.brokerAccountId);
  if (state.status === 'WAITING_FOR_BROKER_SESSION') throw Object.assign(new Error('Reconnect this account to reconcile existing orders or positions before starting a strategy.'), { status: 409, code: 'RECOVERY_SESSION_REQUIRED' });
  if (state.status !== 'READY') throw Object.assign(new Error(state.message || 'Account recovery is incomplete; strategy start is withheld.'), { status: 409, code: 'RECOVERY_REQUIRED' });
}

async function assertExecutionAllowed(context, { recoverDegraded = true } = {}) {
  if (!databaseReady) throw Object.assign(new Error('Database recovery is not ready; broker mutations are withheld.'), { status: 503, code: 'RECOVERY_NOT_READY' });
  if (globalGateMessage) throw Object.assign(new Error(globalGateMessage), { status: 409, code: 'RECOVERY_REQUIRED' });
  let state = getState(context.userId, context.brokerAccountId);
  if (state.status === 'DEGRADED' && recoverDegraded) {
    try { await recoverAccount(context); } catch { /* Keep the account fenced and report the scoped degraded state below. */ }
    state = getState(context.userId, context.brokerAccountId);
  }
  if (state.status !== 'READY') throw Object.assign(new Error(state.message || 'Account recovery is incomplete; broker mutations are withheld.'), { status: 409, code: 'RECOVERY_REQUIRED' });
}

function databaseRestored() {
  if (scanPromise) return scanPromise;
  scanPromise = scanDatabase().catch(error => { databaseReady = false; console.error(`[StartupRecovery] Database rescan failed: ${error.message}`); })
    .finally(() => { scanPromise = null; });
  return scanPromise;
}
function databaseUnavailable() { databaseReady = false; }
function listStates() { return [...states.entries()].map(([id, state]) => [id.split(':')[0], id.split(':').slice(1).join(':'), { ...state }]); }

module.exports = { initialize, recoverAccount, assertStrategyStartAllowed, assertExecutionAllowed, getState, listStates, databaseRestored, databaseUnavailable };
