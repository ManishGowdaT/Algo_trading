const activeAccounts = new Map();

function key(userId, brokerAccountId) {
  if (!userId || !brokerAccountId) return null;
  return `${String(userId)}:${String(brokerAccountId)}`;
}

// Legacy process-wide consumers may only observe state when there is exactly
// one connected account. Account-aware requests must always pass both ids.
function getActiveAccount(userId, brokerAccountId) {
  if (userId && brokerAccountId) {
    const account = activeAccounts.get(key(userId, brokerAccountId));
    return account ? { ...account } : null;
  }
  if (activeAccounts.size !== 1) return null;
  return { ...activeAccounts.values().next().value };
}

function maskClientCode(clientCode) {
  const value = clientCode ? String(clientCode) : '';
  return value ? `****${value.slice(-4)}` : null;
}

function maskUserId(userId) {
  const value = String(userId || 'unknown');
  return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : 'unknown';
}

function setActiveAccount({ userId, email = null, clientCode = null, sessionId = null, brokerAccountId = null, sessionGeneration = null, ownerGeneration = null }) {
  const accountKey = key(userId, brokerAccountId);
  if (!accountKey) throw new Error('User and broker account are required');
  const activeAccount = {
    userId: String(userId),
    accountLabel: email ? String(email).replace(/^(.{2}).*(@.*)$/, '$1****$2') : maskUserId(userId),
    clientCode: maskClientCode(clientCode),
    sessionId: sessionId || null,
    brokerAccountId: String(brokerAccountId),
    sessionGeneration,
    ownerGeneration,
    connectedAt: new Date().toISOString(),
  };
  activeAccounts.set(accountKey, activeAccount);
  return { ...activeAccount };
}

function clearActiveAccount(userId, brokerAccountId) {
  if (userId && brokerAccountId) return activeAccounts.delete(key(userId, brokerAccountId));
  // Compatibility for old single-user callers. Never clear another user's
  // state implicitly when multiple accounts exist.
  if (activeAccounts.size === 1) return activeAccounts.clear();
  return false;
}

function assertActiveUser(userId, brokerAccountId) {
  const matches = [...activeAccounts.values()].some(account =>
    account.userId === String(userId) && (!brokerAccountId || account.brokerAccountId === String(brokerAccountId)));
  if (!matches) {
    const error = new Error('This account is not connected. Connect it before trading.');
    error.status = 409;
    error.code = 'INACTIVE_BROKER_ACCOUNT';
    throw error;
  }
}

function listActiveAccounts() { return [...activeAccounts.values()].map(account => ({ ...account })); }

module.exports = { getActiveAccount, setActiveAccount, clearActiveAccount, assertActiveUser, listActiveAccounts };
