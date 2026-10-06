const Strategy = require('../models/Strategy');
const StrategySettings = require('../models/StrategySettings');
const accounts = require('./accountContext');
const strategyRegistry = require('./strategyRegistry');
const { validateStrategyConfig } = require('../utils/inputValidation');

async function ownedStrategy(context, strategyName, requireActiveSession = true) {
  context = accounts.assertVerified(context);
  if (requireActiveSession) await accounts.validate(context);
  await strategyRegistry.init();
  const strategy = await Strategy.findOne({ userId: context.userId, name: strategyName, internalExecutionOnly: { $ne: true } });
  if (!strategy) return null;
  return strategy;
}

async function get(context, strategyName) {
  const strategy = await ownedStrategy(context, strategyName, false);
  if (!strategy) return null;
  return StrategySettings.findOne({ userId: context.userId, brokerAccountId: context.brokerAccountId, strategyId: strategy._id });
}

async function save(context, strategyName, config) {
  const strategy = await ownedStrategy(context, strategyName);
  if (!strategy) return null;
  const validated = structuredClone(validateStrategyConfig(strategyName, config));
  let settings = await StrategySettings.findOne({ userId: context.userId, brokerAccountId: context.brokerAccountId, strategyId: strategy._id });
  if (settings) {
    settings.config = validated;
    await settings.save();
    return settings;
  }
  try {
    return await StrategySettings.create({ userId: context.userId, brokerAccountId: context.brokerAccountId,
      strategyId: strategy._id, config: validated });
  } catch (error) {
    if (error.code !== 11000) throw error;
    settings = await StrategySettings.findOne({ userId: context.userId, brokerAccountId: context.brokerAccountId, strategyId: strategy._id });
    if (!settings) throw error;
    settings.config = validated;
    await settings.save();
    return settings;
  }
}

module.exports = { get, save };
