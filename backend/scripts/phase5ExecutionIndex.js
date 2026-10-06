// Additive only: no documents, historical IDs or existing indexes are changed.
const mongoose = require('mongoose');
require('dotenv').config();
const OrderIntent = require('../models/OrderIntent');

async function auditAndInstall(apply = false) {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
  try {
    const [keys, options] = OrderIntent.schema.indexes().find(([, opts]) => opts.name === 'uniq_unresolved_entry_per_strategy');
    const conflicts = await OrderIntent.aggregate([
      { $match: options.partialFilterExpression },
      { $group: { _id: { userId: '$userId', brokerAccountId: '$brokerAccountId', strategyId: '$strategyId', purpose: '$purpose' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]);
    if (conflicts.length) throw new Error(`${conflicts.length} duplicate unresolved entry groups require operator reconciliation; nothing was changed`);
    if (apply) await OrderIntent.collection.createIndex(keys, options);
    return { conflicts: 0, applied: apply, historicalDocumentsRewritten: 0, historicalIdsChanged: 0 };
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) auditAndInstall(process.argv.includes('--apply')).then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error('Phase 5 index audit/install failed. Reconcile duplicates, DB access and MongoDB partial-index support before enabling new entries.'); process.exitCode = 1; });
module.exports = { auditAndInstall };
