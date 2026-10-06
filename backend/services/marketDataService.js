const EventEmitter = require('events');
const marketSessionManager = require('./marketSessionManager');
const SmartStreamService = require('./smartStream').SmartStreamService;
const OrderUpdateService = require('./orderUpdateService').OrderUpdateService;
const activeAccountService = require('./activeAccountService');
const { requestPython } = require('./pythonApiClient');
const accountContext = require('./accountContext');

const EXCH_TYPE_MAP = {
  NSE: 1,
  nse_cm: 1,
  NFO: 2,
  nse_fo: 2,
  BSE: 3,
  bse_cm: 3,
  BFO: 4,
  bse_fo: 4,
  MCX: 5,
  mcx_fo: 5
};

const INTERVAL_MS_MAP = {
  ONE_MINUTE: 60 * 1000,
  '1m': 60 * 1000,
  THREE_MINUTE: 3 * 60 * 1000,
  '3m': 3 * 60 * 1000,
  FIVE_MINUTE: 5 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  FIFTEEN_MINUTE: 15 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  THIRTY_MINUTE: 30 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  ONE_HOUR: 60 * 60 * 1000,
  '1h': 60 * 60 * 1000
};

class AccountMarketDataService extends EventEmitter {
  constructor(context) {
    super();
    this.accountContext = accountContext.assertVerified(context);
    this.smartStream = new SmartStreamService();
    this.orderUpdateService = new OrderUpdateService();
    this.sessionIdentity = {
      userId: String(context.userId), brokerAccountId: String(context.brokerAccountId),
      sessionGeneration: context.sessionGeneration, sessionId: context.sessionId,
    };
    this.destroyed = false;
    this.requestPython = requestPython;
    this.ltpCache = new Map(); // exchangeType:token -> { ltp, timestamp }
    this.subscribers = new Map(); // role:exchange_token_interval -> { exchange, exchangeType, token, role, refCount }
    this.streamSubscribers = new Map(); // exchangeType:token -> { exchange, exchangeType, token, refCount }
    this.candleBuilders = new Map(); // bufferKey -> builder object

    this.wsConsecutiveTicks = 0;
    this.fallbackTimer = null;
    this.fallbackPollingInterval = null;
    this.isRestFallbackActive = false;
    this.sessionId = null;
    this.sessionAvailable = false;
    this.sessionCheckPromise = null;
    this.accountSessionHealth = new Map();
    this.fallbackPollPromise = null;
    this.fallbackCursor = 0;
    this.lastSessionCheckAt = 0;
    this.pendingSubscriptions = new Map();
    this.fallbackBackoffUntil = 0;
    this.fallbackFailures = 0;

    this.smartStream.on('tick', (tick, identity) => this.handleTick(tick, identity));
    this.smartStream.on('disconnected', () => this.handleStreamDisconnect());
    this.smartStream.on('connected', () => this.handleStreamConnect());
  }

  getOrderUpdateService() { return this.orderUpdateService; }

  getBufferKey(exchange, symboltoken, interval) {
    return `${exchange}_${symboltoken}_${interval}`;
  }

  getExchangeType(exchange) {
    const ex = String(exchange || '').toUpperCase();
    return EXCH_TYPE_MAP[ex] || 1;
  }

  getIntervalMs(interval) {
    const iv = String(interval || '').toUpperCase();
    return INTERVAL_MS_MAP[iv] || 5 * 60 * 1000;
  }

  initSession(credentials) {
    if (this.destroyed) return;
    if (credentials) {
      if (!this.smartStream.isConnected && !this.smartStream.isConnecting) {
        this.smartStream.connect(credentials, this.sessionIdentity);
      }
      if (credentials.jwtToken && !this.orderUpdateService.isConnected && !this.orderUpdateService.isConnecting) {
        this.orderUpdateService.connect(credentials.jwtToken, this.sessionIdentity);
      }
    }
  }

  resetAccountSession(expectedBrokerAccountId = null) {
    if (expectedBrokerAccountId && String(this.accountContext?.brokerAccountId || '') !== String(expectedBrokerAccountId)) {
      return false;
    }
    this.destroyed = true;
    for (const pending of this.pendingSubscriptions.values()) pending.cancelled = true;
    this.pendingSubscriptions.clear();
    this.smartStream.disconnect(true);
    this.orderUpdateService.disconnect(true);
    this.stopRestFallback();
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    this.ltpCache.clear();
    this.subscribers.clear();
    this.streamSubscribers.clear();
    this.candleBuilders.clear();
    this.sessionId = null;
    this.sessionAvailable = false;
    return true;
  }

