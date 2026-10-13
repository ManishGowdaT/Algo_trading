const express = require('express');
const authController = require('../controllers/authController');
const controller = require('../controllers/spreadController');
const { createUserRateLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
// Observe callback admission even when app authentication rejects it.
// This logs booleans/status only; app authentication remains mandatory.
router.use('/upstox/callback', controller.observeCallback);
router.use(authController.protect);
router.use(createUserRateLimiter({ limit: 30, message: 'Too many Spread Terminal requests. Please wait and retry.' }));
router.get('/nifty/expiries', controller.niftyExpiries);
router.post('/nifty/scan', controller.scanNifty);
router.post('/scan', controller.scanMultiple);
router.get('/trending', controller.discovery);
router.post('/discover', controller.discovery);
router.get('/underlyings/:symbol/expiries', controller.underlyingExpiries);
router.post('/underlyings/:symbol/scan', controller.scanUnderlying);
router.post('/upstox/connect', controller.start);
router.get('/upstox/callback', controller.callback);
router.get('/upstox/status', controller.status);
router.post('/upstox/disconnect', controller.disconnect);

module.exports = router;
