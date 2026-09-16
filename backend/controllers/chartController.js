const chartService = require('../services/chartService');
const config = require('../config');

const ltpCache = new Map();

exports.getMarketChartData = async (req, res) => {
  try {
    const { underlying, date, interval } = req.query;
    const data = await chartService.getMarketChartData({ underlying, date, interval, userId: req.user._id });
    res.status(200).json({
      status: 'success',
      data,
    });
  } catch (err) {
    console.error('Error in getMarketChartData controller:', err.message);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Failed to fetch market chart data',
    });
  }
};

exports.getIndexLtp = async (req, res) => {
  try {
    const underlying = (req.query.underlying || 'NIFTY').toUpperCase();
    const cached = ltpCache.get(underlying);
    if (cached && Date.now() - cached.timestamp < 2000) {
      return res.status(200).json(cached.data);
    }

    const response = await fetch(`${config.API.ANGEL_ONE_API_BASE}/market/index-ltp?underlying=${encodeURIComponent(underlying)}`, {
      headers: { 'X-Internal-Service-Key': config.API.INTERNAL_SERVICE_KEY },
    });
    if (!response.ok) {
      const text = await response.text();
      // This route is reached after Node application authentication. A 401
      // from Python means the Angel One session is unavailable, not that the
      // application JWT expired. Return a non-auth status so the frontend
      // does not redirect the user back to the sign-in page.
      if (response.status === 401) {
        return res.status(503).json({
          status: 'fail',
          message: 'Angel One broker session is unavailable',
          brokerSessionUnavailable: true,
        });
      }
      return res.status(response.status).send(text);
    }
    const data = await response.json();
    ltpCache.set(underlying, { timestamp: Date.now(), data });
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
};