  handleStreamConnect() {
    console.log('[MarketDataService] Smart Stream connected. Monitoring consecutive ticks...');
    this.wsConsecutiveTicks = 0;
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  handleStreamDisconnect() {
    if (this.destroyed || !this.sessionAvailable) return;
    console.warn('[MarketDataService] Smart Stream disconnected. Starting 10s timeout for REST fallback...');
    this.wsConsecutiveTicks = 0;
    if (!this.fallbackTimer) {
      this.fallbackTimer = setTimeout(() => {
        this.startRestFallback();
      }, 10000);
    }
  }

  startRestFallback() {
    if (this.destroyed || this.isRestFallbackActive) return;
    console.warn('[MarketDataService] 10s WebSocket disconnect timeout reached. Enabling REST Fallback Polling (2s interval)...');
    this.isRestFallbackActive = true;

    if (this.fallbackPollingInterval) clearInterval(this.fallbackPollingInterval);
    this.fallbackPollingInterval = setInterval(() => {
      this.pollRestLtpFallback();
    }, 2000);
  }

  stopRestFallback() {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (!this.isRestFallbackActive) return;
    console.log('[MarketDataService] WebSocket feed restored with 3 consecutive ticks. Disabling REST Fallback Polling.');
    this.isRestFallbackActive = false;
    if (this.fallbackPollingInterval) {
      clearInterval(this.fallbackPollingInterval);
      this.fallbackPollingInterval = null;
    }
  }

  async pollRestLtpFallback() {
    if (this.fallbackPollPromise || this.destroyed || Date.now() < this.fallbackBackoffUntil || this.streamSubscribers.size === 0) return this.fallbackPollPromise;
    this.fallbackPollPromise = this._pollRestLtpFallback().finally(() => { this.fallbackPollPromise = null; });
    return this.fallbackPollPromise;
  }

  async _pollRestLtpFallback() {
    const available = [...this.streamSubscribers.entries()].filter(([, sub]) => sub.tradingsymbol);
    if (available.length === 0) return;
    const start = this.fallbackCursor % available.length;
    const subscriptions = Array.from({ length: Math.min(4, available.length) }, (_, offset) => available[(start + offset) % available.length]);
    this.fallbackCursor = (start + subscriptions.length) % available.length;
    const failuresBefore = this.fallbackFailures;
    let receivedQuote = false;

    await Promise.all(subscriptions.map(async ([streamKey, sub]) => {
      try {
        const { response: res, data: json } = await this.requestPython(
          `/market/ltp?exchange=${encodeURIComponent(sub.exchange)}&tradingsymbol=${encodeURIComponent(sub.tradingsymbol)}&symboltoken=${encodeURIComponent(sub.token)}`,
          { timeoutMs: 5000, context: this.accountContext, backgroundQuote: true },
        );
        if (!res.ok) {
          this.backoffFallback(res.status, res.headers?.get('retry-after'));
          return;
        }
        if (this.streamSubscribers.get(streamKey) === sub && !this.destroyed) {
          if (json && Number.isFinite(Number(json.ltp)) && Number(json.ltp) > 0) {
            receivedQuote = true;
            this.handleTick({
              token: sub.token,
              exchangeType: sub.exchangeType,
              ltp: Number(json.ltp),
              timestamp: Date.now(),
              isFallback: true
            });
          } else { this.backoffFallback('invalid-quote'); }
        }
      } catch (err) {
        this.backoffFallback(err.status || 'transport');
      }
    }));
    if (receivedQuote && this.fallbackFailures === failuresBefore) {
      this.fallbackFailures = 0;
      this.fallbackBackoffUntil = 0;
    }
  }

  backoffFallback(status, retryAfter) {
    if (this.destroyed) return;
    this.fallbackFailures++;
    const seconds = Number(retryAfter);
    const retryMs = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 0;
    this.fallbackBackoffUntil = Math.max(this.fallbackBackoffUntil,
      Date.now() + Math.max(2000 * 2 ** Math.min(this.fallbackFailures - 1, 5), Number.isFinite(retryMs) ? retryMs : 0));
    console.warn(`[MarketDataService] Account ${this.accountContext.brokerAccountId} quote fallback failed (${status}); backing off.`);
  }

  handleTick(tick, identity = this.sessionIdentity) {
    return this._acceptTick(tick, identity);
  }

  _acceptTick(tick, identity) {
    if (this.destroyed || !identity || identity.brokerAccountId !== this.sessionIdentity.brokerAccountId
      || identity.userId !== this.sessionIdentity.userId || identity.sessionId !== this.sessionIdentity.sessionId
      || identity.sessionGeneration !== this.sessionIdentity.sessionGeneration) return false;
    if (!tick || !tick.token || !Number.isFinite(tick.ltp) || tick.ltp <= 0) return;

    const token = String(tick.token);
    const streamKey = `${Number(tick.exchangeType)}:${token}`;
    this.ltpCache.set(streamKey, { ltp: tick.ltp, timestamp: tick.timestamp });

    if (!tick.isFallback) {
      this.wsConsecutiveTicks++;
      if (this.wsConsecutiveTicks >= 3 && this.isRestFallbackActive) {
        this.stopRestFallback();
      }
    }

    // Distribute tick to all matching candle builders for this token
    for (const builder of this.candleBuilders.values()) {
      if (builder.symboltoken === token && builder.exchangeType === Number(tick.exchangeType)) {
        this.processTickForBuilder(builder, tick);
      }
    }
    return true;
  }

  processTickForBuilder(builder, tick) {
    const intervalMs = this.getIntervalMs(builder.interval);
    const ts = tick.timestamp;

    if (builder.lastProcessedTs && ts < builder.lastProcessedTs) {
      return; // Discard out of order ticks
    }
    builder.lastProcessedTs = ts;

    const candleStartMs = Math.floor(ts / intervalMs) * intervalMs;
    const candleTimeSec = Math.floor(candleStartMs / 1000);

    if (!builder.activeCandle) {
      builder.activeCandle = {
        time: candleTimeSec,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        candleStartMs
      };
      return;
    }

    if (candleStartMs === builder.activeCandle.candleStartMs) {
      builder.activeCandle.high = Math.max(builder.activeCandle.high, tick.ltp);
      builder.activeCandle.low = Math.min(builder.activeCandle.low, tick.ltp);
      builder.activeCandle.close = tick.ltp;
    } else if (candleStartMs > builder.activeCandle.candleStartMs) {
      // Close current active candle
      const closedCandle = { ...builder.activeCandle };
      delete closedCandle.candleStartMs;
      builder.candles.push(closedCandle);
      if (builder.candles.length > 200) builder.candles.shift();

      this.emit('candle:closed', {
        ...this.sessionIdentity,
        exchange: builder.exchange,
        symboltoken: builder.symboltoken,
        interval: builder.interval,
        candle: closedCandle,
        candles: builder.candles
      });

      // Fill-forward missing gap candles if any
      let gapMs = candleStartMs - builder.activeCandle.candleStartMs;
      while (gapMs > intervalMs) {
        const ghostStartMs = builder.activeCandle.candleStartMs + intervalMs;
        const ghostCandle = {
          time: Math.floor(ghostStartMs / 1000),
          open: closedCandle.close,
          high: closedCandle.close,
          low: closedCandle.close,
          close: closedCandle.close
        };
        builder.candles.push(ghostCandle);
        if (builder.candles.length > 200) builder.candles.shift();

        this.emit('candle:closed', {
          ...this.sessionIdentity,
          exchange: builder.exchange,
          symboltoken: builder.symboltoken,
          interval: builder.interval,
          candle: ghostCandle,
          candles: builder.candles
        });

        builder.activeCandle.candleStartMs = ghostStartMs;
        gapMs -= intervalMs;
      }

      // Initialize new active candle
      builder.activeCandle = {
        time: candleTimeSec,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        candleStartMs
      };
    }
  }

  autoInitSession(force = false) {
    if (this.destroyed) return Promise.resolve();
    if (this.sessionCheckPromise) return this.sessionCheckPromise;
    if (!force && this.sessionAvailable && Date.now() - this.lastSessionCheckAt < 10_000) return Promise.resolve();
    this.lastSessionCheckAt = Date.now();

    return this.checkSession(() => this._performAutoInitSession());
  }

  checkSession(callback) {
    if (this.destroyed) return Promise.resolve();
    if (this.sessionCheckPromise) return this.sessionCheckPromise;
    this.sessionCheckPromise = Promise.resolve().then(callback).finally(() => {
      this.sessionCheckPromise = null;
    });
    return this.sessionCheckPromise;
  }

  performAutoInitSession() { return this.autoInitSession(true); }

  async _performAutoInitSession() {
    const context = this.accountContext;
    try {
      await accountContext.validate(context);
      if (this.destroyed) return;
      const { response: res, data } = await this.requestPython('/angel/session-tokens', { timeoutMs: 10000, context });
      await accountContext.validate(context);
      if (this.destroyed) return;
      if (res.ok) {
        if (data && data.status && data.client_code && data.feed_token) {
          if (data.active_user_id !== context.userId || data.session_id !== context.sessionId) {
            throw accountContext.denied('Broker session identity mismatch.');
          }
          if (!this.sessionAvailable) {
            console.log(`[MarketDataService] Broker session restored${data.session_id ? ` (session ${data.session_id})` : ''}`);
          this.emit('session:restored', { ...data, userId: context.userId, brokerAccountId: context.brokerAccountId, sessionGeneration: context.sessionGeneration, sessionId: context.sessionId });
          }
          this.sessionAvailable = true;
          if (this.sessionId && data.session_id && this.sessionId !== data.session_id) {
            console.log(`[MarketDataService] Broker session changed: ${this.sessionId} -> ${data.session_id}. Reconnecting streams.`);
            this.smartStream.disconnect(false);
            this.orderUpdateService.disconnect(false);
            this.stopRestFallback();
          }
          this.sessionId = data.session_id || this.sessionId;
          this.initSession({
            clientCode: data.client_code,
            feedToken: data.feed_token,
            jwtToken: data.jwt_token,
            apiKey: data.api_key
          });
        }
      } else if (res.status === 401) {
        if (this.sessionAvailable) {
          console.warn('[MarketDataService] Broker session unavailable (HTTP 401)');
        this.emit('session:lost', { reason: 'Broker session is unavailable', ...this.sessionIdentity });
        }
        this.sessionAvailable = false;
        this.sessionId = null;
        this.smartStream.disconnect(false);
        this.orderUpdateService.disconnect(false);
        this.stopRestFallback();
      }
    } catch (e) {
      if (this.destroyed) return;
      if (this.sessionAvailable) {
        console.warn(`[MarketDataService] Broker session health check failed: ${e.message}`);
        this.emit('session:lost', { reason: 'Broker session service is unreachable', ...this.sessionIdentity });
        this.sessionAvailable = false;
      }
    }
  }

  async subscribe(exchange, symboltoken, interval = 'FIVE_MINUTE', lookbackMinutes = null, options = {}) {
    if (this.destroyed) return [];
    const role = options.role === 'position' ? 'position' : 'scanner';

    const token = String(symboltoken);
    const exchType = this.getExchangeType(exchange);
    const key = `${role}:${this.getBufferKey(exchange, token, interval)}`;
    const reservation = { key, cancelled: false };
    this.pendingSubscriptions.set(reservation, reservation);
    try { await this.autoInitSession(); }
    finally { this.pendingSubscriptions.delete(reservation); }
    if (this.destroyed || reservation.cancelled) return [];

    // Reference count the exact candle stream and the underlying broker token separately.
    let sub = this.subscribers.get(key);
    if (!sub) {
      sub = { exchange, exchangeType: exchType, token, role, refCount: 0 };
      this.subscribers.set(key, sub);
    }
    sub.refCount++;
    console.log(`[MarketDataService] Candle subscription ${key}: refCount=${sub.refCount}`);

    const streamKey = `${exchType}:${token}`;
    let streamSub = this.streamSubscribers.get(streamKey);
    if (!streamSub) {
      streamSub = { exchange, exchangeType: exchType, token, tradingsymbol: options.tradingsymbol, refCount: 0 };
      this.streamSubscribers.set(streamKey, streamSub);
    }
    if (options.tradingsymbol) streamSub.tradingsymbol = options.tradingsymbol;
    streamSub.refCount++;

    if (streamSub.refCount === 1) {
      console.log(`[MarketDataService] Broker stream subscribe ${streamKey}`);
      this.smartStream.subscribe([{ exchangeType: exchType, tokens: [token] }]);
    }

    // Builder Setup
    if (role === 'position' && !options.buildCandles) return [];
    let builder = this.candleBuilders.get(key);
    if (!builder) {
      builder = {
        key,
        exchange,
        exchangeType: exchType,
        symboltoken: token,
        interval,
        candles: [],
        activeCandle: null,
        lastProcessedTs: 0
      };
      this.candleBuilders.set(key, builder);

      // Backfill historical candles via REST
      try {
        const targetDate = new Date().toISOString().split('T')[0];
        const { response: res, data } = await this.requestPython(
          `/market/candles?exchange=${encodeURIComponent(exchange)}&symboltoken=${encodeURIComponent(token)}&interval=${encodeURIComponent(interval)}&date=${encodeURIComponent(targetDate)}`,
          { timeoutMs: 10000, context: this.accountContext },
        );
        if (res.ok && !this.destroyed && this.candleBuilders.get(key) === builder) {
          if (Array.isArray(data?.items)) {
            const parsed = data.items.map(c => ({
              time: Math.floor(new Date(c.ts.includes('+') ? c.ts : `${c.ts.replace(' ', 'T')}+05:30`).getTime() / 1000),
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close)
            })).sort((a, b) => a.time - b.time);
            builder.candles = parsed;
          }
        }
      } catch (err) {
        console.warn(`[MarketDataService] Seeding historical candles failed for ${key}:`, err.message);
      }
    }

    return builder.candles;
  }

