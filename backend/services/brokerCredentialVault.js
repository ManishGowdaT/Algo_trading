const crypto = require('node:crypto');
const BrokerCredential = require('../models/BrokerCredential');
let indexesReady;

async function ensureIndexes() {
  if (!indexesReady) {
    indexesReady = (async () => {
      await BrokerCredential.createIndexes();
      const indexes = await BrokerCredential.collection.indexes();
      if (!indexes.some((index) => index.name === 'uniq_broker_credential_per_user'
        && index.unique && index.key?.userId === 1 && index.key?.broker === 1)) {
        throw new Error('Secure broker credential ownership index is unavailable.');
      }
    })().catch((error) => { indexesReady = null; throw error; });
  }
  return indexesReady;
}

function activeKeyVersion() { return process.env.BROKER_CREDENTIAL_ACTIVE_KEY_VERSION || ''; }

function configurationError(code) {
  return Object.assign(new Error('Broker credential encryption is not configured.'), { code });
}

function encryptionKey(version = activeKeyVersion()) {
  let keyring;
  try { keyring = JSON.parse(process.env.BROKER_CREDENTIAL_ENCRYPTION_KEYS || '{}'); }
  catch { throw configurationError('BROKER_VAULT_INVALID_KEYRING_JSON'); }
  if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring)) {
    throw configurationError('BROKER_VAULT_INVALID_KEYRING_OBJECT');
  }
  if (!version || !Object.hasOwn(keyring, version)) {
    throw configurationError('BROKER_VAULT_MISSING_KEY_VERSION');
  }
  const encoded = keyring[version];
  if (typeof encoded !== 'string' || !encoded) throw configurationError('BROKER_VAULT_INVALID_KEY_VALUE');
  let key;
  try { key = Buffer.from(encoded, 'base64'); } catch { throw configurationError('BROKER_VAULT_INVALID_KEY_VALUE'); }
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw configurationError('BROKER_VAULT_INVALID_KEY_LENGTH_OR_ENCODING');
  }
  return key;
}

function aad({ userId, field, version }) {
  return Buffer.from(`angel-one:${userId}:${field}:${version}`, 'utf8');
}

function encrypt(value, identity) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(identity.keyVersion), nonce);
  cipher.setAAD(aad(identity));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), keyVersion: identity.keyVersion };
}

function decrypt(envelope, identity) {
  if (!envelope?.keyVersion) throw new Error('Saved broker credentials need to be set up again.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(envelope.keyVersion), Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(aad(identity));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function validate({ apiKey, clientCode, totpSecret }) {
  const values = {
    apiKey: String(apiKey || '').trim(),
    clientCode: String(clientCode || '').trim().toUpperCase(),
    totpSecret: String(totpSecret || '').replace(/\s+/g, '').toUpperCase(),
  };
  if (values.apiKey.length < 8 || values.apiKey.length > 256) throw Object.assign(new Error('Enter a valid SmartAPI key.'), { status: 400 });
  if (!/^[A-Z0-9_-]{1,64}$/.test(values.clientCode)) throw Object.assign(new Error('Enter a valid Angel One client ID.'), { status: 400 });
  if (!/^[A-Z2-7]+=*$/.test(values.totpSecret) || values.totpSecret.length < 16 || values.totpSecret.length > 128) {
    throw Object.assign(new Error('Enter the authenticator setup secret from the TOTP QR code.'), { status: 400 });
  }
  return values;
}

async function save(userId, input, expectedVersion = 0) {
  await ensureIndexes();
  const values = validate(input);
  // Check key availability before making any database changes.
  const keyVersion = activeKeyVersion();
  encryptionKey(keyVersion);
  const existing = await BrokerCredential.findOne({ userId, broker: 'ANGEL_ONE' }).select('version brokerAccountId').lean();
  if ((existing?.version || 0) !== expectedVersion) throw Object.assign(new Error('Broker setup changed; reload and retry.'), { status: 409 });
  const version = (existing?.version || 0) + 1;
  const identity = { userId: String(userId), version, keyVersion };
  const update = {
    $set: {
      clientCode: encrypt(values.clientCode, { ...identity, field: 'clientCode' }),
      apiKey: encrypt(values.apiKey, { ...identity, field: 'apiKey' }),
      totpSecret: encrypt(values.totpSecret, { ...identity, field: 'totpSecret' }),
      brokerAccountId: existing?.brokerAccountId || null,
      version,
      verifiedAt: null,
    },
  };
  try {
    if (existing) {
      const result = await BrokerCredential.updateOne({ userId, broker: 'ANGEL_ONE', version: existing.version }, update, { runValidators: true });
      if (result.modifiedCount !== 1) throw Object.assign(new Error('Broker setup changed; reload and retry.'), { status: 409 });
    } else {
      await BrokerCredential.create({ userId, broker: 'ANGEL_ONE', ...update.$set });
    }
  } catch (error) {
    if (error.code === 11000) throw Object.assign(new Error('Broker setup changed; reload and retry.'), { status: 409 });
    throw error;
  }
  return { configured: true, clientCode: `****${values.clientCode.slice(-4)}` };
}

async function get(userId) {
  await ensureIndexes();
  const doc = await BrokerCredential.findOne({ userId, broker: 'ANGEL_ONE' })
    .select('+clientCode +apiKey +totpSecret').lean();
  if (!doc) return null;
  const identity = { userId: String(userId), version: doc.version };
  return {
    brokerAccountId: doc.brokerAccountId ? String(doc.brokerAccountId) : null,
    version: doc.version,
    verified: Boolean(doc.verifiedAt),
    clientCode: decrypt(doc.clientCode, { ...identity, field: 'clientCode' }),
    apiKey: decrypt(doc.apiKey, { ...identity, field: 'apiKey' }),
    totpSecret: decrypt(doc.totpSecret, { ...identity, field: 'totpSecret' }),
  };
}

async function markVerified(userId, brokerAccountId, version) {
  await ensureIndexes();
  const result = await BrokerCredential.updateOne({ userId, broker: 'ANGEL_ONE', version },
    { $set: { brokerAccountId, verifiedAt: new Date() } });
  return result.modifiedCount === 1;
}

async function metadata(userId) {
  await ensureIndexes();
  const doc = await BrokerCredential.findOne({ userId, broker: 'ANGEL_ONE' })
    .select('+clientCode').lean();
  if (!doc) return { configured: false, clientCode: null, version: 0 };
  const clientCode = decrypt(doc.clientCode, { userId: String(userId), version: doc.version, field: 'clientCode' });
  return { configured: true, clientCode: `****${clientCode.slice(-4)}`, verified: Boolean(doc.verifiedAt), version: doc.version };
}

module.exports = { save, get, markVerified, metadata };
