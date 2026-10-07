const crypto = require('node:crypto');
const ExecutionLease = require('../models/ExecutionLease');
const Trade = require('../models/Trade');

const ownerId = `${process.pid}:${crypto.randomUUID()}`;
const LEASE_MS = 30_000;
const RENEW_MS = 5_000;
const local = new Map();
const renewalTimers = new Map();
const renewalRuns = new Map();
const leaseQueues = new Map();
const unresolvedStates = ['PREPARED', 'SUBMITTING', 'ACKNOWLEDGED', 'UNKNOWN', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'RECONCILIATION_REQUIRED'];

function scope(context) { return { userId: context.userId, brokerAccountId: context.brokerAccountId }; }
function key(context) { return `${context.userId}:${context.brokerAccountId}`; }
function conflict(message = 'Execution ownership is unavailable; broker mutations are paused.') {
  return Object.assign(new Error(message), { status: 409, code: 'EXECUTION_LEASE_UNAVAILABLE' });
}

function withLeaseLock(id, callback) {
  const previous = leaseQueues.get(id) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  leaseQueues.set(id, gate);
  return previous.then(callback).finally(() => {
    release();
    if (leaseQueues.get(id) === gate) leaseQueues.delete(id);
  });
}

function stopRenewal(id) {
  const timer = renewalTimers.get(id);
  if (timer) clearInterval(timer);
  renewalTimers.delete(id);
}

function startRenewal(id) {
  if (renewalTimers.has(id)) return;
  const timer = setInterval(() => {
    renewAccount(id).catch(error => {
      console.warn(`[ExecutionLease] Background renewal pass failed (${error.code || error.name || 'error'}).`);
    });
  }, RENEW_MS);
  timer.unref?.();
  renewalTimers.set(id, timer);
}

async function acquireLocked(context) {
  const id = key(context);
  const existing = local.get(id);
  if (existing && existing.leaseUntil.getTime() > Date.now()) {
    await assertCurrent(existing);
    startRenewal(id);
    return existing;
  }
  if (existing) local.delete(id);
  let lease = await ExecutionLease.findOne(scope(context)).lean();
  if (!lease) {
    try { await ExecutionLease.create({ ...scope(context), ownerId: null, generation: 0, leaseUntil: new Date(0), state: 'IDLE' }); }
    catch (error) { if (error.code !== 11000) throw error; }
  }
  const now = new Date();
  const acquired = await ExecutionLease.findOneAndUpdate({ ...scope(context), $or: [
    { ownerId }, { ownerId: null }, { leaseUntil: { $lte: now } },
  ] }, { $set: { ownerId, leaseUntil: new Date(now.getTime() + LEASE_MS), state: 'ACTIVE', heartbeatAt: now }, $inc: { generation: 1 } },
  { returnDocument: 'after', runValidators: true }).lean();
  if (!acquired) throw conflict('Another process currently owns this broker account execution lease.');
  const token = Object.freeze({ userId: String(context.userId), brokerAccountId: String(context.brokerAccountId), ownerId,
    generation: acquired.generation, leaseUntil: acquired.leaseUntil });
  local.set(id, token);
  startRenewal(id);
  return token;
}

async function acquire(context) {
  const id = key(context);
  return withLeaseLock(id, () => acquireLocked(context));
}

async function renewLocked(token) {
  if (!token || token.ownerId !== ownerId) throw conflict();
  const id = `${token.userId}:${token.brokerAccountId}`;
  if (local.get(id)?.generation !== token.generation) throw conflict();
  const now = new Date();
  const result = await ExecutionLease.updateOne({ userId: token.userId, brokerAccountId: token.brokerAccountId,
    ownerId, generation: token.generation, leaseUntil: { $gt: now } },
  { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS), heartbeatAt: now, state: 'ACTIVE' } });
  if (result.matchedCount !== 1) {
    local.delete(`${token.userId}:${token.brokerAccountId}`);
    throw conflict();
  }
  const renewed = Object.freeze({ ...token, leaseUntil: new Date(now.getTime() + LEASE_MS) });
  local.set(`${token.userId}:${token.brokerAccountId}`, renewed);
  return renewed;
}

async function renew(token) {
  if (!token) throw conflict();
  const id = `${token.userId}:${token.brokerAccountId}`;
  return withLeaseLock(id, () => renewLocked(token));
}

async function assertCurrent(token) {
  if (!token || token.ownerId !== ownerId || local.get(`${token.userId}:${token.brokerAccountId}`)?.generation !== token.generation) throw conflict();
  const current = await ExecutionLease.findOne({ userId: token.userId, brokerAccountId: token.brokerAccountId,
    ownerId, generation: token.generation, leaseUntil: { $gt: new Date() }, state: 'ACTIVE' }).select('_id').lean();
  if (!current) { local.delete(`${token.userId}:${token.brokerAccountId}`); throw conflict(); }
  return token;
}

