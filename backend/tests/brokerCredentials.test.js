const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { collections } = require('./helpers/mongooseMemory');
const Credential = require('../models/BrokerCredential');
const vault = require('../services/brokerCredentialVault');

const userA = '111111111111111111111111';
const userB = '222222222222222222222222';
const input = { clientCode: 'CLIENT-A', apiKey: 'test-broker-api-key', totpSecret: 'JBSWY3DPEHPK3PXP' };

function fixture(t, models = [Credential], seeds = {}) {
  const oldKeys = process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS;
  const oldVersion = process.env.BROKER_CREDENTIAL_ACTIVE_KEY_VERSION;
  process.env.BROKER_CREDENTIAL_ACTIVE_KEY_VERSION = 'test-v1';
  process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ 'test-v1': crypto.randomBytes(32).toString('base64') });
  t.after(() => {
    if (oldKeys === undefined) delete process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS; else process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS = oldKeys;
    if (oldVersion === undefined) delete process.env.BROKER_CREDENTIAL_ACTIVE_KEY_VERSION; else process.env.BROKER_CREDENTIAL_ACTIVE_KEY_VERSION = oldVersion;
  });
  const stores = collections(t, models, seeds);
  // The real Mongo driver serializes nested Mongoose subdocuments. Match that
  // boundary here instead of retaining their internal JavaScript properties.
  const update = Credential.collection.updateOne;
  Credential.collection.updateOne = (filter, mutation, options) => update(filter, JSON.parse(JSON.stringify(mutation)), options);
  return stores;
}

test('vault encrypts persisted credentials with distinct nonces; MPIN and app passwords are absent', async t => {
  const stores = fixture(t);
  await vault.save(userA, { ...input, mpin: '0123', currentPassword: 'not-stored' });
  const raw = stores.BrokerCredential[0];
  const serialized = JSON.stringify(raw);
  for (const secret of [...Object.values(input), '0123', 'not-stored']) assert.ok(!serialized.includes(secret));
  assert.equal(raw.clientCode.nonce === raw.apiKey.nonce, false);
  assert.equal(raw.apiKey.nonce === raw.totpSecret.nonce, false);
  assert.equal(raw.mpin, undefined);
  const saved = await vault.get(userA);
  assert.equal(saved.apiKey, input.apiKey);
  assert.equal(saved.clientCode, input.clientCode);
  assert.equal(saved.totpSecret, input.totpSecret);
  assert.equal(Credential.schema.path('apiKey').options.select, false);
  assert.equal(Credential.schema.path('totpSecret').options.select, false);
});

test('vault reads, metadata and verification are isolated to their owner', async t => {
  fixture(t);
  await vault.save(userA, input);
  assert.equal(await vault.get(userB), null);
  assert.equal((await vault.metadata(userB)).configured, false);
  const metadata = await vault.metadata(userA);
  assert.equal(metadata.clientCode, '****NT-A');
  assert.equal(metadata.apiKey, undefined);
  assert.equal(metadata.totpSecret, undefined);
  assert.equal(await vault.markVerified(userB, new mongoose.Types.ObjectId(), 1), false);
  assert.equal((await vault.metadata(userA)).verified, false);
});

test('ciphertext tampering, owner replay and field replay fail authentication', async t => {
  const stores = fixture(t);
  await vault.save(userA, input);
  const row = stores.BrokerCredential[0];
  const original = structuredClone(row.apiKey);
  const bytes = Buffer.from(row.apiKey.ciphertext, 'base64'); bytes[0] ^= 1;
  row.apiKey.ciphertext = bytes.toString('base64');
  await assert.rejects(vault.get(userA));
  row.apiKey = original;
  row.userId = new mongoose.Types.ObjectId(userB);
  await assert.rejects(vault.get(userB));
  row.userId = new mongoose.Types.ObjectId(userA);
  row.apiKey = structuredClone(row.totpSecret);
  await assert.rejects(vault.get(userA));
});

test('missing keys fail closed; retained old keys permit rotation without losing saved setup', async t => {
  const stores = fixture(t);
  const oldKeyring = process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS;
  delete process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS;
  await assert.rejects(vault.save(userA, input), /not configured/);
  assert.equal(stores.BrokerCredential.length, 0);
  process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS = oldKeyring;
  await vault.save(userA, input);
  const keyring = JSON.parse(oldKeyring);
  keyring['test-v2'] = crypto.randomBytes(32).toString('base64');
  process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify(keyring);
  process.env.BROKER_CREDENTIAL_ACTIVE_KEY_VERSION = 'test-v2';
  assert.equal((await vault.get(userA)).apiKey, input.apiKey);
  await vault.save(userA, input, 1);
  assert.equal(stores.BrokerCredential[0].apiKey.keyVersion, 'test-v2');
  assert.equal((await vault.get(userA)).apiKey, input.apiKey);
});

test('stale saves and concurrent replacements cannot overwrite a newer credential version', async t => {
  fixture(t);
  await vault.save(userA, input);
  await assert.rejects(vault.save(userA, input, 0), { status: 409 });
  const results = await Promise.allSettled([
    vault.save(userA, { ...input, apiKey: 'replacement-api-key-one' }, 1),
    vault.save(userA, { ...input, apiKey: 'replacement-api-key-two' }, 1),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.status === 409).length, 1);
  assert.equal((await vault.get(userA)).version, 2);
});

