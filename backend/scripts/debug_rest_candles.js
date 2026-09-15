const contractManager = require('../services/contractManager');

async function testRestCandles() {
  console.log('====================================================');
  console.log(' TESTING REST CANDLE BACKFILL FOR BFO VS NFO OPTIONS');
  console.log('====================================================\n');

  const ANGEL_API_BASE = 'http://localhost:8000';
  const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || process.env.ANGEL_ONE_INTERNAL_SECRET || '';
  const targetDate = new Date().toISOString().split('T')[0];

  const bn = await contractManager.resolveContracts('BANKNIFTY', 'ATM', 1);
  const sx = await contractManager.resolveContracts('SENSEX', 'ATM', 1);

  console.log(`BANKNIFTY CE Token (${bn.ceContract.tradingsymbol}): ${bn.ceContract.symboltoken} (Exchange: ${bn.exchange})`);
  console.log(`SENSEX CE Token (${sx.ceContract.tradingsymbol}): ${sx.ceContract.symboltoken} (Exchange: ${sx.exchange})`);

  // Fetch NFO candles
  try {
    const urlNfo = `${ANGEL_API_BASE}/market/candles?exchange=${encodeURIComponent(bn.exchange)}&symboltoken=${encodeURIComponent(bn.ceContract.symboltoken)}&interval=FIVE_MINUTE&date=${targetDate}`;
    const resNfo = await fetch(urlNfo, { headers: { 'X-Internal-Service-Key': INTERNAL_SERVICE_KEY } });
    const jsonNfo = await resNfo.json();
    console.log(`\n[NFO REST Candles Response Status: ${resNfo.status}] Items Count: ${Array.isArray(jsonNfo.items) ? jsonNfo.items.length : 0}`);
  } catch (err) {
    console.error('NFO REST Fetch Error:', err.message);
  }

  // Fetch BFO candles
  try {
    const urlBfo = `${ANGEL_API_BASE}/market/candles?exchange=${encodeURIComponent(sx.exchange)}&symboltoken=${encodeURIComponent(sx.ceContract.symboltoken)}&interval=FIVE_MINUTE&date=${targetDate}`;
    const resBfo = await fetch(urlBfo, { headers: { 'X-Internal-Service-Key': INTERNAL_SERVICE_KEY } });
    const jsonBfo = await resBfo.json();
    console.log(`[BFO REST Candles Response Status: ${resBfo.status}] Items Count: ${Array.isArray(jsonBfo.items) ? jsonBfo.items.length : 0}`);
    if (jsonBfo.detail) {
      console.log(`BFO Error Detail:`, jsonBfo.detail);
    }
  } catch (err) {
    console.error('BFO REST Fetch Error:', err.message);
  }

  process.exit(0);
}

testRestCandles().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
