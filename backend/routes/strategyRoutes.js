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
router.get('/settings/:strategyName', require('../services/accountContext').readMiddleware, require('../controllers/strategySettingsController').get);
router.post('/settings/:strategyName', require('../services/accountContext').middleware, require('../controllers/strategySettingsController').save);
router.get('/stats/report', strategyReadLimiter, strategyController.getConditionReport);
router.post('/stats/reset', strategyController.resetConditionReport);

router.post('/:strategyName/start', strategyStartLimiter, require('../services/accountContext').middleware, strategyController.startStrategy);
router.post('/:strategyName/stop', require('../services/accountContext').middleware, strategyController.stopStrategy);
router.get('/:strategyName/status', strategyReadLimiter, require('../services/accountContext').readMiddleware, strategyController.getStrategyStatus);
router.post('/:strategyName/exit', require('../services/accountContext').middleware, strategyController.exitStrategyPosition);

module.exports = router;
