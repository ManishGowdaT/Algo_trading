const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  brokerAccountId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  strategyName: { type: String, enum: ['IndexVwapOrb'], required: true, immutable: true },
  settingsEnabled: { type: Boolean, default: false, required: true },
  liveExecutionEnabled: { type: Boolean, default: false, required: true },
}, { timestamps: true, strict: 'throw', versionKey: 'version', optimisticConcurrency: true });
schema.index({ userId: 1, brokerAccountId: 1, strategyName: 1 }, { unique: true, name: 'uniq_strategy_availability_account' });
module.exports = mongoose.model('StrategyAvailability', schema);
