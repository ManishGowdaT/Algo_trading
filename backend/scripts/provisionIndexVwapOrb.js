// Explicit account-specific settings provisioning; never starts scanning or trades.
require('dotenv').config();
const mongoose = require('mongoose');
async function main(args = process.argv.slice(2)) {
  const user = args[args.indexOf('--user') + 1];
  const account = args[args.indexOf('--account') + 1];
  if (!args.includes('--enable-settings') || !args.includes('--user') || !args.includes('--account')
    || !mongoose.isObjectIdOrHexString(user) || !mongoose.isObjectIdOrHexString(account)) {
    throw new Error('Usage: node scripts/provisionIndexVwapOrb.js --user USER_ID --account BROKER_ACCOUNT_ID --enable-settings');
  }
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required.');
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const broker = await require('../models/BrokerAccount').findOne({ _id: account, userId: user, status: { $ne: 'DISABLED' } }).lean();
    if (!broker) throw new Error('Broker account is missing, disabled or belongs to another user.');
    const Availability = require('../models/StrategyAvailability');
    await Availability.createIndexes(); await require('../models/StrategySession').createIndexes();
    const scope = { userId: user, brokerAccountId: account, strategyName: 'IndexVwapOrb' };
    const existing = await Availability.findOne(scope);
    if (existing && !existing.settingsEnabled) throw new Error('Account explicitly disabled; no automatic re-enable performed.');
    if (!existing) {
      try { await Availability.create({ ...scope, settingsEnabled: true }); }
      catch (error) { if (error.code !== 11000) throw error; }
    }
    await require('../services/indexVwapOrbAvailability').ensureStrategy(user);
    console.log('Account settings provisioned. Existing settings/consent preserved; scanning and execution remain stopped.');
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
