const Strategy = require('../models/Strategy');
const strategyEngine = require('../services/strategyEngine');
const strategyStats = require('../services/strategyStats');
const activeAccountService = require('../services/activeAccountService');

exports.getStrategyCount = async (req, res) => {
    try {
        const count = await Strategy.countDocuments({ userId: req.user._id });
        res.status(200).json({
            status: 'success',
            data: {
                count
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.getAllStrategies = async (req, res) => {
    try {
        const strategies = await Strategy.find({ userId: req.user._id }).select('_id name');
        res.status(200).json({
            status: 'success',
            data: {
                strategies
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.startStrategy = async (req, res) => {
    try {
        activeAccountService.assertActiveUser(req.user._id);
        const { strategyName } = req.params;
        const config = req.body || {};
        const status = await strategyEngine.startStrategy(req.user._id.toString(), strategyName, config);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.stopStrategy = async (req, res) => {
    try {
        activeAccountService.assertActiveUser(req.user._id);
        const { strategyName } = req.params;
        const status = strategyEngine.stopStrategy(req.user._id.toString(), strategyName);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.getStrategyStatus = async (req, res) => {
    try {
        const { strategyName } = req.params;
        const status = strategyEngine.getStrategyStatus(req.user._id.toString(), strategyName);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

exports.exitStrategyPosition = async (req, res) => {
    try {
        activeAccountService.assertActiveUser(req.user._id);
        const { strategyName } = req.params;
        const status = await strategyEngine.manualExitStrategy(req.user._id.toString(), strategyName);
        res.status(200).json({
            status: 'success',
            data: status
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
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
        res.status(500).json({ status: 'error', message: err.message });
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
        res.status(500).json({ status: 'error', message: err.message });
    }
};

/**
 * GET /api/v1/strategies/manifests
 * Returns schemas of all registered strategy plugins.
 */
exports.getManifests = (req, res) => {
    try {
        const strategyRegistry = require('../services/strategyRegistry');
        const manifests = strategyRegistry.getManifests();
        res.status(200).json({ status: 'success', data: { manifests } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};
