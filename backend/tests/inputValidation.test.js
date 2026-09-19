const test = require('node:test');
const assert = require('node:assert/strict');
const {
  escapeRegexLiteral,
  isIsoDate,
  parseBoundedInteger,
  validateStrategyConfig,
} = require('../utils/inputValidation');

test('trade search regex escaping preserves special characters literally', () => {
  const literal = 'NIFTY.*(CE)+[1]';
  const escaped = escapeRegexLiteral(literal);
  assert.equal(new RegExp(escaped).test(literal), true);
  assert.equal(new RegExp(`^${escaped}$`).test('NIFTYxxCE1'), false);
});

test('trade query pagination accepts current defaults and rejects unsafe bounds', () => {
  assert.equal(parseBoundedInteger(undefined, { name: 'page', defaultValue: 1, max: 10_000 }), 1);
  assert.equal(parseBoundedInteger('25', { name: 'limit', defaultValue: 10, max: 100 }), 25);
  assert.throws(() => parseBoundedInteger('1e9', { name: 'limit', defaultValue: 10, max: 100 }), /whole number/);
  assert.throws(() => parseBoundedInteger('101', { name: 'limit', defaultValue: 10, max: 100 }), /whole number/);
});

test('date filter accepts real ISO dates only', () => {
  assert.equal(isIsoDate('2026-09-19'), true);
  assert.equal(isIsoDate('2026-02-30'), false);
  assert.equal(isIsoDate('19-09-2026'), false);
});

test('current strategy UI payloads remain valid', () => {
  assert.doesNotThrow(() => validateStrategyConfig('HeikenAshi', {
    underlying: 'SENSEX', quantity: 20, baseTimeframe: 'FIVE_MINUTE',
    needConfirmation: false, confirmationTimeframe: 'FIFTEEN_MINUTE',
    strikeMode: 'ATM', strikeDepth: 1, premiumMin: 300, premiumMax: 400,
    exitStrategy: 'CANDLES', targetPoints: 20, slPoints: 30,
    liveTradingConsent: false,
  }));
  assert.doesNotThrow(() => validateStrategyConfig('ModifiedHeikenAshi', {
    underlying: 'CRUDEOILM', quantity: 1, baseTimeframe: 'FIVE_MINUTE',
    needConfirmation: true, confirmationTimeframe: 'FIFTEEN_MINUTE',
    strikeMode: 'OTM', strikeDepth: 2, premiumMin: 300, premiumMax: 400,
    exitStrategy: 'TRAILING_SL', targetPoints: 20, slPoints: 30,
    initialSlPoints: 30, trailingStopPoints: 20, finalTargetPoints: 100,
    liveTradingConsent: true,
  }));
  assert.doesNotThrow(() => validateStrategyConfig('5minBreakout', {
    underlying: 'NIFTY', exchange: 'NFO', quantity: 75, lookback: 5,
    targetPoints: 20, bufferPoints: 2, maxRangeLimit: 30, strikeMode: 'ATM',
    strikeDepth: 1, premiumMin: 300, premiumMax: 400, liveTradingConsent: false,
  }));
});

test('strategy validation rejects unknown fields and truthy non-boolean live consent', () => {
  assert.throws(() => validateStrategyConfig('HeikenAshi', { liveTradingConsent: 'false' }), /true or false/);
  assert.throws(() => validateStrategyConfig('HeikenAshi', { unexpected: 'value' }), /unsupported field/);
  assert.throws(() => validateStrategyConfig('not-registered', {}), /Unsupported strategy/);
});
