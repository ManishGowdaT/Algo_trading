const express = require('express');
const authController = require('../controllers/authController');
const proxy = require('../controllers/brokerProxyController');
const {
  angelLoginLimiter,
  brokerReadLimiter,
  marketReadLimiter,
  orderPlacementLimiter,
} = require('../middleware/rateLimiters');

const router = express.Router();
router.use(authController.protect);

router.post('/angel/login', angelLoginLimiter, proxy.login);
router.post('/angel/logout', proxy.logout);
router.get('/angel/status', brokerReadLimiter, proxy.status);

router.get('/angel/margins', brokerReadLimiter, proxy.forwardGet('/angel/margins'));
router.post('/angel/margins/required', brokerReadLimiter, proxy.forwardPost('/angel/margins/required'));
router.get('/angel/profile', brokerReadLimiter, proxy.forwardGet('/angel/profile'));
router.get('/angel/orderbook', brokerReadLimiter, proxy.forwardGet('/angel/orderbook'));
router.get('/angel/positions', brokerReadLimiter, proxy.forwardGet('/angel/positions'));
router.post('/angel/positions/exit', proxy.forwardPost('/angel/positions/exit'));
router.post('/angel/orders/simple', orderPlacementLimiter, proxy.forwardPost('/angel/orders/simple'));
router.post('/angel/orders/:orderId/cancel', (req, res) => proxy.forwardPost(`/angel/orders/${encodeURIComponent(req.params.orderId)}/cancel`)(req, res));

router.get('/market/candles', marketReadLimiter, proxy.forwardGet('/market/candles'));
router.get('/market/ltp', marketReadLimiter, proxy.forwardGet('/market/ltp'));
router.get('/instruments/index-options', marketReadLimiter, proxy.forwardGet('/instruments/index-options'));

module.exports = router;
