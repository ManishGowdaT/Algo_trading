const Trade = require('../models/Trade');
const Strategy = require('../models/Strategy');
const contractManager = require('./contractManager');
const marketDataService = require('./marketDataService');
const legacyOrderUpdateService = require('./orderUpdateService');
const marketSessionManager = require('./marketSessionManager');
const { notifyUrgent } = require('./notificationService');
const { requestPython } = require('./pythonApiClient');
marketSessionManager.startMonitoring();

const strategyRegistry = require('./strategyRegistry');
const indicators = require('../trading/indicators');
strategyRegistry.init().catch(err => console.error('[StrategyEngine] Registry init error:', err.message));

const INDEX_CONFIG = {
  SENSEX: { qty: 20, step: 20, exchange: 'BFO' },
  NIFTY: { qty: 65, step: 65, exchange: 'NFO' },
  BANKNIFTY: { qty: 30, step: 30, exchange: 'NFO' },
  CRUDEOILM: { qty: 1, step: 1, exchange: 'MCX' }
};

// Helper: HTTP request to Python Angel One Wrapper
async function callAngelApi(endpoint, method = 'GET', body = null, timeoutMs = null) {
  const { response, data, text } = await requestPython(endpoint, {
    method,
    body: body === null ? undefined : body,
    timeoutMs,
  });
  if (!response.ok) {
    const retryAfter = response.headers?.get('retry-after');
    const seconds = Number(retryAfter);
    const retryMs = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
    throw Object.assign(new Error(`Angel API Error [${response.status}]: ${text}`), { status: response.status, retryMs });
  }
  return data;
}

function ownedTradeFilter(runner, tradeId) {
  return { _id: tradeId, userId: runner.userId, brokerAccountId: runner.accountContext.brokerAccountId };
}
function updateRunnerTrade(runner, update) {
  return runner.accountContext
    ? Trade.findOneAndUpdate(ownedTradeFilter(runner, runner.activeTradeId), update)
    : Trade.findByIdAndUpdate(runner.activeTradeId, update);
}

function formatPrecisionTime(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
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

function parseCandleTsMs(ts) {
  const raw = String(ts || '').trim();
  if (!raw) return null;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0, 0).getTime();
}

function getLastCompletedCandleWindow(candles, lookback) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return null;
  const now = new Date();
  now.setSeconds(0, 0);
  const currentMinuteStartMs = now.getTime();

  const completed = candles.filter(c => {
    const ms = parseCandleTsMs(c.ts);
    return ms !== null && ms < currentMinuteStartMs;
  });

  if (completed.length < lookback + 1) return null;

  const breakoutCandle = completed[completed.length - 1];
  const rangeCandles = completed.slice(completed.length - (lookback + 1), completed.length - 1);
  if (rangeCandles.length !== lookback) return null;
  return { rangeCandles, breakoutCandle };
}

class SingleStrategyRunner {
  constructor(strategyName) {
    this.strategyName = strategyName;
    this.userId = null;
    this.isRunning = false;
    this.shutdownDraining = false;
    this.state = 'STOPPED';
    this.message = 'Initialized';
    this.trend = 'NEUTRAL';

    this.config = {};
    this.selectedExpiry = null;
    this.atmStrike = null;
    this.ceContract = null;
    this.peContract = null;

    this.monitoredPremiums = { ce: '---', pe: '---' };
    this.previousDayCandles = { ce: [], pe: [] };
    this.warmupTokens = { ce: null, pe: null };
    this.warmupRequests = { ce: null, pe: null };
    this.checkpoints = [];

    this.activeTradeId = null;
    this.activeTradePremium = null;
    this.entryPrice = null;
    this.activeTradeContract = null;
    this.entryOrderId = null;
    this.protectiveOrderId = null;
    this.protectiveStopPrice = null;
    this.positionState = 'NONE';
    this.currentLtp = null;
    this.activeTrailingSl = null;
    this.stopLoss = null;
    this.target = null;
    this.rangeSide = null;
    this.cooldownUntil = null;
    this.lastCompletedTrade = null;

    this.logs = [];
    this.lastEntryTime = null;
    this.lastProcessedCandleTs = null;
    this.lastProcessedBreakoutCandles = new Map();
    this.isExiting = false;
    this.exitInProgress = false;
    this.exitTriggered = false;
    this.exitReasonStored = null;
    this.lastExitError = null;
    this.exitRetryCount = 0;
    this.lastExitAttemptTime = 0;
    this.brokerReady = false;
    this.sessionAlertSent = false;
    this.warmupRecovery = {};
    this.dataReadiness = 'WARMING_UP';

    this.contractInterval = null;
    this.scanInterval = null;
    this.monitorInterval = null;
  }

  log(msg) {
    const timestamp = new Date().toLocaleTimeString('en-IN');
    const logLine = `[${timestamp}] [${this.strategyName}] ${msg}`;
    console.log(logLine);
    this.message = msg;
    this.logs.unshift(logLine);
    if (this.logs.length > 100) this.logs.pop();
  }

  async start(config, userId) {
    if (this.strategyName === 'IndexVwapOrb') {
      await require('./indexVwapOrbAvailability').assertEnabled(this.accountContext);
      config = require('../utils/inputValidation').validateStrategyConfig(this.strategyName, config);
      if (config.liveTradingConsent) await require('./indexVwapOrbAvailability').assertLiveExecution(this.accountContext);
      await require('../models/StrategySession').createIndexes();
      this.indexOrbSession = await require('./indexVwapOrbSession').restore(this.accountContext);
      if (this.indexOrbSession.blocked) throw Object.assign(new Error('Index VWAP ORB has an unresolved entry or exposure.'), { status: 409, code: 'ENTRY_OR_EXPOSURE_UNRESOLVED' });
    }
    this.config = config || {};
    this.userId = userId;

    const brokerStatus = await callAngelApi('/angel/status');
    if (!brokerStatus || !brokerStatus.connected) {
      throw new Error(brokerStatus?.message || 'Angel One broker session is not connected');
    }

    this.brokerReady = true;
    this.isRunning = true;
    this.feedScanReady = false;
    this.state = this.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
    this.log('Strategy execution started on Node.js');

    try {
      if (typeof marketDataService.ensureReady === 'function') await marketDataService.ensureReady();
      if (!this.isRunning) return;
      // Register before subscriptions/backfill can deliver a closed candle.
      await this.startScanLoop();
      await this.recoverTrade();
      if (!this.isRunning) return;
      await this.startContractLoop();
      if (this.isRunning) {
        this.feedScanReady = true;
        this.startHeartbeatLoop();
      }
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  isHeikenAshiWarmupStrategy() {
    return this.strategyName === 'HeikenAshi' || this.strategyName === 'ModifiedHeikenAshi';
  }

  getIstDateIso(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  shiftIsoDate(dateIso, days) {
    const date = new Date(`${dateIso}T00:00:00+05:30`);
    date.setUTCDate(date.getUTCDate() + days);
    return this.getIstDateIso(date);
  }

  normalizeHistoricalCandles(items) {
    if (!Array.isArray(items)) return [];
    return items.map((candle) => {
      const rawTs = candle.ts || candle.time;
      const numericTs = Number(rawTs);
      let parsedTs;
      if (Number.isFinite(numericTs) && String(rawTs).trim() !== '') {
        parsedTs = numericTs < 1e10 ? numericTs : Math.floor(numericTs / 1000);
      } else {
        const timestampText = String(rawTs || '').trim();
        const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestampText);
        const normalizedText = hasTimezone
          ? timestampText
          : `${timestampText.replace(' ', 'T')}+05:30`;
        parsedTs = Math.floor(new Date(normalizedText).getTime() / 1000);
      }
      return {
        time: parsedTs,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close)
      };
    }).filter(candle => Number.isFinite(candle.time) &&
      Number.isFinite(candle.open) && Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) && Number.isFinite(candle.close) &&
      candle.high >= Math.max(candle.open, candle.close) &&
      candle.low <= Math.min(candle.open, candle.close) &&
      candle.high >= candle.low)
      .sort((a, b) => a.time - b.time)
      .filter((candle, index, candles) => index === 0 || candle.time !== candles[index - 1].time);
  }

