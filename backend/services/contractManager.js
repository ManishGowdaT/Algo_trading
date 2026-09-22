const EventEmitter = require('events');
const { requestPython } = require('./pythonApiClient');

const INDEX_CONFIG = {
  SENSEX: { qty: 20, step: 20, exchange: 'BFO' },
  NIFTY: { qty: 65, step: 65, exchange: 'NFO' },
  BANKNIFTY: { qty: 30, step: 30, exchange: 'NFO' },
  CRUDEOILM: { qty: 1, step: 1, exchange: 'MCX' }
};

async function callAngelApi(endpoint, method = 'GET', body = null) {
  const { response, data, text } = await requestPython(endpoint, {
    method,
    body: body === null ? undefined : body,
    timeoutMs: null,
  });
  if (!response.ok) {
    throw new Error(`Angel API Error [${response.status}]: ${text}`);
  }
  return data;
}

function asIsoDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function pickNearestExpiry(expiries) {
  if (!Array.isArray(expiries)) return null;
  const todayIso = asIsoDate();
  const valid = [...expiries].filter(Boolean).sort();
  return valid.find(e => e >= todayIso) || (valid.length ? valid[valid.length - 1] : null);
}

function pickNearestStrike(strikes, spot) {
  if (!Array.isArray(strikes) || strikes.length === 0) return null;
  return strikes.reduce((prev, curr) =>
    Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev
  );
}

function resolveStrikeForSide(params) {
  const { strikes, atmStrike, mode, depth, side } = params;
  if (!Array.isArray(strikes) || atmStrike === null) return null;
  const sorted = [...strikes].filter(Number.isFinite).sort((a, b) => a - b);
  const idx = sorted.findIndex(s => Math.abs(s - atmStrike) < 1e-6);
  if (idx < 0) return null;

  if (mode === 'ATM') return sorted[idx];

  const steps = Math.max(0, Math.floor(depth || 1));
  if (side === 'CE') {
    const next = mode === 'ITM' ? idx - steps : idx + steps;
    return next >= 0 && next < sorted.length ? sorted[next] : null;
  }
  const next = mode === 'ITM' ? idx + steps : idx - steps;
  return next >= 0 && next < sorted.length ? sorted[next] : null;
}

class ContractManagerService extends EventEmitter {
  constructor() {
    super();
    this.cache = new Map();
  }

  async resolveContracts(underlying = 'SENSEX', strikeMode = 'ATM', strikeDepth = 1) {
    const key = `${underlying}_${strikeMode}_${strikeDepth}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < 60_000) {
      return cached.data;
    }

    try {
      const indexConf = INDEX_CONFIG[underlying] || INDEX_CONFIG.SENSEX;
      const exchange = indexConf.exchange;

      const indexRes = await callAngelApi(`/market/index-ltp?underlying=${encodeURIComponent(underlying)}`);
      const optRes = await callAngelApi(`/instruments/index-options?exchange=${encodeURIComponent(exchange)}&underlying=${encodeURIComponent(underlying)}`);

      const selectedExpiry = pickNearestExpiry(optRes.expiries);
      const atmStrike = pickNearestStrike(optRes.strikes, indexRes.ltp);

      if (!selectedExpiry || atmStrike === null) {
        throw new Error(`Unable to resolve expiry or ATM strike for ${underlying}`);
      }

      const optChain = await callAngelApi(`/instruments/index-options?exchange=${encodeURIComponent(exchange)}&underlying=${encodeURIComponent(underlying)}&expiry=${encodeURIComponent(selectedExpiry)}`);

      const ceStrike = resolveStrikeForSide({
        strikes: optChain.strikes,
        atmStrike,
        mode: strikeMode,
        depth: strikeDepth,
        side: 'CE'
      });
      const peStrike = resolveStrikeForSide({
        strikes: optChain.strikes,
        atmStrike,
        mode: strikeMode,
        depth: strikeDepth,
        side: 'PE'
      });

      const ce = optChain.contracts.find(c => Math.abs(c.strike - (ceStrike ?? 0)) < 1e-6 && c.option_type === 'CE') || null;
      const pe = optChain.contracts.find(c => Math.abs(c.strike - (peStrike ?? 0)) < 1e-6 && c.option_type === 'PE') || null;

      const data = {
        underlying,
        exchange,
        selectedExpiry,
        atmStrike,
        ceContract: ce,
        peContract: pe,
        spotLtp: indexRes.ltp
      };

      this.cache.set(key, { timestamp: Date.now(), data });
      this.emit('contracts:updated', data);
      return data;
    } catch (err) {
      console.error(`[ContractManager] Error resolving contracts for ${underlying}:`, err.message);
      if (cached) return cached.data;
      throw err;
    }
  }
}

module.exports = new ContractManagerService();
