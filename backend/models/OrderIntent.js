const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { INTENT_TRANSITIONS, canTransition } = require('./phase1Lifecycle');

const orderRequestSnapshotSchema = new mongoose.Schema({
    action: { type: String, enum: ['BUY', 'SELL', 'MODIFY', 'CANCEL'], required: true },
    exchange: { type: String, required: true },
    tradingsymbol: { type: String, required: true },
    symboltoken: { type: String, required: true },
    ordertype: { type: String, required: true },
    producttype: { type: String, required: true },
    variety: String,
    quantity: { type: Number, min: 1, required: true },
    price: Number,
    triggerprice: Number,
}, { _id: false, strict: 'throw' });

const orderIntentSchema = new mongoose.Schema({
    intentId: { type: String, required: true, default: () => crypto.randomUUID(), immutable: true },
    idempotencyKey: { type: String, required: true, trim: true, maxlength: 128, immutable: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    brokerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrokerAccount', required: true, immutable: true },
    // Entry intents are persisted before a Position/Trade exists. Exit intents
    // may bind both links; ownership is checked by accountRepository.
    positionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Position' },
    tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade' },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Strategy', required: true, immutable: true },
    purpose: { type: String, enum: ['ENTRY', 'EXIT', 'PROTECT', 'CANCEL', 'MANUAL'], immutable: true },
    executionMetadata: { type: mongoose.Schema.Types.Mixed, immutable: true },
    resultTradeId: { type: mongoose.Schema.Types.ObjectId, immutable: true },
    resultPositionId: { type: mongoose.Schema.Types.ObjectId, immutable: true },
    targetIntentId: { type: mongoose.Schema.Types.ObjectId, immutable: true },
    requestSnapshot: { type: orderRequestSnapshotSchema, required: true, immutable: true },
    status: {
        type: String,
        enum: ['PREPARED', 'SUBMITTING', 'ACKNOWLEDGED', 'UNKNOWN', 'PARTIALLY_FILLED', 'FILLED', 'REJECTED', 'CANCEL_PENDING', 'CANCELLED', 'FAILED', 'RECONCILIATION_REQUIRED'],
        default: 'PREPARED',
        required: true
    },
    brokerOrderId: String,
    brokerUniqueOrderId: String,
    brokerResponse: mongoose.Schema.Types.Mixed,
    requestedQuantity: { type: Number, min: 1, required: true, immutable: true },
    filledQuantity: { type: Number, min: 0, default: 0, required: true },
    remainingQuantity: { type: Number, min: 0, required: true },
    averageFillPrice: { type: Number, min: 0 },
    attemptCount: { type: Number, min: 0, default: 0, required: true },
    sessionGeneration: { type: Number, min: 0, default: 0, required: true },
    ownerGeneration: { type: Number, min: 0, default: 0, required: true },
    executionOwnerId: { type: String, maxlength: 160 },
    executionOwnerGeneration: { type: Number, min: 0, default: 0, required: true },
    lastErrorCode: { type: String, maxlength: 80 },
    lastErrorMessage: { type: String, maxlength: 240 },
    submittedAt: Date,
    acknowledgedAt: Date,
    completedAt: Date,
    lastReconciledAt: Date,
}, {
    timestamps: true,
    versionKey: 'version',
    optimisticConcurrency: true,
    strict: 'throw'
});

orderIntentSchema.post('init', function rememberLoadedIntentStatus() {
    this.$locals.originalStatus = this.status;
});
orderIntentSchema.post('save', function rememberSavedIntentStatus() {
    this.$locals.originalStatus = this.status;
});

