const config = require('../config');

function sanitizeDetails(details = {}) {
  const allowed = ['strategyName', 'symbol', 'quantity', 'state', 'reason', 'lastKnownLtp', 'clientCode'];
  return Object.fromEntries(allowed.filter((key) => details[key] !== undefined).map((key) => [key, details[key]]));
}

async function notifyUrgent(event, details = {}) {
  const payload = {
    event,
    at: new Date().toISOString(),
    details: sanitizeDetails(details),
  };

  console.error('[URGENT BROKER ALERT]', JSON.stringify(payload));

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return { delivered: false, reason: 'ALERT_WEBHOOK_URL is not configured' };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.API.TIMEOUT_MS),
    });
    return { delivered: response.ok, status: response.status };
  } catch (err) {
    console.error('[NotificationService] Webhook delivery failed:', err.message);
    return { delivered: false, reason: err.message };
  }
}

module.exports = { notifyUrgent };
