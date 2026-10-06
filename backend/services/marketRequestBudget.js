// Process-wide admission for quote reads, shared by monitoring and fallback.
// These local safety budgets do not assert broker entitlements or published limits.
// Never retries or delays broker mutations; no unbounded waiting queue.
class MarketRequestBudget {
  constructor({ accountLimit = 4, globalLimit = 16, windowMs = 1000 } = {}) {
    this.accountLimit = accountLimit;
    this.globalLimit = globalLimit;
    this.windowMs = windowMs;
    this.accounts = new Map();
    this.global = [];
    this.inFlight = 0;
  }

  acquire(key, now = Date.now(), background = false) {
    this.global = this.global.filter(time => time > now - this.windowMs);
    for (const [id, state] of this.accounts) {
      state.times = state.times.filter(time => time > now - this.windowMs);
      if (!state.times.length && !state.inFlight) this.accounts.delete(id);
    }
    const state = this.accounts.get(key) || { times: [], inFlight: 0 };
    // Reserve capacity for position monitoring when fallback batches compete.
    const accountLimit = background ? Math.max(1, this.accountLimit - 1) : this.accountLimit;
    const globalLimit = background ? Math.max(1, this.globalLimit - this.accountLimit) : this.globalLimit;
    if (state.times.length >= accountLimit || state.inFlight >= accountLimit
      || this.global.length >= globalLimit || this.inFlight >= globalLimit) return null;
    this.accounts.set(key, state);
    state.times.push(now);
    this.global.push(now);
    state.inFlight++;
    this.inFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.inFlight--;
      this.inFlight--;
    };
  }
}
module.exports = new MarketRequestBudget();
module.exports.MarketRequestBudget = MarketRequestBudget;
