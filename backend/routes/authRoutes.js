const express = require('express');
const authController = require('../controllers/authController');
const { authLoginDiagnostics, authLoginLimiter, authRegisterLimiter } = require('../middleware/rateLimiters');

const router = express.Router();

router.post('/login', authLoginDiagnostics, authLoginLimiter, authController.login);
router.post('/register', authRegisterLimiter, authController.register);
router.post('/logout', authController.logout);
router.post('/refresh', authController.refresh);
router.get('/me', authController.protect, authController.getMe);

module.exports = router;
