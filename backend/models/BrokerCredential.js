const mongoose = require('mongoose');

const encryptedFieldSchema = new mongoose.Schema({
  ciphertext: { type: String, required: true },
  nonce: { type: String, required: true },
  tag: { type: String, required: true },
  keyVersion: { type: String, required: true },
}, { _id: false, strict: 'throw' });

const brokerCredentialSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  brokerAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrokerAccount', default: null },
  broker: { type: String, enum: ['ANGEL_ONE'], default: 'ANGEL_ONE', immutable: true },
  clientCode: { type: encryptedFieldSchema, required: true, select: false },
  apiKey: { type: encryptedFieldSchema, required: true, select: false },
  totpSecret: { type: encryptedFieldSchema, required: true, select: false },
  version: { type: Number, min: 1, default: 1, required: true },
  verifiedAt: Date,
}, { timestamps: true, versionKey: false, strict: 'throw' });

brokerCredentialSchema.index({ userId: 1, broker: 1 }, { unique: true, name: 'uniq_broker_credential_per_user' });
brokerCredentialSchema.index({ brokerAccountId: 1 }, { sparse: true, name: 'broker_credential_account' });

module.exports = mongoose.model('BrokerCredential', brokerCredentialSchema);
