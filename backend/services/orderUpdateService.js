const EventEmitter = require('events');
const config = require('../config');

class OrderUpdateService extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.jwtToken = null;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.isExplicitDisconnect = false;
    this.connectionGeneration = 0;
    this.accountIdentity = null;
  }

  connect(jwtToken, accountIdentity = this.accountIdentity) {
    if (jwtToken) {
      this.jwtToken = jwtToken;
    }

    if (!this.jwtToken) {
      console.warn('[OrderUpdateService] Cannot connect without jwtToken');
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
      const wsUrl = 'wss://tns.angelone.in/smart-order-update';

      console.log('[OrderUpdateService] Connecting to Order Update WebSocket...');
      this.isConnecting = true;
      const socket = new WebSocketImpl(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.jwtToken}`
        }
      });
      this.ws = socket;

      socket.onopen = () => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        console.log('[OrderUpdateService] Order Update WebSocket connected');
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startKeepalive();
        this.emit('connected');
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        this.handleMessage(event.data, connectionIdentity);
      };

      socket.onerror = (err) => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        console.error('[OrderUpdateService] WebSocket error:', err.message || err);
      };

      socket.onclose = (event) => {
        if (this.ws !== socket || this.connectionGeneration !== connectionGeneration) return;
        console.warn(`[OrderUpdateService] WebSocket closed (code: ${event.code})`);
        this.cleanup();
        if (!this.isExplicitDisconnect) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      this.isConnecting = false;
      console.error('[OrderUpdateService] Error initiating WebSocket:', err.message);
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
          console.warn('[OrderUpdateService] Ping failed:', e.message);
        }
      }
    }, 10000);
  }

  handleMessage(data, accountIdentity = this.accountIdentity) {
    if (data === 'pong' || data === 'ping') return;
    if (!accountIdentity || !this.accountIdentity
      || accountIdentity.userId !== this.accountIdentity.userId
      || accountIdentity.brokerAccountId !== this.accountIdentity.brokerAccountId
      || accountIdentity.sessionId !== this.accountIdentity.sessionId
      || accountIdentity.sessionGeneration !== this.accountIdentity.sessionGeneration) return;

    try {
      const payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString());
      if (payload && payload.orderData) {
        const orderData = payload.orderData;
        const orderId = orderData.orderid || orderData.orderId || orderData.uniqueorderid || 'N/A';
        const status = orderData.status || orderData.orderstatus || orderData.orderStatus || 'N/A';
        console.log(`[OrderUpdateService] Order Update: ${orderId} -> Status: ${status}`);
        this.emit('order:update', orderData, accountIdentity ? { ...accountIdentity } : null);
      }
    } catch (err) {
      console.error('[OrderUpdateService] Error parsing order message:', err.message);
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(`[OrderUpdateService] Scheduling reconnect in ${delay}ms (Attempt ${this.reconnectAttempts})`);
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
  }

  disconnect(clearToken = true) {
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
    if (clearToken) {
      this.jwtToken = null;
      this.accountIdentity = null;
    }
  }
}

const defaultInstance = new OrderUpdateService();
defaultInstance.OrderUpdateService = OrderUpdateService;
module.exports = defaultInstance;
