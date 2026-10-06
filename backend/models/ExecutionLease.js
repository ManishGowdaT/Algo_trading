const mongoose = require('mongoose');

// A single durable execution owner per broker account fences every Position
// and OrderIntent for that account, including entry intents without a Position.
const executionLeaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  brokerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrokerAccount', required: true, immutable: true },
  ownerId: { type: String, default: null },
  generation: { type: Number, min: 0, default: 0, required: true },
  leaseUntil: { type: Date, default: new Date(0), required: true },
  state: { type: String, enum: ['IDLE', 'ACTIVE', 'DEGRADED'], default: 'IDLE', required: true },
  heartbeatAt: Date,
}, { timestamps: true, versionKey: false, strict: 'throw' });

executionLeaseSchema.index({ userId: 1, brokerAccountId: 1 }, { unique: true, name: 'uniq_execution_lease_per_account' });

module.exports = mongoose.model('ExecutionLease', executionLeaseSchema);
