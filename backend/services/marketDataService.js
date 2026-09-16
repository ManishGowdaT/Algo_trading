const EventEmitter = require('events');
const config = require('../config');
const marketSessionManager = require('./marketSessionManager');
const smartStream = require('./smartStream');
const orderUpdateService = require('./orderUpdateService');
const activeAccountService = require('./activeAccountService');

const ANGEL_API_BASE = config.API.ANGEL_ONE_API_BASE;

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

class MarketDataService extends EventEmitter {
  constructor() {
    super();
    this.ltpCache = new Map(); // token -> { ltp, timestamp }
    this.subscribers = new Map(); // exchange_token_interval -> { exchange, exchangeType, token, refCount }
    this.streamSubscribers = new Map(); // exchangeType:token -> { exchange, exchangeType, token, refCount }
    this.candleBuilders = new Map(); // bufferKey -> builder object

    this.wsConsecutiveTicks = 0;
    this.fallbackTimer = null;
    this.fallbackPollingInterval = null;
    this.isRestFallbackActive = false;
    this.sessionId = null;
    this.sessionAvailable = false;

    smartStream.on('tick', (tick) => this.handleTick(tick));
    smartStream.on('disconnected', () => this.handleStreamDisconnect());
    smartStream.on('connected', () => this.handleStreamConnect());
  }

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
    if (credentials) {
      if (!smartStream.isConnected && !smartStream.isConnecting) {
        smartStream.connect(credentials);
      }
      if (credentials.jwtToken && !orderUpdateService.isConnected && !orderUpdateService.isConnecting) {
        orderUpdateService.connect(credentials.jwtToken);
      }
    }
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
    console.warn('[MarketDataService] Smart Stream disconnected. Starting 10s timeout for REST fallback...');
    this.wsConsecutiveTicks = 0;
    if (!this.fallbackTimer) {
      this.fallbackTimer = setTimeout(() => {
        this.startRestFallback();
      }, 10000);
    }
  }

  startRestFallback() {
    if (this.isRestFallbackActive) return;
    console.warn('[MarketDataService] 10s WebSocket disconnect timeout reached. Enabling REST Fallback Polling (2s interval)...');
    this.isRestFallbackActive = true;

    if (this.fallbackPollingInterval) clearInterval(this.fallbackPollingInterval);
    this.fallbackPollingInterval = setInterval(() => {
      this.pollRestLtpFallback();
    }, 2000);
  }

  stopRestFallback() {
    if (!this.isRestFallbackActive) return;
    console.log('[MarketDataService] WebSocket feed restored with 3 consecutive ticks. Disabling REST Fallback Polling.');
    this.isRestFallbackActive = false;
    if (this.fallbackPollingInterval) {
      clearInterval(this.fallbackPollingInterval);
      this.fallbackPollingInterval = null;
    }
  }

  async pollRestLtpFallback() {
    if (this.subscribers.size === 0) return;

    for (const [streamKey, sub] of this.streamSubscribers.entries()) {
      try {
        const url = `${ANGEL_API_BASE}/market/ltp?exchange=${encodeURIComponent(sub.exchange)}&tradingsymbol=&symboltoken=${encodeURIComponent(sub.token)}`;
        const res = await fetch(url, {
          headers: { 'X-Internal-Service-Key': config.API.INTERNAL_SERVICE_KEY },
        });
        if (res.ok) {
          const json = await res.json();
          if (json && json.ltp > 0) {
          this.handleTick({
            token: sub.token,
              exchangeType: sub.exchangeType,
              ltp: json.ltp,
              timestamp: Date.now(),
              isFallback: true
            });
          }
        }
      } catch (err) {
        // Suppress fallback error output
      }
    }
  }

  handleTick(tick) {
    if (!tick || !tick.token || typeof tick.ltp !== 'number' || tick.ltp <= 0) return;

    const token = String(tick.token);
    this.ltpCache.set(token, { ltp: tick.ltp, timestamp: tick.timestamp });

    if (!tick.isFallback) {
      this.wsConsecutiveTicks++;
      if (this.wsConsecutiveTicks >= 3 && this.isRestFallbackActive) {
        this.stopRestFallback();
      }
    }

    // Distribute tick to all matching candle builders for this token
    for (const [key, builder] of this.candleBuilders.entries()) {
      if (builder.symboltoken === token) {
        this.processTickForBuilder(builder, tick);
      }
    }
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

  async autoInitSession() {
    try {
      const res = await fetch(`${ANGEL_API_BASE}/angel/session-tokens`, {
        headers: { 'X-Internal-Service-Key': config.API.INTERNAL_SERVICE_KEY },
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.status && data.client_code && data.feed_token) {
          if (!this.sessionAvailable) {
            console.log(`[MarketDataService] Broker session restored${data.session_id ? ` (session ${data.session_id})` : ''}`);
            this.emit('session:restored', data);
          }
          this.sessionAvailable = true;
          if (data.active_user_id) {
            activeAccountService.setActiveAccount({
              userId: data.active_user_id,
              clientCode: data.client_code,
              sessionId: data.session_id,
            });
          }
          if (this.sessionId && data.session_id && this.sessionId !== data.session_id) {
            console.log(`[MarketDataService] Broker session changed: ${this.sessionId} -> ${data.session_id}. Reconnecting streams.`);
            smartStream.disconnect(false);
            orderUpdateService.disconnect(false);
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
          this.emit('session:lost', { reason: 'Broker session is unavailable' });
        }
        this.sessionAvailable = false;
        this.sessionId = null;
        activeAccountService.clearActiveAccount();
        smartStream.disconnect(false);
        orderUpdateService.disconnect(false);
        this.stopRestFallback();
      }
    } catch (e) {
      if (this.sessionAvailable) {
        console.warn(`[MarketDataService] Broker session health check failed: ${e.message}`);
        this.emit('session:lost', { reason: 'Broker session service is unreachable' });
        this.sessionAvailable = false;
        activeAccountService.clearActiveAccount();
      }
    }
  }

  async subscribe(exchange, symboltoken, interval = 'FIVE_MINUTE', lookbackMinutes = null) {
    await this.autoInitSession();

    const token = String(symboltoken);
    const exchType = this.getExchangeType(exchange);
    const key = this.getBufferKey(exchange, token, interval);

    // Reference count the exact candle stream and the underlying broker token separately.
    let sub = this.subscribers.get(key);
    if (!sub) {
      sub = { exchange, exchangeType: exchType, token, refCount: 0 };
      this.subscribers.set(key, sub);
    }
    sub.refCount++;
    console.log(`[MarketDataService] Candle subscription ${key}: refCount=${sub.refCount}`);

    const streamKey = `${exchType}:${token}`;
    let streamSub = this.streamSubscribers.get(streamKey);
    if (!streamSub) {
      streamSub = { exchange, exchangeType: exchType, token, refCount: 0 };
      this.streamSubscribers.set(streamKey, streamSub);
    }
    streamSub.refCount++;

    if (streamSub.refCount === 1) {
      console.log(`[MarketDataService] Broker stream subscribe ${streamKey}`);
      smartStream.subscribe([{ exchangeType: exchType, tokens: [token] }]);
    }

    // Builder Setup
    let builder = this.candleBuilders.get(key);
    if (!builder) {
      builder = {
        key,
        exchange,
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
        const url = `${ANGEL_API_BASE}/market/candles?exchange=${encodeURIComponent(exchange)}&symboltoken=${encodeURIComponent(token)}&interval=${encodeURIComponent(interval)}&date=${targetDate}`;
        const res = await fetch(url, {
          headers: { 'X-Internal-Service-Key': config.API.INTERNAL_SERVICE_KEY },
        });
        if (res.ok) {
          const json = await res.json();
          if (Array.isArray(json.items)) {
            const parsed = json.items.map(c => ({
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

  unsubscribe(exchange, symboltoken, interval = 'FIVE_MINUTE') {
    const token = String(symboltoken);
    const key = this.getBufferKey(exchange, token, interval);

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
          smartStream.unsubscribe([{ exchangeType: streamSub.exchangeType, tokens: [token] }]);
          this.streamSubscribers.delete(streamKey);
          this.ltpCache.delete(token);
        } else {
          console.log(`[MarketDataService] Broker stream ${streamKey}: refCount=${streamSub.refCount}`);
        }
      }
    }
  }

  getLtp(exchange, symboltoken) {
    const token = String(symboltoken);
    const cached = this.ltpCache.get(token);
    return cached ? cached.ltp : null;
  }

  getBuffer(exchange, symboltoken, interval) {
    const key = this.getBufferKey(exchange, symboltoken, interval);
    const builder = this.candleBuilders.get(key);
    return builder ? builder.candles : [];
  }
}

module.exports = new MarketDataService();