  unsubscribe(exchange, symboltoken, interval = 'FIVE_MINUTE', role = 'scanner') {
    const token = String(symboltoken);
    const key = `${role === 'position' ? 'position' : 'scanner'}:${this.getBufferKey(exchange, token, interval)}`;

    const pending = [...this.pendingSubscriptions.values()].find(item => item.key === key && !item.cancelled);
    if (pending) { pending.cancelled = true; return; }

    const sub = this.subscribers.get(key);
    if (sub) {
      sub.refCount--;
      if (sub.refCount <= 0) {
        console.log(`[MarketDataService] Candle subscription ${key}: removed`);
        this.candleBuilders.delete(key);
        this.subscribers.delete(key);
      }

      const streamKey = `${sub.exchangeType}:${token}`;
      const streamSub = this.streamSubscribers.get(streamKey);
      if (streamSub) {
        streamSub.refCount--;
        if (streamSub.refCount <= 0) {
          console.log(`[MarketDataService] Broker stream unsubscribe ${streamKey}`);
          this.streamSubscribers.delete(streamKey);
          this.ltpCache.delete(streamKey);
          try { this.smartStream.unsubscribe([{ exchangeType: streamSub.exchangeType, tokens: [token] }]); }
          catch (error) { console.warn(`[MarketDataService] Feed cleanup failed: ${error.message}`); }
        } else {
          console.log(`[MarketDataService] Broker stream ${streamKey}: refCount=${streamSub.refCount}`);
        }
      }
    }
  }

