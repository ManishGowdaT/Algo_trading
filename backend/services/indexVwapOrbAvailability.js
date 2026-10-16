const accounts = require('./accountContext');
const Availability = require('../models/StrategyAvailability');
const Strategy = require('../models/Strategy');
const NAME = 'IndexVwapOrb';
const denied = () => Object.assign(new Error('Index VWAP ORB is not available for this broker account.'), { status: 403, code: 'STRATEGY_ACCOUNT_DISABLED' });
async function enabled(context) {
  accounts.assertVerified(context);
  return Boolean(await Availability.findOne({ userId: context.userId, brokerAccountId: context.brokerAccountId, strategyName: NAME, settingsEnabled: true }).lean());
}
async function assertEnabled(context) { if (!await enabled(context)) throw denied(); }
async function assertLiveExecution(context) {
  await accounts.validate(context);
  const allowed = await Availability.findOne({ userId: context.userId, brokerAccountId: context.brokerAccountId,
    strategyName: NAME, settingsEnabled: true, liveExecutionEnabled: true }).lean();
  if (!allowed) throw Object.assign(new Error('Live execution has not been enabled for this account.'), { status: 409, code: 'INDEX_ORB_EXECUTION_NOT_READY' });
}
async function ensureStrategy(userId) {
  let row = await Strategy.findOne({ userId, name: NAME });
  if (!row) {
    try { row = await Strategy.create({ userId, name: NAME }); }
    catch (error) { if (error.code !== 11000) throw error; row = await Strategy.findOne({ userId, name: NAME }); }
  }
  if (!row || row.internalExecutionOnly) throw denied();
  return row;
}
// Explicit internal provisioning only; no public enable endpoint and no live authority.
async function provision(context) {
  await accounts.validate(context);
  await Availability.createIndexes();
  const scope = { userId: context.userId, brokerAccountId: context.brokerAccountId, strategyName: NAME };
  let row = await Availability.findOne(scope);
  if (!row) {
    try { row = await Availability.create({ ...scope, settingsEnabled: true }); }
    catch (error) { if (error.code !== 11000) throw error; row = await Availability.findOne(scope); }
  }
  // An explicitly disabled existing account is never silently re-enabled.
  if (!row?.settingsEnabled) throw denied();
  await ensureStrategy(context.userId);
  return row;
}
async function manifestsForUser(manifests, userId) {
  if (!manifests.some(m => m.id === NAME)) return manifests;
  const BrokerAccount = require('../models/BrokerAccount');
  const broker = await BrokerAccount.findOne({ userId }).lean();
  const allowed = broker && await Availability.findOne({ userId, brokerAccountId: broker._id, strategyName: NAME, settingsEnabled: true }).lean();
  return manifests.filter(m => m.id !== NAME || Boolean(allowed));
}
module.exports = { NAME, enabled, assertEnabled, assertLiveExecution, ensureStrategy, provision, manifestsForUser };
