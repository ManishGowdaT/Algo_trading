const express = require('express');
const authController = require('../controllers/authController');
const proxy = require('../controllers/brokerProxyController');

const router = express.Router();
router.use(authController.protect);

router.post('/angel/login', proxy.login);
router.post('/angel/logout', proxy.logout);
router.get('/angel/status', proxy.status);

router.get('/angel/margins', proxy.forwardGet('/angel/margins'));
router.post('/angel/margins/required', proxy.forwardPost('/angel/margins/required'));
router.get('/angel/profile', proxy.forwardGet('/angel/profile'));
router.get('/angel/orderbook', proxy.forwardGet('/angel/orderbook'));
router.get('/angel/positions', proxy.forwardGet('/angel/positions'));
router.post('/angel/positions/exit', proxy.forwardPost('/angel/positions/exit'));
router.post('/angel/orders/simple', proxy.forwardPost('/angel/orders/simple'));
router.post('/angel/orders/:orderId/cancel', (req, res) => proxy.forwardPost(`/angel/orders/${encodeURIComponent(req.params.orderId)}/cancel`)(req, res));

router.get('/market/candles', proxy.forwardGet('/market/candles'));
router.get('/market/ltp', proxy.forwardGet('/market/ltp'));
router.get('/instruments/index-options', proxy.forwardGet('/instruments/index-options'));

module.exports = router;
