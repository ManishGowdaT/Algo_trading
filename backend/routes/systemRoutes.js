const express = require('express');
const authController = require('../controllers/authController');
const systemController = require('../controllers/systemController');

const router = express.Router();
router.use(authController.protect);
router.get('/health', systemController.health);

module.exports = router;