  async loadPreviousDayWarmup(contract, side) {
    if (!this.isHeikenAshiWarmupStrategy() || !contract?.symboltoken) return;

    const token = String(contract.symboltoken);
    if (this.warmupTokens[side] === token && this.previousDayCandles[side].length > 0) return;
    if (this.warmupRequests[side]?.token === token) return this.warmupRequests[side].promise;
    const recovery = this.warmupRecovery[side];
    if (recovery?.token === token && Date.now() < recovery.nextAttemptAt) return;
    if (recovery?.token !== token) delete this.warmupRecovery[side];

    this.warmupTokens[side] = token;
    this.previousDayCandles[side] = [];

    const promise = (async () => {
      const todayIso = this.getIstDateIso();
      for (let offset = 1; offset <= 7; offset++) {
        const dateIso = this.shiftIsoDate(todayIso, -offset);
        try {
          const response = await callAngelApi(`/market/candles?exchange=${encodeURIComponent(contract.exchange)}&symboltoken=${encodeURIComponent(token)}&interval=FIVE_MINUTE&date=${dateIso}`, 'GET', null, 5000);
          const candles = this.normalizeHistoricalCandles(response?.items);
          if (candles.length > 0) {
            this.previousDayCandles[side] = candles;
            delete this.warmupRecovery[side];
            this.log(`Loaded ${candles.length} previous trading-day candles for ${side.toUpperCase()} warm-up (${dateIso})`);
            return;
          }
        } catch (err) {
          console.warn(`[${this.strategyName}] Previous-day candle warm-up failed for ${side.toUpperCase()} ${dateIso}: status=${err.status || 'transport'}`);
          // An error does not prove that this date was a holiday or had no
          // candles. Do not silently initialize indicators from an older day
          // after a rate limit, timeout or upstream outage.
          const failures = (this.warmupRecovery[side]?.failures || 0) + 1;
          this.warmupRecovery[side] = { token, failures, failed: true,
            nextAttemptAt: Date.now() + Math.max(Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4)), Math.max(0, err.retryMs || 0)) };
          return;
        }
      }

      this.log(`Previous-day candle warm-up unavailable for ${side.toUpperCase()}; continuing with current-day history`);
      this.warmupRecovery[side] = { token, failed: false, nextAttemptAt: Date.now() + 60_000 };
    })();

    this.warmupRequests[side] = { token, promise };
    try {
      await promise;
    } finally {
      if (this.warmupRequests[side]?.token === token) this.warmupRequests[side] = null;
    }
  }

  getCalculationCandles(contract, currentCandles, side) {
    if (!this.isHeikenAshiWarmupStrategy()) return currentCandles;

    const historical = this.accountContext && contract?.symboltoken === this.activeTradeContract?.symboltoken && this.heldWarmupCandles
      ? this.heldWarmupCandles : this.previousDayCandles[side] || [];
    const current = Array.isArray(currentCandles) ? currentCandles : [];
    const merged = [...historical, ...current]
      .filter(candle => candle && Number.isFinite(Number(candle.time)))
      .sort((a, b) => Number(a.time) - Number(b.time));

    return merged.filter((candle, index) => index === 0 || Number(candle.time) !== Number(merged[index - 1].time));
  }

  startHeartbeatLoop() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    const emitHeartbeat = () => {
      if (!this.isRunning || (this.state !== 'SCANNING' && this.state !== 'WAITING')) return;
      if (!this.ceContract || !this.peContract) return;

      const ceLtp = marketDataService.getLtp(this.ceContract.exchange, this.ceContract.symboltoken);
      const peLtp = marketDataService.getLtp(this.peContract.exchange, this.peContract.symboltoken);

      const now = new Date();
      const intervalMs = 5 * 60 * 1000;
      const nextCandleMs = Math.ceil(now.getTime() / intervalMs) * intervalMs;
      const secondsLeft = Math.max(0, Math.round((nextCandleMs - now.getTime()) / 1000));

      const ceStr = ceLtp !== null ? `₹${ceLtp.toFixed(2)}` : 'Awaiting Ticks';
      const peStr = peLtp !== null ? `₹${peLtp.toFixed(2)}` : 'Awaiting Ticks';

      this.log(`[SCANNER HEARTBEAT] Active | CE: ${this.ceContract.tradingsymbol} (${ceStr}) | PE: ${this.peContract.tradingsymbol} (${peStr}) | Next Candle Close: ${secondsLeft}s`);
    };

    emitHeartbeat();
    this.heartbeatInterval = setInterval(emitHeartbeat, 10_000);
  }

  getBaseTimeframe() {
    const pluginClass = strategyRegistry.getPlugin(this.strategyName);
    if (pluginClass && pluginClass.manifest && pluginClass.manifest.requires && pluginClass.manifest.requires.timeframe) {
      return pluginClass.manifest.requires.timeframe;
    }
    return this.config.baseTimeframe || 'FIVE_MINUTE';
  }

  stop() {
    const managed = this.accountContext && require('./positionExecution').forRunner(this, { feed: marketDataService }).hasExposure();
    this.isRunning = false;
    this.feedScanReady = false;
    this.state = 'STOPPED';
    this.log('Strategy execution halted.');
    if (managed) {
      if (this.contractInterval) clearInterval(this.contractInterval);
      if (this.scanInterval) clearInterval(this.scanInterval);
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      this.contractInterval = this.scanInterval = this.heartbeatInterval = null;
      this.state = this.positionState === 'PROTECTED' ? 'POSITION_PROTECTED' : this.positionState === 'UNPROTECTED' ? 'POSITION_UNPROTECTED' : 'RECONCILIATION_REQUIRED';
      this.message = 'New entries stopped; held and unresolved positions remain managed.';
    } else this.clearAllIntervals();

    const baseTimeframe = this.getBaseTimeframe();
    if (this.underlyingSubscription) {
      require('./accountContext').run(this.accountContext, () => marketDataService.unsubscribeUnderlying(this.underlyingSubscription));
      this.underlyingSubscription = null;
    }
    if (this.candleListener && !managed) {
      marketDataService.removeListener('candle:closed', this.candleListener);
      this.candleListener = null;
    }
    if (this.ceContract) {
      this.releaseFeed(this.ceContract.exchange, this.subscribedCeToken || this.ceContract.symboltoken, baseTimeframe, 'scanner');
    }
    if (this.peContract) {
      this.releaseFeed(this.peContract.exchange, this.subscribedPeToken || this.peContract.symboltoken, baseTimeframe, 'scanner');
    }
    this.subscribedCeToken = null;
    this.subscribedPeToken = null;
    if (managed) return;
    if (this.activeTradeContract && typeof marketDataService.unsubscribe === 'function') {
      this.releaseFeed(this.activeTradeContract.exchange, this.activeTradeContract.symboltoken, 'ONE_MINUTE', 'position');
    }
    this.subscribedCeToken = null;
    this.subscribedPeToken = null;

    this.ceContract = null;
    this.peContract = null;
    this.atmStrike = null;
    this.selectedExpiry = null;
    this.activeTradeId = null;
    this.activeTradePremium = null;
    this.entryPrice = null;
    this.activeTradeContract = null;
    this.entryOrderId = null;
    this.protectiveOrderId = null;
    this.protectiveStopPrice = null;
    this.positionState = 'NONE';
    this.currentLtp = null;
    this.activeTrailingSl = null;
    this.stopLoss = null;
    this.target = null;
    this.rangeSide = null;
    this.monitoredPremiums = { ce: '---', pe: '---' };
    this.previousDayCandles = { ce: [], pe: [] };
    this.warmupTokens = { ce: null, pe: null };
    this.warmupRequests = { ce: null, pe: null };
    this.warmupRecovery = {};
    this.dataReadiness = 'WARMING_UP';
  }

  clearAllIntervals() {
    if (this.contractInterval) clearInterval(this.contractInterval);
    if (this.scanInterval) clearInterval(this.scanInterval);
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.contractInterval = null;
    this.scanInterval = null;
    this.monitorInterval = null;
    this.heartbeatInterval = null;
  }

  async recoverTrade() {
    if (this.accountContext) return require('./positionExecution').forRunner(this, { feed: marketDataService }).resume();
    try {
      const strategyDoc = await Strategy.findOne({ name: this.strategyName, userId: this.userId });
      if (!strategyDoc) return;

      const trade = await Trade.findOne({
        userId: this.userId,
        ...(this.accountContext ? { brokerAccountId: this.accountContext.brokerAccountId } : {}),
        strategyId: strategyDoc._id,
        exitPrice: { $exists: false }
      }).sort({ createdAt: -1 });

      if (trade) {
        let isStillOpenOnBroker = true;
        if (this.config.liveTradingConsent) {
          try {
            const posRes = await callAngelApi('/angel/positions');
            const posList = Array.isArray(posRes?.data) ? posRes.data : [];
            const held = posList.find(p => p.tradingsymbol === trade.premium);
            const netQty = held ? parseInt(held.netqty || '0', 10) : 0;
            if (netQty <= 0) {
              isStillOpenOnBroker = false;
            }
          } catch (e) {
            // Keep existing status if position check fails
          }
        }

        if (isStillOpenOnBroker) {
          this.activeTradeId = trade._id.toString();
          this.activeTradePremium = trade.premium;
          this.entryPrice = trade.buyPrice;
          this.entryOrderId = trade.entryOrderId || null;
          this.protectiveOrderId = trade.protectiveOrderId || null;
          this.protectiveStopPrice = trade.protectiveStopPrice || null;
          this.positionState = trade.positionState || (this.config.liveTradingConsent ? 'UNPROTECTED' : 'PROTECTED');
          this.state = this.positionState === 'PROTECTED' ? 'POSITION_PROTECTED' : 'POSITION_UNPROTECTED';
          if (trade.premium.endsWith('CE')) this.rangeSide = 'CE';
          if (trade.premium.endsWith('PE')) this.rangeSide = 'PE';
          
          try {
            const underlyingIndex = trade.index || 'SENSEX';
            const exchange = (underlyingIndex === 'SENSEX') ? 'BFO' : 'NFO';
            const optRes = await callAngelApi(`/instruments/index-options?exchange=${exchange}&underlying=${underlyingIndex}`);
            const todayIso = new Date().toISOString().split('T')[0];
            const validExpiries = (optRes.expiries || []).filter(Boolean).sort();
            const expiry = validExpiries.find(e => e >= todayIso) || (validExpiries.length ? validExpiries[validExpiries.length - 1] : null);
            if (expiry) {
              const optChain = await callAngelApi(`/instruments/index-options?exchange=${exchange}&underlying=${underlyingIndex}&expiry=${expiry}`);
              const contract = optChain.contracts.find(c => c.tradingsymbol === trade.premium);
              if (contract) {
                this.activeTradeContract = contract;
                this.log(`Successfully recovered option contract details for ${trade.premium} (Token: ${contract.symboltoken})`);
                this.subscribeHeldPosition(contract);
              }
            }
          } catch (e) {
            this.log(`Warning: Failed to fetch contract details for active trade: ${e.message}`);
          }

          this.log(`Recovered active open trade for ${trade.premium} @ ₹${trade.buyPrice}`);
          this.startMonitorLoop();
        } else {
          this.log(`Stale MongoDB trade ${trade.premium} found closed on broker. Cleaning up DB...`);
          trade.exitPrice = trade.buyPrice;
          trade.exitReason = 'RECOVERY_CLEANUP';
          trade.pnl = 0;
          await trade.save();
        }
      }
    } catch (err) {
      console.error(`[${this.strategyName}] Recovery error:`, err);
    }
  }

  async startContractLoop() {
    const resolveContracts = async () => {
      if (!this.isRunning) return;
      try {
        const underlying = this.config.underlying || 'SENSEX';
        const strikeMode = this.config.strikeMode || 'ATM';
        const strikeDepth = this.config.strikeDepth || 1;

        const resolved = await contractManager.resolveContracts(underlying, strikeMode, strikeDepth);
        if (!this.isRunning) return;

        if (!this.selectedExpiry) {
          this.selectedExpiry = resolved.selectedExpiry;
        }
        if (!this.activeTradeId) {
          this.atmStrike = resolved.atmStrike;
        }

        this.ceContract = resolved.ceContract;
        this.peContract = resolved.peContract;

        if (this.ceContract && this.peContract) {
          this.monitoredPremiums = { ce: this.ceContract.tradingsymbol, pe: this.peContract.tradingsymbol };
          if (strategyRegistry.getPlugin(this.strategyName)?.manifest?.requires?.dataStreams?.includes('UNDERLYING_CANDLES')) return;
          
          // Subscribe contracts to MarketDataService only when changed or initial
          const baseTimeframe = this.getBaseTimeframe();
          if (!this.subscribedCeToken || this.subscribedCeToken !== this.ceContract.symboltoken) {
            if (this.subscribedCeToken) {
              this.releaseFeed(this.ceContract.exchange, this.subscribedCeToken, baseTimeframe, 'scanner');
            }
            await marketDataService.subscribe(this.ceContract.exchange, this.ceContract.symboltoken, baseTimeframe, null, { role: 'scanner', tradingsymbol: this.ceContract.tradingsymbol });
            if (!this.isRunning) return;
            this.subscribedCeToken = this.ceContract.symboltoken;
            if (!this.isRunning) return;
          }
          if (!this.subscribedPeToken || this.subscribedPeToken !== this.peContract.symboltoken) {
            if (this.subscribedPeToken) {
              this.releaseFeed(this.peContract.exchange, this.subscribedPeToken, baseTimeframe, 'scanner');
            }
            await marketDataService.subscribe(this.peContract.exchange, this.peContract.symboltoken, baseTimeframe, null, { role: 'scanner', tradingsymbol: this.peContract.tradingsymbol });
            if (!this.isRunning) return;
            this.subscribedPeToken = this.peContract.symboltoken;
          }
          await this.loadPreviousDayWarmup(this.ceContract, 'ce');
          if (!this.isRunning) return;
          await this.loadPreviousDayWarmup(this.peContract, 'pe');
        }
      } catch (err) {
        console.error(`[${this.strategyName}] Contract discovery error:`, err.message);
      }
    };

    await resolveContracts();
    if (this.isRunning) this.contractInterval = setInterval(resolveContracts, 60_000);
  }

  async startScanLoop() {
    if (this.candleListener) return;
    const requirements = strategyRegistry.getPlugin(this.strategyName)?.manifest?.requires;
    if (requirements?.dataStreams?.includes('UNDERLYING_CANDLES')) {
      return this.startUnderlyingDataLoop(requirements);
    }

    const runScan = async (eventData = null) => {
      if ((!this.isRunning || this.feedScanReady === false) && !(this.accountContext && require('./positionExecution').forRunner(this, { feed: marketDataService }).hasExposure())) return;
      if (this.state === 'COOLDOWN') {
        if (this.cooldownUntil && Date.now() >= this.cooldownUntil) {
          this.state = this.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
          this.cooldownUntil = null;
          this.log('Cooldown period completed. Resuming scanner.');
        } else {
          return;
        }
      }

      try {
      // Handle Reversal exit check when IN_POSITION on closed candle
      if ((['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED'].includes(this.state)
        || (this.accountContext && ['RECONCILIATION_REQUIRED', 'EXIT_PENDING'].includes(this.state))) && this.activeTradePremium) {
        const activeContract = this.activeTradeContract || ((this.ceContract && this.ceContract.tradingsymbol === this.activeTradePremium)
          ? this.ceContract
          : (this.peContract && this.peContract.tradingsymbol === this.activeTradePremium)
            ? this.peContract
            : null);

        if (activeContract) {
          const baseTimeframe = this.getBaseTimeframe();
          const currentItems = marketDataService.getBuffer(activeContract.exchange, activeContract.symboltoken, baseTimeframe, this.accountContext ? 'position' : 'scanner');
          const activeSide = this.heldSide || (activeContract.symboltoken === this.peContract?.symboltoken ? 'pe' : 'ce');
          const items = this.getCalculationCandles(activeContract, currentItems, activeSide);
          if (items && items.length >= 2) {
            const PluginClass = strategyRegistry.getPlugin(this.strategyName);
            if (PluginClass) {
              const pluginInstance = new PluginClass(this.config);
              const signal = pluginInstance.analyze({ items, indicators, userId: this.userId });
              if (signal.isExit && !this.isExiting) {
                this.log(`Reversal exit signal detected on closed candle for ${activeContract.tradingsymbol}`);
                await this.executeExit(activeContract, this.currentLtp || signal.haClose, 'Reversal');
                return;
              }
            }
          }
        }
        return;
      }

      if (this.state !== 'SCANNING' && this.state !== 'WAITING') return;
      if (!this.isRunning || this.feedScanReady === false) return;
      if (!this.brokerReady) return;
      if (this.activeTradeId) return;
      if (!this.ceContract || !this.peContract) return;

      const scanStartMs = Date.now();
      const scanStartTs = formatPrecisionTime(new Date(scanStartMs));

        const PluginClass = strategyRegistry.getPlugin(this.strategyName);
        if (!PluginClass) {
          console.warn(`[${this.strategyName}] Plugin not registered in strategyRegistry`);
          return;
        }

        const pluginInstance = new PluginClass(this.config);
        const req = PluginClass.manifest?.requires || {};
        const baseTimeframe = req.timeframe || this.config.baseTimeframe || 'FIVE_MINUTE';
        const requiredCandles = req.lookbackCandles || 2;

        if (this.strategyName === '5minBreakout') {
          const fetchStartMs = Date.now();
          let ceItems = marketDataService.getBuffer(this.ceContract.exchange, this.ceContract.symboltoken, 'ONE_MINUTE');
          let peItems = marketDataService.getBuffer(this.peContract.exchange, this.peContract.symboltoken, 'ONE_MINUTE');

          if (!ceItems || ceItems.length < requiredCandles) {
            try { ceItems = await marketDataService.ensureHistory(this.ceContract.exchange, this.ceContract.symboltoken, 'ONE_MINUTE', 'scanner'); } catch (err) { return; }
          }
          if (!peItems || peItems.length < requiredCandles) {
            try { peItems = await marketDataService.ensureHistory(this.peContract.exchange, this.peContract.symboltoken, 'ONE_MINUTE', 'scanner'); } catch (err) { return; }
          }
          if (!ceItems || ceItems.length < requiredCandles || !peItems || peItems.length < requiredCandles) {
            this.setDataReadiness('DATA_DEGRADED', 'Waiting for verified breakout candle history.'); return;
          }
          this.setDataReadiness('READY');
          const fetchEndMs = Date.now();

          const ceKey = `${this.ceContract.exchange}:${this.ceContract.symboltoken}`;
          const peKey = `${this.peContract.exchange}:${this.peContract.symboltoken}`;
          const ceEval = pluginInstance.analyze({ items: ceItems, lastProcessedTs: this.lastProcessedBreakoutCandles.get(ceKey) ?? null, indicators, userId: this.userId });
          const peEval = pluginInstance.analyze({ items: peItems, lastProcessedTs: this.lastProcessedBreakoutCandles.get(peKey) ?? null, indicators, userId: this.userId });

          if (!eventData?.synthetic && (ceEval.isBreakout || peEval.isBreakout)) {
            const isCE = ceEval.isBreakout;
            const activeEval = isCE ? ceEval : peEval;
            const contractToTrade = isCE ? this.ceContract : this.peContract;

            this.rangeSide = isCE ? 'CE' : 'PE';
            this.stopLoss = activeEval.stopLoss;
            this.target = activeEval.target;

            const signalMs = Date.now();
            let outcome;
            try {
              outcome = await this.submitSignalEntry(contractToTrade, activeEval.entryPrice, isCE ? 'BULLISH' : 'BEARISH', activeEval.nextTs, {
              candleDetectedTs: scanStartTs,
              signalGeneratedMs: signalMs,
              signalGeneratedTs: formatPrecisionTime(new Date(signalMs)),
              fetchMs: fetchEndMs - fetchStartMs,
              calcMs: 0
            });
            } finally {
              // An exception can follow durable submission. Consume both
              // evaluated legs unless admission explicitly proved no submit.
              if (!outcome?.retryableBeforeSubmit) {
                if (ceEval.nextTs) this.lastProcessedBreakoutCandles.set(ceKey, ceEval.nextTs);
                if (peEval.nextTs) this.lastProcessedBreakoutCandles.set(peKey, peEval.nextTs);
              }
            }
          } else {
            if (ceEval.nextTs) this.lastProcessedBreakoutCandles.set(ceKey, ceEval.nextTs);
            if (peEval.nextTs) this.lastProcessedBreakoutCandles.set(peKey, peEval.nextTs);
          }
          if (ceEval.nextTs) this.lastProcessedCandleTs = ceEval.nextTs;
          else if (peEval.nextTs) this.lastProcessedCandleTs = peEval.nextTs;
        } else {
          const scanExchange = this.ceContract.exchange;
          const fetchStartMs = Date.now();
          let ceItems = marketDataService.getBuffer(scanExchange, this.ceContract.symboltoken, baseTimeframe);
          let peItems = marketDataService.getBuffer(scanExchange, this.peContract.symboltoken, baseTimeframe);

          if (!ceItems || (ceItems.length < requiredCandles &&
            (!this.isHeikenAshiWarmupStrategy() || this.previousDayCandles.ce.length === 0))) {
            try { ceItems = await marketDataService.ensureHistory(scanExchange, this.ceContract.symboltoken, baseTimeframe, 'scanner'); } catch (err) { return; }
          }
          if (!peItems || (peItems.length < requiredCandles &&
            (!this.isHeikenAshiWarmupStrategy() || this.previousDayCandles.pe.length === 0))) {
            try { peItems = await marketDataService.ensureHistory(scanExchange, this.peContract.symboltoken, baseTimeframe, 'scanner'); } catch (err) { return; }
          }
          for (const side of ['ce', 'pe']) {
            const contract = side === 'ce' ? this.ceContract : this.peContract;
            if (this.warmupTokens[side] === String(contract.symboltoken) && !this.previousDayCandles[side].length) {
              await this.loadPreviousDayWarmup(contract, side);
            }
          }
          ceItems = this.getCalculationCandles(this.ceContract, ceItems, 'ce');
          peItems = this.getCalculationCandles(this.peContract, peItems, 'pe');
          if (Object.values(this.warmupRecovery).some(item => item.failed)
            || !ceItems || ceItems.length < requiredCandles || !peItems || peItems.length < requiredCandles) {
            this.setDataReadiness('DATA_DEGRADED', 'Waiting for verified candle history/warm-up; new entries are paused.'); return;
          }
          this.setDataReadiness('READY');
          const fetchEndMs = Date.now();

          const calcStartMs = Date.now();
          const ceSignal = pluginInstance.analyze({ items: ceItems, indicators, userId: this.userId });
          const peSignal = pluginInstance.analyze({ items: peItems, indicators, userId: this.userId });
          const calcEndMs = Date.now();

          // Diagnostic per-candle log output for the specific contract event (CE or PE)
          const targetSignal = (eventData && eventData.symboltoken === this.peContract?.symboltoken) ? peSignal : ceSignal;
          const targetContract = (eventData && eventData.symboltoken === this.peContract?.symboltoken) ? this.peContract : this.ceContract;
          const targetType = (eventData && eventData.symboltoken === this.peContract?.symboltoken) ? 'PE' : 'CE';

          if (targetSignal && targetSignal.lastCandle) {
            const timeStr = targetSignal.lastCandle.time
              ? new Date(typeof targetSignal.lastCandle.time === 'number' && targetSignal.lastCandle.time < 1e10 ? targetSignal.lastCandle.time * 1000 : targetSignal.lastCandle.time).toLocaleTimeString('en-IN')
              : scanStartTs;

            this.log(`[CANDLE EVALUATION - ${targetType} ${targetContract.tradingsymbol}] Time: ${timeStr}
  EMA = ${targetSignal.ema.toFixed(2)}
  JMA = ${targetSignal.jma.toFixed(2)}
  Last Candle = O:${targetSignal.lastCandle.open.toFixed(2)} H:${targetSignal.lastCandle.high.toFixed(2)} L:${targetSignal.lastCandle.low.toFixed(2)} C:${targetSignal.lastCandle.close.toFixed(2)}
  Prev Candle = O:${targetSignal.prevCandle.open.toFixed(2)} H:${targetSignal.prevCandle.high.toFixed(2)} L:${targetSignal.prevCandle.low.toFixed(2)} C:${targetSignal.prevCandle.close.toFixed(2)}
  lastNoWick = ${targetSignal.lastNoWick}
  prevNoWick = ${targetSignal.prevNoWick}
  jmaGtEma = ${targetSignal.jmaGtEma}
  closeGtJma = ${targetSignal.closeGtJma}
  lastGreen = ${targetSignal.lastGreen}
  prevGreen = ${targetSignal.prevGreen}
  Result: ${targetSignal.isEntry ? 'SIGNAL GENERATED (YES)' : 'NO ENTRY'}
  ${!targetSignal.isEntry && targetSignal.failedReasons?.length ? 'Reason:\n    ' + targetSignal.failedReasons.join('\n    ') : ''}`);
          }

          const ceLastClosedTs = ceItems.length >= 1 ? (ceItems[ceItems.length - 1].time ?? null) : null;
          const peLastClosedTs = peItems.length >= 1 ? (peItems[peItems.length - 1].time ?? null) : null;

          if (!eventData?.synthetic && ceSignal.isEntry && ceLastClosedTs !== this.lastEntryTime) {
            const signalMs = Date.now();
            await this.submitSignalEntry(this.ceContract, ceSignal.haClose, 'BULLISH', ceLastClosedTs, {
              candleDetectedTs: scanStartTs,
              signalGeneratedMs: signalMs,
              signalGeneratedTs: formatPrecisionTime(new Date(signalMs)),
              fetchMs: fetchEndMs - fetchStartMs,
              calcMs: calcEndMs - calcStartMs,
              candleClosedAt: eventData?.closedAt || null,
            });
          } else if (!eventData?.synthetic && peSignal.isEntry && peLastClosedTs !== this.lastEntryTime) {
            const signalMs = Date.now();
            await this.submitSignalEntry(this.peContract, peSignal.haClose, 'BEARISH', peLastClosedTs, {
              candleDetectedTs: scanStartTs,
              signalGeneratedMs: signalMs,
              signalGeneratedTs: formatPrecisionTime(new Date(signalMs)),
              fetchMs: fetchEndMs - fetchStartMs,
              calcMs: calcEndMs - calcStartMs,
              candleClosedAt: eventData?.closedAt || null,
            });
          } else {
            this.trend = ceSignal.trend;
          }
        }
      } catch (err) {
        console.error(`[${this.strategyName}] Scan error:`, err.message);
      }
    };

    this.candleListener = async (eventData) => {
      const hasExposure = Boolean(this.activeTradeId || this.activeTradeContract
        || (this.accountContext && require('./positionExecution').forRunner(this, { feed: marketDataService }).hasExposure()));
      const expectedRole = hasExposure ? 'position' : 'scanner';
      const expectedInterval = this.getBaseTimeframe();
      if (this.accountContext && (eventData.userId !== this.accountContext.userId
        || eventData.brokerAccountId !== this.accountContext.brokerAccountId
        || eventData.sessionGeneration !== this.accountContext.sessionGeneration
        || eventData.sessionId !== this.accountContext.sessionId)) return;
      if (eventData.exchange && eventData.exchange !== (this.activeTradeContract || this.ceContract)?.exchange) return;
      if (eventData.interval && eventData.interval !== expectedInterval) return;
      if (eventData.role && eventData.role !== expectedRole) return;
      if ((this.ceContract && this.peContract) || this.activeTradeContract) {
        if (eventData.symboltoken === this.ceContract?.symboltoken || eventData.symboltoken === this.peContract?.symboltoken
          || eventData.symboltoken === this.activeTradeContract?.symboltoken) {
          await runScan(eventData);
        }
      }
    };

    marketDataService.on('candle:closed', this.candleListener);
  }

  async startUnderlyingDataLoop(requirements) {
    const { INDEX_SPOT_TOKENS } = require('./candleService');
    const underlying = this.config.underlying;
    const instrument = INDEX_SPOT_TOKENS[underlying];
    if (!['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(underlying) || !instrument || !this.accountContext) {
      throw new Error('Underlying candle strategies require a verified account and supported index');
    }
    const context = this.accountContext;
    this.candleListener = async event => {
      if (!this.isRunning || event.userId !== context.userId || event.brokerAccountId !== context.brokerAccountId
        || event.sessionGeneration !== context.sessionGeneration || event.sessionId !== context.sessionId
        || event.role !== 'underlying' || event.underlying !== underlying || event.exchange !== instrument.exchange
        || event.symboltoken !== instrument.symboltoken || !requirements.timeframes.includes(event.interval)) return;
      const snapshot = marketDataService.getUnderlyingSnapshot(underlying);
      this.underlyingData = snapshot;
      this.setDataReadiness(snapshot?.ready ? 'READY' : 'DATA_DEGRADED', snapshot?.ready
        ? 'Completed underlying candle history is ready.' : 'Underlying history is incomplete, invalid or stale.');
      if (this.strategyName === 'IndexVwapOrb' && snapshot?.ready && event.interval === 'ONE_MINUTE' && !this.indexOrbScanInFlight) {
        this.indexOrbScanInFlight = true;
        try {
          const sessions = require('./indexVwapOrbSession');
          const restored = await sessions.restore(context);
          if (!this.isRunning) return;
          const Plugin = strategyRegistry.getPlugin(this.strategyName);
          const result = new Plugin(this.config).analyze({ underlying, asOf: Date.now(), snapshot,
            consumedSetupIds: restored.consumedSetupIds });
          await sessions.checkpoint(context, underlying, { asOf: result.diagnostics.asOf ?? Date.now(),
            state: result.state, setup: result.diagnostics.setup ?? null, signalId: result.signalId ?? null, processedClose: event.closedAt });
          if (!this.isRunning) return;
          this.indexOrbAnalysis = result; this.indexOrbSession = restored;
          this.message = restored.blocked ? 'Entry or exposure requires reconciliation.' : result.isEntry
            ? 'Signal ready; checking option execution.' : result.failedReasons.join(', ');
          if (result.isEntry && !restored.blocked && restored.entriesFilled + restored.entriesReserved < 2) {
            const contract = result.direction === 'LONG' ? this.ceContract : this.peContract;
            const intent = await sessions.prepareEntry(context, { signal: result, config: this.config, contract });
            await require('./positionExecution').forRunner(this, { feed: marketDataService }).executePreparedReferenceEntry(intent._id);
          }
        } catch (error) { this.setDataReadiness('DATA_DEGRADED', error.message); }
        finally { this.indexOrbScanInFlight = false; }
      }
    };
    marketDataService.on('candle:closed', this.candleListener);
    this.underlyingSubscription = underlying;
    const snapshot = await marketDataService.subscribeUnderlying(underlying);
    if (!this.isRunning) return;
    this.underlyingData = snapshot;
    this.setDataReadiness(snapshot?.ready ? 'READY' : 'DATA_DEGRADED');
  }

  async submitSignalEntry(contract, signalPrice, trendSide, candleTime, timingInfo) {
    if (this.entryAttemptInFlight) return { accepted: false, retryableBeforeSubmit: true, reason: 'ENTRY_ATTEMPT_IN_FLIGHT' };
    this.entryAttemptInFlight = String(candleTime);
    try {
      const outcome = await this.executeEntry(contract, signalPrice, trendSide, timingInfo);
      if (outcome?.retryableBeforeSubmit) {
        this.message = 'Entry is waiting for verified execution ownership; the signal remains eligible for re-evaluation.';
        this.log(`Entry deferred before broker submission (${outcome.reason}).`);
        return outcome;
      }
      // Consume only after the execution path has either accepted the request
      // or returned a non-retryable result. Durable/unknown submissions must
      // never be replayed as another BUY from this signal.
      this.lastEntryTime = candleTime;
      return outcome;
    } catch (error) {
      this.lastEntryTime = candleTime;
      throw error;
    } finally {
      this.entryAttemptInFlight = null;
    }
  }

  setDataReadiness(status, message) {
    if (this.dataReadiness !== status) {
      this.dataReadiness = status;
      this.log(message || 'Verified candle history is ready; scanner evaluation resumed.');
    }
  }

  async executeEntry(contract, signalPrice, trendSide, timingInfo = {}) {
    if (this.accountContext) return require('./positionExecution').forRunner(this, { feed: marketDataService }).entry(contract, signalPrice, trendSide, timingInfo);
    if (this.accountContext) await require('./accountContext').validate(this.accountContext);
    if (!this.brokerReady) {
      this.log('Entry blocked because the Angel One session is unavailable.');
      return;
    }
    const signalGeneratedMs = timingInfo.signalGeneratedMs || Date.now();
    const candleDetectedTs = timingInfo.candleDetectedTs || formatPrecisionTime(new Date(signalGeneratedMs));
    const signalGeneratedTs = timingInfo.signalGeneratedTs || formatPrecisionTime(new Date(signalGeneratedMs));

    this.log(`New candle detected: ${candleDetectedTs}`);
    this.log(`Signal generated: ${signalGeneratedTs}`);

    let actualPrice = signalPrice;
    const qty = this.config.quantity || INDEX_CONFIG[this.config.underlying || 'SENSEX']?.qty || 10;
    let entryOrderId = null;
    let protectiveOrderId = null;
    let protectiveStopPrice = null;

    let buySentMs = Date.now();
    let buySentTs = formatPrecisionTime(new Date(buySentMs));

    if (this.config.liveTradingConsent) {
      try {
        const brokerStatus = await callAngelApi('/angel/status');
        if (!brokerStatus || !brokerStatus.connected) {
          throw new Error(brokerStatus?.message || 'Angel One broker session is not connected');
        }

        this.log(`BUY request sent: ${buySentTs}`);
        const sendStartMs = Date.now();
        const orderRes = await callAngelApi('/angel/orders/simple', 'POST', {
          exchange: contract.exchange,
          tradingsymbol: contract.tradingsymbol,
          symboltoken: contract.symboltoken,
          transactiontype: 'BUY',
          producttype: 'CARRYFORWARD',
          quantity: qty,
          ordertype: 'MARKET'
        });
        const ackMs = Date.now();
        const ackTs = formatPrecisionTime(new Date(ackMs));
        this.log(`Broker acknowledged: ${ackTs} (API HTTP delay: ${ackMs - sendStartMs}ms)`);

        const orderId = orderRes?.item?.response?.data?.orderid || orderRes?.item?.response?.orderid;
        entryOrderId = orderId || null;
        if (orderId) {
          let orderConfirmed = false;
          for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const ob = await callAngelApi('/angel/orderbook');
            const order = (ob?.data || []).find(o => String(o.orderid) === String(orderId));
            if (order && (order.status === 'complete' || order.status === 'executed' || order.orderstatus === 'complete')) {
              const execPrice = parseFloat(order.averageprice || order.price);
              if (!isNaN(execPrice) && execPrice > 0) {
                actualPrice = execPrice;
                orderConfirmed = true;
                const completedMs = Date.now();
                const completedTs = formatPrecisionTime(new Date(completedMs));
                this.log(`Order completed: ${completedTs}`);
                break;
              }
            }
          }
          if (!orderConfirmed) {
            throw new Error(`BUY order ${orderId} was not confirmed by the broker`);
          }
        } else {
          throw new Error('Broker returned no BUY order ID');
        }
      } catch (err) {
        console.error(`[${this.strategyName}] LIVE BUY Order failed:`, err.message);
        return;
      }
    } else {
      // Paper trading simulation timing logging
      this.log(`BUY request sent: ${buySentTs}`);
      this.log(`Broker acknowledged: ${buySentTs}`);
      this.log(`Order completed: ${buySentTs}`);
    }

    const confirmedMs = Date.now();
    const confirmedTs = formatPrecisionTime(new Date(confirmedMs));
    this.log(`Execution confirmed: ${confirmedTs}`);

    const totalLatencyMs = confirmedMs - signalGeneratedMs;
    this.log(`Total execution latency: ${totalLatencyMs} ms`);

    this.entryPrice = actualPrice;
    this.entryOrderId = entryOrderId;
    this.activeTradePremium = contract.tradingsymbol;
    this.activeTradeContract = contract;
    this.subscribeHeldPosition(contract);
    this.state = 'IN_POSITION';
    this.trend = trendSide;

    if (this.strategyName === '5minBreakout') {
      const targetPoints = Number(this.config.targetPoints) || 20;
      this.target = actualPrice + targetPoints;
    } else if (this.strategyName === 'ModifiedHeikenAshi') {
      const initialSlPoints = Number(this.config.initialSlPoints) || 30;
      this.activeTrailingSl = actualPrice - initialSlPoints;
    }

    if (this.strategyName === '5minBreakout') {
      protectiveStopPrice = Number(this.stopLoss);
    } else if (this.strategyName === 'ModifiedHeikenAshi' && this.config.exitStrategy === 'TRAILING_SL') {
      protectiveStopPrice = Number(this.activeTrailingSl);
    } else {
      protectiveStopPrice = actualPrice - (Number(this.config.slPoints) || 30);
    }

    if (this.config.liveTradingConsent && Number.isFinite(protectiveStopPrice) && protectiveStopPrice > 0) {
      try {
        const protectiveRes = await callAngelApi('/angel/orders/simple', 'POST', {
          exchange: contract.exchange,
          tradingsymbol: contract.tradingsymbol,
          symboltoken: contract.symboltoken,
          transactiontype: 'SELL',
          producttype: 'CARRYFORWARD',
          quantity: qty,
          ordertype: 'SL',
          triggerprice: protectiveStopPrice
        });
        protectiveOrderId = protectiveRes?.item?.response?.data?.orderid || protectiveRes?.item?.response?.orderid || null;
      } catch (err) {
        this.log(`Protective stop placement failed: ${err.message}`);
      }
    }

    this.protectiveOrderId = protectiveOrderId;
    this.protectiveStopPrice = protectiveStopPrice;
    this.positionState = this.config.liveTradingConsent
      ? (protectiveOrderId ? 'PROTECTED' : 'UNPROTECTED')
      : 'PROTECTED';
    this.state = this.positionState === 'UNPROTECTED' ? 'POSITION_UNPROTECTED' : 'POSITION_PROTECTED';

    if (this.positionState === 'UNPROTECTED') {
      await notifyUrgent('OPEN_POSITION_UNPROTECTED', {
        userId: this.userId,
        brokerAccountId: this.accountContext?.brokerAccountId,
        strategyName: this.strategyName,
        symbol: contract.tradingsymbol,
        quantity: qty,
        state: this.state,
        reason: 'Protective stop was not confirmed',
        lastKnownLtp: actualPrice,
      });
    }

    this.log(`ENTRY ${contract.tradingsymbol} @ ₹${actualPrice}`);

    // Record trade to MongoDB
    const dbStartMs = Date.now();
    try {
      const strategyDoc = await Strategy.findOne({ name: this.strategyName, userId: this.userId });
      if (strategyDoc) {
        const tradeDoc = await Trade.create({
          userId: this.userId,
          ...(this.accountContext ? { brokerAccountId: this.accountContext.brokerAccountId } : {}),
          strategyId: strategyDoc._id,
          index: this.config.underlying || 'SENSEX',
          premium: contract.tradingsymbol,
          qty,
          buyPrice: actualPrice,
          executionMode: this.config.liveTradingConsent ? 'LIVE' : 'PAPER',
          entryOrderId,
          protectiveOrderId,
          protectiveStopPrice,
          positionState: this.positionState
        });
        this.activeTradeId = tradeDoc._id.toString();
        const dbEndMs = Date.now();
        this.log(`Database update complete: ${formatPrecisionTime(new Date(dbEndMs))} (DB write delay: ${dbEndMs - dbStartMs}ms)`);
      }
    } catch (err) {
      console.error(`[${this.strategyName}] Trade DB Record error:`, err.message);
    }

    this.startMonitorLoop();
  }

  startMonitorLoop() {
    if (this.monitorInterval) clearInterval(this.monitorInterval);

    const monitor = async () => {
      const heldState = ['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED'].includes(this.state)
        || (this.accountContext && ['RECONCILIATION_REQUIRED', 'EXIT_PENDING'].includes(this.state));
      if ((!this.isRunning && !this.accountContext && !this.shutdownDraining) || !heldState || !this.activeTradePremium) return;
      // Do not make exit decisions from stale prices while the broker session is down.
      // A confirmed broker-side protective order remains active during this period.
      if (!this.brokerReady) return;

      const contract = this.activeTradeContract || (
        (this.ceContract && this.ceContract.tradingsymbol === this.activeTradePremium)
          ? this.ceContract
          : (this.peContract && this.peContract.tradingsymbol === this.activeTradePremium)
            ? this.peContract
            : null
      );

      if (!contract) return;

        try {
          const ltpRes = await callAngelApi(`/market/ltp?exchange=${encodeURIComponent(contract.exchange)}&tradingsymbol=${encodeURIComponent(contract.tradingsymbol)}&symboltoken=${encodeURIComponent(contract.symboltoken)}${this.accountContext ? '&requireFresh=true' : ''}`, 'GET', null, 5000);
          const livePrice = ltpRes.ltp;
          if (!Number.isFinite(livePrice) || livePrice <= 0) throw new Error('Invalid quote; position monitoring is degraded.');
          if (this.accountContext) {
            const age = Date.now() - ltpRes.quoteTimestamp;
            const maxAge = Math.max(5000, Number(process.env.STALE_POSITION_QUOTE_MS) || 20000);
            if (!Number.isFinite(ltpRes.quoteTimestamp) || age > maxAge || age < -5000) {
              throw new Error('Missing, stale or future exchange quote timestamp; position monitoring is degraded.');
            }
          }
          this.currentLtp = livePrice;
          this.lastQuoteReceivedAt = Date.now();

          if (this.entryPrice) {
            const pnl = (livePrice - this.entryPrice) * (this.config.quantity || 10);
            this.message = `Position Active | LTP: ₹${livePrice.toFixed(2)} | PnL: ₹${pnl.toFixed(2)}`;
          }

          let shouldExit = this.exitTriggered || false;
          let exitPrice = livePrice;
          let exitReason = this.exitReasonStored || '';

          if (!shouldExit) {
            if (this.strategyName === '5minBreakout') {
              const targetPoints = Number(this.config.targetPoints) || 20;
              const targetPrice = (this.entryPrice && !isNaN(this.entryPrice)) ? (this.entryPrice + targetPoints) : this.target;

              if (this.stopLoss && livePrice <= this.stopLoss) {
                shouldExit = true;
                exitReason = 'SL';
              } else if (targetPrice && livePrice >= targetPrice) {
                shouldExit = true;
                exitReason = 'Target';
              }
            } else if (this.strategyName === 'ModifiedHeikenAshi' && this.config.exitStrategy === 'TRAILING_SL') {
              const finalTargetPoints = Number(this.config.finalTargetPoints) || 100;
              const initialSlPoints = Number(this.config.initialSlPoints) || 30;
              const trailingStopPoints = Number(this.config.trailingStopPoints) || 20;

              if (this.entryPrice && this.activeTrailingSl !== null) {
                const targetPrice = this.entryPrice + finalTargetPoints;
                if (livePrice >= targetPrice) {
                  shouldExit = true;
                  exitReason = 'Target';
                } else if (livePrice <= this.activeTrailingSl) {
                  shouldExit = true;
                  exitReason = this.activeTrailingSl === (this.entryPrice - initialSlPoints) ? 'SL' : 'Trailing SL';
                } else {
                  const pointsGained = livePrice - this.entryPrice;
                  if (pointsGained >= trailingStopPoints) {
                    const steps = Math.floor(pointsGained / trailingStopPoints);
                    const proposedSl = this.entryPrice + (steps * trailingStopPoints) - initialSlPoints;
                    if (proposedSl > this.activeTrailingSl) {
                      try {
                        const replaced = await this.replaceProtectiveStop(contract, proposedSl);
                        if (!replaced) return;
                        this.activeTrailingSl = proposedSl;
                        this.log(`Trailed SL up to ₹${proposedSl}`);
                      } catch (err) {
                        this.positionState = 'UNPROTECTED';
                        this.state = 'POSITION_UNPROTECTED';
                        this.log(`Trailing stop update failed: ${err.message}`);
                        await notifyUrgent('OPEN_POSITION_UNPROTECTED', {
                          userId: this.userId,
                          brokerAccountId: this.accountContext?.brokerAccountId,
                          strategyName: this.strategyName,
                          symbol: contract.tradingsymbol,
                          quantity: this.config.quantity || 10,
                          state: this.state,
                          reason: 'Trailing stop replacement failed',
                          lastKnownLtp: livePrice,
                        });
                      }
                    }
                  }
                }
              }
            } else {
              // Combined SL & Target checks for HeikenAshi and all other strategies
              const targetPoints = Number(this.config.targetPoints) || 20;
              const slPoints = Number(this.config.slPoints) || 30;

              if (this.entryPrice) {
                if (livePrice >= this.entryPrice + targetPoints) {
                  shouldExit = true;
                  exitReason = 'Target';
                } else if (livePrice <= this.entryPrice - slPoints) {
                  shouldExit = true;
                  exitReason = 'SL';
                }
              }
            }

            if (shouldExit) {
              this.exitTriggered = true;
              this.exitReasonStored = exitReason;
            }
          }

          if (shouldExit && !this.exitInProgress) {
            const now = Date.now();
            const backoffDelay = Math.min(1000 * Math.pow(2, this.exitRetryCount), 60000);
            if (now - this.lastExitAttemptTime >= backoffDelay) {
              await this.executeExit(contract, exitPrice, exitReason);
            }
          }

      } catch (err) {
        this.message = `Position monitoring degraded: ${err.message}`;
        console.error(`[${this.strategyName}] Monitor error:`, err.message);
      }
    };

    const monitorContext = this.accountContext;
    this.monitorInterval = setInterval(async () => {
      if (this.monitorInFlight) return;
      this.monitorInFlight = true;
      try {
        await (monitorContext ? require('./accountContext').run(monitorContext, monitor) : monitor());
      } finally { this.monitorInFlight = false; }
    }, 1000);
  }

  subscribeHeldPosition(contract) {
    if (typeof marketDataService.subscribe !== 'function' || !contract?.exchange || !contract?.symboltoken) return;
    marketDataService.subscribe(contract.exchange, contract.symboltoken, 'ONE_MINUTE', null,
      { role: 'position', tradingsymbol: contract.tradingsymbol })
      .catch(err => this.log(`Position feed subscription unavailable; existing monitor remains active: ${err.message}`));
  }

  releaseFeed(exchange, token, interval, role) {
    if (typeof marketDataService.unsubscribe !== 'function') return;
    try { marketDataService.unsubscribe(exchange, token, interval, role); }
    catch (error) { console.warn(`[${this.strategyName}] Feed cleanup failed: ${error.message}`); }
  }

  async replaceProtectiveStop(contract, stopPrice) {
    if (this.accountContext) return require('./positionExecution').forRunner(this, { feed: marketDataService }).trailing(stopPrice);
    if (!this.config.liveTradingConsent) return true;
    if (!contract || !Number.isFinite(stopPrice) || stopPrice <= 0) {
      throw new Error('Invalid protective stop details');
    }

    if (this.protectiveOrderId) {
      await callAngelApi(`/angel/orders/${encodeURIComponent(this.protectiveOrderId)}/cancel`, 'POST', { variety: 'NORMAL' });
    }

    const qty = this.config.quantity || 10;
    const protectiveRes = await callAngelApi('/angel/orders/simple', 'POST', {
      exchange: contract.exchange,
      tradingsymbol: contract.tradingsymbol,
      symboltoken: contract.symboltoken,
      transactiontype: 'SELL',
      producttype: 'CARRYFORWARD',
      quantity: qty,
      ordertype: 'SL',
      triggerprice: stopPrice
    });
    const orderId = protectiveRes?.item?.response?.data?.orderid || protectiveRes?.item?.response?.orderid;
    if (!orderId) throw new Error('Broker returned no protective stop order ID');

    this.protectiveOrderId = orderId;
    this.protectiveStopPrice = stopPrice;
    this.positionState = 'PROTECTED';
    this.state = 'POSITION_PROTECTED';
    if (this.activeTradeId) {
      updateRunnerTrade(this, {
        protectiveOrderId: orderId,
        protectiveStopPrice: stopPrice,
        positionState: 'PROTECTED',
        lastBrokerSyncAt: new Date()
      }).catch(err => console.error(`[${this.strategyName}] Protective stop DB sync error:`, err.message));
    }
    return true;
  }

  async executeExit(contract, price, exitReason) {
    if (this.accountContext) {
      const owned = this.activeTradeId && await Trade.findOne(ownedTradeFilter(this, this.activeTradeId));
      if (!owned) throw require('./accountContext').denied('Position ownership could not be verified.', 404);
      if (this.config.liveTradingConsent && (!contract || contract.tradingsymbol !== owned.premium)) {
        throw require('./accountContext').denied('Exit instrument does not match the owned position.');
      }
      return require('./positionExecution').forRunner(this, { feed: marketDataService }).exit(exitReason, price);
    }
    if (this.accountContext) {
      await require('./accountContext').validate(this.accountContext);
      const ownedTrade = this.activeTradeId && await Trade.findOne(ownedTradeFilter(this, this.activeTradeId));
      if (!ownedTrade) {
        throw require('./accountContext').denied('Position ownership could not be verified.', 404);
      }
      if (this.config.liveTradingConsent && (!contract || contract.tradingsymbol !== ownedTrade.premium
        || (this.activeTradeContract && ['exchange', 'symboltoken'].some(key =>
          String(contract[key]) !== String(this.activeTradeContract[key]))))) {
        throw require('./accountContext').denied('Exit instrument does not match the owned position.');
      }
    }
    if (this.exitInProgress) {
      this.log('Exit order execution already in progress. Skipping duplicate call.');
      return;
    }
    this.exitInProgress = true;
    this.isExiting = true;
    this.lastExitAttemptTime = Date.now();
    let actualExitPx = price;
    const qty = this.config.quantity || 10;
    let exitSuccess = false;

    if (this.config.liveTradingConsent && contract) {
      try {
        if (this.protectiveOrderId) {
          await callAngelApi(`/angel/orders/${encodeURIComponent(this.protectiveOrderId)}/cancel`, 'POST', { variety: 'NORMAL' });
          this.protectiveOrderId = null;
        }
        const orderRes = await callAngelApi('/angel/orders/simple', 'POST', {
          exchange: contract.exchange,
          tradingsymbol: contract.tradingsymbol,
          symboltoken: contract.symboltoken,
          transactiontype: 'SELL',
          producttype: 'CARRYFORWARD',
          quantity: qty,
          ordertype: 'MARKET'
        });
        const orderId = orderRes?.item?.response?.data?.orderid || orderRes?.item?.response?.orderid;
        const brokerStatus = orderRes?.item?.response?.status;
        const brokerError = orderRes?.item?.response?.error;

        if (orderId) {
          let handleOrderUpdate = null;
          let fallbackTimer = null;
          const orderUpdates = this.accountContext
            ? await marketDataService.getOrderUpdateService()
            : legacyOrderUpdateService;

          const orderPromise = new Promise((resolve, reject) => {
            handleOrderUpdate = (data, identity) => {
              if (this.accountContext && (!identity || identity.userId !== this.accountContext.userId
                || identity.brokerAccountId !== this.accountContext.brokerAccountId
                || identity.sessionGeneration !== this.accountContext.sessionGeneration
                || identity.sessionId !== this.accountContext.sessionId)) return;
              if (String(data.orderid) === String(orderId)) {
                const status = (data.status || data.orderstatus || '').toLowerCase();
                if (status === 'complete' || status === 'executed') {
                  const execPrice = parseFloat(data.averageprice || data.price);
                  resolve(execPrice > 0 ? execPrice : actualExitPx);
                } else if (status === 'rejected' || status === 'cancelled') {
                  reject(new Error(`Broker order was rejected or cancelled: ${data.text || status}`));
                }
              }
            };
            orderUpdates.on('order:update', handleOrderUpdate);

            fallbackTimer = setTimeout(async () => {
              try {
                console.log(`[${this.strategyName}] WS order confirmation timeout (5s) for ${orderId}. Checking orderbook fallback...`);
                const ob = await callAngelApi('/angel/orderbook');
                const order = (ob?.data || []).find(o => String(o.orderid) === String(orderId));
                if (order && (order.status === 'complete' || order.status === 'executed' || order.orderstatus === 'complete')) {
                  const execPrice = parseFloat(order.averageprice || order.price);
                  resolve(execPrice > 0 ? execPrice : actualExitPx);
                } else if (order && (order.status === 'rejected' || order.status === 'cancelled' || order.orderstatus === 'rejected')) {
                  reject(new Error(`Broker order was rejected or cancelled: ${order.text || order.status}`));
                } else {
                  reject(new Error('Order placed but confirmation timed out in orderbook fallback'));
                }
              } catch (err) {
                reject(err);
              }
            }, 5000);
          });

          try {
            const confirmedPrice = await orderPromise;
            actualExitPx = confirmedPrice;
            exitSuccess = true;
          } finally {
            if (handleOrderUpdate) orderUpdates.off('order:update', handleOrderUpdate);
            if (fallbackTimer) clearTimeout(fallbackTimer);
          }
        } else if (brokerStatus === false && brokerError) {
          const errStr = String(brokerError).toLowerCase();
          if (errStr.includes('no holdings') || errStr.includes('position not found') || errStr.includes('insufficient quantity to sell') || errStr.includes('no open position')) {
            this.log(`Rejection indicates position already closed: ${brokerError}. Cleaning up...`);
            exitSuccess = true;
          } else {
            throw new Error(`Broker rejected order: ${brokerError}`);
          }
        } else {
          throw new Error('SmartAPI returned empty or failed response during order placement');
        }
      } catch (err) {
        this.exitRetryCount++;
        this.lastExitError = err.message;
        this.log(`LIVE SELL failed: ${err.message}. Retries: ${this.exitRetryCount}`);
        this.exitInProgress = false;
        this.isExiting = false;
        return;
      }
    } else {
      exitSuccess = true;
    }

    if (exitSuccess) {
      this.log(`EXIT ${contract ? contract.tradingsymbol : ''} @ ₹${actualExitPx} (${exitReason})`);

      if (this.activeTradeId) {
        try {
          const trade = this.accountContext
            ? await Trade.findOne(ownedTradeFilter(this, this.activeTradeId))
            : await Trade.findById(this.activeTradeId);
          if (trade) {
            const pnl = (actualExitPx - trade.buyPrice) * trade.qty;
            trade.exitPrice = actualExitPx;
            trade.exitReason = exitReason;
            trade.pnl = pnl;
            trade.positionState = 'CLOSED';
            trade.lastBrokerSyncAt = new Date();
            await trade.save();
            this.lastCompletedTrade = trade.toObject();
          }
        } catch (err) {
          console.error(`[${this.strategyName}] Trade exit update DB error:`, err.message);
        }
      }

      if (this.activeTradeContract && typeof marketDataService.unsubscribe === 'function') {
        this.releaseFeed(this.activeTradeContract.exchange, this.activeTradeContract.symboltoken, 'ONE_MINUTE', 'position');
      }
      this.activeTradeId = null;
      this.activeTradePremium = null;
      this.entryPrice = null;
      this.activeTradeContract = null;
      this.activeTrailingSl = null;
      this.entryOrderId = null;
      this.protectiveOrderId = null;
      this.protectiveStopPrice = null;
      this.positionState = 'NONE';
      this.stopLoss = null;
      this.target = null;
      this.rangeSide = null;
      this.trend = 'NEUTRAL';
      
      this.exitInProgress = false;
      this.isExiting = false;
      this.exitTriggered = false;
      this.exitReasonStored = null;
      this.exitRetryCount = 0;
      this.lastExitAttemptTime = 0;
      this.lastExitError = null;

      if (this.monitorInterval) {
        clearInterval(this.monitorInterval);
        this.monitorInterval = null;
      }

      // Cooldown check
      let cooldownMinutes = 0;
      if (this.strategyName === '5minBreakout') {
        cooldownMinutes = 1;
      } else {
        if (exitReason === 'SL') cooldownMinutes = 4;
        else if (exitReason === 'Target' || exitReason === 'Trailing SL') cooldownMinutes = 2;
      }

      if (cooldownMinutes > 0) {
        this.cooldownUntil = Date.now() + (cooldownMinutes * 60 * 1000);
        this.state = 'COOLDOWN';
        this.log(`Entering cooldown for ${cooldownMinutes} min`);
      } else {
        this.state = this.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
      }
    }
  }

  async manualExit() {
    if (this.accountContext) return require('./positionExecution').forRunner(this, { feed: marketDataService }).exit('Manual', this.currentLtp || this.entryPrice);
    if (!this.activeTradePremium) return;
    const contract = (this.ceContract && this.ceContract.tradingsymbol === this.activeTradePremium)
      ? this.ceContract
      : (this.peContract && this.peContract.tradingsymbol === this.activeTradePremium)
        ? this.peContract
        : null;

    let exitPx = this.currentLtp || this.entryPrice || 0;
    if (contract) {
      try {
        const ltpRes = await callAngelApi(`/market/ltp?exchange=${encodeURIComponent(contract.exchange)}&tradingsymbol=${encodeURIComponent(contract.tradingsymbol)}&symboltoken=${encodeURIComponent(contract.symboltoken)}`);
        if (ltpRes.ltp > 0) exitPx = ltpRes.ltp;
      } catch (e) {
        // use fallback
      }
    }

    this.exitTriggered = true;
    this.exitReasonStored = 'Manual';
    this.exitRetryCount = 0;
    this.lastExitAttemptTime = 0;
    await this.executeExit(contract, exitPx, 'Manual');
  }

  handleBrokerSessionLost(reason = 'Broker session expired') {
    this.brokerReady = false;
    if (this.accountContext && require('./positionExecution').forRunner(this, { feed: marketDataService }).hasExposure()) {
      require('./positionExecution').forRunner(this, { feed: marketDataService }).degraded(new Error('Broker session unavailable; protection status cannot currently be verified.'));
      return;
    }
    if (!this.isRunning) return;

    if (this.activeTradePremium) {
      const hasBrokerProtection = Boolean(this.protectiveOrderId);
      this.positionState = hasBrokerProtection ? 'PROTECTED' : 'UNPROTECTED';
      this.state = hasBrokerProtection ? 'POSITION_PROTECTED' : 'POSITION_UNPROTECTED';
      this.message = hasBrokerProtection
        ? `Broker session lost. Broker-side protective stop remains active for ${this.activeTradePremium}.`
        : `URGENT: broker session lost with an unprotected position ${this.activeTradePremium}.`;

      if (this.activeTradeId) {
        updateRunnerTrade(this, {
          positionState: this.positionState,
          lastBrokerSyncAt: new Date()
        }).catch(err => console.error(`[${this.strategyName}] Session-loss DB sync error:`, err.message));
      }

      if (!hasBrokerProtection && !this.sessionAlertSent) {
        this.sessionAlertSent = true;
        notifyUrgent('OPEN_POSITION_SESSION_EXPIRED', {
          userId: this.userId,
          strategyName: this.strategyName,
          symbol: this.activeTradePremium,
          quantity: this.config.quantity || 10,
          state: this.state,
          reason,
          lastKnownLtp: this.currentLtp,
        }).catch(err => console.error(`[${this.strategyName}] Session-loss alert error:`, err.message));
      }
    } else {
      this.message = `Broker session lost. New entries are blocked until reconnection.`;
    }
  }

  handleBrokerSessionRestored() {
    this.brokerReady = true;
    this.sessionAlertSent = false;
    if (this.accountContext && require('./positionExecution').forRunner(this, { feed: marketDataService }).hasExposure()) {
      this.reconcileProtectiveOrder().catch(err => this.log(`Position reconciliation failed: ${err.message}`));
      return;
    }
    if (!this.isRunning) return;

    if (this.activeTradePremium) {
      this.positionState = this.protectiveOrderId ? 'PROTECTED' : 'UNPROTECTED';
      this.state = this.protectiveOrderId ? 'POSITION_PROTECTED' : 'POSITION_UNPROTECTED';
      this.message = this.protectiveOrderId
        ? `Broker session restored. Protective stop active for ${this.activeTradePremium}.`
        : `Broker session restored. Position ${this.activeTradePremium} still requires protection.`;
      if (this.protectiveOrderId) this.reconcileProtectiveOrder().catch(err => this.log(`Protective order reconciliation failed: ${err.message}`));
    } else {
      this.state = this.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
      this.message = 'Broker session restored. Strategy scanning resumed.';
    }
  }

  async reconcileProtectiveOrder() {
    if (this.accountContext) return require('./positionExecution').forRunner(this, { feed: marketDataService }).reconcile();
    if (!this.protectiveOrderId || !this.config.liveTradingConsent) return;
    const orderbook = await callAngelApi('/angel/orderbook');
    const order = (orderbook?.data || []).find(item => String(item.orderid) === String(this.protectiveOrderId));
    const status = String(order?.status || order?.orderstatus || '').toLowerCase();
    if (!['complete', 'executed'].includes(status)) return;

    const exitPrice = Number(order.averageprice || order.price || this.protectiveStopPrice || this.currentLtp || this.entryPrice);
    if (this.activeTradeId) {
      await updateRunnerTrade(this, {
        exitPrice,
        exitReason: 'SL',
        pnl: (exitPrice - this.entryPrice) * (this.config.quantity || 10),
        positionState: 'CLOSED',
        lastBrokerSyncAt: new Date()
      });
    }
    this.log(`Protective stop ${this.protectiveOrderId} was executed while disconnected. Position reconciled.`);
    this.lastCompletedTrade = { exitPrice, exitReason: 'SL' };
    if (this.activeTradeContract) this.releaseFeed(this.activeTradeContract.exchange, this.activeTradeContract.symboltoken, 'ONE_MINUTE', 'position');
    this.activeTradeId = null;
    this.activeTradePremium = null;
    this.activeTradeContract = null;
    this.entryPrice = null;
    this.entryOrderId = null;
    this.protectiveOrderId = null;
    this.protectiveStopPrice = null;
    this.positionState = 'NONE';
    this.exitTriggered = false;
    this.exitReasonStored = null;
    this.state = this.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  getStatus() {
    if (this.underlyingSubscription) {
      const snapshot = require('./accountContext').run(this.accountContext,
        () => marketDataService.getUnderlyingSnapshot(this.underlyingSubscription));
      this.underlyingData = snapshot;
      this.dataReadiness = snapshot?.ready ? 'READY' : 'DATA_DEGRADED';
    }
    // Refresh checkpoints dynamically
    this.checkpoints = [
      { id: 'broker', label: 'Broker Connection', status: this.brokerReady ? 'success' : 'error' },
      { id: 'expiry', label: 'Next Expiry Locked', status: this.selectedExpiry ? 'success' : 'pending' },
      { id: 'ha_trend', label: 'HA Trend Stability', status: this.trend !== 'NEUTRAL' ? 'success' : 'pending' },
      { id: 'confirmation', label: 'ATM Strike Sync', status: this.atmStrike ? 'success' : 'pending' },
      { id: 'indicators', label: 'Premium Discovery', status: (this.ceContract && this.peContract) ? 'success' : 'pending' }
    ];

    return {
      strategyName: this.strategyName,
      isRunning: this.isRunning,
      state: this.state,
      message: this.message,
      trend: this.trend,
      selectedExpiry: this.selectedExpiry,
      atmStrike: this.atmStrike,
      ceContract: this.ceContract,
      peContract: this.peContract,
      monitoredPremiums: this.monitoredPremiums,
      checkpoints: this.checkpoints,
      activeTradeId: this.activeTradeId,
      activeTradePremium: this.activeTradePremium,
      entryPrice: this.entryPrice,
      currentLtp: this.currentLtp,
      lastQuoteReceivedAt: this.lastQuoteReceivedAt ?? null,
      activeTrailingSl: this.activeTrailingSl,
      stopLoss: this.stopLoss,
      target: this.target,
      lastCompletedTrade: this.lastCompletedTrade,
      exitInProgress: this.exitInProgress,
      exitTriggered: this.exitTriggered,
      exitReasonStored: this.exitReasonStored,
      lastExitError: this.lastExitError,
      exitRetryCount: this.exitRetryCount,
      lastExitAttemptTime: this.lastExitAttemptTime,
      brokerReady: this.brokerReady,
      dataReadiness: this.dataReadiness,
      ...(this.underlyingSubscription ? { underlyingData: this.underlyingData } : {}),
      ...(this.strategyName === 'IndexVwapOrb' ? { executionReadiness: 'REFERENCE_RISK_ACCOUNT_GATED', referenceRisk: this.referenceRisk ?? null,
        analysis: this.indexOrbAnalysis ?? null, dailyEntries: this.indexOrbSession ? {
          sessionDate: this.indexOrbSession.day.istDate,
          filled: this.indexOrbSession.entriesFilled, reserved: this.indexOrbSession.entriesReserved, limit: 2,
          blocked: this.indexOrbSession.blocked,
        } : null } : {}),
      positionState: this.positionState,
      remainingQuantity: this.remainingQuantity ?? null,
      pendingEntryQuantity: this.pendingEntryQuantity ?? null,
      completionPending: this.completionPending ?? false,
      entryOrderId: this.entryOrderId,
      protectiveOrderId: this.protectiveOrderId,
      protectiveStopPrice: this.protectiveStopPrice,
      logs: this.logs
    };
  }
}