test('invalid deployment keyrings fail with secret-free diagnostic codes, including JSON null', async t => {
  const stores = fixture(t);
  for (const value of ['null', '[]', '"key"', '123']) {
    process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS = value;
    await assert.rejects(vault.save(userA, input), { code: 'BROKER_VAULT_INVALID_KEYRING_OBJECT' });
  }
  process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS = '{';
  await assert.rejects(vault.save(userA, input), { code: 'BROKER_VAULT_INVALID_KEYRING_JSON' });
  process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ 'test-v1': 123 });
  await assert.rejects(vault.save(userA, input), { code: 'BROKER_VAULT_INVALID_KEY_VALUE' });
  assert.equal(stores.BrokerCredential.length, 0);
});

test('HTTP setup saves through POST, MPIN-only login uses server secrets, and replacement respects active exposure', async t => {
  const express = require('express');
  const bcrypt = require('bcryptjs');
  const BrokerAccount = require('../models/BrokerAccount');
  const User = require('../models/User');
  const Position = require('../models/Position');
  const OrderIntent = require('../models/OrderIntent');
  const Trade = require('../models/Trade');
  const stores = fixture(t, [Credential, BrokerAccount, User, Position, OrderIntent, Trade], {
    User: [{ _id: new mongoose.Types.ObjectId(userA), email: 'test@example.com', password: await bcrypt.hash('app-password', 4) }],
  });
  const auth = require('../controllers/authController');
  const originalProtect = auth.protect;
  auth.protect = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer test-app-token') return res.status(401).json({ message: 'Authentication required.' });
    req.user = { _id: new mongoose.Types.ObjectId(userA) }; next();
  };
  const routePath = require.resolve('../routes/brokerProxyRoutes');
  delete require.cache[routePath];
  const app = express(); app.use(express.json()); app.use(require(routePath));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = global.fetch;
  const oldInternalKey = process.env.INTERNAL_SERVICE_KEY;
  const config = require('../config');
  const oldConfigKey = config.API.INTERNAL_SERVICE_KEY;
  config.API.INTERNAL_SERVICE_KEY = 'test-internal-key';
  const pythonCalls = [];
  let rejectBrokerLogin = false;
  global.fetch = async (url, options) => {
    if (String(url).startsWith(base)) return originalFetch(url, options);
    pythonCalls.push({ url, options });
    if (rejectBrokerLogin && String(url).endsWith('/angel/login')) return {
      ok: false, status: 400, headers: new Headers(),
      text: async () => JSON.stringify({ status: false, apiKey: input.apiKey,
        message: `Rejected ${input.apiKey} ${input.totpSecret} 0123` }),
    };
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ status: true, client_code: input.clientCode, session_id: 'test-broker-session' }) };
  };
  t.after(async () => {
    auth.protect = originalProtect; global.fetch = originalFetch;
    config.API.INTERNAL_SERVICE_KEY = oldConfigKey;
    if (oldInternalKey === undefined) delete process.env.INTERNAL_SERVICE_KEY; else process.env.INTERNAL_SERVICE_KEY = oldInternalKey;
    require('../services/activeAccountService').clearActiveAccount(userA);
    require('../services/marketSessionManager').stopMonitoring();
    delete require.cache[routePath];
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  const request = (path, body, authenticated = true) => global.fetch(base + path, {
    method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer test-app-token' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await request('/angel/credentials/status', null, false)).status, 401);
  assert.equal((await request('/angel/credentials', { ...input, consent: true, mpin: '0123' })).status, 400);
  const setup = await request('/angel/credentials', { ...input, consent: true });
  assert.equal(setup.status, 200); assert.equal((await setup.json()).configured, true);
  const connection = await request('/angel/login', { mpin: '0123', useSavedCredentials: true });
  const result = await connection.json();
  assert.equal(connection.status, 200); assert.equal(result.connected, true);
  const login = pythonCalls.find(call => call.url.endsWith('/angel/login'));
  const brokerBody = JSON.parse(login.options.body);
  assert.equal(brokerBody.apiKey, input.apiKey); assert.equal(brokerBody.totpSecret, input.totpSecret); assert.equal(brokerBody.mpin, '0123');
  assert.equal(result.apiKey, undefined); assert.equal(result.totpSecret, undefined);
  assert.equal((await vault.metadata(userA)).verified, true);
  rejectBrokerLogin = true;
  const failed = await request('/angel/login', { mpin: '0123', useSavedCredentials: true });
  assert.equal(failed.status, 400);
  const diagnostic = JSON.stringify(await failed.json());
  for (const secret of [input.apiKey, input.totpSecret, '0123']) assert.ok(!diagnostic.includes(secret));
  rejectBrokerLogin = false;
  assert.equal((await request('/angel/credentials', { ...input, consent: true })).status, 403);
  assert.equal((await request('/angel/credentials', { ...input, consent: true, currentPassword: 'app-password' })).status, 409);
  require('../services/activeAccountService').clearActiveAccount(userA);
  const account = stores.BrokerAccount[0]; account.status = 'DISCONNECTED';
  stores.Position.push({ _id: new mongoose.Types.ObjectId(), userId: account.userId, brokerAccountId: account._id, status: 'OPEN' });
  assert.equal((await request('/angel/credentials', { ...input, consent: true, currentPassword: 'app-password' })).status, 409);
  assert.equal((await vault.get(userA)).version, 1);
});
