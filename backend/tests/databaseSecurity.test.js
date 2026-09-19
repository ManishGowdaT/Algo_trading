const assert = require('node:assert/strict');
const test = require('node:test');

process.env.JWT_SECRET = 'test-only-jwt-secret';
process.env.JWT_EXPIRES_IN = '1h';
process.env.JWT_REFRESH_EXPIRES_IN = '1h';
process.env.JWT_COOKIE_EXPIRES_IN = '1';
process.env.JWT_REFRESH_COOKIE_EXPIRES_IN = '1';
process.env.NODE_ENV = 'test';
process.env.AUTH_REFRESH_COOKIE_SAME_SITE = 'lax';

const User = require('../models/User');
const authController = require('../controllers/authController');
const {
  ensureSeedData,
  getSeedConfig,
  isProductionEnvironment,
} = require('../scripts/seed');

test('password hashes are excluded from normal Mongoose user queries', () => {
  assert.equal(User.schema.path('password').options.select, false);
});

test('login explicitly selects the password hash and still returns a successful session', async () => {
  const originalFindOne = User.findOne;
  let selectedFields;
  User.findOne = (filter) => {
    assert.deepEqual(filter, { email: 'user@example.com' });
    return {
      select(fields) {
        selectedFields = fields;
        return Promise.resolve({
          _id: 'user-id',
          email: 'user@example.com',
          password: 'stored-hash',
          comparePassword: async (candidate) => candidate === 'valid-password',
        });
      },
    };
  };

  const response = {
    cookies: [],
    cookie(name, value, options) { this.cookies.push({ name, value, options }); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await authController.login({ body: { email: 'user@example.com', password: 'valid-password' } }, response);
  } finally {
    User.findOne = originalFindOne;
  }

  assert.equal(selectedFields, '+password');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.user.email, 'user@example.com');
  assert.equal(Object.hasOwn(response.body.data.user, 'password'), false);
  assert.equal(response.cookies.length, 2);
  assert.equal(response.cookies.find(({ name }) => name === 'jwt').options.sameSite, 'lax');
  assert.equal(response.cookies.find(({ name }) => name === 'refresh_jwt').options.sameSite, 'lax');
});

