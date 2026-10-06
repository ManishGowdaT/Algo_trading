const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    // Optional during the additive rollout. Historical trades keep their IDs
    // and user ownership until account ownership can be verified separately.
    brokerAccountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'BrokerAccount'
    },
    strategyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Strategy',
        required: true
    },
    index: {
        type: String,
        required: true
    },
    premium: {
        type: String,
        required: true
    },
    qty: {
        type: Number,
        required: true
    },
    buyPrice: {
        type: Number,
        required: true
    },
    exitPrice: {
        type: Number
    },
    pnl: {
        type: Number
    },
    executionMode: {
        type: String,
        enum: ['PAPER', 'LIVE'],
        default: 'PAPER'
    },
    entryOrderId: {
        type: String
    },
    protectiveOrderId: {
        type: String
    },
    protectiveStopPrice: {
        type: Number
    },
    positionState: {
        type: String,
        enum: ['OPEN', 'PROTECTED', 'UNPROTECTED', 'EXIT_PENDING', 'CLOSED', 'RECONCILIATION_REQUIRED'],
        default: 'OPEN'
    },
    // Immutable entry-time snapshot for new durable position/recovery records.
    // Deliberately absent on legacy trade documents until independently backfilled.
    executionSnapshot: {
        type: mongoose.Schema.Types.Mixed,
        immutable: true,
        default: undefined
    },
    lastBrokerSyncAt: {
        type: Date
    },
    exitReason: {
        type: String,
        enum: ['Target', 'SL', 'Trailing SL', 'Strategy', 'HA_TREND_REVERSAL', 'Reversal', 'RECOVERY_CLEANUP', 'Manual']
    }
}, { timestamps: true });

tradeSchema.pre('validate', function protectTradeExecutionSnapshot() {
    if (!this.isNew && this.isModified('executionSnapshot')) {
        this.invalidate('executionSnapshot', 'Trade execution snapshots are immutable after creation');
    }
});

function tradeUpdateTouchesSnapshot(update) {
    if (Array.isArray(update)) return true;
    return Object.entries(update || {}).some(([operator, value]) => {
        if (operator.startsWith('$')) {
            return Object.keys(value || {}).some((path) => path === 'executionSnapshot' || path.startsWith('executionSnapshot.'));
        }
        return operator === 'executionSnapshot' || operator.startsWith('executionSnapshot.');
    });
}

tradeSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne'], function protectTradeSnapshotQuery() {
    if (this.op === 'replaceOne') throw new Error('Trade replacement updates are not supported');
    if (tradeUpdateTouchesSnapshot(this.getUpdate())) {
        throw new Error('Trade execution snapshots are immutable');
    }
});

tradeSchema.index({ userId: 1, brokerAccountId: 1, strategyId: 1, createdAt: -1 });

module.exports = mongoose.model('Trade', tradeSchema);
