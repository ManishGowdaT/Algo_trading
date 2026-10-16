const mongoose = require('mongoose');
const entry = new mongoose.Schema({
  signalId: { type: String, required: true }, setupId: { type: String, required: true },
  underlying: { type: String, enum: ['NIFTY', 'BANKNIFTY', 'SENSEX'], required: true },
  intentId: { type: mongoose.Schema.Types.ObjectId, required: true },
  state: { type: String, enum: ['RESERVED', 'INTENT_PREPARED', 'COUNTED', 'RELEASED'], required: true },
  filledQuantity: { type: Number, min: 0, default: 0 },
  request: { type: mongoose.Schema.Types.Mixed, required: true },
  metadata: { type: mongoose.Schema.Types.Mixed, required: true },
  reservedAt: { type: Date, required: true },
}, { _id: false, strict: 'throw' });
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  brokerAccountId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  strategyId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  istDate: { type: String, required: true, immutable: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  ruleVersion: { type: String, required: true },
  entriesFilled: { type: Number, min: 0, max: 2, required: true, default: 0 },
  entries: { type: [entry], default: [] },
  activeIntentId: { type: mongoose.Schema.Types.ObjectId, default: null },
  checkpoints: { type: mongoose.Schema.Types.Mixed, default: {} },
  executionOwnerGeneration: { type: Number, min: 0, default: 0 },
}, { timestamps: true, strict: 'throw', versionKey: 'version', optimisticConcurrency: true });
schema.index({ userId: 1, brokerAccountId: 1, strategyId: 1, istDate: 1 }, { unique: true, name: 'uniq_strategy_session_ist_date' });
schema.index({ userId: 1, brokerAccountId: 1, strategyId: 1, activeIntentId: 1 }, { name: 'strategy_sessions_pending' });
module.exports = mongoose.model('StrategySession', schema);
