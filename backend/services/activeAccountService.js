let activeAccount = null;

function getActiveAccount() {
  return activeAccount ? { ...activeAccount } : null;
}

function maskClientCode(clientCode) {
  const value = clientCode ? String(clientCode) : '';
  return value ? `****${value.slice(-4)}` : null;
}

function maskUserId(userId) {
  const value = String(userId || 'unknown');
  return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : 'unknown';
}

function setActiveAccount({ userId, email = null, clientCode = null, sessionId = null }) {
  activeAccount = {
    userId: String(userId),
    accountLabel: email ? String(email).replace(/^(.{2}).*(@.*)$/, '$1****$2') : maskUserId(userId),
    clientCode: maskClientCode(clientCode),
    sessionId: sessionId || null,
    connectedAt: new Date().toISOString(),
  };
  return getActiveAccount();
}

function clearActiveAccount() {
  activeAccount = null;
}

function assertActiveUser(userId) {
  if (!activeAccount || activeAccount.userId !== String(userId)) {
    const error = new Error('This account is not the active Angel One account. Connect it before trading.');
    error.status = 409;
    error.code = 'INACTIVE_BROKER_ACCOUNT';
    throw error;
  }
}

module.exports = { getActiveAccount, setActiveAccount, clearActiveAccount, assertActiveUser };