  getLtp(exchange, symboltoken) {
    const token = String(symboltoken);
    const cached = this.ltpCache.get(`${this.getExchangeType(exchange)}:${token}`);
    return cached ? cached.ltp : null;
  }

  getBuffer(exchange, symboltoken, interval, role = 'scanner') {
    const key = `scanner:${this.getBufferKey(exchange, symboltoken, interval)}`;
    const builder = this.candleBuilders.get(role === 'position' ? key.replace('scanner:', 'position:') : key)
      || this.candleBuilders.get(key.replace('scanner:', 'position:'));
    return builder ? builder.candles : [];
  }
}

class MarketDataRouter extends EventEmitter {
  constructor() {
    super();
    this.accounts = new Map();
    this.listenerServices = new WeakMap();
    this.sessionCheckPromise = null;
    this.accountSessionHealth = new Map();
    this.pendingRoutes = new Set();
  }

  _key(context) { return `${context.userId}:${context.brokerAccountId}`; }

  _currentContext() {
    const context = accountContext.optional();
    if (context) return context;
    const active = activeAccountService.listActiveAccounts();
    if (active.length !== 1) throw accountContext.denied('Verified account context is required for market data.');
    return accountContext.resolve(active[0].userId, active[0].brokerAccountId);
  }

  async _service(context = null) {
    context = context || await this._currentContext();
    await accountContext.validate(context);
    const key = this._key(context);
    let service = this.accounts.get(key);
    if (service && (service.destroyed || service.sessionIdentity.sessionId !== context.sessionId
      || service.sessionIdentity.sessionGeneration !== context.sessionGeneration)) {
      service.resetAccountSession(context.brokerAccountId);
      this.accounts.delete(key);
      service = null;
    }
    if (!service) {
      service = new AccountMarketDataService(context);
      this.accounts.set(key, service);
      for (const event of ['session:lost', 'session:restored']) {
        service.on(event, payload => {
          if (!service.destroyed && payload?.sessionGeneration === service.sessionIdentity.sessionGeneration
            && payload?.sessionId === service.sessionIdentity.sessionId) this.emit(event, payload);
        });
      }
    }
    return service;
  }

