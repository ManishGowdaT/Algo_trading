const accounts = require('./accountContext');
const { PositionExecution, coordinate, ownerFor, terminal, unresolved } = require('./positionExecution');
const Position = require('../models/Position');
const OrderIntent = require('../models/OrderIntent');
const Strategy = require('../models/Strategy');
const { validateMutation } = require('./brokerOwnership');
const pendingManual = new Map();

function result(intent, extra = {}) {
  const failed = ['REJECTED', 'FAILED', 'UNKNOWN'].includes(intent?.status);
  if (intent?.brokerResponse && typeof intent.brokerResponse === 'object') {
    return { response: { ok: true, status: intent.status === 'UNKNOWN' ? 202 : 200 },
      data: { ...intent.brokerResponse, executionState: intent.status, ...extra } };
  }
  return { response: { ok: true, status: intent?.status === 'UNKNOWN' ? 202 : 200 }, data: { item: {
    id: intent?.intentId, request: intent?.requestSnapshot?.toObject?.() || intent?.requestSnapshot,
    response: { status: !failed, data: { orderid: intent?.brokerOrderId },
      ...(failed ? { outcome: intent.status, error: intent.status === 'UNKNOWN' ? 'Order outcome is unresolved; do not resubmit.' : 'Broker order was rejected.' } : {}) },
  }, executionState: intent?.status || 'RECONCILED', ...extra } };
}
function observer(context, strategy) {
  const runner = { accountContext: context, strategyName: strategy.name, config: {},
    positionState: 'NONE', state: 'WAITING', message: '' };
  const execution = new PositionExecution(runner); execution.strategyId = strategy._id;
  return execution;
}
function watch(execution, intent) {
  const key = String(intent._id);
  if (pendingManual.has(key) || terminal.has(intent.status)) return;
  const job = { busy: false, timer: null };
  job.timer = setInterval(async () => {
    if (job.busy) return;
    job.busy = true;
    try {
      await coordinate(execution.context, () => accounts.run(execution.context, async () => {
        await accounts.validate(execution.context);
        const current = await OrderIntent.findOne({ ...execution.scope(), _id: intent._id });
        if (!current) throw unresolved('Manual order intent is missing.');
        await execution.observe(current, await execution.book());
        if (terminal.has(current.status)) { clearInterval(job.timer); pendingManual.delete(key); }
      }));
    } catch (error) { console.warn(`[ExecutionGateway] Manual intent ${key} requires reconciliation (${error.code || 'service-error'}).`); }
    finally { job.busy = false; }
  }, 1000);
  pendingManual.set(key, job);
}

