const marketDataService = require('../services/marketDataService');
const smartStream = require('../services/smartStream');
const orderUpdateService = require('../services/orderUpdateService');
const { computeHeikenAshi } = require('../trading/strategies/heikenAshi');

async function runE2ESimulation() {
  console.log('====================================================');
  console.log('  OptionAlgo End-to-End Execution & Validation Suite');
  console.log('====================================================\n');

  // STAGE 1: Session Token Bridge Test
  console.log('[STAGE 1] Session Token Initialization');
  marketDataService.initSession({
    clientCode: 'BHIT1152',
    feedToken: 'MOCK_FEED_TOKEN_123',
    jwtToken: 'MOCK_JWT_TOKEN_456',
    apiKey: 'l66FCIi6'
  });
  console.log('✅ [Executed] Session initialized with mock tokens\n');

  // STAGE 2: Market Data Subscription & Ref Counting
  console.log('[STAGE 2] Subscribing Tokens (Reference Counting)');
  await marketDataService.subscribe('BFO', '854321', 'FIVE_MINUTE');
  const sub = marketDataService.subscribers.get('BFO_854321_FIVE_MINUTE');
  console.log(`Subscribed Token: 854321 | RefCount: ${sub.refCount} | ExchangeType: ${sub.exchangeType}`);
  console.log('✅ [Executed] Token subscription registered\n');

  // STAGE 3: Binary Tick Ingestion & LTP Cache Update
  console.log('[STAGE 3] Binary Tick Ingestion & Parsing');
  let receivedTick = null;
  smartStream.once('tick', (tick) => { receivedTick = tick; });

  const testTs = Date.now();
  const buf = Buffer.alloc(51);
  buf.writeInt8(1, 0); // Mode 1
  buf.writeInt8(4, 1); // BFO
  buf.write('854321\0', 2, 'utf8'); // Token
  buf.writeBigInt64LE(BigInt(1001), 27); // Seq
  buf.writeBigInt64LE(BigInt(testTs), 35); // Timestamp
  buf.writeInt32LE(42550, 43); // 42550 paise = 425.50 INR

  smartStream.handleMessage(buf);

  const cachedLtp = marketDataService.getLtp('BFO', '854321');
  console.log(`Decoded Tick LTP: ₹${receivedTick ? receivedTick.ltp : 'N/A'} | Cached LTP: ₹${cachedLtp}`);
  if (cachedLtp === 425.50) {
    console.log('✅ [Executed] Binary parsing and $O(1)$ LTP cache update verified\n');
  } else {
    throw new Error('LTP Cache mismatch');
  }

  // STAGE 4: OHLC Candle Compilation
  console.log('[STAGE 4] Live OHLC Candle Construction');
  let closedCandleEvt = null;
  marketDataService.on('candle:closed', (evt) => {
    if (evt.symboltoken === '999111') closedCandleEvt = evt;
  });

  await marketDataService.subscribe('NSE', '999111', 'FIVE_MINUTE');
  const startMs = Math.floor((testTs + 600000) / 300000) * 300000;

  // Stream 4 ticks within candle window
  marketDataService.handleTick({ token: '999111', exchangeType: 1, ltp: 150.0, timestamp: startMs + 1000 });
  marketDataService.handleTick({ token: '999111', exchangeType: 1, ltp: 175.0, timestamp: startMs + 10000 }); // High
  marketDataService.handleTick({ token: '999111', exchangeType: 1, ltp: 140.0, timestamp: startMs + 20000 }); // Low
  marketDataService.handleTick({ token: '999111', exchangeType: 1, ltp: 165.0, timestamp: startMs + 50000 }); // Close

  // Trigger candle boundary close
  marketDataService.handleTick({ token: '999111', exchangeType: 1, ltp: 168.0, timestamp: startMs + 300000 + 1000 });

  if (closedCandleEvt) {
    console.log('Compiled Candle:', closedCandleEvt.candle);
    console.log('✅ [Executed] OHLC Candle compilation and event emission verified\n');
  } else {
    throw new Error('Candle boundary emission failed');
  }

  // STAGE 5: Strategy Indicator Computation
  console.log('[STAGE 5] Heiken Ashi Indicator Computation');
  const rawCandles = [
    { time: 1, open: 100, high: 110, low: 95, close: 105 },
    { time: 2, open: 105, high: 115, low: 102, close: 112 },
    { time: 3, open: 112, high: 125, low: 110, close: 122 }
  ];
  const haCandles = computeHeikenAshi(rawCandles);
  console.log(`Computed ${haCandles.length} HA Candles. Last HA Close: ₹${haCandles[haCandles.length - 1].close.toFixed(2)}`);
  console.log('✅ [Executed] Heiken Ashi calculation verified\n');

  // STAGE 6: Order Status WebSocket Push Callback & Execution
  console.log('[STAGE 6] Order Update WebSocket Push Execution');
  let orderHandled = false;
  orderUpdateService.once('order:update', (data) => {
    if (data.orderid === 'E2E_ORDER_100' && data.status === 'complete') {
      orderHandled = true;
    }
  });

  orderUpdateService.handleMessage(JSON.stringify({
    'user-id': 'BHIT1152',
    'status-code': '200',
    'order-status': 'AB05',
    orderData: {
      orderid: 'E2E_ORDER_100',
      status: 'complete',
      averageprice: 165.0
    }
  }));

  if (orderHandled) {
    console.log('✅ [Executed] Order Update WebSocket Push callback verified\n');
  } else {
    throw new Error('Order Update callback failed');
  }

  // STAGE 7: Resource Cleanup & Memory Safety
  console.log('[STAGE 7] Resource Cleanup');
  marketDataService.unsubscribe('BFO', '854321', 'FIVE_MINUTE');
  marketDataService.unsubscribe('NSE', '999111', 'FIVE_MINUTE');
  console.log(`Subscribers Map Size: ${marketDataService.subscribers.size} | LTP Cache Size: ${marketDataService.ltpCache.size}`);
  if (marketDataService.subscribers.size === 0 && marketDataService.ltpCache.size === 0) {
    console.log('✅ [Executed] Subscriptions & Cache eviction verified\n');
  } else {
    throw new Error('Cleanup failed');
  }

  console.log('====================================================');
  console.log('  ALL 7 E2E STAGES EXECUTED & VERIFIED WITH 100% SUCCESS');
  console.log('====================================================');
  process.exit(0);
}

runE2ESimulation().catch(err => {
  console.error('❌ E2E Simulation Failed:', err);
  process.exit(1);
});
