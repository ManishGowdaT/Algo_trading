const express = require('express');
const router = express.Router();
const chartController = require('../controllers/chartController');
const authController = require('../controllers/authController');
const { marketReadLimiter } = require('../middleware/rateLimiters');

router.use(authController.protect);
router.use(require('../services/accountContext').middleware);

router.get('/market-data', marketReadLimiter, chartController.getMarketChartData);
router.get('/index-ltp', marketReadLimiter, chartController.getIndexLtp);

module.exports = router;
