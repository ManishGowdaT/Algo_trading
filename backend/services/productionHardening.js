'use strict';

const crypto = require('node:crypto');

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.internal') || host === '::1') return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

function validateProductionConfig(env = process.env) {
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production'
    || String(env.APP_ENV || '').toLowerCase() === 'production';
  if (!production) return [];
  const errors = [];
  const secret = String(env.INTERNAL_SERVICE_KEY || env.ANGEL_ONE_INTERNAL_SECRET || '').trim();
  if (secret.length < 32) errors.push('INTERNAL_SERVICE_KEY must contain at least 32 characters in production');
  if (!env.MONGO_URI) errors.push('MONGO_URI must be configured in production');
  if (env.MONGO_URI && env.MONGO_URI.startsWith('mongodb://')) {
    let mongoUrl;
    try { mongoUrl = new URL(env.MONGO_URI); } catch { /* handled as missing TLS below */ }
    const tls = mongoUrl && (mongoUrl.searchParams.get('tls') === 'true' || mongoUrl.searchParams.get('ssl') === 'true');
    if (!tls) errors.push('mongodb:// production connections must explicitly enable tls=true');
  } else if (env.MONGO_URI && !env.MONGO_URI.startsWith('mongodb+srv://')) {
    errors.push('MONGO_URI must use mongodb+srv:// or mongodb:// with tls=true');
  }
  const origins = String(env.CORS_ORIGIN || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!origins.length || origins.includes('*') || origins.some(origin => {
    try { return new URL(origin).protocol !== 'https:'; } catch { return true; }
  })) errors.push('CORS_ORIGIN must contain explicit HTTPS origins in production');
  let serviceUrl;
  try { serviceUrl = new URL(env.ANGEL_ONE_API_BASE || ''); } catch { /* reported below */ }
  if (!serviceUrl || (serviceUrl.protocol !== 'https:' && !(
    serviceUrl.protocol === 'http:' && env.ALLOW_PRIVATE_HTTP_SERVICE === 'true' && isPrivateHost(serviceUrl.hostname)
  ))) errors.push('ANGEL_ONE_API_BASE must use HTTPS; private HTTP requires an explicit private-network opt-in');
  if (serviceUrl?.protocol === 'http:' && env.ALLOW_PRIVATE_HTTP_SERVICE === 'true' && !isPrivateHost(serviceUrl.hostname)) {
    errors.push('Private HTTP service URL must use a private-network hostname');
  }
  if (env.ALERT_WEBHOOK_URL) {
    try { if (new URL(env.ALERT_WEBHOOK_URL).protocol !== 'https:') errors.push('ALERT_WEBHOOK_URL must use HTTPS in production'); }
    catch { errors.push('ALERT_WEBHOOK_URL must be a valid HTTPS URL in production'); }
  }
  return errors;
}

function redact(value) {
  const keys = '(?:api.?key|mpin|totp(?:.?secret)?|password|access.?token|refresh.?token|jwt.?token|feed.?token|authorization|internal.?service.?key)';
  return String(value ?? '')
    // Quoted JSON/log values may contain whitespace and escaped quotes.
    .replace(new RegExp(`(["']?${keys}["']?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, 'ig'), '$1"[REDACTED]"')
    .replace(new RegExp(`(${keys}\\s*[:=]\\s*)(?:Bearer\\s+|Basic\\s+)?[^,;\\s]+`, 'ig'), '$1[REDACTED]');
}

const metricCounts = new Map();
function increment(name) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw new TypeError('Invalid metric name');
  metricCounts.set(name, (metricCounts.get(name) || 0) + 1);
}
function metricsSnapshot() { return Object.fromEntries(metricCounts); }

function audit(event, context, attributes = {}) {
  const row = {
    type: 'trading_audit', event: String(event).slice(0, 80), at: new Date().toISOString(),
    requestId: attributes.requestId ? String(attributes.requestId).slice(0, 100) : undefined,
    userId: context?.userId ? String(context.userId) : undefined,
    brokerAccountId: context?.brokerAccountId ? String(context.brokerAccountId) : undefined,
    sessionGeneration: Number.isInteger(context?.sessionGeneration) ? context.sessionGeneration : undefined,
    attributes: Object.fromEntries(Object.entries(attributes).filter(([key, value]) =>
      !/secret|token|password|api.?key|mpin|totp|credential|authorization|body/i.test(key) && value != null
    ).map(([key, value]) => [key, typeof value === 'string' ? redact(value).slice(0, 160) : value])),
  };
  increment('audit_events_total');
  console.log(JSON.stringify(row));
  return row;
}

function newRequestId() { return crypto.randomUUID(); }

module.exports = { validateProductionConfig, isPrivateHost, redact, audit, increment, metricsSnapshot, newRequestId };
