const mongoose = require('mongoose');

const brokerAccountSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true
    },
    broker: {
        type: String,
        enum: ['ANGEL_ONE'],
        default: 'ANGEL_ONE',
        required: true,
        immutable: true
    },
    // Account identity only. API keys, MPIN, TOTP secrets and session tokens
    // must never be persisted in this document.
    brokerClientId: {
        type: String,
        required: true,
        trim: true,
        uppercase: true,
        immutable: true
    },
    displayLabel: { type: String, trim: true, maxlength: 80 },
    status: {
        type: String,
        enum: ['DISCONNECTED', 'CONNECTING', 'CONNECTED', 'SESSION_EXPIRED', 'SERVICE_UNAVAILABLE', 'DISABLED'],
        default: 'DISCONNECTED',
        required: true
    },
    statusMessage: { type: String, maxlength: 240 },
    sessionGeneration: { type: Number, min: 0, default: 0, required: true },
    ownerGeneration: { type: Number, min: 0, default: 0, required: true },
    lastHealthCheckAt: Date,
    lastHealthSuccessAt: Date,
    connectedAt: Date,
}, {
    timestamps: true,
    versionKey: 'version',
    optimisticConcurrency: true,
    strict: 'throw'
});

// Initial scope is one linked broker account per app user and one app owner
// per actual broker account. Conflicts must be resolved explicitly.
brokerAccountSchema.index({ userId: 1, broker: 1 }, { unique: true, name: 'uniq_broker_account_per_user' });
brokerAccountSchema.index({ broker: 1, brokerClientId: 1 }, { unique: true, name: 'uniq_broker_client_owner' });

module.exports = mongoose.model('BrokerAccount', brokerAccountSchema);
