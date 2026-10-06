const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const BrokerAccount = require('../models/BrokerAccount');
const StrategySettings = require('../models/StrategySettings');
const Position = require('../models/Position');
const OrderIntent = require('../models/OrderIntent');
const Trade = require('../models/Trade');

async function createPhase1OwnershipIndexes() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required to create Phase 1 ownership indexes');

    await mongoose.connect(process.env.MONGO_URI);
    try {
        // createIndexes is additive. Do not use syncIndexes here: it can drop
        // indexes and is not appropriate for a compatibility migration.
        await Promise.all([
            BrokerAccount.createIndexes(),
            StrategySettings.createIndexes(),
            Position.createIndexes(),
            OrderIntent.createIndexes(),
            Trade.createIndexes(),
        ]);
        return {
            collections: ['brokeraccounts', 'strategysettings', 'positions', 'orderintents', 'trades'],
            historicalDocumentsRewritten: 0,
            historicalIdsChanged: 0,
        };
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    createPhase1OwnershipIndexes()
        .then((summary) => {
            console.log('Phase 1 additive ownership indexes created:', summary);
        })
        .catch((err) => {
            console.error('Phase 1 ownership index migration failed:', err.message);
            process.exitCode = 1;
        });
}

module.exports = { createPhase1OwnershipIndexes };
