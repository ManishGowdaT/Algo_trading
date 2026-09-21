const healthMonitor = require('../services/healthMonitor');

exports.health = (req, res) => {
  const health = healthMonitor.getStatus();
  const ready = Boolean(health.pythonApi && health.mongoDb);
  return res.status(200).json({
    ready,
    pythonApi: Boolean(health.pythonApi),
    mongoDb: Boolean(health.mongoDb),
    lastCheck: health.lastCheck,
  });
};