class StrategyEngineManager {
  constructor() {
    this.runners = new Map();
  }

  getRunner(key) {
    if (!this.runners.has(key)) {
      // key: `${userId}_${strategyName}`
      const parts = key.split('_');
      const strategyName = parts.slice(1).join('_');
      this.runners.set(key, new SingleStrategyRunner(strategyName));
    }
    return this.runners.get(key);
  }

  replaceForRecovery(userId, strategyName) {
    const key = `${userId}_${strategyName}`;
    const runner = new SingleStrategyRunner(strategyName);
    this.runners.set(key, runner);
    return runner;
  }

  async startStrategy(userId, strategyName, config) {
    return require('./accountContext').exclusive(`strategy-start:${userId}:${strategyName}`,
      () => this.startStrategyLocked(userId, strategyName, config));
  }

  async startStrategyLocked(userId, strategyName, config) {
    const key = `${userId}_${strategyName}`;
    let runner = this.getRunner(key);
    const context = require('./accountContext').current();
    if (context) {
      await require('./accountContext').validate(context);
      if (context.userId !== String(userId)) throw require('./accountContext').denied();
      if (runner.isRunning && runner.accountContext && (runner.accountContext.brokerAccountId !== context.brokerAccountId
        || runner.accountContext.sessionId !== context.sessionId || runner.accountContext.sessionGeneration !== context.sessionGeneration)) {
        throw require('./accountContext').denied('Runner belongs to an earlier broker session.');
      }
    }
    if (runner.accountContext && require('./positionExecution').forRunner(runner, { feed: marketDataService }).hasExposure()) {
      throw require('./accountContext').denied('Position settings and mode cannot change while exposure or an order is unresolved.');
    }
    if (runner.isRunning) return runner.getStatus();
    if (context) {
      if (context.userId !== String(userId)) throw require('./accountContext').denied();
      const unverified = await Trade.findOne({ userId, exitPrice: { $exists: false }, executionMode: { $ne: 'PAPER' },
        $or: [{ brokerAccountId: { $exists: false } }, { brokerAccountId: { $ne: context.brokerAccountId } }] }).select('_id').lean();
      if (unverified) throw require('./accountContext').denied('Unresolved legacy position needs verified broker ownership before Start.');
      if (runner.accountContext && (runner.accountContext.brokerAccountId !== context.brokerAccountId
        || runner.accountContext.sessionGeneration !== context.sessionGeneration)) {
        if (runner.isRunning || runner.activeTradeId || runner.activeTradePremium || runner.exitInProgress) {
          throw require('./accountContext').denied('Runner belongs to an earlier broker session.');
        }
        // Retire the instance instead of rebinding late callbacks to a new session.
        runner = new SingleStrategyRunner(strategyName);
        this.runners.set(key, runner);
      }
      runner.accountContext = context;
    }
    await runner.start(config, userId);
    return runner.getStatus();
  }

