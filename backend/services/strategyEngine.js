const Trade = require('../models/Trade');
const Strategy = require('../models/Strategy');
const contractManager = require('./contractManager');
const marketDataService = require('./marketDataService');
const orderUpdateService = require('./orderUpdateService');
const marketSessionManager = require('./marketSessionManager');
const { notifyUrgent } = require('./notificationService');
marketSessionManager.startMonitoring();

const strategyRegistry = require('./strategyRegistry');
const indicators = require('../trading/indicators');
strategyRegistry.init().catch(err => console.error('[StrategyEngine] Registry init error:', err.message));

const ANGEL_API_BASE = process.env.ANGEL_ONE_API_BASE || 'http://localhost:8000';
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || process.env.ANGEL_ONE_INTERNAL_SECRET || '';

const INDEX_CONFIG = {
  SENSEX: { qty: 20, step: 20, exchange: 'BFO' },
  NIFTY: { qty: 65, step: 65, exchange: 'NFO' },
  BANKNIFTY: { qty: 30, step: 30, exchange: 'NFO' },
  CRUDEOILM: { qty: 1, step: 1, exchange: 'MCX' }
};

// Helper: HTTP request to Python Angel One Wrapper
async function callAngelApi(endpoint, method = 'GET', body = null) {
  const url = `${ANGEL_API_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Service-Key': INTERNAL_SERVICE_KEY,
    }
  };
  if (body !== null) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Angel API Error [${res.status}]: ${text}`);
  }
  return await res.json();
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
    this.state = 'STOPPED';
    this.message = 'Initialized';
    this.trend = 'NEUTRAL';

    this.config = {};
    this.selectedExpiry = null;
    this.atmStrike = null;
    this.ceContract = null;
    this.peContract = null;

    this.monitoredPremiums = { ce: '---', pe: '---' };
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
    this.isExiting = false;
    this.exitInProgress = false;
    this.exitTriggered = false;
    this.exitReasonStored = null;
    this.lastExitError = null;
    this.exitRetryCount = 0;
    this.lastExitAttemptTime = 0;
    this.brokerReady = false;
    this.sessionAlertSent = false;

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
    this.config = config || {};
    this.userId = userId;

    const brokerStatus = await callAngelApi('/angel/status');
    if (!brokerStatus || !brokerStatus.connected) {
      throw new Error(brokerStatus?.message || 'Angel One broker session is not connected');
    }

    this.brokerReady = true;
    this.isRunning = true;
    this.state = this.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
    this.log('Strategy execution started on Node.js');

    // Attempt trade recovery
    await this.recoverTrade();

    // Start background tasks
    this.startContractLoop();
    this.startScanLoop();
    this.startHeartbeatLoop();
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
    this.isRunning = false;
    this.state = 'STOPPED';
    this.log('Strategy execution halted.');
    this.clearAllIntervals();

    const baseTimeframe = this.getBaseTimeframe();
    if (this.candleListener) {
      marketDataService.removeListener('candle:closed', this.candleListener);
      this.candleListener = null;
    }
    if (this.ceContract) {
      marketDataService.unsubscribe(this.ceContract.exchange, this.subscribedCeToken || this.ceContract.symboltoken, baseTimeframe);
    }
    if (this.peContract) {
      marketDataService.unsubscribe(this.peContract.exchange, this.subscribedPeToken || this.peContract.symboltoken, baseTimeframe);
    }

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
    try {
      const strategyDoc = await Strategy.findOne({ name: this.strategyName, userId: this.userId });
      if (!strategyDoc) return;

      const trade = await Trade.findOne({
        userId: this.userId,
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
          
          // Subscribe contracts to MarketDataService only when changed or initial
          const baseTimeframe = this.getBaseTimeframe();
          if (!this.subscribedCeToken || this.subscribedCeToken !== this.ceContract.symboltoken) {
            if (this.subscribedCeToken) {
              marketDataService.unsubscribe(this.ceContract.exchange, this.subscribedCeToken, baseTimeframe);
            }
            await marketDataService.subscribe(this.ceContract.exchange, this.ceContract.symboltoken, baseTimeframe);
            this.subscribedCeToken = this.ceContract.symboltoken;
          }
          if (!this.subscribedPeToken || this.subscribedPeToken !== this.peContract.symboltoken) {
            if (this.subscribedPeToken) {
              marketDataService.unsubscribe(this.peContract.exchange, this.subscribedPeToken, baseTimeframe);
            }
            await marketDataService.subscribe(this.peContract.exchange, this.peContract.symboltoken, baseTimeframe);
            this.subscribedPeToken = this.peContract.symboltoken;
          }
        }
      } catch (err) {
        console.error(`[${this.strategyName}] Contract discovery error:`, err.message);
      }
    };

    await resolveContracts();
    this.contractInterval = setInterval(resolveContracts, 60_000);
  }

  async startScanLoop() {
    if (this.candleListener) return;

    const runScan = async (eventData = null) => {
      if (!this.isRunning) return;
      if (this.state === 'COOLDOWN') {
        if (this.cooldownUntil && Date.now() >= this.cooldownUntil) {
          this.state = this.strategyName === '5minBreakout' ? 'WAITING' : 'SCANNING';
          this.cooldownUntil = null;
          this.log('Cooldown period completed. Resuming scanner.');
        } else {
          return;
        }
      }

      // Handle Reversal exit check when IN_POSITION on closed candle
      if (['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED'].includes(this.state) && this.activeTradePremium) {
        const activeContract = (this.ceContract && this.ceContract.tradingsymbol === this.activeTradePremium)
          ? this.ceContract
          : (this.peContract && this.peContract.tradingsymbol === this.activeTradePremium)
            ? this.peContract
            : null;

        if (activeContract) {
          const baseTimeframe = this.getBaseTimeframe();
          const items = marketDataService.getBuffer(activeContract.exchange, activeContract.symboltoken, baseTimeframe);
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
      if (!this.brokerReady) return;
      if (this.activeTradeId) return;
      if (!this.ceContract || !this.peContract) return;

      const scanStartMs = Date.now();
      const scanStartTs = formatPrecisionTime(new Date(scanStartMs));

      try {
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
            try { ceItems = await marketDataService.subscribe(this.ceContract.exchange, this.ceContract.symboltoken, 'ONE_MINUTE', 20); } catch (err) { return; }
          }
          if (!peItems || peItems.length < requiredCandles) {
            try { peItems = await marketDataService.subscribe(this.peContract.exchange, this.peContract.symboltoken, 'ONE_MINUTE', 20); } catch (err) { return; }
          }
          if (!ceItems || ceItems.length < requiredCandles || !peItems || peItems.length < requiredCandles) return;
          const fetchEndMs = Date.now();

          const ceEval = pluginInstance.analyze({ items: ceItems, lastProcessedTs: this.lastProcessedCandleTs, indicators, userId: this.userId });
          const peEval = pluginInstance.analyze({ items: peItems, lastProcessedTs: this.lastProcessedCandleTs, indicators, userId: this.userId });

          if (ceEval.nextTs) this.lastProcessedCandleTs = ceEval.nextTs;
          else if (peEval.nextTs) this.lastProcessedCandleTs = peEval.nextTs;

          if (ceEval.isBreakout || peEval.isBreakout) {
            const isCE = ceEval.isBreakout;
            const activeEval = isCE ? ceEval : peEval;
            const contractToTrade = isCE ? this.ceContract : this.peContract;

            this.rangeSide = isCE ? 'CE' : 'PE';
            this.stopLoss = activeEval.stopLoss;
            this.target = activeEval.target;

            const signalMs = Date.now();
            await this.executeEntry(contractToTrade, activeEval.entryPrice, isCE ? 'BULLISH' : 'BEARISH', {
              candleDetectedTs: scanStartTs,
              signalGeneratedMs: signalMs,
              signalGeneratedTs: formatPrecisionTime(new Date(signalMs)),
              fetchMs: fetchEndMs - fetchStartMs,
              calcMs: 0
            });
          }
        } else {
          const scanExchange = this.ceContract.exchange;
          const fetchStartMs = Date.now();
          let ceItems = marketDataService.getBuffer(scanExchange, this.ceContract.symboltoken, baseTimeframe);
          let peItems = marketDataService.getBuffer(scanExchange, this.peContract.symboltoken, baseTimeframe);

          if (!ceItems || ceItems.length < requiredCandles) {
            try { ceItems = await marketDataService.subscribe(scanExchange, this.ceContract.symboltoken, baseTimeframe); } catch (err) { return; }
          }
          if (!peItems || peItems.length < requiredCandles) {
            try { peItems = await marketDataService.subscribe(scanExchange, this.peContract.symboltoken, baseTimeframe); } catch (err) { return; }
          }
          if (!ceItems || ceItems.length < requiredCandles || !peItems || peItems.length < requiredCandles) return;
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

          if (ceSignal.isEntry && ceLastClosedTs !== this.lastEntryTime) {
            this.lastEntryTime = ceLastClosedTs;
            const signalMs = Date.now();
            await this.executeEntry(this.ceContract, ceSignal.haClose, 'BULLISH', {
              candleDetectedTs: scanStartTs,
              signalGeneratedMs: signalMs,
              signalGeneratedTs: formatPrecisionTime(new Date(signalMs)),
              fetchMs: fetchEndMs - fetchStartMs,
              calcMs: calcEndMs - calcStartMs
            });
          } else if (peSignal.isEntry && peLastClosedTs !== this.lastEntryTime) {
            this.lastEntryTime = peLastClosedTs;
            const signalMs = Date.now();
            await this.executeEntry(this.peContract, peSignal.haClose, 'BEARISH', {
              candleDetectedTs: scanStartTs,
              signalGeneratedMs: signalMs,
              signalGeneratedTs: formatPrecisionTime(new Date(signalMs)),
              fetchMs: fetchEndMs - fetchStartMs,
              calcMs: calcEndMs - calcStartMs
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
      if (this.ceContract && this.peContract) {
        if (eventData.symboltoken === this.ceContract.symboltoken || eventData.symboltoken === this.peContract.symboltoken) {
          await runScan(eventData);
        }
      }
    };

    marketDataService.on('candle:closed', this.candleListener);
  }

  async executeEntry(contract, signalPrice, trendSide, timingInfo = {}) {
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
      if (!this.isRunning || !['IN_POSITION', 'POSITION_PROTECTED', 'POSITION_UNPROTECTED'].includes(this.state) || !this.activeTradePremium) return;
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
          const ltpRes = await callAngelApi(`/market/ltp?exchange=${encodeURIComponent(contract.exchange)}&tradingsymbol=${encodeURIComponent(contract.tradingsymbol)}&symboltoken=${encodeURIComponent(contract.symboltoken)}`);
          const livePrice = ltpRes.ltp;
          this.currentLtp = livePrice;

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
                        await this.replaceProtectiveStop(contract, proposedSl);
                        this.activeTrailingSl = proposedSl;
                        this.log(`Trailed SL up to ₹${proposedSl}`);
                      } catch (err) {
                        this.positionState = 'UNPROTECTED';
                        this.state = 'POSITION_UNPROTECTED';
                        this.log(`Trailing stop update failed: ${err.message}`);
                        await notifyUrgent('OPEN_POSITION_UNPROTECTED', {
                          userId: this.userId,
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
        console.error(`[${this.strategyName}] Monitor error:`, err.message);
      }
    };

    this.monitorInterval = setInterval(monitor, 1000);
  }

  async replaceProtectiveStop(contract, stopPrice) {
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
      Trade.findByIdAndUpdate(this.activeTradeId, {
        protectiveOrderId: orderId,
        protectiveStopPrice: stopPrice,
        positionState: 'PROTECTED',
        lastBrokerSyncAt: new Date()
      }).catch(err => console.error(`[${this.strategyName}] Protective stop DB sync error:`, err.message));
    }
    return true;
  }

  async executeExit(contract, price, exitReason) {
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

          const orderPromise = new Promise((resolve, reject) => {
            handleOrderUpdate = (data) => {
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

            orderUpdateService.on('order:update', handleOrderUpdate);

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
            if (handleOrderUpdate) orderUpdateService.off('order:update', handleOrderUpdate);
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
          const trade = await Trade.findById(this.activeTradeId);
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
    if (!this.isRunning) return;

    if (this.activeTradePremium) {
      const hasBrokerProtection = Boolean(this.protectiveOrderId);
      this.positionState = hasBrokerProtection ? 'PROTECTED' : 'UNPROTECTED';
      this.state = hasBrokerProtection ? 'POSITION_PROTECTED' : 'POSITION_UNPROTECTED';
      this.message = hasBrokerProtection
        ? `Broker session lost. Broker-side protective stop remains active for ${this.activeTradePremium}.`
        : `URGENT: broker session lost with an unprotected position ${this.activeTradePremium}.`;

      if (this.activeTradeId) {
        Trade.findByIdAndUpdate(this.activeTradeId, {
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
    if (!this.protectiveOrderId || !this.config.liveTradingConsent) return;
    const orderbook = await callAngelApi('/angel/orderbook');
    const order = (orderbook?.data || []).find(item => String(item.orderid) === String(this.protectiveOrderId));
    const status = String(order?.status || order?.orderstatus || '').toLowerCase();
    if (!['complete', 'executed'].includes(status)) return;

    const exitPrice = Number(order.averageprice || order.price || this.protectiveStopPrice || this.currentLtp || this.entryPrice);
    if (this.activeTradeId) {
      await Trade.findByIdAndUpdate(this.activeTradeId, {
        exitPrice,
        exitReason: 'SL',
        pnl: (exitPrice - this.entryPrice) * (this.config.quantity || 10),
        positionState: 'CLOSED',
        lastBrokerSyncAt: new Date()
      });
    }
    this.log(`Protective stop ${this.protectiveOrderId} was executed while disconnected. Position reconciled.`);
    this.lastCompletedTrade = { exitPrice, exitReason: 'SL' };
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
      positionState: this.positionState,
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

  async startStrategy(userId, strategyName, config) {
    const key = `${userId}_${strategyName}`;
    const runner = this.getRunner(key);
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
        this.runners.delete(key);
      }
    }
  }

  stopStrategy(userId, strategyName) {
    const key = `${userId}_${strategyName}`;
    const runner = this.getRunner(key);
    runner.stop();
    return runner.getStatus();
  }

  async manualExitStrategy(userId, strategyName) {
    const key = `${userId}_${strategyName}`;
    const runner = this.getRunner(key);
    await runner.manualExit();
    return runner.getStatus();
  }

  getStrategyStatus(userId, strategyName) {
    const key = `${userId}_${strategyName}`;
    const runner = this.getRunner(key);
    return runner.getStatus();
  }

  handleBrokerSessionLost(reason) {
    for (const runner of this.runners.values()) runner.handleBrokerSessionLost(reason);
  }

  handleBrokerSessionRestored() {
    for (const runner of this.runners.values()) runner.handleBrokerSessionRestored();
  }
}

const manager = new StrategyEngineManager();
marketDataService.on('session:lost', ({ reason }) => {
  console.warn(`[StrategyEngine] Broker session lost: ${reason}`);
  manager.handleBrokerSessionLost(reason);
  notifyUrgent('BROKER_SESSION_LOST', { reason }).catch(err => {
    console.error('[StrategyEngine] Session-loss alert error:', err.message);
  });
});
marketDataService.on('session:restored', () => {
  console.log('[StrategyEngine] Broker session restored');
  manager.handleBrokerSessionRestored();
  notifyUrgent('BROKER_SESSION_RESTORED').catch(err => {
    console.error('[StrategyEngine] Session-restored alert error:', err.message);
  });
});

module.exports = manager;
