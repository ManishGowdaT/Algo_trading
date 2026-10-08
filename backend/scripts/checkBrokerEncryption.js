const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const vault = require('../services/brokerCredentialVault');
try {
  vault.checkConfiguration();
  console.log('Broker encryption configuration is valid. No secrets were displayed.');
} catch (error) {
  console.error(`${error.code || 'BROKER_VAULT_CONFIG_ERROR'}: ${vault.configurationMessage(error)}`);
  process.exitCode = 1;
}
