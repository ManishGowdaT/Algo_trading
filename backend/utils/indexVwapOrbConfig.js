const DEFAULT_TOLERANCE = { NIFTY: 10, BANKNIFTY: 20, SENSEX: 30 };
function validate(config, ErrorType = Error) {
  const fail = message => { throw new ErrorType(message); };
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('Strategy configuration must be a JSON object.');
  const allowed = new Set(['underlying', 'quantity', 'strikeMode', 'strikeDepth', 'premiumMin', 'premiumMax', 'retestTolerancePointsByUnderlying', 'liveTradingConsent']);
  if (Object.keys(config).some(key => !allowed.has(key))) fail('Unsupported IndexVwapOrb configuration field.');
  if (Object.values(config).some(value => value === null)) fail('Configuration values cannot be null.');
  if (!Object.hasOwn(DEFAULT_TOLERANCE, config.underlying || '')) fail('Select NIFTY, BANKNIFTY or SENSEX.');
  if (!Number.isSafeInteger(config.quantity) || config.quantity <= 0 || config.quantity > 1000000) fail('quantity must be a positive whole number up to 1000000.');
  const result = { underlying: config.underlying, quantity: config.quantity, strikeMode: config.strikeMode ?? 'ATM',
    strikeDepth: config.strikeDepth ?? 1, premiumMin: config.premiumMin ?? 0, premiumMax: config.premiumMax ?? 1000000,
    retestTolerancePointsByUnderlying: { ...DEFAULT_TOLERANCE }, liveTradingConsent: config.liveTradingConsent ?? false };
  if (!['ATM', 'ITM', 'OTM'].includes(result.strikeMode)) fail('Invalid strike preference.');
  if (!Number.isSafeInteger(result.strikeDepth) || result.strikeDepth < 1 || result.strikeDepth > 100) fail('Invalid strike depth.');
  if ([result.premiumMin, result.premiumMax].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1000000)
    || result.premiumMin > result.premiumMax) fail('Invalid option premium range.');
  if (typeof result.liveTradingConsent !== 'boolean') fail('liveTradingConsent must be true or false.');
  if (config.retestTolerancePointsByUnderlying !== undefined) {
    const tolerances = config.retestTolerancePointsByUnderlying;
    if (!tolerances || typeof tolerances !== 'object' || Array.isArray(tolerances)) fail('Invalid tolerance map.');
    for (const [key, value] of Object.entries(tolerances)) {
      if (!Object.hasOwn(DEFAULT_TOLERANCE, key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000) fail('Invalid per-index tolerance.');
      result.retestTolerancePointsByUnderlying[key] = value;
    }
  }
  return result;
}
module.exports = { validate };
