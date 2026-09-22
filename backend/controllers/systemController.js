const healthMonitor = require('../services/healthMonitor');

exports.health = (req, res) => {
  const health = healthMonitor.getStatus();
  const ready = Boolean(health.pythonApi && health.mongoDb);
  const response = {
    ready,
    pythonApi: Boolean(health.pythonApi),
    mongoDb: Boolean(health.mongoDb),
    lastCheck: health.lastCheck,
  };
  if (health.pythonStatus) response.pythonStatus = health.pythonStatus;
  return res.status(200).json(response);
};
