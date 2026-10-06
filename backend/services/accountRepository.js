const { INTENT_TRANSITIONS, POSITION_TRANSITIONS, canTransition } = require('../models/phase1Lifecycle');

const ACCOUNT_UPDATE_FIELDS = new Set([
    'status', 'statusMessage', 'lastHealthCheckAt', 'lastHealthSuccessAt', 'connectedAt',
]);
const POSITION_UPDATE_FIELDS = new Set([
    'remainingQuantity', 'filledExitQuantity', 'protectiveOrderId',
    'protectiveStopPrice', 'lastQuoteAt', 'lastReconciledAt', 'reconciliationHealth',
]);
const INTENT_UPDATE_FIELDS = new Set([
    'brokerOrderId', 'brokerUniqueOrderId', 'filledQuantity', 'remainingQuantity',
    'averageFillPrice', 'attemptCount', 'lastErrorCode', 'lastErrorMessage',
    'submittedAt', 'acknowledgedAt', 'completedAt', 'lastReconciledAt',
]);

function generationIncrements({ incrementSessionGeneration = false, incrementOwnerGeneration = false } = {}) {
    if (typeof incrementSessionGeneration !== 'boolean' || typeof incrementOwnerGeneration !== 'boolean') {
        throw new TypeError('generation increment flags must be booleans');
    }
    const increments = {};
    if (incrementSessionGeneration) increments.sessionGeneration = 1;
    if (incrementOwnerGeneration) increments.ownerGeneration = 1;
    return increments;
}

