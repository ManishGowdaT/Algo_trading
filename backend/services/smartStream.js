const EventEmitter = require('events');

class SmartStreamService extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.credentials = null; // { clientCode, feedToken, apiKey, jwtToken }
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.subscribedTokens = new Map(); // exchangeType:token -> { token, exchangeType }
    this.isExplicitDisconnect = false;
    this.connectionGeneration = 0;
    this.accountIdentity = null;
  }

  connect(credentials, accountIdentity = this.accountIdentity) {
    if (credentials) {
      this.credentials = credentials;
    }

    if (!this.credentials || !this.credentials.clientCode || !this.credentials.feedToken || !this.credentials.apiKey) {
      console.warn('[SmartStreamService] Cannot connect without valid credentials');
      return;
    }

    if (this.isConnected || this.isConnecting) {
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
        return; // Already connecting or connected
      }
    }

    this.disconnect(false);
    this.isExplicitDisconnect = false;
    this.accountIdentity = accountIdentity ? { ...accountIdentity } : null;
    const connectionIdentity = this.accountIdentity ? { ...this.accountIdentity } : null;
    const connectionGeneration = ++this.connectionGeneration;

    try {
      const WebSocketImpl = globalThis.WebSocket || require('ws');
      const params = new URLSearchParams({
        clientCode: this.credentials.clientCode,
        feedToken: this.credentials.feedToken,
        apiKey: this.credentials.apiKey
      });

      const wsUrl = `wss://smartapisocket.angelone.in/smart-stream?${params.toString()}`;
      console.log('[SmartStreamService] Connecting to Smart Stream 2.0...');
      this.isConnecting = true;

      const headers = {};
      if (this.credentials.jwtToken) {
        headers['Authorization'] = this.credentials.jwtToken.startsWith('Bearer ')
          ? this.credentials.jwtToken
          : `Bearer ${this.credentials.jwtToken}`;
        headers['x-api-key'] = this.credentials.apiKey;
        headers['x-client-code'] = this.credentials.clientCode;
        headers['x-feed-token'] = this.credentials.feedToken;
      }

      const socket = new WebSocketImpl(wsUrl, { headers });
      this.ws = socket;
      socket.binaryType = 'arraybuffer';

      socket.onopen = () => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        console.log('[SmartStreamService] Smart Stream WebSocket connected');
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startKeepalive();
        this.resubscribeAll();
        this.emit('connected');
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        this.handleMessage(event.data, connectionIdentity);
      };

      socket.onerror = (err) => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        console.error('[SmartStreamService] WebSocket error:', err.message || err);
      };

      socket.onclose = (event) => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        console.warn(`[SmartStreamService] WebSocket closed (code: ${event.code})`);
        this.cleanup();
        if (!this.isExplicitDisconnect) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.isConnecting = false;
      console.error('[SmartStreamService] Error initiating WebSocket:', err.message);
      this.scheduleReconnect();
    }
  }

  startKeepalive() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.isConnected) {
        try {
          this.ws.send('ping');
        } catch (e) {
          console.warn('[SmartStreamService] Ping failed:', e.message);
        }
      }
    }, 30000);
  }

  subscribe(tokenList) {
    if (!Array.isArray(tokenList) || tokenList.length === 0) return;

    for (const item of tokenList) {
      const exchType = Number(item.exchangeType);
      for (const token of item.tokens) {
        this.subscribedTokens.set(`${exchType}:${String(token)}`, { token: String(token), exchangeType: exchType });
      }
    }

    if (this.ws && this.isConnected) {
      const payload = {
        correlationID: `sub_${Date.now()}`,
        action: 1, // Subscribe
        params: {
          mode: 1, // LTP Mode
          tokenList: tokenList
        }
      };
      this.ws.send(JSON.stringify(payload));
    }
  }

  unsubscribe(tokenList) {
    if (!Array.isArray(tokenList) || tokenList.length === 0) return;

    for (const item of tokenList) {
      for (const token of item.tokens) {
        this.subscribedTokens.delete(`${Number(item.exchangeType)}:${String(token)}`);
      }
    }

    if (this.ws && this.isConnected) {
      const payload = {
        correlationID: `unsub_${Date.now()}`,
        action: 0, // Unsubscribe
        params: {
          mode: 1,
          tokenList: tokenList
        }
      };
      this.ws.send(JSON.stringify(payload));
    }
  }

  resubscribeAll() {
    if (this.subscribedTokens.size === 0) return;

    const byExch = new Map();
    for (const { token, exchangeType } of this.subscribedTokens.values()) {
      if (!byExch.has(exchangeType)) byExch.set(exchangeType, []);
      byExch.get(exchangeType).push(token);
    }

    const tokenList = [];
    for (const [exchType, tokens] of byExch.entries()) {
      tokenList.push({ exchangeType: exchType, tokens });
    }

    this.subscribe(tokenList);
  }

  handleMessage(data, accountIdentity = this.accountIdentity) {
    if (!accountIdentity || !this.accountIdentity
      || accountIdentity.userId !== this.accountIdentity.userId
      || accountIdentity.brokerAccountId !== this.accountIdentity.brokerAccountId
      || accountIdentity.sessionId !== this.accountIdentity.sessionId
      || accountIdentity.sessionGeneration !== this.accountIdentity.sessionGeneration) return;
    if (typeof data === 'string') {
      if (data === 'pong' || data === 'ping') return;
      try {
        const json = JSON.parse(data);
        if (json.errorCode) {
          console.error('[SmartStreamService] Error response:', json.errorCode, json.errorMessage);
        }
      } catch (e) {}
      return;
    }

    // Binary packet decoding for LTP Mode
    try {
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data);
      if (buf.length < 51) return; // Mode 1 LTP packet size = 51 bytes

      const subscriptionMode = buf.readInt8(0);
      const exchangeType = buf.readInt8(1);

      // Token starting at index 2 (25 bytes char array)
      let tokenStr = buf.toString('utf8', 2, 27);
      const nullIdx = tokenStr.indexOf('\0');
      if (nullIdx !== -1) {
        tokenStr = tokenStr.substring(0, nullIdx);
      }
      tokenStr = tokenStr.trim();

      // Sequence Number starting at index 27 (8 bytes int64)
      const sequenceNumber = Number(buf.readBigInt64LE(27));

      // Exchange Timestamp starting at index 35 (8 bytes int64 epoch ms)
      const exchangeTimestamp = Number(buf.readBigInt64LE(35));

      // LTP starting at index 43 (4 bytes int32 or 8 bytes int64 - read as Int32LE)
      const rawLtp = buf.readInt32LE(43);
      const ltp = rawLtp / 100.0; // Convert paise to Rupees

      if (tokenStr && ltp > 0) {
        const tick = {
          token: tokenStr,
          exchangeType,
          ltp,
          timestamp: exchangeTimestamp > 0 ? exchangeTimestamp : Date.now(),
          sequenceNumber
        };
        this.emit('tick', tick, accountIdentity ? { ...accountIdentity } : null);
      }
    } catch (err) {
      console.error('[SmartStreamService] Error decoding binary packet:', err.message);
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[SmartStreamService] Scheduling reconnect in ${delay}ms (Attempt ${this.reconnectAttempts})`);
    const connectionGeneration = this.connectionGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.connectionGeneration === connectionGeneration && !this.isExplicitDisconnect) {
        this.connect(undefined, this.accountIdentity);
      }
    }, delay);
  }

  cleanup() {
    this.isConnected = false;
    this.isConnecting = false;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.emit('disconnected');
  }

  disconnect(clearCredentials = true) {
    this.connectionGeneration++;
    this.isExplicitDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    if (clearCredentials) {
      this.credentials = null;
      this.subscribedTokens.clear();
      this.accountIdentity = null;
    }
  }
}

const defaultInstance = new SmartStreamService();
defaultInstance.SmartStreamService = SmartStreamService;
module.exports = defaultInstance;