  async assertAccountCanSwitch(userId) {
    const normalized = String(userId);
    const activeStates = ['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED'];
    const activePositionStates = ['OPEN', 'PROTECTED', 'UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED'];
    for (const [key, runner] of this.runners.entries()) {
      if (!key.startsWith(`${normalized}_`)) continue;
      const status = runner.getStatus();
      if (status.isRunning || status.activeTradeId || activeStates.includes(status.state) || activePositionStates.includes(status.positionState)) {
        const error = new Error('Account switch blocked while a strategy or position is active. Stop strategies and close all positions first.');
        error.status = 409;
        error.code = 'ACCOUNT_SWITCH_BLOCKED';
        throw error;
      }
    }

    const openTrade = await Trade.findOne({
      userId: normalized,
      $or: [
        { exitPrice: { $exists: false } },
        { positionState: { $in: activePositionStates } },
      ],
    }).select('_id').lean();
    if (openTrade) {
      const error = new Error('Account switch blocked while an application position is open or pending.');
      error.status = 409;
      error.code = 'ACCOUNT_SWITCH_BLOCKED';
      throw error;
    }
  }

  stopUserRunners(userId) {
    const normalized = String(userId);
    for (const [key, runner] of this.runners.entries()) {
      if (key.startsWith(`${normalized}_`)) {
        runner.stop();
        if (!runner.accountContext || !require('./positionExecution').forRunner(runner, { feed: marketDataService }).hasExposure()) this.runners.delete(key);
      }
    }
  }