  _serviceSync() {
    const context = accountContext.optional();
    if (context) {
      accountContext.assertVerified(context);
      const service = this.accounts.get(this._key(context));
      if (service && !service.destroyed && service.sessionIdentity.sessionGeneration === context.sessionGeneration
        && service.sessionIdentity.sessionId === context.sessionId) return service;
      throw accountContext.denied('Market feed for this broker session is not initialized.');
    }
    if (this.accounts.size === 1) return this.accounts.values().next().value;
    throw accountContext.denied('Verified account context is required for market data.');
  }

  autoInitSession() {
    if (this.sessionCheckPromise) return this.sessionCheckPromise;
    this.sessionCheckPromise = this._checkAccounts().finally(() => { this.sessionCheckPromise = null; });
    return this.sessionCheckPromise;
  }

  async performAutoInitSession() { return this.autoInitSession(); }

  async _checkAccounts() {
    const accounts = activeAccountService.listActiveAccounts();
    if (accounts.length === 0) {
      const legacy = activeAccountService.getActiveAccount();
      if (legacy?.userId && legacy?.brokerAccountId) accounts.push(legacy);
    }
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => {
      while (index < accounts.length) {
        const active = accounts[index++];
        let context = null;
        let service = null;
        let key = null;
        try {
          context = await accountContext.resolve(active.userId, active.brokerAccountId);
          service = await this._service(context);
          key = this._key(context);
          await service.checkSession(async () => {
            const { response, data } = await requestPython('/angel/status', { context, timeoutMs: 5000 });
            await accountContext.validate(context);
            const now = activeAccountService.getActiveAccount(context.userId, context.brokerAccountId);
            if (service.destroyed || !now || now.sessionGeneration !== context.sessionGeneration || now.sessionId !== context.sessionId) return;
            const connected = response.ok && Boolean(data?.connected ?? data?.status);
            const previous = this.accountSessionHealth.get(key) || { connected: true, sessionGeneration: context.sessionGeneration };
            this.accountSessionHealth.set(key, { connected, sessionGeneration: context.sessionGeneration });
            if (previous.sessionGeneration === context.sessionGeneration && previous.connected && !connected) {
              service.emit('session:lost', { ...service.sessionIdentity, reason: data?.message || 'Broker session is unavailable' });
            }
            if (connected) {
              await service._performAutoInitSession();
            } else {
              service.sessionAvailable = false;
              service.ltpCache.clear();
              service.smartStream.disconnect(false);
              service.orderUpdateService.disconnect(false);
              service.stopRestFallback();
            }
          });
        } catch (error) {
          if (context && service && !service.destroyed && key) {
            const current = activeAccountService.getActiveAccount(context.userId, context.brokerAccountId);
            if (current?.sessionGeneration === context.sessionGeneration && current?.sessionId === context.sessionId) {
              const previous = this.accountSessionHealth.get(key) || { connected: true, sessionGeneration: context.sessionGeneration };
              this.accountSessionHealth.set(key, { connected: false, sessionGeneration: context.sessionGeneration });
              if (previous.connected && previous.sessionGeneration === context.sessionGeneration) {
                service.emit('session:lost', { ...service.sessionIdentity, reason: 'Broker session service is unreachable' });
              }
              service.sessionAvailable = false;
              service.ltpCache.clear();
              service.smartStream.disconnect(false);
              service.orderUpdateService.disconnect(false);
              service.stopRestFallback();
            }
          }
          console.warn(`[MarketDataService] Account session check failed: ${error.message}`);
        }
      }
    }));
  }

  async subscribe(...args) {
    const current = this._currentContext();
    const context = accountContext.optional() || await current;
    const reservation = { context, args, cancelled: false };
    this.pendingRoutes.add(reservation);
    try {
      const service = await this._service(context);
      if (reservation.cancelled) return [];
      const result = service.subscribe(...args);
      this.pendingRoutes.delete(reservation);
      return await result;
    } finally { this.pendingRoutes.delete(reservation); }
  }
  async ensureReady() {
    const service = await this._service();
    await service.autoInitSession();
    await accountContext.validate(service.accountContext);
    if (service.destroyed || !service.sessionAvailable) throw accountContext.denied('Broker feed is unavailable.');
    return service;
  }
  unsubscribe(...args) {
    const context = accountContext.optional();
    if (context) {
      accountContext.assertVerified(context);
      const pending = [...this.pendingRoutes].find(item => !item.cancelled && this._key(item.context) === this._key(context)
        && item.context.sessionId === context.sessionId && item.context.sessionGeneration === context.sessionGeneration
        && item.args[0] === args[0] && String(item.args[1]) === String(args[1])
        && (item.args[2] || 'FIVE_MINUTE') === (args[2] || 'FIVE_MINUTE')
        && (item.args[4]?.role || 'scanner') === (args[3] || 'scanner'));
      if (pending) { pending.cancelled = true; return; }
      const service = this.accounts.get(this._key(context));
      if (!service || service.destroyed || service.sessionIdentity.sessionId !== context.sessionId
        || service.sessionIdentity.sessionGeneration !== context.sessionGeneration) return;
      return service.unsubscribe(...args);
    }
    return this._serviceSync().unsubscribe(...args);
  }
  getLtp(...args) { return this._serviceSync().getLtp(...args); }
  getBuffer(...args) { return this._serviceSync().getBuffer(...args); }
  async getOrderUpdateService() { return (await this._service()).getOrderUpdateService(); }

  on(event, listener) {
    if (event !== 'candle:closed') return super.on(event, listener);
    const context = accountContext.optional();
    if (!context) throw accountContext.denied('Account context required for candle subscriptions.');
    const key = this._key(context);
    const service = this.accounts.get(key);
    if (!service || service.sessionIdentity.sessionGeneration !== context.sessionGeneration) throw accountContext.denied('Market feed is not initialized.');
    accountContext.assertVerified(context);
    if (service.destroyed || service.sessionIdentity.sessionId !== context.sessionId) throw accountContext.denied('Market feed is not initialized.');
    const wrapped = payload => {
      if (service.destroyed || this.accounts.get(key) !== service || payload?.userId !== context.userId
        || payload?.brokerAccountId !== context.brokerAccountId || payload?.sessionId !== context.sessionId
        || payload?.sessionGeneration !== context.sessionGeneration) return;
      const active = activeAccountService.getActiveAccount(context.userId, context.brokerAccountId);
      if (!active || active.sessionId !== context.sessionId || active.sessionGeneration !== context.sessionGeneration
        || active.ownerGeneration !== context.ownerGeneration) return;
      // Preserve synchronous closed-candle delivery (including fill-forward gaps).
      // Broker requests/entries still revalidate ownership against persistence.
      try {
        Promise.resolve(accountContext.run(context, () => listener(payload)))
          .catch(error => console.warn(`[MarketDataService] Account candle callback failed: ${error.message}`));
      } catch (error) { console.warn(`[MarketDataService] Account candle callback failed: ${error.message}`); }
    };
    service.on(event, wrapped);
    this.listenerServices.set(listener, { service, wrapped });
    return this;
  }

  removeListener(event, listener) {
    if (event !== 'candle:closed') return super.removeListener(event, listener);
    const registration = this.listenerServices.get(listener);
    if (registration) registration.service.removeListener(event, registration.wrapped);
    this.listenerServices.delete(listener);
    return this;
  }

  resetAccountSession(expectedBrokerAccountId = null) {
    for (const pending of this.pendingRoutes) {
      if (!expectedBrokerAccountId || String(pending.context.brokerAccountId) === String(expectedBrokerAccountId)) pending.cancelled = true;
    }
    let reset = false;
    for (const [key, service] of this.accounts) {
      if (!expectedBrokerAccountId || String(service.accountContext.brokerAccountId) === String(expectedBrokerAccountId)) {
        reset = service.resetAccountSession(expectedBrokerAccountId) || reset;
        this.accountSessionHealth.delete(key);
        this.accounts.delete(key);
      }
    }
    return reset;
  }
}

const router = new MarketDataRouter();
router.AccountMarketDataService = AccountMarketDataService;
router.MarketDataRouter = MarketDataRouter;
module.exports = router;