async function executionContext(context) {
  const id = key(context);
  return withLeaseLock(id, async () => {
    let token = local.get(id);
    if (!token || token.leaseUntil.getTime() <= Date.now()) {
      if (token) local.delete(id);
      return acquireLocked(context);
    }
    if (token.leaseUntil.getTime() - Date.now() <= LEASE_MS - RENEW_MS) {
      try { return await renewLocked(token); }
      catch (error) {
        // A failed CAS means this token is no longer usable. Reacquisition is
        // safe only through the durable lease predicate; a live other owner
        // still blocks this call. Database/transport errors propagate as-is.
        if (error.code !== 'EXECUTION_LEASE_UNAVAILABLE' || local.has(id)) throw error;
        return acquireLocked(context);
      }
    }
    await assertCurrent(token);
    return token;
  });
}

async function renewDueLeases() {
  return (await Promise.all([...renewalTimers.keys()].map(renewAccount))).filter(Boolean);
}

function renewAccount(id) {
  if (renewalRuns.has(id)) return renewalRuns.get(id);
  const pass = withLeaseLock(id, async () => {
      const token = local.get(id);
      if (!token) { stopRenewal(id); return; }
      const remainingMs = token.leaseUntil.getTime() - Date.now();
      if (remainingMs > LEASE_MS - RENEW_MS) return;
      try {
        const renewed = await renewLocked(token);
        return { brokerAccountId: token.brokerAccountId, renewed: true, generation: renewed.generation };
      } catch (error) {
        // Do not claim a renewal after a database failure. Keep the timer while
        // the lease may still be valid so a transient outage can recover; the
        // request path remains fenced by assertCurrent and lease expiry.
        if (error.code === 'EXECUTION_LEASE_UNAVAILABLE' && !local.has(id)) stopRenewal(id);
        console.warn(`[ExecutionLease] Renewal failed for active account (${error.code || error.name || 'error'}).`);
        return { brokerAccountId: token.brokerAccountId, renewed: false, code: error.code || error.name || 'error' };
      }
    }).finally(() => { if (renewalRuns.get(id) === pass) renewalRuns.delete(id); });
  renewalRuns.set(id, pass);
  return pass;
}

async function discoverUnresolved() {
  const Position = require('../models/Position');
  const OrderIntent = require('../models/OrderIntent');
  const [positions, intents, trades] = await Promise.all([
    Position.find({ status: { $ne: 'CLOSED' } }).select('userId brokerAccountId strategyId status').lean(),
    OrderIntent.find({ $or: [
      { status: { $in: unresolvedStates } },
      { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
    ] }).select('userId brokerAccountId strategyId status').lean(),
    Trade.find({ exitPrice: { $exists: false }, executionMode: 'LIVE' }).select('userId brokerAccountId strategyId').lean(),
  ]);
  const accounts = new Map();
  const unscoped = [...positions, ...intents, ...trades].filter(item => !item.userId || !item.brokerAccountId || !item.strategyId).length;
  for (const item of [...positions, ...intents, ...trades]) {
    if (!item.userId || !item.brokerAccountId || !item.strategyId) continue;
    const id = `${item.userId}:${item.brokerAccountId}`;
    const row = accounts.get(id) || { userId: String(item.userId), brokerAccountId: String(item.brokerAccountId), strategyIds: new Set() };
    row.strategyIds.add(String(item.strategyId)); accounts.set(id, row);
  }
  const results = [...accounts.values()].map(item => ({ ...item, strategyIds: [...item.strategyIds] }));
  Object.defineProperty(results, 'unscopedCount', { value: unscoped, enumerable: false });
  return results;
}

function releaseLocal(context) {
  const id = key(context);
  local.delete(id);
  stopRenewal(id);
}
function current(context) { return local.get(key(context)) || null; }
async function releaseOwned() {
  const released = [];
  for (const id of [...local.keys()]) {
    await withLeaseLock(id, async () => {
    const token = local.get(id);
    if (!token || token.ownerId !== ownerId) return;
    const result = await ExecutionLease.updateOne({ userId: token.userId, brokerAccountId: token.brokerAccountId,
      ownerId, generation: token.generation, state: 'ACTIVE' },
    { $set: { ownerId: null, leaseUntil: new Date(0), state: 'IDLE' } });
    if (result.matchedCount === 1) {
      local.delete(id);
      stopRenewal(id);
      released.push({ userId: token.userId, brokerAccountId: token.brokerAccountId, generation: token.generation });
    } else {
      local.delete(id);
      stopRenewal(id);
    }
    });
  }
  return released;
}
async function ensureIndexes() {
  const indexes = await ExecutionLease.collection.indexes();
  const valid = indexes.some(index => index.unique && index.name === 'uniq_execution_lease_per_account'
    && index.key?.userId === 1 && index.key?.brokerAccountId === 1);
  if (!valid) throw conflict('Execution lease uniqueness index is missing; account recovery is withheld.');
}

module.exports = { ownerId, LEASE_MS, RENEW_MS, acquire, renew, renewDueLeases, assertCurrent, executionContext, discoverUnresolved, releaseLocal, releaseOwned, current, ensureIndexes, unresolvedStates, conflict };
