const http = require('node:http');
const { once } = require('node:events');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { collections } = require('./mongooseMemory');
const accounts = require('../../services/accountContext');
const active = require('../../services/activeAccountService');
const models = Object.fromEntries(['BrokerAccount', 'Strategy', 'Trade', 'Position', 'OrderIntent', 'ExecutionLease'].map(name => [name, require(`../../models/${name}`)]));
const config = require('../../config');
const feeds = require('../../services/marketDataService');
const engine = require('../../services/strategyEngine');
require('../../services/marketSessionManager').stopMonitoring();
class Socket {
  constructor() { this.readyState = 0; this.sent = []; this.failSend = false; }
  send(data) { if (this.failSend) throw new Error('socket closed'); this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
}
async function fixture(t, { readyFeed = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const rows = [
    { _id: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'), userId: new mongoose.Types.ObjectId('111111111111111111111111'), broker: 'ANGEL_ONE', brokerClientId: 'CLIENT-A', status: 'CONNECTED', sessionGeneration: 1, ownerGeneration: 0 },
    { _id: new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'), userId: new mongoose.Types.ObjectId('222222222222222222222222'), broker: 'ANGEL_ONE', brokerClientId: 'CLIENT-B', status: 'CONNECTED', sessionGeneration: 1, ownerGeneration: 0 },
  ];
  const strategies = rows.flatMap(row => ['HeikenAshi', 'ModifiedHeikenAshi', '5minBreakout'].map(name => ({ _id: new mongoose.Types.ObjectId(), userId: row.userId, name })));
  const stores = collections(t, Object.values(models), { BrokerAccount: rows, Strategy: strategies });
  const previous = { socket: globalThis.WebSocket, base: config.API.ANGEL_ONE_API_BASE, key: config.API.INTERNAL_SERVICE_KEY };
  globalThis.WebSocket = Socket; config.API.INTERNAL_SERVICE_KEY = 'phase5-fixture';
  const sessions = rows.map(() => crypto.randomUUID());
  rows.forEach((row, i) => active.setActiveAccount({ userId: row.userId, brokerAccountId: row._id,
    clientCode: row.brokerClientId, sessionId: sessions[i], sessionGeneration: 1, ownerGeneration: 0 }));
  const orders = new Map(rows.map(row => [String(row._id), []]));
  const state = { calls: [], onPlace: null, onCancel: null, quote: 100, quoteTimestamp: () => Date.now(), bookFailure: false, failFence: false };
  const server = http.createServer(async (req, res) => {
    try {
      const row = rows.find(item => String(item._id) === req.headers['x-broker-account-id']);
      if (!row || req.headers['x-active-user-id'] !== String(row.userId) || req.headers['x-broker-client-id'] !== row.brokerClientId
        || req.headers['x-broker-session-id'] !== sessions[rows.indexOf(row)]) { res.statusCode = 403; res.end('{}'); return; }
      let body = ''; for await (const chunk of req) body += chunk; body = body ? JSON.parse(body) : null;
      const url = new URL(req.url, 'http://localhost');
      state.calls.push({ account: String(row._id), path: url.pathname, body, headers: req.headers });
      const list = orders.get(String(row._id));
      const respond = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
      if (url.pathname === '/internal/execution-fence') {
        if (state.failFence) { res.statusCode = 503; return respond({ accepted: false }); }
        return respond({ accepted: true, ownerGeneration: body.generation });
      }
      if (url.pathname === '/angel/session-tokens') return respond({ status: true, active_user_id: String(row.userId), session_id: sessions[rows.indexOf(row)],
        client_code: row.brokerClientId, feed_token: 'test', jwt_token: 'test', api_key: 'test' });
      if (url.pathname === '/angel/status') return respond({ connected: true });
      if (url.pathname === '/market/candles') return respond({ items: [] });
      if (url.pathname === '/market/ltp') return respond({ ltp: state.quote, quoteTimestamp: state.quoteTimestamp() });
      if (url.pathname === '/angel/orderbook') {
        if (state.bookFailure) { res.statusCode = 503; return respond({ status: false }); }
        return respond({ status: true, data: list });
      }
      if (url.pathname === '/angel/positions') {
        const netqty = list.reduce((sum, order) => sum + (order.transactiontype === 'BUY' ? 1 : -1)
          * Number(order.filledshares || 0), 0);
        const held = list.find(order => order.transactiontype === 'BUY' && Number(order.filledshares || 0) > 0);
        return respond({ status: true, data: held && netqty !== 0 ? [{ exchange: held.exchange,
          symboltoken: held.symboltoken, tradingsymbol: held.tradingsymbol,
          producttype: held.producttype, netqty: String(netqty) }] : [] });
      }
      if (url.pathname === '/angel/orders/simple') {
        const durable = stores.OrderIntent.find(intent => String(intent.brokerAccountId) === String(row._id) && intent.status === 'SUBMITTING'
          && intent.requestSnapshot.tradingsymbol === body.tradingsymbol && intent.requestSnapshot.action === body.transactiontype);
        if (!durable) throw new Error('Broker mutation without a persisted SUBMITTING intent');
        const order = { ...body, orderid: crypto.randomUUID(), variety: 'NORMAL', quantity: body.quantity,
          filledshares: body.ordertype === 'SL' ? 0 : body.quantity, averageprice: body.transactiontype === 'BUY' ? 100 : 120,
          orderstatus: body.ordertype === 'SL' ? 'trigger pending' : 'complete' };
        list.push(order);
        if (state.onPlace && await state.onPlace({ row, body, order, req, res, respond, durable })) return;
        return respond({ item: { id: crypto.randomUUID(), request: body, response: { status: true, data: { orderid: order.orderid } } } });
      }
      const cancel = /\/angel\/orders\/(.+)\/cancel/.exec(url.pathname);
      if (cancel) {
        const order = list.find(item => item.orderid === decodeURIComponent(cancel[1]));
        if (!order) { res.statusCode = 404; return respond({}); }
        const durable = stores.OrderIntent.find(intent => intent.purpose === 'CANCEL' && intent.status === 'SUBMITTING' && intent.brokerOrderId === order.orderid);
        if (!durable) throw new Error('Cancel without durable intent');
        if (state.onCancel && await state.onCancel({ row, order, req, res, respond })) return;
        order.orderstatus = 'cancelled'; return respond({ status: true, data: { orderid: order.orderid } });
      }
      res.statusCode = 404; respond({});
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ fixtureError: error.message })); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  config.API.ANGEL_ONE_API_BASE = `http://127.0.0.1:${server.address().port}`;
  const budget = require('../../services/marketRequestBudget'); budget.accounts.clear(); budget.global = []; budget.inFlight = 0;
  const contexts = await Promise.all(rows.map(row => accounts.resolve(String(row.userId), String(row._id))));
  await require('../../services/startupRecovery').initialize();
  const runners = [];
  async function runner(index = 0, name = 'HeikenAshi', live = true) {
    const ctx = contexts[index];
    const result = engine.getRunner(`${ctx.userId}_${name}`);
    result.accountContext = ctx; result.userId = ctx.userId; result.isRunning = true; result.brokerReady = true;
    result.config = { underlying: 'NIFTY', quantity: 10, targetPoints: 20, slPoints: 30, liveTradingConsent: live };
    result.feedScanReady = true;
    if (readyFeed) await accounts.run(ctx, () => feeds.ensureReady());
    runners.push(result);
    return result;
  }
  t.after(async () => {
    const gateway = require('../../services/executionGateway');
    for (const job of gateway.pendingManual.values()) clearInterval(job.timer);
    gateway.pendingManual.clear();
    for (const result of new Set([...runners, ...engine.runners.values()])) {
      const execution = require('../../services/positionExecution').forRunner(result);
      execution.suspendForRecovery();
      execution.positionId = null; execution.entryIntentId = null; execution.recoveryIntentId = null; execution.retire(); result.stop();
    }
    engine.runners.clear(); feeds.resetAccountSession();
    const executionLeases = require('../../services/executionLeaseService');
    rows.forEach(row => executionLeases.releaseLocal({ userId: String(row.userId), brokerAccountId: String(row._id) }));
    rows.forEach(row => active.clearActiveAccount(String(row.userId), String(row._id)));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    globalThis.WebSocket = previous.socket; config.API.ANGEL_ONE_API_BASE = previous.base; config.API.INTERNAL_SERVICE_KEY = previous.key;
  });
  const contract = { exchange: 'NFO', symboltoken: '77', tradingsymbol: 'HELD-CE' };
  return { runner, contexts, rows, stores, models, orders, state, contract, engine, feeds, accounts };
}
module.exports = { fixture };
