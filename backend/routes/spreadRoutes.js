const express = require('express');
const authController = require('../controllers/authController');
const controller = require('../controllers/spreadController');
const { createUserRateLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
// Observe callback admission even when app authentication rejects it.
// This logs booleans/status only; app authentication remains mandatory.
router.use('/upstox/callback', controller.observeCallback);
router.use(authController.protect);
// Loading a 50-name selection performs one read per underlying. Keep these
// authenticated reads out of the smaller scan/OAuth/discovery request budget.
router.get('/underlyings/:symbol/expiries', createUserRateLimiter({
  limit: 120,
  message: 'Too many Spread Terminal expiry requests. Please wait and retry.',
}), controller.underlyingExpiries);
router.use(createUserRateLimiter({ limit: 30, message: 'Too many Spread Terminal requests. Please wait and retry.' }));
router.get('/nifty/expiries', controller.niftyExpiries);
router.post('/nifty/scan', controller.scanNifty);
router.post('/scan', controller.scanMultiple);
router.get('/trending', controller.discovery);
router.post('/discover', controller.discovery);
router.post('/underlyings/:symbol/scan', controller.scanUnderlying);
router.post('/upstox/connect', controller.start);
router.get('/upstox/callback', controller.callback);
router.get('/upstox/status', controller.status);
router.post('/upstox/disconnect', controller.disconnect);

module.exports = router;
