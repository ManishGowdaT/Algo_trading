const helmet = require('helmet');

function permissionsPolicy(req, res, next) {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function addHstsOnlyForHttps(production) {
  return (req, res, next) => {
    if (production && req.secure) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    }
    next();
  };
}

function createSecurityHeaders({ production = process.env.NODE_ENV === 'production' } = {}) {
  return [helmet({
    // The API does not serve the frontend document. Add CSP only after the
    // frontend's script/style/connect sources have been audited and tested.
    contentSecurityPolicy: false,
    // These policies are for document/resource embedding and are unnecessary
    // for this JSON API; avoid changing cross-origin frontend behavior.
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    // HSTS is added separately only when Express sees a trusted HTTPS request.
    hsts: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }), addHstsOnlyForHttps(production), permissionsPolicy];
}

module.exports = createSecurityHeaders;
