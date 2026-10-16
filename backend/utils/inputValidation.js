const TIMEFRAMES = new Set([
  'ONE_MINUTE',
  'THREE_MINUTE',
  'FIVE_MINUTE',
  'FIFTEEN_MINUTE',
  'THIRTY_MINUTE',
]);

const STRATEGY_CONFIG_FIELDS = {
  HeikenAshi: new Set([
    'underlying', 'quantity', 'baseTimeframe', 'needConfirmation',
    'confirmationTimeframe', 'strikeMode', 'strikeDepth', 'premiumMin',
    'premiumMax', 'exitStrategy', 'targetPoints', 'slPoints', 'emaPeriod', 'jmaLength',
    'liveTradingConsent',
  ]),
  ModifiedHeikenAshi: new Set([
    'underlying', 'quantity', 'baseTimeframe', 'needConfirmation',
    'confirmationTimeframe', 'strikeMode', 'strikeDepth', 'premiumMin',
    'premiumMax', 'exitStrategy', 'targetPoints', 'slPoints',
    'initialSlPoints', 'trailingStopPoints', 'finalTargetPoints', 'emaPeriod', 'jmaLength',
    'liveTradingConsent',
  ]),
  '5minBreakout': new Set([
    'underlying', 'exchange', 'quantity', 'lookback', 'targetPoints',
    'bufferPoints', 'maxRangeLimit', 'strikeMode', 'strikeDepth',
    'premiumMin', 'premiumMax', 'liveTradingConsent',
  ]),
};

class InputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputValidationError';
    this.status = 400;
  }
}

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseBoundedInteger(value, { name, defaultValue, min = 1, max }) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new InputValidationError(`${name} must be a whole number between ${min} and ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new InputValidationError(`${name} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateStrategyConfig(strategyName, config) {
  if (strategyName === 'IndexVwapOrb') return require('./indexVwapOrbConfig').validate(config, InputValidationError);
  const allowedFields = STRATEGY_CONFIG_FIELDS[strategyName];
  if (!allowedFields) throw new InputValidationError('Unsupported strategy.');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new InputValidationError('Strategy configuration must be a JSON object.');
  }

  const unknownField = Object.keys(config).find((key) => !allowedFields.has(key));
  if (unknownField) throw new InputValidationError('Strategy configuration contains an unsupported field.');

  const enumFields = {
    underlying: strategyName === '5minBreakout'
      ? ['SENSEX', 'NIFTY', 'BANKNIFTY']
      : ['SENSEX', 'NIFTY', 'BANKNIFTY', 'CRUDEOILM'],
    exchange: ['BSE', 'NFO'],
    baseTimeframe: [...TIMEFRAMES],
    confirmationTimeframe: [...TIMEFRAMES],
    strikeMode: ['ATM', 'ITM', 'OTM'],
    exitStrategy: strategyName === 'ModifiedHeikenAshi'
      ? ['CANDLES', 'TARGET', 'TRAILING_SL']
      : ['CANDLES', 'TARGET'],
  };

  for (const [field, options] of Object.entries(enumFields)) {
    if (config[field] !== undefined && !options.includes(config[field])) {
      throw new InputValidationError(`Invalid ${field} for ${strategyName}.`);
    }
  }

  const booleanFields = ['needConfirmation', 'liveTradingConsent'];
  for (const field of booleanFields) {
    if (config[field] !== undefined && typeof config[field] !== 'boolean') {
      throw new InputValidationError(`${field} must be true or false.`);
    }
  }

  const numericFields = [
    'quantity', 'strikeDepth', 'premiumMin', 'premiumMax', 'targetPoints',
    'slPoints', 'initialSlPoints', 'trailingStopPoints', 'finalTargetPoints',
    'emaPeriod', 'jmaLength',
    'bufferPoints', 'maxRangeLimit',
  ];
  for (const field of numericFields) {
    if (config[field] === undefined) continue;
    const value = config[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
      throw new InputValidationError(`${field} must be a finite number between 0 and 1000000.`);
    }
    if (['quantity', 'strikeDepth', 'emaPeriod', 'jmaLength'].includes(field) && !Number.isInteger(value)) {
      throw new InputValidationError(`${field} must be a whole number.`);
    }
    if (field === 'quantity' && value < 1) throw new InputValidationError('quantity must be greater than zero.');
    if (field === 'strikeDepth' && value < 1) throw new InputValidationError('strikeDepth must be at least 1.');
    if (field === 'emaPeriod' && (value < 2 || value > 200)) throw new InputValidationError('emaPeriod must be between 2 and 200.');
    if (field === 'jmaLength' && (value < 2 || value > 100)) throw new InputValidationError('jmaLength must be between 2 and 100.');
  }

  if (config.lookback !== undefined && ![4, 5].includes(config.lookback)) {
    throw new InputValidationError('lookback must be 4 or 5.');
  }
  if (config.premiumMin !== undefined && config.premiumMax !== undefined && config.premiumMin > config.premiumMax) {
    throw new InputValidationError('premiumMin must not exceed premiumMax.');
  }

  return config;
}

module.exports = {
  escapeRegexLiteral,
  InputValidationError,
  isIsoDate,
  parseBoundedInteger,
  validateStrategyConfig,
};
