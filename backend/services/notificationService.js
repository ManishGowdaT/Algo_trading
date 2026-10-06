const config = require('../config');

function sanitizeDetails(details = {}) {
  const userId = details.userId == null ? null : String(details.userId);
  const brokerAccountId = details.brokerAccountId == null ? null : String(details.brokerAccountId);
  const accountLabel = details.accountLabel || (brokerAccountId ? `account-${brokerAccountId.slice(-6)}` : 'unscoped');
  const allowed = ['strategyName', 'positionId', 'symbol', 'quantity', 'state', 'reason', 'lastKnownLtp'];
  const sanitized = Object.fromEntries(allowed.filter((key) => details[key] !== undefined).map((key) => [key, details[key]]));
  return {
    ...sanitized,
    accountLabel,
    accountUserId: userId || null,
    brokerAccountId,
  };
}

async function notifyUrgent(event, details = {}) {
  const payload = {
    event,
    at: new Date().toISOString(),
    details: sanitizeDetails(details),
  };

  console.error('[URGENT BROKER ALERT]', JSON.stringify(payload));

  if (!payload.details.accountUserId || !payload.details.brokerAccountId) {
    return { delivered: false, reason: 'verified user/account scope is required' };
  }

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn(JSON.stringify({ type: 'alert_delivery_unconfigured', event }));
    return { delivered: false, reason: 'ALERT_WEBHOOK_URL is not configured' };
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.API.TIMEOUT_MS),
    });
    return { delivered: response.ok, status: response.status };
  } catch (err) {
    console.error(`[NotificationService] Webhook delivery failed (${err.name || 'transport error'}).`);
    return { delivered: false, reason: 'webhook transport failed' };
  }
}

module.exports = { notifyUrgent };
