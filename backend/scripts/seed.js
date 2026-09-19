const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../models/User');
const Strategy = require('../models/Strategy');

dotenv.config();

const DEFAULT_STRATEGIES = ['HeikenAshi', 'ModifiedHeikenAshi', '5minBreakout'];

function isProductionEnvironment(env = process.env) {
    const values = [env.NODE_ENV, env.APP_ENV].map((value) => String(value || '').trim().toLowerCase());
    const isRender = String(env.RENDER || '').trim().toLowerCase() === 'true';
    return isRender || values.some((value) => value === 'production' || value === 'prod');
}

function getSeedConfig(env = process.env) {
    if (isProductionEnvironment(env)) {
        throw new Error('Database seeding is disabled in production environments.');
    }
    if (String(env.ALLOW_DATABASE_SEED || '').trim().toLowerCase() !== 'true') {
        throw new Error('Set ALLOW_DATABASE_SEED=true in the local environment to explicitly enable seeding.');
    }

    const mongoUri = String(env.MONGO_URI || '').trim();
    const email = String(env.SEED_EMAIL || '').trim().toLowerCase();
    const password = String(env.SEED_PASSWORD || '');

    if (!mongoUri) throw new Error('MONGO_URI is required.');
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('SEED_EMAIL must be a valid email address.');
    if (password.length < 8) throw new Error('SEED_PASSWORD must contain at least 8 characters.');

    return { mongoUri, email, password };
}

async function ensureSeedData({ UserModel, StrategyModel, email, password }) {
    let user = await UserModel.findOne({ email }).select('_id');
    let createdUser = false;

    if (!user) {
        user = await UserModel.create({ email, password });
        createdUser = true;
    }

    for (const name of DEFAULT_STRATEGIES) {
        await StrategyModel.updateOne(
            { userId: user._id, name },
            { $setOnInsert: { userId: user._id, name } },
            { upsert: true }
        );
    }

    return { user, createdUser };
}

async function seed() {
    const { mongoUri, email, password } = getSeedConfig();
    try {
        await mongoose.connect(mongoUri);
        const { createdUser } = await ensureSeedData({
            UserModel: User,
            StrategyModel: Strategy,
            email,
            password,
        });

        console.log(createdUser
            ? 'Local seed account and missing strategies created.'
            : 'Existing account preserved; missing strategies ensured.');
    } finally {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    }
}

if (require.main === module) {
    seed().catch((err) => {
        // Avoid printing database URIs or credential-bearing driver errors.
        console.error(`Database seeding failed (${err.name || 'Error'}). Check local configuration and database connectivity.`);
        process.exitCode = 1;
    });
}

module.exports = { DEFAULT_STRATEGIES, ensureSeedData, getSeedConfig, isProductionEnvironment };
