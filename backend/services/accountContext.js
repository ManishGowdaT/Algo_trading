const { AsyncLocalStorage } = require('node:async_hooks');
const BrokerAccount = require('../models/BrokerAccount');
const activeAccount = require('./activeAccountService');

const storage = new AsyncLocalStorage();
const verified = new WeakSet();
const queues = new Map();
function denied(message = 'Broker account is unavailable for this user.', status = 409) {
  return Object.assign(new Error(message), { status, code: 'BROKER_CONTEXT_REQUIRED' });
}
function mint(record, sessionId = null, connecting = false) {
  const context = Object.freeze({ userId: String(record.userId), brokerAccountId: String(record._id),
    brokerClientIdentity: record.brokerClientId, sessionGeneration: record.sessionGeneration,
    ownerGeneration: record.ownerGeneration, sessionId, connecting });
  verified.add(context);
  return context;
}
function assertVerified(context) {
  if (!context || !verified.has(context)) throw denied();
  return context;
}
async function owned(userId, selector) {
  if (!userId) throw denied('Authentication required.', 401);
  if (selector && !/^[a-f\d]{24}$/i.test(String(selector))) throw denied('Broker account not found.', 404);
  const record = await BrokerAccount.findOne({ userId, broker: 'ANGEL_ONE', ...(selector ? { _id: selector } : {}) }).lean();
  if (!record || record.status === 'DISABLED') throw denied('Broker account not found.', 404);
  return record;
}
async function resolve(userId, selector) {
  const record = await owned(userId, selector);
  activeAccount.assertActiveUser(userId, record._id);
  const active = activeAccount.getActiveAccount(userId, record._id);
  if (!active || active.sessionGeneration !== record.sessionGeneration
    || active.ownerGeneration !== record.ownerGeneration || !active.sessionId) throw denied();
  return mint(record, active.sessionId);
}
async function validate(context) {
  assertVerified(context);
  const record = await owned(context.userId, context.brokerAccountId);
  const expectedGeneration = context.connecting ? context.sessionGeneration - 1 : context.sessionGeneration;
  if (record.brokerClientId !== context.brokerClientIdentity || record.sessionGeneration !== expectedGeneration
    || record.ownerGeneration !== context.ownerGeneration) throw denied('Stale broker account context.');
  if (context.connecting && record.status !== 'CONNECTING') throw denied('Broker connection reservation is unavailable.');
  if (!context.connecting) {
    const active = activeAccount.getActiveAccount(context.userId, context.brokerAccountId);
    if (!active || active.userId !== context.userId || active.brokerAccountId !== context.brokerAccountId
      || active.sessionId !== context.sessionId || active.sessionGeneration !== context.sessionGeneration) throw denied();
  }
  return context;
}
function run(context, callback) { assertVerified(context); return storage.run(context, callback); }
function current() { return assertVerified(storage.getStore()); }
function optional() { return storage.getStore(); }
async function exclusive(key, callback) {
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  queues.set(key, gate);
  await previous;
  try { return await callback(); } finally { release(); if (queues.get(key) === gate) queues.delete(key); }
}
async function middleware(req, res, next) {
  try {
    const context = await resolve(req.user._id, selector(req));
    req.accountContext = context;
    run(context, next);
  } catch (err) { next(err); }
}
async function readMiddleware(req, res, next) {
  try {
    const record = await owned(req.user._id, selector(req));
    const context = mint(record);
    req.accountContext = context;
    run(context, next);
  } catch (err) { next(err); }
}
function selector(req) {
  const body = req.body?.brokerAccountId;
  const query = req.query?.brokerAccountId;
  if (body && query && String(body) !== String(query)) throw denied('Conflicting broker account selectors.', 403);
  return body || query;
}
function assertAdmission(userId, clientId) {
  // Python broker execution is account isolated in Phase 3. Shared market
  // feed admission remains gated separately until Phase 4.
  return { userId: String(userId), clientId };
}
function retainAdmission(context) {
  assertVerified(context);
  return context;
}
async function assertNoForeignExposure(userId) {
  const Trade = require('../models/Trade');
  const Position = require('../models/Position');
  const OrderIntent = require('../models/OrderIntent');
  const [trade, position, intent] = await Promise.all([
    Trade.findOne({ userId: { $ne: userId }, executionMode: { $ne: 'PAPER' }, exitPrice: { $exists: false } }).select('_id').lean(),
    Position.findOne({ userId: { $ne: userId }, status: { $ne: 'CLOSED' } }).select('_id').lean(),
    OrderIntent.findOne({ userId: { $ne: userId }, status: { $nin: ['FILLED', 'CANCELLED', 'REJECTED', 'FAILED'] } }).select('_id').lean(),
  ]);
  if (trade || position || intent) throw denied('Another account has unresolved exposure or order intents. Singleton admission is blocked.');
}
async function verifyOwnershipIndexes() {
  const indexes = await BrokerAccount.collection.indexes();
  for (const keys of [['userId', 'broker'], ['broker', 'brokerClientId']]) {
    if (!indexes.some(index => index.unique === true && JSON.stringify(Object.keys(index.key)) === JSON.stringify(keys)
      && Object.values(index.key).every(value => value === 1) && !index.partialFilterExpression && !index.sparse)) {
      throw denied('Broker ownership indexes must be installed and audited before connection.');
    }
  }
}
module.exports = { resolve, owned, validate, mint, assertVerified, run, current, optional, exclusive, middleware, readMiddleware, denied, assertNoForeignExposure, verifyOwnershipIndexes, selector, assertAdmission, retainAdmission };
