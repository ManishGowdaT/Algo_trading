const mongoose = require('mongoose');
const { POSITION_TRANSITIONS, canTransition } = require('./phase1Lifecycle');

const executionSnapshotSchema = new mongoose.Schema({
    executionMode: { type: String, enum: ['PAPER', 'LIVE'], required: true },
    quantity: { type: Number, min: 1, required: true },
    underlying: { type: String, required: true },
    exchange: { type: String, required: true },
    tradingsymbol: { type: String, required: true },
    symboltoken: { type: String, required: true },
    producttype: String,
    entryPrice: { type: Number, min: 0, required: true },
    stopLoss: { type: Number, min: 0 },
    target: { type: Number, min: 0 },
    exitStrategy: String,
    initialSlPoints: Number,
    trailingStopPoints: Number,
    finalTargetPoints: Number,
    targetPoints: Number,
    slPoints: Number,
}, { _id: false, strict: 'throw' });

const positionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    brokerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrokerAccount', required: true, immutable: true },
    strategyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Strategy', required: true, immutable: true },
    tradeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trade', required: true, immutable: true },
    entryIntentId: { type: mongoose.Schema.Types.ObjectId, immutable: true },
    executionConfig: { type: mongoose.Schema.Types.Mixed, immutable: true },
    pendingEntryQuantity: { type: Number, min: 0, default: 0 },
    abandonedEntryQuantity: { type: Number, min: 0, default: 0 },
    averageEntryPrice: { type: Number, min: 0 },
    activeTrailingSl: { type: Number, min: 0 },
    exitEvidence: { type: [{ intentId: String, quantity: Number, price: Number }], default: undefined },
    completionPending: { type: Boolean, default: false },
    exitReason: String,
    status: {
        type: String,
        enum: ['OPEN', 'PROTECTED', 'UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED', 'CLOSED'],
        default: 'OPEN',
        required: true
    },
    executionSnapshot: { type: executionSnapshotSchema, required: true, immutable: true },
    remainingQuantity: { type: Number, min: 0, required: true },
    filledExitQuantity: { type: Number, min: 0, default: 0, required: true },
    protectiveOrderId: String,
    protectiveStopPrice: { type: Number, min: 0 },
    intentRevision: { type: Number, min: 0, default: 0, required: true },
    sessionGeneration: { type: Number, min: 0, default: 0, required: true },
    ownerGeneration: { type: Number, min: 0, default: 0, required: true },
    executionOwnerId: { type: String, maxlength: 160 },
    executionOwnerGeneration: { type: Number, min: 0, default: 0, required: true },
    lastQuoteAt: Date,
    lastReconciledAt: Date,
    reconciliationHealth: {
        type: String,
        enum: ['UNKNOWN', 'HEALTHY', 'DEGRADED', 'RECONCILIATION_REQUIRED'],
        default: 'UNKNOWN',
        required: true
    },
}, {
    timestamps: true,
    versionKey: 'version',
    optimisticConcurrency: true,
    strict: 'throw'
});

positionSchema.post('init', function rememberLoadedPositionStatus() {
    this.$locals.originalStatus = this.status;
});
positionSchema.post('save', function rememberSavedPositionStatus() {
    this.$locals.originalStatus = this.status;
});

positionSchema.pre('validate', function validatePositionQuantities() {
    const openedQuantity = this.executionSnapshot?.quantity;
    const remaining = Number(this.remainingQuantity || 0);
    const exited = Number(this.filledExitQuantity || 0);
    const pending = Number(this.pendingEntryQuantity || 0);
    const abandoned = Number(this.abandonedEntryQuantity || 0);
    if (![openedQuantity, remaining, exited, pending, abandoned].every(value => Number.isInteger(value) && value >= 0)) {
        this.invalidate('remainingQuantity', 'Position quantities must be nonnegative integers');
    }
    if (Number.isFinite(openedQuantity) && remaining + exited + pending + abandoned !== openedQuantity) {
        this.invalidate('remainingQuantity', 'Remaining plus exited quantity must equal the entry snapshot quantity');
    }
    if (this.status === 'CLOSED' && (remaining !== 0 || pending !== 0 || exited + abandoned !== openedQuantity || this.completionPending)) {
        this.invalidate('status', 'A position can be closed only after all entry quantity has exited');
    } else if (this.status !== 'CLOSED' && remaining <= 0 && !(this.completionPending && ['EXIT_PENDING', 'RECONCILIATION_REQUIRED'].includes(this.status))) {
        this.invalidate('status', 'A position with no remaining quantity must be closed');
    }
    if (!this.isNew && ['executionSnapshot', 'executionConfig', 'entryIntentId'].some(path => this.isModified(path))) {
        this.invalidate('executionSnapshot', 'Position execution snapshots are immutable after creation');
    }
    if (!this.isNew && this.isModified('status') && !canTransition(POSITION_TRANSITIONS, this.$locals.originalStatus, this.status)) {
        this.invalidate('status', `Invalid position transition to ${this.status}`);
    }
});

function updateTouchesSnapshot(update) {
    if (Array.isArray(update)) return true;
    return Object.entries(update || {}).some(([operator, value]) => {
        if (operator.startsWith('$')) {
            return Object.entries(value || {}).some(([path, destination]) =>
                path === 'executionSnapshot' || path.startsWith('executionSnapshot.') ||
                (operator === '$rename' && (destination === 'executionSnapshot' || String(destination).startsWith('executionSnapshot.'))));
        }
        return operator === 'executionSnapshot' || operator.startsWith('executionSnapshot.');
    });
}

