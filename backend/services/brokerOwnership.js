const { denied } = require('./accountContext');
function rows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.items)) return data.items;
  throw denied('Broker ownership evidence is unavailable.');
}
async function evidence(path, context) {
  const { requestPython } = require('./pythonApiClient');
  const { response, data } = await requestPython(path, { context, ownershipChecked: true });
  if (!response.ok || data?.status === false) throw denied('Broker ownership evidence is unavailable.');
  return rows(data);
}
async function validateMutation(path, method, body, context) {
  if (method !== 'POST') return;
  const cancel = /^\/angel\/orders\/([^/?]+)\/cancel$/.exec(path);
  if (cancel) {
    const id = decodeURIComponent(cancel[1]);
    const orders = await evidence('/angel/orderbook', context);
    if (!orders.some(order => String(order.orderid) === id && (!order.variety || order.variety === (body?.variety || 'NORMAL')))) {
      throw denied('Order not found in this broker account.', 404);
    }
  }
  if (path === '/angel/positions/exit') {
    const positions = await evidence('/angel/positions', context);
    const position = positions.find(item => ['exchange', 'tradingsymbol', 'symboltoken', 'producttype']
      .every(key => String(item[key]) === String(body?.[key] || (key === 'producttype' ? 'INTRADAY' : ''))));
    const net = Number(position?.netqty);
    const quantity = Number(body?.quantity);
    if (!position || !Number.isFinite(net) || !Number.isInteger(quantity) || quantity <= 0
      || quantity > Math.abs(net) || body?.transactiontype !== (net > 0 ? 'SELL' : 'BUY')) {
      throw denied('Position not found or exit does not match owned exposure.', 404);
    }
  }
}
module.exports = { rows, validateMutation };