  stopAllForShutdown() {
    let stopped = 0;
    let managed = 0;
    for (const runner of this.runners.values()) {
      const execution = runner.accountContext && require('./positionExecution').forRunner(runner, { feed: marketDataService });
      const hasExposure = Boolean((execution && execution.hasExposure()) || runner.activeTradeId || runner.activeTradePremium
        || runner.exitInProgress || ['OPEN', 'PROTECTED', 'UNPROTECTED', 'EXIT_PENDING', 'RECONCILIATION_REQUIRED'].includes(runner.positionState));
      if (hasExposure && !runner.accountContext) {
        // Keep the legacy single-user monitor alive for the grace window while
        // removing every path that can discover or submit a new strategy entry.
        runner.shutdownDraining = true;
        runner.isRunning = false;
        runner.feedScanReady = false;
        for (const timer of [runner.contractInterval, runner.scanInterval, runner.heartbeatInterval]) if (timer) clearInterval(timer);
        runner.contractInterval = runner.scanInterval = runner.heartbeatInterval = null;
        if (runner.candleListener) marketDataService.removeListener('candle:closed', runner.candleListener);
        runner.candleListener = null;
        if (runner.ceContract) runner.releaseFeed(runner.ceContract.exchange, runner.subscribedCeToken || runner.ceContract.symboltoken, runner.getBaseTimeframe(), 'scanner');
        if (runner.peContract) runner.releaseFeed(runner.peContract.exchange, runner.subscribedPeToken || runner.peContract.symboltoken, runner.getBaseTimeframe(), 'scanner');
      } else runner.stop();
      stopped += 1;
      if (hasExposure) managed += 1;
    }
    return { stopped, positionsStillManaged: managed };
  }

