'use strict';

const unresolvedStates = require('./executionLeaseService').unresolvedStates;

async function offboardAccount(context, { BrokerAccount, Position, OrderIntent, Trade, activeAccounts, accountContext: accounts } = {}) {
  accounts ||= require('./accountContext');
  context = accounts.assertVerified(context);
  const ownedAccount = await accounts.owned(context.userId, context.brokerAccountId);
  if (String(ownedAccount._id) !== String(context.brokerAccountId)) throw accounts.denied('Broker account ownership could not be verified.', 404);
  BrokerAccount ||= require('../models/BrokerAccount');
  Position ||= require('../models/Position');
  OrderIntent ||= require('../models/OrderIntent');
  Trade ||= require('../models/Trade');
  activeAccounts ||= require('./activeAccountService');
  // BrokerAccount uses MongoDB's _id as the broker-account identity. Keep the
  // owner predicate in every read/write so a caller cannot disable another
  // user's account by supplying a known account id.
  const scope = { userId: context.userId, _id: context.brokerAccountId };
  const exposureScope = { userId: context.userId, brokerAccountId: context.brokerAccountId };
  const account = await BrokerAccount.findOne(scope);
  if (!account) throw Object.assign(new Error('Owned broker account was not found.'), { status: 404 });
  if (activeAccounts.getActiveAccount(context.userId, context.brokerAccountId) || account.status === 'CONNECTED' || account.status === 'CONNECTING') {
    throw Object.assign(new Error('Disconnect the verified broker session before offboarding.'), { status: 409 });
  }
  const [position, intent, liveTrade] = await Promise.all([
    Position.findOne({ ...exposureScope, status: { $ne: 'CLOSED' } }).select('_id').lean(),
    OrderIntent.findOne({ ...exposureScope, $or: [
      { status: { $in: unresolvedStates } },
      { filledQuantity: { $gt: 0 }, positionId: { $exists: false } },
    ] }).select('_id').lean(),
    Trade.findOne({ ...exposureScope, executionMode: 'LIVE', exitPrice: { $exists: false } }).select('_id').lean(),
  ]);
  if (position || intent || liveTrade) throw Object.assign(new Error('Offboarding is blocked while a position, live trade, or order intent is unresolved.'), { status: 409, code: 'UNRESOLVED_EXPOSURE' });
  const updated = await BrokerAccount.findOneAndUpdate({ ...scope, version: account.version, status: { $in: ['DISCONNECTED', 'SESSION_EXPIRED', 'SERVICE_UNAVAILABLE'] } },
    { $set: { status: 'DISABLED', statusMessage: 'Offboarded; trading history retained.' }, $inc: { version: 1, sessionGeneration: 1, ownerGeneration: 1 } },
    { returnDocument: 'after', runValidators: true });
  if (!updated) throw Object.assign(new Error('Account state changed during offboarding; retry after reconciliation.'), { status: 409 });
  require('./productionHardening').audit('broker_account_offboarded', context, { requestId: 'operator' });
  return { status: 'DISABLED', historyRetained: true };
}

module.exports = { offboardAccount };
