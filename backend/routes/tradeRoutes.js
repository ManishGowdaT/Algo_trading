const express = require('express');
const tradeController = require('../controllers/tradeController');
const authController = require('../controllers/authController');
const { tradeReadLimiter, tradeWriteLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.use(authController.protect); // All trade routes are protected
router.get('/', tradeReadLimiter, tradeController.getAllTrades);
router.get('/stats', tradeReadLimiter, tradeController.getStats);
router.get('/latest-open', tradeReadLimiter, tradeController.getLatestOpenTrade);

router.post('/record', tradeWriteLimiter, tradeController.recordTrade);
router.post('/update-exit', tradeWriteLimiter, tradeController.updateTradeExit);
router.delete('/:tradeId', tradeWriteLimiter, tradeController.deleteTrade);

module.exports = router;