  async finishShutdownHandoff() {
    let quiesced = true;
    for (const runner of this.runners.values()) {
      if (runner.accountContext) {
        const execution = require('./positionExecution').forRunner(runner, { feed: marketDataService });
        if (!await execution.quiesceForShutdown()) quiesced = false;
      } else {
        if (runner.monitorInterval) clearInterval(runner.monitorInterval);
        runner.monitorInterval = null;
        const deadline = Date.now() + 5_000;
        while (runner.monitorInFlight && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        if (runner.monitorInFlight) quiesced = false;
      }
    }
    if (!quiesced) return { handedOff: false, reason: 'A position reconciliation is still active.' };
    const releasedLeases = await require('./executionLeaseService').releaseOwned();
    return { handedOff: true, releasedLeases: releasedLeases.length };
  }

  getRuntimePositionHealth() {
    return [...this.runners.values()].filter(runner => runner.accountContext && (runner.activeTradeId || runner.activeTradePremium))
      .map(runner => {
        const execution = require('./positionExecution').forRunner(runner, { feed: marketDataService });
        return { userId: String(runner.accountContext.userId), brokerAccountId: String(runner.accountContext.brokerAccountId),
          positionId: execution.positionId ? String(execution.positionId) : null,
          lastQuoteReceivedAt: Number(runner.lastQuoteReceivedAt) || null, state: runner.positionState || runner.state };
      });
  }

  stopStrategy(userId, strategyName, context = require('./accountContext').optional()) {
    const key = `${userId}_${strategyName}`;
    const runner = this.getRunner(key);
    if (context && runner.accountContext && (runner.accountContext.userId !== context.userId
      || runner.accountContext.brokerAccountId !== context.brokerAccountId)) {
      throw require('./accountContext').denied('Strategy runner belongs to another broker account.');
    }
    runner.stop();
    return runner.getStatus();
  }

  async manualExitStrategy(userId, strategyName) {
    const key = `${userId}_${strategyName}`;
    const runner = this.getRunner(key);
    const context = require('./accountContext').current();
    if (!runner.activeTradeId && !runner.activeTradePremium) return runner.getStatus();
    if (!runner.accountContext || runner.accountContext.userId !== context.userId
      || runner.accountContext.brokerAccountId !== context.brokerAccountId
      || runner.accountContext.sessionGeneration !== context.sessionGeneration) {
      throw require('./accountContext').denied('Position does not belong to this broker session.');
    }
    if (runner.activeTradeId) {
      const trade = await Trade.findOne({ _id: runner.activeTradeId, userId: context.userId, brokerAccountId: context.brokerAccountId });
      if (!trade) throw require('./accountContext').denied('Position ownership could not be verified.', 404);
    }
    await runner.manualExit();
    return runner.getStatus();
  }

  getStrategyStatus(userId, strategyName, context = require('./accountContext').optional()) {
    const key = `${userId}_${strategyName}`;
    const runner = this.getRunner(key);
    if (context && (!runner.accountContext || runner.accountContext.userId !== context.userId
      || runner.accountContext.brokerAccountId !== context.brokerAccountId)) {
      return new SingleStrategyRunner(strategyName).getStatus();
    }
    return runner.getStatus();
  }

  isTradeActive(userId, tradeId) {
    const ownerId = String(userId);
    const targetTradeId = String(tradeId);
    return Array.from(this.runners.values()).some((runner) =>
      String(runner.userId) === ownerId && String(runner.activeTradeId) === targetTradeId
    );
  }

  handleBrokerSessionLost(reason, brokerAccountId = null, userId = null, sessionGeneration = null) {
    for (const runner of this.runners.values()) {
      const runnerAccountId = runner.accountContext?.brokerAccountId || null;
      const runnerUserId = runner.accountContext?.userId || null;
      const runnerGeneration = runner.accountContext?.sessionGeneration ?? null;
      if (brokerAccountId ? runnerAccountId === brokerAccountId && (!userId || runnerUserId === String(userId))
        && (sessionGeneration == null || runnerGeneration === sessionGeneration) : runnerAccountId === null) {
        runner.handleBrokerSessionLost(reason);
      }
    }
  }

  handleBrokerSessionRestored(brokerAccountId = null, userId = null, sessionGeneration = null) {
    for (const runner of this.runners.values()) {
      const runnerAccountId = runner.accountContext?.brokerAccountId || null;
      const runnerUserId = runner.accountContext?.userId || null;
      const runnerGeneration = runner.accountContext?.sessionGeneration ?? null;
      if (brokerAccountId ? runnerAccountId === brokerAccountId && (!userId || runnerUserId === String(userId))
        && (sessionGeneration == null || runnerGeneration === sessionGeneration) : runnerAccountId === null) {
        runner.handleBrokerSessionRestored();
      }
    }
  }
}

// EventEmitter callbacks may originate outside request async scope. Bind every
// runner method to the context captured at Start, including timers and recovery.
for (const name of Object.getOwnPropertyNames(SingleStrategyRunner.prototype)) {
  if (name === 'constructor') continue;
  const original = SingleStrategyRunner.prototype[name];
  if (typeof original !== 'function') continue;
  SingleStrategyRunner.prototype[name] = function (...args) {
    return this.accountContext
      ? require('./accountContext').run(this.accountContext, () => original.apply(this, args))
      : original.apply(this, args);
  };
}
const manager = new StrategyEngineManager();
marketDataService.on('session:lost', ({ reason, userId, brokerAccountId, sessionGeneration }) => {
  console.warn(`[StrategyEngine] Broker session lost: ${reason}`);
  manager.handleBrokerSessionLost(reason, brokerAccountId || null, userId || null, sessionGeneration ?? null);
  notifyUrgent('BROKER_SESSION_LOST', { reason, userId, brokerAccountId }).catch(err => {
    console.error('[StrategyEngine] Session-loss alert error:', err.message);
  });
});
marketDataService.on('session:restored', ({ broker_account_id: brokerAccountId, brokerAccountId: scopedAccountId, userId, sessionGeneration } = {}) => {
  console.log('[StrategyEngine] Broker session restored');
  manager.handleBrokerSessionRestored(scopedAccountId || brokerAccountId || null, userId || null, sessionGeneration ?? null);
  notifyUrgent('BROKER_SESSION_RESTORED', { userId, brokerAccountId: scopedAccountId || brokerAccountId }).catch(err => {
    console.error('[StrategyEngine] Session-restored alert error:', err.message);
  });
});

module.exports = manager;
