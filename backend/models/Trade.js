const mongoose = require('mongoose');

const tradeSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
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
    lastBrokerSyncAt: {
        type: Date
    },
    exitReason: {
        type: String,
        enum: ['Target', 'SL', 'Trailing SL', 'Strategy', 'HA_TREND_REVERSAL', 'Reversal', 'RECOVERY_CLEANUP', 'Manual']
    }
}, { timestamps: true });

module.exports = mongoose.model('Trade', tradeSchema);
