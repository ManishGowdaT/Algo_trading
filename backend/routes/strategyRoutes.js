const express = require('express');
const strategyController = require('../controllers/strategyController');
const authController = require('../controllers/authController');
const { strategyReadLimiter, strategyStartLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.use(authController.protect);

router.get('/', strategyReadLimiter, strategyController.getAllStrategies);
router.get('/count', strategyReadLimiter, strategyController.getStrategyCount);

// ── Condition statistics endpoints (must be before /:strategyName wildcard) ──
router.get('/manifests', strategyReadLimiter, strategyController.getManifests);
router.get('/stats/report', strategyReadLimiter, strategyController.getConditionReport);
router.post('/stats/reset', strategyController.resetConditionReport);

router.post('/:strategyName/start', strategyStartLimiter, strategyController.startStrategy);
router.post('/:strategyName/stop', strategyController.stopStrategy);
router.get('/:strategyName/status', strategyReadLimiter, strategyController.getStrategyStatus);
router.post('/:strategyName/exit', strategyController.exitStrategyPosition);

module.exports = router;
