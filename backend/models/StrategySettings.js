const mongoose = require('mongoose');

const strategySettingsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        immutable: true
    },
    brokerAccountId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'BrokerAccount',
        required: true,
        immutable: true
    },
    strategyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Strategy',
        required: true,
        immutable: true
    },
    config: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
        default: () => ({})
    }
}, {
    timestamps: true,
    versionKey: 'version',
    optimisticConcurrency: true,
    strict: 'throw'
});

strategySettingsSchema.index(
    { userId: 1, brokerAccountId: 1, strategyId: 1 },
    { unique: true, name: 'uniq_strategy_settings_owner_account_strategy' }
);

module.exports = mongoose.model('StrategySettings', strategySettingsSchema);