orderIntentSchema.pre('validate', function validateIntentQuantities() {
    if (this.requestSnapshot?.quantity !== undefined && this.requestedQuantity !== this.requestSnapshot.quantity) {
        this.invalidate('requestedQuantity', 'Requested quantity must match the immutable request snapshot');
    }
    if ((Number(this.filledQuantity || 0) + Number(this.remainingQuantity || 0)) > Number(this.requestedQuantity || 0)) {
        this.invalidate('remainingQuantity', 'Filled plus remaining quantity cannot exceed the requested quantity');
    }
    if (!['CANCELLED', 'REJECTED', 'FAILED'].includes(this.status) && this.filledQuantity + this.remainingQuantity !== this.requestedQuantity) {
        this.invalidate('remainingQuantity', 'Active order intent quantity must equal filled plus remaining quantity');
    }
    if (this.status === 'FILLED' && (this.filledQuantity !== this.requestedQuantity || this.remainingQuantity !== 0)) {
        this.invalidate('status', 'A filled order intent must have all requested quantity filled and none remaining');
    }
    if (['CANCELLED', 'REJECTED', 'FAILED'].includes(this.status) && this.remainingQuantity !== 0) {
        this.invalidate('remainingQuantity', 'A terminal unfilled order intent cannot retain remaining quantity');
    }
    if (this.status === 'PARTIALLY_FILLED' && (this.filledQuantity <= 0 || this.filledQuantity >= this.requestedQuantity || this.remainingQuantity <= 0)) {
        this.invalidate('status', 'A partially filled order intent must have a partial positive fill');
    }
    if (!this.isNew && (['requestSnapshot', 'executionMetadata', 'purpose', 'resultTradeId', 'resultPositionId', 'targetIntentId', 'positionId', 'tradeId'].some(path => this.isModified(path)))) {
        this.invalidate('requestSnapshot', 'Order request snapshots and established links are immutable');
    }
    if (!this.isNew && this.isModified('status') && !canTransition(INTENT_TRANSITIONS, this.$locals.originalStatus, this.status)) {
        this.invalidate('status', `Invalid order intent transition to ${this.status}`);
    }
});

function updateTouchesPath(update, path) {
    if (Array.isArray(update)) return true;
    return Object.entries(update || {}).some(([operator, value]) => {
        if (operator.startsWith('$')) {
            return Object.entries(value || {}).some(([key, destination]) =>
                key === path || key.startsWith(`${path}.`) ||
                (operator === '$rename' && (destination === path || String(destination).startsWith(`${path}.`))));
        }
        return operator === path || operator.startsWith(`${path}.`);
    });
}

function updateSet(update) {
    return { ...(update?.$set || {}), ...Object.fromEntries(Object.entries(update || {}).filter(([key]) => !key.startsWith('$'))) };
}

function assertIntentQuantities({ requestedQuantity, filledQuantity, remainingQuantity, status }) {
    if (!Number.isFinite(requestedQuantity) || requestedQuantity < 1 || filledQuantity < 0 || remainingQuantity < 0 || filledQuantity + remainingQuantity > requestedQuantity) {
        throw new Error('Filled plus remaining quantity cannot exceed the requested quantity');
    }
    if (!['CANCELLED', 'REJECTED', 'FAILED'].includes(status) && filledQuantity + remainingQuantity !== requestedQuantity) {
        throw new Error('Active order intent quantity must equal filled plus remaining quantity');
    }
    if (status === 'FILLED' && (filledQuantity !== requestedQuantity || remainingQuantity !== 0)) {
        throw new Error('A filled order intent must have all requested quantity filled and none remaining');
    }
    if (['CANCELLED', 'REJECTED', 'FAILED'].includes(status) && remainingQuantity !== 0) {
        throw new Error('A terminal unfilled order intent cannot retain remaining quantity');
    }
    if (status === 'PARTIALLY_FILLED' && (filledQuantity <= 0 || filledQuantity >= requestedQuantity || remainingQuantity <= 0)) {
        throw new Error('A partially filled order intent must have a partial positive fill');
    }
}

