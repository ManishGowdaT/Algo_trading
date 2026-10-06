class CandleCache {
  constructor() {
    this.cache = new Map();
  }

  getKey(underlying, date, interval) {
    const context = require('./accountContext').current();
    return `${context.brokerAccountId}:${context.sessionGeneration}:${underlying.toUpperCase()}:${date}:${interval.toUpperCase()}`;
  }

  get(underlying, date, interval) {
    const key = this.getKey(underlying, date, interval);
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(underlying, date, interval, data, ttlMs = 5 * 60 * 1000) {
    const key = this.getKey(underlying, date, interval);
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttlMs,
    });
  }

  clear() {
    this.cache.clear();
  }
}

module.exports = new CandleCache();