function updateTouchesField(update, field) {
    if (Array.isArray(update)) return true;
    return Object.entries(update || {}).some(([operator, value]) => {
        if (operator.startsWith('$')) {
            return Object.entries(value || {}).some(([path, destination]) =>
                path === field || path.startsWith(`${field}.`) ||
                (operator === '$rename' && (destination === field || String(destination).startsWith(`${field}.`))));
        }
        return operator === field || operator.startsWith(`${field}.`);
    });
}

function updateSet(update) {
    return { ...(update?.$set || {}), ...Object.fromEntries(Object.entries(update || {}).filter(([key]) => !key.startsWith('$'))) };
}

function assertPositionQuantities({ quantity, remainingQuantity, filledExitQuantity, status, pendingEntryQuantity = 0, abandonedEntryQuantity = 0, completionPending = false }) {
    if (![quantity, remainingQuantity, filledExitQuantity, pendingEntryQuantity, abandonedEntryQuantity].every(value => Number.isInteger(value) && value >= 0)) {
        throw new Error('Position quantities must be nonnegative integers');
    }
    if (!Number.isFinite(quantity) || quantity < 1 || remainingQuantity + filledExitQuantity + pendingEntryQuantity + abandonedEntryQuantity !== quantity) {
        throw new Error('Remaining plus exited quantity must equal the entry snapshot quantity');
    }
    if (status === 'CLOSED' && (remainingQuantity !== 0 || pendingEntryQuantity !== 0 || filledExitQuantity + abandonedEntryQuantity !== quantity || completionPending)) {
        throw new Error('A position can be closed only after all entry quantity has exited');
    }
    if (status !== 'CLOSED' && remainingQuantity <= 0 && !(completionPending && ['EXIT_PENDING', 'RECONCILIATION_REQUIRED'].includes(status))) {
        throw new Error('A position with no remaining quantity must be closed');
    }
}

positionSchema.pre(['findOneAndUpdate', 'updateOne'], async function validatePositionUpdate() {
    const update = this.getUpdate();
    if (this.getOptions().upsert) throw new Error('Upserts are not supported for durable positions');
    if (this.getOptions().overwrite) throw new Error('Replacement updates are not supported for durable positions');
    if (Array.isArray(update)) throw new Error('Update pipelines are not supported for durable positions');
    if (updateTouchesSnapshot(update) || updateTouchesField(update, 'executionConfig') || updateTouchesField(update, 'entryIntentId')) throw new Error('Position execution snapshots are immutable');
    const immutableOwner = ['userId', 'brokerAccountId', 'strategyId', 'tradeId'].find((path) => updateTouchesField(update, path));
    if (immutableOwner) throw new Error(`Position ownership field is immutable: ${immutableOwner}`);
    if (Object.keys(update || {}).some((key) => !key.startsWith('$'))) throw new Error('Replacement updates are not supported for durable positions');
    for (const [operator, values] of Object.entries(update || {})) {
        if (!operator.startsWith('$') || ['$set', '$inc', '$setOnInsert', '$unset'].includes(operator)) continue;
        throw new Error(`Unsupported position update operator: ${operator}`);
    }
    for (const path of Object.keys(update?.$inc || {})) {
        if (['status', 'remainingQuantity', 'filledExitQuantity', 'pendingEntryQuantity', 'abandonedEntryQuantity', 'completionPending'].includes(path)) {
            throw new Error(`Unsupported position lifecycle increment: ${path}`);
        }
    }
    for (const path of Object.keys(update?.$unset || {})) {
        if (['status', 'remainingQuantity', 'filledExitQuantity', 'pendingEntryQuantity', 'abandonedEntryQuantity', 'completionPending'].includes(path)) {
            throw new Error(`Cannot unset required position lifecycle field: ${path}`);
        }
    }
    const query = this.getQuery();
    const current = await this.model.findOne(query).session(this.getOptions().session || null).lean().exec();
    if (!current) return;

    const set = updateSet(update);
    const quantity = current.executionSnapshot?.quantity;
    const remainingQuantity = set.remainingQuantity ?? current.remainingQuantity;
    const filledExitQuantity = set.filledExitQuantity ?? current.filledExitQuantity;
    const status = set.status ?? current.status;
    if (!canTransition(POSITION_TRANSITIONS, current.status, status)) {
        throw new Error(`Invalid position transition: ${current.status} -> ${status}`);
    }
    assertPositionQuantities({ quantity, remainingQuantity, filledExitQuantity, status,
        pendingEntryQuantity: set.pendingEntryQuantity ?? current.pendingEntryQuantity ?? 0,
        abandonedEntryQuantity: set.abandonedEntryQuantity ?? current.abandonedEntryQuantity ?? 0,
        completionPending: set.completionPending ?? current.completionPending ?? false });

    const expectedVersion = current.version ?? 0;
    if (query.version !== undefined && query.version !== expectedVersion) return;
    this.setQuery({
        ...query,
        version: expectedVersion,
        remainingQuantity: current.remainingQuantity,
        filledExitQuantity: current.filledExitQuantity,
        'executionSnapshot.quantity': quantity,
    });
});

positionSchema.pre(['updateMany', 'replaceOne'], function rejectBulkPositionMutation() {
    throw new Error('Bulk and replacement updates are not supported for durable positions');
});

positionSchema.index({ userId: 1, brokerAccountId: 1, status: 1, updatedAt: -1 }, { name: 'positions_by_owner_account_status' });
positionSchema.index({ userId: 1, brokerAccountId: 1, tradeId: 1 }, { unique: true, name: 'uniq_position_per_owned_trade' });

module.exports = mongoose.model('Position', positionSchema);