test('cross-site refresh cookies require Secure and can be cleared with matching attributes', async () => {
  const previousSameSite = process.env.AUTH_REFRESH_COOKIE_SAME_SITE;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.AUTH_REFRESH_COOKIE_SAME_SITE = 'none';
  process.env.NODE_ENV = 'production';

  // Reload just this controller to exercise the deployment-time cookie config.
  const controllerPath = require.resolve('../controllers/authController');
  const cachedController = require.cache[controllerPath];
  delete require.cache[controllerPath];
  const configuredController = require('../controllers/authController');
  const originalFindOne = User.findOne;
  User.findOne = () => ({
    select: async () => ({
      _id: 'user-id',
      email: 'user@example.com',
      password: 'stored-hash',
      comparePassword: async () => true,
    }),
  });

  const response = {
    cookies: [],
    cookie(name, value, options) { this.cookies.push({ name, value, options }); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  try {
    await configuredController.login({ body: { email: 'user@example.com', password: 'valid-password' } }, response);
  } finally {
    User.findOne = originalFindOne;
    if (cachedController) require.cache[controllerPath] = cachedController;
    else delete require.cache[controllerPath];
    if (previousSameSite === undefined) delete process.env.AUTH_REFRESH_COOKIE_SAME_SITE;
    else process.env.AUTH_REFRESH_COOKIE_SAME_SITE = previousSameSite;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }

  const refreshCookie = response.cookies.find(({ name }) => name === 'refresh_jwt');
  assert.equal(refreshCookie.options.sameSite, 'none');
  assert.equal(refreshCookie.options.secure, true);
  assert.equal(refreshCookie.options.httpOnly, true);

  const clearResponse = {
    cleared: [],
    clearCookie(name, options) { this.cleared.push({ name, options }); },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  configuredController.logout({}, clearResponse);
  const clearedRefreshCookie = clearResponse.cleared.find(({ name }) => name === 'refresh_jwt');
  assert.equal(clearedRefreshCookie.options.sameSite, 'none');
  assert.equal(clearedRefreshCookie.options.secure, true);
});

test('/me never serializes a selected password hash', () => {
  const response = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };

  authController.getMe({
    user: {
      _id: 'user-id',
      email: 'user@example.com',
      password: 'stored-hash',
      toJSON() { return { _id: this._id, email: this.email, password: this.password }; },
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.user.email, 'user@example.com');
  assert.equal(Object.hasOwn(response.body.data.user, 'password'), false);
});

test('database seeding requires an explicit local opt-in and credentials', () => {
  assert.throws(() => getSeedConfig({}), /ALLOW_DATABASE_SEED=true/);
  assert.throws(() => getSeedConfig({
    ALLOW_DATABASE_SEED: 'true',
    MONGO_URI: 'mongodb://localhost/test',
  }), /SEED_EMAIL/);
  assert.deepEqual(getSeedConfig({
    ALLOW_DATABASE_SEED: 'true',
    MONGO_URI: 'mongodb://localhost/test',
    SEED_EMAIL: 'LOCAL@example.com',
    SEED_PASSWORD: 'local-password',
  }), {
    mongoUri: 'mongodb://localhost/test',
    email: 'local@example.com',
    password: 'local-password',
  });
});

test('database seeding refuses production and Render environments', () => {
  assert.equal(isProductionEnvironment({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEnvironment({ APP_ENV: 'prod' }), true);
  assert.equal(isProductionEnvironment({ RENDER: 'true' }), true);
  assert.throws(() => getSeedConfig({
    RENDER: 'true',
    ALLOW_DATABASE_SEED: 'true',
    MONGO_URI: 'mongodb://localhost/test',
    SEED_EMAIL: 'local@example.com',
    SEED_PASSWORD: 'local-password',
  }), /disabled in production/);
});

test('seed preserves an existing account and only ensures missing starter strategies', async () => {
  const existingUser = { _id: 'existing-user-id' };
  let createCalled = false;
  const strategyUpdates = [];
  const result = await ensureSeedData({
    UserModel: {
      findOne(filter) {
        assert.deepEqual(filter, { email: 'local@example.com' });
        return { select: async (fields) => {
          assert.equal(fields, '_id');
          return existingUser;
        } };
      },
      async create() { createCalled = true; throw new Error('must not replace existing account'); },
    },
    StrategyModel: {
      async updateOne(filter, update, options) {
        strategyUpdates.push({ filter, update, options });
      },
    },
    email: 'local@example.com',
    password: 'unused-for-existing-user',
  });

  assert.equal(createCalled, false);
  assert.equal(result.user, existingUser);
  assert.equal(result.createdUser, false);
  assert.equal(strategyUpdates.length, 3);
  for (const { filter, update, options } of strategyUpdates) {
    assert.equal(filter.userId, existingUser._id);
    assert.equal(update.$setOnInsert.userId, existingUser._id);
    assert.deepEqual(options, { upsert: true });
  }
});

test('seed creates an account only when absent and upserts starter strategies', async () => {
  let createdWith;
  const upsertedNames = [];
  const newUser = { _id: 'new-user-id' };

  const result = await ensureSeedData({
    UserModel: {
      findOne() { return { select: async () => null }; },
      async create(fields) { createdWith = fields; return newUser; },
    },
    StrategyModel: {
      async updateOne(filter, update, options) {
        upsertedNames.push(filter.name);
        assert.deepEqual(update.$setOnInsert, { userId: newUser._id, name: filter.name });
        assert.deepEqual(options, { upsert: true });
      },
    },
    email: 'local@example.com',
    password: 'local-password',
  });

  assert.deepEqual(createdWith, { email: 'local@example.com', password: 'local-password' });
  assert.equal(result.user, newUser);
  assert.equal(result.createdUser, true);
  assert.deepEqual(upsertedNames, ['HeikenAshi', 'ModifiedHeikenAshi', '5minBreakout']);
});
