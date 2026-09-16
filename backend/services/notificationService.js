const config = require('../config');
const activeAccountService = require('./activeAccountService');

function sanitizeDetails(details = {}) {
  const active = activeAccountService.getActiveAccount();
  const userId = details.userId || active?.userId;
  const accountLabel = details.accountLabel || active?.accountLabel || (userId ? `${String(userId).slice(0, 4)}****${String(userId).slice(-4)}` : 'unknown');
  const clientCode = details.clientCode || active?.clientCode;
  const allowed = ['strategyName', 'symbol', 'quantity', 'state', 'reason', 'lastKnownLtp'];
  const sanitized = Object.fromEntries(allowed.filter((key) => details[key] !== undefined).map((key) => [key, details[key]]));
  return {
    ...sanitized,
    accountLabel,
    accountUserId: userId || null,
    ...(clientCode ? { clientCode } : {}),
  };
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