orderIntentSchema.pre(['findOneAndUpdate', 'updateOne'], async function validateOrderIntentUpdate() {
    const update = this.getUpdate();
    if (this.getOptions().upsert) throw new Error('Upserts are not supported for durable order intents');
    if (this.getOptions().overwrite) throw new Error('Replacement updates are not supported for durable order intents');
    if (Array.isArray(update)) throw new Error('Update pipelines are not supported for durable order intents');
    const immutable = ['requestSnapshot', 'requestedQuantity', 'purpose', 'executionMetadata', 'resultTradeId', 'resultPositionId', 'targetIntentId'].find((path) => updateTouchesPath(update, path));
    if (immutable) throw new Error('Order request snapshots are immutable');
    const immutableOwner = ['userId', 'brokerAccountId', 'strategyId'].find((path) => updateTouchesPath(update, path));
    if (immutableOwner) throw new Error(`Order intent ownership field is immutable: ${immutableOwner}`);
    if (Object.keys(update || {}).some((key) => !key.startsWith('$'))) throw new Error('Replacement updates are not supported for durable order intents');
    for (const [operator, values] of Object.entries(update || {})) {
        if (!operator.startsWith('$') || ['$set', '$inc', '$setOnInsert', '$unset'].includes(operator)) continue;
        throw new Error(`Unsupported order intent update operator: ${operator}`);
    }
    for (const path of Object.keys(update?.$inc || {})) {
        if (['requestedQuantity', 'filledQuantity', 'remainingQuantity'].includes(path)) {
            throw new Error(`Unsupported order intent quantity increment: ${path}`);
        }
    }
    for (const path of Object.keys(update?.$unset || {})) {
        if (['status', 'requestedQuantity', 'filledQuantity', 'remainingQuantity', 'positionId', 'tradeId'].includes(path)) {
            throw new Error(`Cannot unset required order intent field: ${path}`);
        }
    }
    const query = this.getQuery();
    const current = await this.model.findOne(query).session(this.getOptions().session || null).lean().exec();
    if (!current) return;
    const set = updateSet(update);
    const newStatus = set.status ?? current.status;
    if (newStatus !== current.status && !canTransition(INTENT_TRANSITIONS, current.status, newStatus)) {
        throw new Error(`Invalid order intent transition: ${current.status} -> ${newStatus}`);
    }
    const settingPosition = Object.prototype.hasOwnProperty.call(set, 'positionId');
    const settingTrade = Object.prototype.hasOwnProperty.call(set, 'tradeId');
    if (settingPosition !== settingTrade) throw new Error('Position and trade links must be set together');
    if (settingPosition) {
        if (current.positionId || current.tradeId) throw new Error('Order intent links can only be established once');
        assertIntentQuantities({
            requestedQuantity: current.requestedQuantity,
            filledQuantity: set.filledQuantity ?? current.filledQuantity,
            remainingQuantity: set.remainingQuantity ?? current.remainingQuantity,
            status: set.status ?? current.status,
        });
        const expectedVersion = current.version ?? 0;
        if (query.version !== undefined && query.version !== expectedVersion) return;
        this.setQuery({ ...query, version: expectedVersion, positionId: { $exists: false }, tradeId: { $exists: false } });
        return;
    }

    const requestedQuantity = current.requestedQuantity;
    const filledQuantity = set.filledQuantity ?? current.filledQuantity;
    const remainingQuantity = set.remainingQuantity ?? current.remainingQuantity;
    const status = set.status ?? current.status;
    assertIntentQuantities({ requestedQuantity, filledQuantity, remainingQuantity, status });

    const expectedVersion = current.version ?? 0;
    if (query.version !== undefined && query.version !== expectedVersion) return;
    this.setQuery({ ...query, version: expectedVersion, filledQuantity: current.filledQuantity, remainingQuantity: current.remainingQuantity });
});

orderIntentSchema.pre(['updateMany', 'replaceOne'], function rejectBulkIntentMutation() {
    throw new Error('Bulk and replacement updates are not supported for durable order intents');
});

orderIntentSchema.index({ intentId: 1 }, { unique: true, name: 'uniq_order_intent_id' });
orderIntentSchema.index({ brokerAccountId: 1, idempotencyKey: 1 }, { unique: true, name: 'uniq_order_intent_account_idempotency' });
orderIntentSchema.index({ userId: 1, brokerAccountId: 1, status: 1, updatedAt: -1 }, { name: 'order_intents_by_owner_account_status' });
orderIntentSchema.index({ userId: 1, brokerAccountId: 1, strategyId: 1, purpose: 1 }, {
    unique: true, name: 'uniq_unresolved_entry_per_strategy',
    partialFilterExpression: { purpose: 'ENTRY', status: { $in: ['PREPARED', 'SUBMITTING', 'ACKNOWLEDGED', 'UNKNOWN', 'PARTIALLY_FILLED', 'RECONCILIATION_REQUIRED'] } },
});

module.exports = mongoose.model('OrderIntent', orderIntentSchema);