async function dispatch(path, body, context) {
  context = accounts.assertVerified(context || accounts.current());
  // Recovery itself enters the account execution coordinator. Do it before
  // taking the coordinator lock here, or degraded recovery would wait on its
  // own non-reentrant lock.
  await accounts.validate(context);
  await require('./startupRecovery').assertExecutionAllowed(context);
  return coordinate(context, () => accounts.run(context, async () => {
    await accounts.validate(context);
    await require('./startupRecovery').assertExecutionAllowed(context, { recoverDegraded: false });
    const scope = { userId: context.userId, brokerAccountId: context.brokerAccountId };
    const cancel = /^\/angel\/orders\/([^/?]+)\/cancel$/.exec(path);
    let cancellationTarget;
    if (!cancel) {
      body = { ...body, exchange: String(body?.exchange || '').trim().toUpperCase(),
        transactiontype: String(body?.transactiontype || '').trim().toUpperCase(),
        ordertype: String(body?.ordertype || 'MARKET').trim().toUpperCase(),
        producttype: body?.producttype || (path === '/angel/positions/exit' ? 'INTRADAY' : '') };
      if (['NFO', 'BFO'].includes(body.exchange) && body.producttype === 'DELIVERY') body.producttype = 'CARRYFORWARD';
      if (!['BUY', 'SELL'].includes(body.transactiontype) || !['MARKET', 'LIMIT', 'SL', 'SL-L'].includes(body.ordertype)
        || !Number.isInteger(Number(body.quantity)) || Number(body.quantity) < 1 || Number(body.quantity) > 1000000) {
        throw accounts.denied('Invalid order direction, type or quantity.', 400);
      }
    }
    if (cancel) {
      await validateMutation(path, 'POST', body, context);
      const target = await OrderIntent.findOne({ ...scope, brokerOrderId: decodeURIComponent(cancel[1]), purpose: { $ne: 'CANCEL' } });
      cancellationTarget = target;
      if (target) {
        const owner = ownerFor(context, target.positionId, target._id);
        if (owner) {
          await accounts.validate(owner.context);
          await owner.cancel(target, await owner.ownedPosition(), await owner.book());
          await owner.reconcileLocked();
          return { response: { ok: true, status: 200 }, data: { status: true, data: { orderid: target.brokerOrderId }, executionState: target.status } };
        }
        if (target.positionId) throw unresolved('Managed position has no current execution owner.');
      }
    }
    if (!cancel && !['/angel/orders/simple', '/angel/positions/exit'].includes(path)) throw accounts.denied('Unsupported mutation.', 403);
    await validateMutation(path, 'POST', body, context);
    const instrument = !cancel && { exchange: body?.exchange, symboltoken: body?.symboltoken, tradingsymbol: body?.tradingsymbol };
    if (instrument) {
      const positions = await Position.find({ ...scope, status: { $ne: 'CLOSED' },
        'executionSnapshot.executionMode': 'LIVE', 'executionSnapshot.exchange': instrument.exchange,
        'executionSnapshot.symboltoken': instrument.symboltoken, 'executionSnapshot.tradingsymbol': instrument.tradingsymbol });
      if (positions.length > 1) throw unresolved('Multiple managed positions share this instrument; use their strategy exit controls.');
      if (positions.length) {
        const position = positions[0]; const owner = ownerFor(context, position._id);
        if (!owner) throw unresolved('Managed position has no current execution owner.');
        if (body.transactiontype !== 'SELL' || (body.ordertype || 'MARKET') !== 'MARKET'
          || body.producttype !== owner.held(position).producttype) throw unresolved('Manual mutation conflicts with the managed held position.');
        await accounts.validate(owner.context);
        const intent = await owner.exitLocked('Manual', undefined, Number(body.quantity));
        return result(intent, { remainingQuantity: owner.hasExposure() ? owner.runner.config.quantity : 0 });
      }
      const unresolvedEntry = await OrderIntent.findOne({ ...scope, purpose: 'ENTRY',
        'requestSnapshot.exchange': instrument.exchange, 'requestSnapshot.symboltoken': instrument.symboltoken,
        $or: [{ status: { $nin: [...terminal] } }, { filledQuantity: { $gt: 0 }, positionId: { $exists: false } }] });
      if (unresolvedEntry) throw unresolved('Entry exposure must be reconciled before manual broker mutations.');
    }
    // Unmanaged broker operations keep their existing request semantics, while
    // gaining durable intents and reconciliation. They do not close app trades.
    let strategy = await Strategy.findOne({ userId: context.userId, name: 'BrokerManual' });
    if (!strategy) {
      try { strategy = await Strategy.create({ userId: context.userId, name: 'BrokerManual', internalExecutionOnly: true }); }
      catch (error) { if (error.code !== 11000) throw error; strategy = await Strategy.findOne({ userId: context.userId, name: 'BrokerManual' }); }
    }
    const execution = observer(context, strategy);
    if (!strategy.internalExecutionOnly) throw unresolved('The internal manual-execution strategy name conflicts with an existing record.');
    await execution.prepareOwnership();
    let request;
    if (cancel) {
      const order = (await execution.book()).find(row => String(row.orderid) === decodeURIComponent(cancel[1]));
      if (!order) throw accounts.denied('Order not found in this broker account.', 404);
      request = { action: 'CANCEL', exchange: order.exchange, symboltoken: order.symboltoken,
        tradingsymbol: order.tradingsymbol, producttype: order.producttype, variety: body?.variety || order.variety || 'NORMAL',
        quantity: Number(order.quantity), ordertype: order.ordertype || 'MARKET' };
    } else {
      request = { ...instrument, action: body.transactiontype, producttype: body.producttype,
        variety: body.variety || 'NORMAL',
        quantity: Number(body.quantity), ordertype: body.ordertype || 'MARKET',
        ...(body.price !== undefined ? { price: body.price } : {}), ...(body.triggerprice !== undefined ? { triggerprice: body.triggerprice } : {}) };
    }
    const previous = await OrderIntent.findOne({ ...scope, strategyId: strategy._id,
      ...(cancel ? { purpose: 'CANCEL', brokerOrderId: decodeURIComponent(cancel[1]) }
        : { 'requestSnapshot.exchange': request.exchange, 'requestSnapshot.symboltoken': request.symboltoken }),
      status: { $nin: [...terminal] } });
    if (previous) {
      await execution.observe(previous, await execution.book());
      if (!terminal.has(previous.status)) throw unresolved('Previous manual order is unresolved; no retry was submitted.');
      if (cancel) return result(previous);
    }
    const intent = await execution.intent(cancel ? 'CANCEL' : 'MANUAL', request, null, cancellationTarget);
    if (cancel) { intent.brokerOrderId = decodeURIComponent(cancel[1]); await intent.save(); }
    try {
      await execution.submit(intent, path);
      await execution.observe(intent, await execution.book(true));
      if (cancellationTarget) await execution.observe(cancellationTarget, await execution.book());
    } finally { watch(execution, intent); }
    return result(intent);
  }));
}
module.exports = { dispatch, pendingManual };
