'use strict';

function createGlobalRequestBudget({ limit = 1000 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('Global HTTP concurrency limit must be between 1 and 10000');
  let inFlight = 0;
  return {
    middleware(req, res, next) {
      if (inFlight >= limit) {
        require('../services/productionHardening').increment('http_global_saturated_total');
        return res.status(503).json({ status: 'fail', code: 'SERVICE_CAPACITY_EXCEEDED', message: 'Service capacity is temporarily full. Please retry shortly.' });
      }
      inFlight += 1;
      let released = false;
      const release = () => { if (released) return; released = true; inFlight = Math.max(0, inFlight - 1); };
      res.once('finish', release);
      res.once('close', release);
      return next();
    },
    snapshot() { return { inFlight, limit }; },
  };
}

const configured = Number(process.env.MAX_IN_FLIGHT_HTTP_REQUESTS || 1000);
const globalRequestBudget = createGlobalRequestBudget({ limit: Number.isInteger(configured) && configured > 0 && configured <= 10_000 ? configured : 1000 });

module.exports = { createGlobalRequestBudget, globalRequestBudget };
