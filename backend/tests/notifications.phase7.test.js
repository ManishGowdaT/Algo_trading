const test = require('node:test');
const assert = require('node:assert/strict');

test('urgent notifications require explicit verified account scope and never use a global active account', async (t) => {
  const previousFetch = global.fetch;
  const previousWebhook = process.env.ALERT_WEBHOOK_URL;
  const requests = [];
  process.env.ALERT_WEBHOOK_URL = 'https://notifications.invalid/hook';
  global.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, status: 200 };
  };
  t.after(() => {
    global.fetch = previousFetch;
    if (previousWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL;
    else process.env.ALERT_WEBHOOK_URL = previousWebhook;
  });

  const { notifyUrgent } = require('../services/notificationService');
  const unscoped = await notifyUrgent('BROKER_SESSION_LOST', { reason: 'no ownership context' });
  assert.equal(unscoped.delivered, false);
  assert.deepEqual(requests, []);

  const scoped = await notifyUrgent('OPEN_POSITION_UNPROTECTED', {
    userId: 'user-a', brokerAccountId: 'account-a', strategyName: 'HeikenAshi', reason: 'test',
  });
  assert.equal(scoped.delivered, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].details.accountUserId, 'user-a');
  assert.equal(requests[0].details.brokerAccountId, 'account-a');
  assert.equal(requests[0].details.reason, 'test');
});

test('health degradation and restoration notifications are sent only to explicitly connected account scopes', async t => {
  const active = require('../services/activeAccountService');
  const monitor = require('../services/healthMonitor');
  const previousFetch = global.fetch;
  const previousWebhook = process.env.ALERT_WEBHOOK_URL;
  const requests = [];
  process.env.ALERT_WEBHOOK_URL = 'https://notifications.invalid/hook';
  global.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, status: 200 }; };
  active.clearActiveAccount('user-a', 'account-a');
  active.clearActiveAccount('user-b', 'account-b');
  monitor.accountOperationalStates.clear();
  active.setActiveAccount({ userId: 'user-a', brokerAccountId: 'account-a', clientCode: 'CLIENT-A' });
  active.setActiveAccount({ userId: 'user-b', brokerAccountId: 'account-b', clientCode: 'CLIENT-B' });
  t.after(() => {
    global.fetch = previousFetch;
    if (previousWebhook === undefined) delete process.env.ALERT_WEBHOOK_URL; else process.env.ALERT_WEBHOOK_URL = previousWebhook;
    active.clearActiveAccount('user-a', 'account-a'); active.clearActiveAccount('user-b', 'account-b');
    monitor.accountOperationalStates.clear();
  });

  await monitor.notifyAccountHealth(false, { pythonStatus: 'timeout', mongoDb: true });
  await monitor.notifyAccountHealth(true, { pythonStatus: 'ready', mongoDb: true });
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map(item => item.event), [
    'SYSTEM_HEALTH_DEGRADED', 'SYSTEM_HEALTH_DEGRADED', 'SYSTEM_HEALTH_RESTORED', 'SYSTEM_HEALTH_RESTORED',
  ]);
  assert.deepEqual(new Set(requests.map(item => `${item.details.accountUserId}:${item.details.brokerAccountId}`)),
    new Set(['user-a:account-a', 'user-b:account-b']));
  assert.ok(requests.every(item => item.details.accountUserId && item.details.brokerAccountId));
});
