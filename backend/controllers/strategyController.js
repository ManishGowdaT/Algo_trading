const Strategy = require('../models/Strategy');
const strategyEngine = require('../services/strategyEngine');
const strategyStats = require('../services/strategyStats');
const activeAccountService = require('../services/activeAccountService');
const strategyRegistry = require('../services/strategyRegistry');
const { InputValidationError, validateStrategyConfig } = require('../utils/inputValidation');
const { respondWithApiError } = require('../middleware/apiErrors');

async function requireRegisteredStrategy(strategyName) {
    if (typeof strategyName !== 'string' || strategyName.length > 64 || !strategyName.trim()) {
        throw new InputValidationError('A valid strategy name is required.');
    }
    await strategyRegistry.init();
    if (!strategyRegistry.hasPlugin(strategyName)) {
        throw new InputValidationError('Unsupported strategy.');
    }
}

function sendFailure(req, res, err) {
    return respondWithApiError(req, res, err);
}

exports.getStrategyCount = async (req, res) => {
    try {
        const count = await Strategy.countDocuments({ userId: req.user._id, internalExecutionOnly: { $ne: true } });
        res.status(200).json({
            status: 'success',
            data: {
                count
            }
        });
    } catch (err) {
        respondWithApiError(req, res, err);
    }
};

exports.getAllStrategies = async (req, res) => {
    try {
        const strategies = await Strategy.find({ userId: req.user._id, internalExecutionOnly: { $ne: true } }).select('_id name');
        res.status(200).json({
            status: 'success',
            data: {
                strategies
            }
        });
    } catch (err) {
        respondWithApiError(req, res, err);
    }
};

exports.startStrategy = async (req, res) => {
    try {
        activeAccountService.assertActiveUser(req.user._id, req.accountContext?.brokerAccountId);
        await require('../services/startupRecovery').assertStrategyStartAllowed(req.accountContext);
        const { strategyName } = req.params;
        if (strategyName === 'IndexVwapOrb') await require('../services/indexVwapOrbAvailability').assertEnabled(req.accountContext);
        await requireRegisteredStrategy(strategyName);
        const config = validateStrategyConfig(strategyName, req.body === undefined ? {} : req.body);
        await require('../services/strategySettingsService').save(req.accountContext, strategyName, config);
        const status = await strategyEngine.startStrategy(req.user._id.toString(), strategyName, config);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};

exports.stopStrategy = async (req, res) => {
    try {
        activeAccountService.assertActiveUser(req.user._id, req.accountContext?.brokerAccountId);
        const { strategyName } = req.params;
        await requireRegisteredStrategy(strategyName);
        const status = strategyEngine.stopStrategy(req.user._id.toString(), strategyName, req.accountContext);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};

exports.getStrategyStatus = async (req, res) => {
    try {
        const { strategyName } = req.params;
        if (strategyName === 'IndexVwapOrb') await require('../services/indexVwapOrbAvailability').assertEnabled(req.accountContext);
        await requireRegisteredStrategy(strategyName);
        const status = strategyEngine.getStrategyStatus(req.user._id.toString(), strategyName, req.accountContext);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};

exports.exitStrategyPosition = async (req, res) => {
    try {
        activeAccountService.assertActiveUser(req.user._id, req.accountContext?.brokerAccountId);
        const { strategyName } = req.params;
        await requireRegisteredStrategy(strategyName);
        const status = await strategyEngine.manualExitStrategy(req.user._id.toString(), strategyName);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        sendFailure(req, res, err);
    }
};

/**
 * GET /api/v1/strategies/stats/report
 * Returns the live condition evaluation statistics collected since last reset.
 */
exports.getConditionReport = (req, res) => {
    try {
        const report = strategyStats.getReport(req.user._id);
        res.status(200).json({ status: 'success', data: report });
    } catch (err) {
        respondWithApiError(req, res, err);
    }
};

/**
 * POST /api/v1/strategies/stats/reset
 * Clears all counters so data collection starts fresh.
 */
exports.resetConditionReport = (req, res) => {
    try {
        strategyStats.reset(req.user._id);
        res.status(200).json({ status: 'success', message: 'Statistics counters reset.' });
    } catch (err) {
        respondWithApiError(req, res, err);
    }
};

/**
 * GET /api/v1/strategies/manifests
 * Returns schemas of all registered strategy plugins.
 */
exports.getManifests = async (req, res) => {
    try {
        const strategyRegistry = require('../services/strategyRegistry');
        const manifests = await require('../services/indexVwapOrbAvailability').manifestsForUser(strategyRegistry.getManifests(), req.user._id);
        res.status(200).json({ status: 'success', data: { manifests } });
    } catch (err) {
        respondWithApiError(req, res, err);
    }
};