function hasIdentity(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

function pickAllowed(source, allowlist, label) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        throw new TypeError(`${label} must be an object`);
    }
    const keys = Object.keys(source);
    const unsupported = keys.filter((key) => !allowlist.has(key));
    if (unsupported.length > 0) throw new TypeError(`Unsupported ${label} field: ${unsupported[0]}`);
    return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function createAccountRepository({ BrokerAccount, Strategy, StrategySettings, Trade, Position, OrderIntent }) {
    for (const [name, model] of Object.entries({ BrokerAccount, Strategy, StrategySettings, Trade, Position, OrderIntent })) {
        if (!model) throw new TypeError(`${name} model is required`);
    }

    async function getBrokerAccount(userId, brokerAccountId) {
        if (!hasIdentity(userId) || !hasIdentity(brokerAccountId)) return null;
        return BrokerAccount.findOne({ _id: brokerAccountId, userId });
    }

    async function requireOwnedReferences({ userId, brokerAccountId, strategyId, tradeId }) {
        if (![userId, brokerAccountId, strategyId].every(hasIdentity)) return null;
        if (tradeId !== undefined && tradeId !== null && !hasIdentity(tradeId)) return null;
        const account = await getBrokerAccount(userId, brokerAccountId);
        if (!account) return null;

        const strategy = await Strategy.findOne({ _id: strategyId, userId });
        if (!strategy) return null;

        if (tradeId !== undefined) {
            const trade = await Trade.findOne({
                _id: tradeId,
                userId,
                brokerAccountId,
                strategyId,
            });
            if (!trade) return null;
            return { account, strategy, trade };
        }
        return { account, strategy };
    }

    return Object.freeze({
        getBrokerAccount,

        async createBrokerAccount({ userId, brokerClientId, ...metadata }) {
            if (!hasIdentity(userId)) throw new TypeError('userId is required');
            if (!hasIdentity(brokerClientId)) throw new TypeError('brokerClientId is required');
            return BrokerAccount.create({ userId, brokerClientId, ...metadata });
        },

        async updateBrokerAccountStatus({ userId, brokerAccountId, expectedVersion, changes, incrementSessionGeneration = false, incrementOwnerGeneration = false }) {
            if (![userId, brokerAccountId].every(hasIdentity)) throw new TypeError('userId and brokerAccountId are required');
            if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required');
            const safeChanges = pickAllowed(changes, ACCOUNT_UPDATE_FIELDS, 'broker account update');
            const increments = generationIncrements({ incrementSessionGeneration, incrementOwnerGeneration });
            increments.version = 1;
            return BrokerAccount.findOneAndUpdate(
                { _id: brokerAccountId, userId, version: expectedVersion },
                { $set: safeChanges, $inc: increments },
                { returnDocument: 'after', runValidators: true }
            );
        },

        async createStrategySettings({ userId, brokerAccountId, strategyId, config }) {
            const owned = await requireOwnedReferences({ userId, brokerAccountId, strategyId });
            if (!owned) return null;
            return StrategySettings.create({ userId, brokerAccountId, strategyId, config });
        },

        async findStrategySettings({ userId, brokerAccountId, settingsId }) {
            if (![userId, brokerAccountId, settingsId].every(hasIdentity)) return null;
            return StrategySettings.findOne({ _id: settingsId, userId, brokerAccountId });
        },

        async updateStrategySettings({ userId, brokerAccountId, settingsId, expectedVersion, config }) {
            if (![userId, brokerAccountId, settingsId].every(hasIdentity)) throw new TypeError('owner and settings IDs are required');
            if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required');
            return StrategySettings.findOneAndUpdate(
                { _id: settingsId, userId, brokerAccountId, version: expectedVersion },
                { $set: { config }, $inc: { version: 1 } },
                { returnDocument: 'after', runValidators: true }
            );
        },

        async deleteStrategySettings({ userId, brokerAccountId, settingsId }) {
            if (![userId, brokerAccountId, settingsId].every(hasIdentity)) return null;
            return StrategySettings.findOneAndDelete({ _id: settingsId, userId, brokerAccountId });
        },

        async createPosition({ userId, brokerAccountId, strategyId, tradeId, ...position }) {
            const owned = await requireOwnedReferences({ userId, brokerAccountId, strategyId, tradeId });
            if (!owned) return null;
            return Position.create({ userId, brokerAccountId, strategyId, tradeId, ...position });
        },

        async findPosition({ userId, brokerAccountId, positionId }) {
            if (![userId, brokerAccountId, positionId].every(hasIdentity)) return null;
            return Position.findOne({ _id: positionId, userId, brokerAccountId });
        },

        async transitionPosition({ userId, brokerAccountId, positionId, expectedVersion, expectedStatus, status, changes = {}, incrementSessionGeneration = false, incrementOwnerGeneration = false }) {
            if (![userId, brokerAccountId, positionId].every(hasIdentity)) throw new TypeError('owner and position IDs are required');
            if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required');
            if (!canTransition(POSITION_TRANSITIONS, expectedStatus, status)) {
                throw new Error(`Invalid position transition: ${expectedStatus} -> ${status}`);
            }
            const safeChanges = pickAllowed(changes, POSITION_UPDATE_FIELDS, 'position update');
            const increments = generationIncrements({ incrementSessionGeneration, incrementOwnerGeneration });
            increments.version = 1;
            return Position.findOneAndUpdate(
                { _id: positionId, userId, brokerAccountId, version: expectedVersion, status: expectedStatus },
                { $set: { ...safeChanges, status }, $inc: increments },
                { returnDocument: 'after', runValidators: true }
            );
        },

        async deleteClosedPosition({ userId, brokerAccountId, positionId }) {
            if (![userId, brokerAccountId, positionId].every(hasIdentity)) return null;
            const candidate = await Position.findOne({ _id: positionId, userId, brokerAccountId, status: 'CLOSED' });
            if (!candidate) return null;
            const session = await Position.db.startSession();
            let deleted = null;
            try {
                await session.withTransaction(async () => {
                    const position = await Position.findOne({ _id: positionId, userId, brokerAccountId, status: 'CLOSED' }).session(session).lean().exec();
                    if (!position) return;
                    const quantity = position.executionSnapshot?.quantity;
                    if (!Number.isFinite(quantity) || position.remainingQuantity !== 0 || position.filledExitQuantity !== quantity) return;
                    const linkedIntent = await OrderIntent.exists({ userId, brokerAccountId, positionId }).session(session).exec();
                    if (linkedIntent) return;
                    deleted = await Position.findOneAndDelete({
                        _id: positionId, userId, brokerAccountId, status: 'CLOSED',
                        version: position.version ?? 0,
                        intentRevision: position.intentRevision ?? 0,
                        remainingQuantity: 0,
                        filledExitQuantity: quantity,
                        'executionSnapshot.quantity': quantity,
                    }).session(session).exec();
                });
            } finally {
                await session.endSession();
            }
            return deleted;
        },

        async createOrderIntent({ userId, brokerAccountId, strategyId, positionId, tradeId, ...intent }) {
            const owned = await requireOwnedReferences({ userId, brokerAccountId, strategyId });
            if (!owned) return null;
            if (positionId !== undefined && positionId !== null) {
                const candidate = await Position.findOne({ _id: positionId, userId, brokerAccountId, strategyId });
                if (!candidate) return null;
                const linkedTradeId = tradeId || candidate.tradeId;
                if (String(candidate.tradeId) !== String(linkedTradeId)) return null;
                const existingTrade = await Trade.findOne({ _id: linkedTradeId, userId, brokerAccountId, strategyId });
                if (!existingTrade) return null;
                const session = await Position.db.startSession();
                let created = null;
                try {
                    await session.withTransaction(async () => {
                        const position = await Position.findOne({ _id: positionId, userId, brokerAccountId, strategyId }).session(session).lean().exec();
                        if (!position) return;
                        const txTradeId = tradeId || position.tradeId;
                        if (String(position.tradeId) !== String(txTradeId)) return;
                        const trade = await Trade.findOne({ _id: txTradeId, userId, brokerAccountId, strategyId }).session(session).lean().exec();
                        if (!trade) return;
                        const locked = await Position.findOneAndUpdate(
                            { _id: positionId, userId, brokerAccountId, strategyId, version: position.version ?? 0, intentRevision: position.intentRevision ?? 0 },
                            { $inc: { intentRevision: 1, version: 1 } },
                            { returnDocument: 'after', runValidators: true, session }
                        );
                        if (!locked) return;
                        [created] = await OrderIntent.create([{
                            userId, brokerAccountId, strategyId, positionId, tradeId: txTradeId, ...intent,
                        }], { session });
                    });
                } finally {
                    await session.endSession();
                }
                return created;
            } else if (tradeId !== undefined && tradeId !== null) {
                const trade = await Trade.findOne({ _id: tradeId, userId, brokerAccountId, strategyId });
                if (!trade) return null;
            }
            return OrderIntent.create({ userId, brokerAccountId, strategyId, positionId, tradeId, ...intent });
        },

        async linkOrderIntent({ userId, brokerAccountId, strategyId, intentRecordId, positionId, tradeId, expectedVersion }) {
            if (![userId, brokerAccountId, strategyId, intentRecordId, positionId, tradeId].every(hasIdentity)) {
                throw new TypeError('owner and intent/position/trade IDs are required');
            }
            if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required');
            const session = await Position.db.startSession();
            let linked = null;
            try {
                await session.withTransaction(async () => {
                    const intent = await OrderIntent.findOne({
                        _id: intentRecordId, userId, brokerAccountId, strategyId,
                        version: expectedVersion,
                    }).session(session).lean().exec();
                    if (!intent) return;
                    if (intent.positionId || intent.tradeId) {
                        if (String(intent.positionId) === String(positionId) && String(intent.tradeId) === String(tradeId)) linked = intent;
                        return;
                    }
                    const owned = await requireOwnedReferences({ userId, brokerAccountId, strategyId, tradeId });
                    if (!owned) return;
                    const position = await Position.findOne({ _id: positionId, userId, brokerAccountId, strategyId, tradeId }).session(session).lean().exec();
                    if (!position) return;

                    const locked = await Position.findOneAndUpdate(
                        { _id: positionId, userId, brokerAccountId, strategyId, tradeId, version: position.version ?? 0, intentRevision: position.intentRevision ?? 0 },
                        { $inc: { intentRevision: 1, version: 1 } },
                        { returnDocument: 'after', runValidators: true, session }
                    );
                    if (!locked) return;
                    linked = await OrderIntent.findOneAndUpdate(
                        { _id: intentRecordId, userId, brokerAccountId, strategyId, version: expectedVersion, positionId: { $exists: false }, tradeId: { $exists: false } },
                        { $set: { positionId, tradeId }, $inc: { version: 1 } },
                        { returnDocument: 'after', runValidators: true, session }
                    );
                });
            } finally {
                await session.endSession();
            }
            return linked;
        },

        async findOrderIntent({ userId, brokerAccountId, intentRecordId }) {
            if (![userId, brokerAccountId, intentRecordId].every(hasIdentity)) return null;
            return OrderIntent.findOne({ _id: intentRecordId, userId, brokerAccountId });
        },

        async transitionOrderIntent({ userId, brokerAccountId, intentRecordId, expectedVersion, expectedStatuses, status, changes = {} }) {
            if (![userId, brokerAccountId, intentRecordId].every(hasIdentity)) throw new TypeError('owner and order intent IDs are required');
            if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new TypeError('expectedVersion is required');
            if (!Array.isArray(expectedStatuses) || expectedStatuses.length === 0) throw new TypeError('expectedStatuses is required');
            const unsupported = expectedStatuses.find((current) => !canTransition(INTENT_TRANSITIONS, current, status));
            if (unsupported) throw new Error(`Invalid order intent transition: ${unsupported} -> ${status}`);
            const safeChanges = pickAllowed(changes, INTENT_UPDATE_FIELDS, 'order intent update');
            return OrderIntent.findOneAndUpdate(
                { _id: intentRecordId, userId, brokerAccountId, version: expectedVersion, status: { $in: expectedStatuses } },
                { $set: { ...safeChanges, status }, $inc: { version: 1 } },
                { returnDocument: 'after', runValidators: true }
            );
        },
    });
}

const repository = createAccountRepository({
    BrokerAccount: require('../models/BrokerAccount'),
    Strategy: require('../models/Strategy'),
    StrategySettings: require('../models/StrategySettings'),
    Trade: require('../models/Trade'),
    Position: require('../models/Position'),
    OrderIntent: require('../models/OrderIntent'),
});

module.exports = Object.freeze({
    ...repository,
    createAccountRepository,
    INTENT_TRANSITIONS,
    POSITION_TRANSITIONS,
});
