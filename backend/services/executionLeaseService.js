const crypto = require('node:crypto');
const ExecutionLease = require('../models/ExecutionLease');
const Trade = require('../models/Trade');

const ownerId = `${process.pid}:${crypto.randomUUID()}`;
const LEASE_MS = 30_000;
const RENEW_MS = 5_000;
const local = new Map();
const unresolvedStates = ['PREPARED', 'SUBMITTING', 'ACKNOWLEDGED', 'UNKNOWN', 'PARTIALLY_FILLED', 'CANCEL_PENDING', 'RECONCILIATION_REQUIRED'];

function scope(context) { return { userId: context.userId, brokerAccountId: context.brokerAccountId }; }
function key(context) { return `${context.userId}:${context.brokerAccountId}`; }
function conflict(message = 'Execution ownership is unavailable; broker mutations are paused.') {
  return Object.assign(new Error(message), { status: 409, code: 'EXECUTION_LEASE_UNAVAILABLE' });
}

async function acquire(context) {
  const id = key(context);
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
  return token;
}

async function renew(token) {
  if (!token || token.ownerId !== ownerId) throw conflict();
  const now = new Date();
  const result = await ExecutionLease.updateOne({ userId: token.userId, brokerAccountId: token.brokerAccountId,
    ownerId, generation: token.generation, leaseUntil: { $gt: now } },
  { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS), heartbeatAt: now, state: 'ACTIVE' } });
  if (result.matchedCount !== 1) { local.delete(`${token.userId}:${token.brokerAccountId}`); throw conflict(); }
  const renewed = Object.freeze({ ...token, leaseUntil: new Date(now.getTime() + LEASE_MS) });
  local.set(`${token.userId}:${token.brokerAccountId}`, renewed);
  return renewed;
}

async function assertCurrent(token) {
  if (!token || token.ownerId !== ownerId || local.get(`${token.userId}:${token.brokerAccountId}`)?.generation !== token.generation) throw conflict();
  const current = await ExecutionLease.findOne({ userId: token.userId, brokerAccountId: token.brokerAccountId,
    ownerId, generation: token.generation, leaseUntil: { $gt: new Date() }, state: 'ACTIVE' }).select('_id').lean();
  if (!current) { local.delete(`${token.userId}:${token.brokerAccountId}`); throw conflict(); }
  return token;
}

async function executionContext(context) {
  let token = local.get(key(context));
  if (!token) token = await acquire(context);
  else if (token.leaseUntil.getTime() - Date.now() <= LEASE_MS - RENEW_MS) token = await renew(token);
  else await assertCurrent(token);
  return token;
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

function releaseLocal(context) { local.delete(key(context)); }
function current(context) { return local.get(key(context)) || null; }
async function releaseOwned() {
  const released = [];
  for (const [id, token] of [...local.entries()]) {
    if (token.ownerId !== ownerId) continue;
    const result = await ExecutionLease.updateOne({ userId: token.userId, brokerAccountId: token.brokerAccountId,
      ownerId, generation: token.generation, state: 'ACTIVE' },
    { $set: { ownerId: null, leaseUntil: new Date(0), state: 'IDLE' } });
    if (result.matchedCount === 1) {
      local.delete(id);
      released.push({ userId: token.userId, brokerAccountId: token.brokerAccountId, generation: token.generation });
    }
  }
  return released;
}
async function ensureIndexes() {
  const indexes = await ExecutionLease.collection.indexes();
  const valid = indexes.some(index => index.unique && index.name === 'uniq_execution_lease_per_account'
    && index.key?.userId === 1 && index.key?.brokerAccountId === 1);
  if (!valid) throw conflict('Execution lease uniqueness index is missing; account recovery is withheld.');
}

module.exports = { ownerId, LEASE_MS, acquire, renew, assertCurrent, executionContext, discoverUnresolved, releaseLocal, releaseOwned, current, ensureIndexes, unresolvedStates, conflict };
