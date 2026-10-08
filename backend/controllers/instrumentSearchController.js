'use strict';
const search = require('../services/instrumentSearchService');
const accounts = require('../services/accountContext');
const feeds = require('../services/marketDataService');
const { respondWithApiError } = require('../middleware/apiErrors');

exports.search = async (req, res) => {
  try {
    const input = search.searchInput(req.query);
    const result = await search.read(`/instruments/search?${new URLSearchParams(input)}`, req.accountContext);
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  } catch (error) { respondWithApiError(req, res, error, { status: error.status || 502, message: error.status >= 500 ? 'Instrument search is unavailable. Please retry shortly.' : undefined }); }
};

exports.live = async (req, res) => {
  let service, selection, release, timer, deadline;
  let closed = false, subscribed = false, busy = false;
  const cleanup = () => {
    closed = true; clearTimeout(timer); clearTimeout(deadline);
    if (subscribed && service) { subscribed = false; service.unsubscribe(selection.exchange, selection.symboltoken, selection.interval, 'chart'); }
    release?.();
  };
  res.once('close', cleanup);
  try {
    selection = search.selectionInput(req.query);
    release = search.reserve(req.accountContext);
    const { item } = await search.read(`/instruments/resolve?${new URLSearchParams({ exchange: selection.exchange, symboltoken: selection.symboltoken })}`, req.accountContext);
    if (!item || item.exchange !== selection.exchange || item.symboltoken !== selection.symboltoken || !item.tradingsymbol) throw Object.assign(new Error('Instrument identity could not be verified.'), { status: 502 });
    if (closed) { release(); return; }
    service = await accounts.run(req.accountContext, () => feeds.ensureReady());
    if (closed) return;
    if (Number.isFinite(req.accessTokenExpiresAt) && Date.now() >= req.accessTokenExpiresAt) throw Object.assign(new Error('Application session expired.'), { status: 401 });
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = payload => {
      if (closed || res.destroyed) return false;
      if (res.writableLength > 65536) { cleanup(); res.end(); return false; }
      return res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    let lastValidation = 0;
    const publish = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        if (!search.sessionCurrent(req.accountContext) || service.destroyed
          || Date.now() >= (req.accessTokenExpiresAt || Infinity)) throw new Error('Broker session changed. Reconnect to continue.');
        if (Date.now() - lastValidation >= 5000) { await accounts.validate(req.accountContext); lastValidation = Date.now(); }
        send(search.snapshot(service, item, selection.interval));
      } catch (_error) {
        send({ error: 'Live connection ended. Reconnect your broker or retry.' }); cleanup(); res.end();
      } finally { busy = false; if (!closed) timer = setTimeout(publish, 1000); }
    };
    // Bound authenticated stream lifetime; reconnect re-runs application auth.
    const lifetime = Number.isFinite(req.accessTokenExpiresAt) ? Math.min(60000, Math.max(1, req.accessTokenExpiresAt - Date.now())) : 60000;
    deadline = setTimeout(() => { cleanup(); res.end(); }, lifetime);
    subscribed = true;
    const admission = accounts.run(req.accountContext, () => service.subscribe(selection.exchange, selection.symboltoken, selection.interval, null,
      { role: 'chart', tradingsymbol: item.tradingsymbol }));
    // One timestamped snapshot helps inactive symbols; ongoing updates use WS.
    const streamKey = `${service.getExchangeType(selection.exchange)}:${selection.symboltoken}`;
    if (!service.ltpCache.has(streamKey)) {
      void require('../services/pythonApiClient').requestPython(`/market/ltp?${new URLSearchParams({ exchange: selection.exchange,
        symboltoken: selection.symboltoken, tradingsymbol: item.tradingsymbol, requireFresh: 'true' })}`,
      { context: req.accountContext, timeoutMs: 3000, backgroundQuote: true }).then(({ response, data }) => {
        if (!closed && !service.destroyed && search.sessionCurrent(req.accountContext) && !service.ltpCache.has(streamKey)
          && response.ok && Number.isFinite(data?.ltp) && data.ltp > 0 && Number.isFinite(data?.quoteTimestamp)) {
          service.ltpCache.set(streamKey, { ltp: data.ltp, timestamp: data.quoteTimestamp, source: 'ANGEL_FULL', receivedAt: Date.now() });
        }
      }).catch(() => {});
    }
    await publish();
    await admission;
  } catch (error) {
    cleanup();
    if (res.headersSent) res.end();
    else if (!res.destroyed) respondWithApiError(req, res, error, { status: error.status || 502, message: 'Live market data is unavailable. Please reconnect your broker or retry.' });
  }
};
