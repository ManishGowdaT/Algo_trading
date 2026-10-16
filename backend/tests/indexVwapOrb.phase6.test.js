const test = require('node:test');
const paperEvidence = [];
if (process.env.INDEX_ORB_PHASE6_EVIDENCE) test.after(() => {
  require('node:fs').writeFileSync(process.env.INDEX_ORB_PHASE6_EVIDENCE, JSON.stringify({
    source: 'Offline runner integration fixtures, not broker sessions',
    assumptions: 'Full-quantity instant PAPER fills at timestamped option LTP, zero slippage/fees, no liquidity model. Entry 100 and exit 115 are fabricated option quotes; index points never substitute for option P&L.',
    trades: paperEvidence,
  }, null, 2) + '\n');
});
const assert = require('node:assert/strict');
const { OPEN, candles, evaluate, replay } = require('./helpers/indexOrbReplay');
const { fixture } = require('./helpers/executionFixture');
const { normalizeSession } = require('../services/underlyingCandleStream');
const { collections } = require('./helpers/mongooseMemory');
const Session = require('../models/StrategySession');
const Availability = require('../models/StrategyAvailability');
const availability = require('../services/indexVwapOrbAvailability');
const sessions = require('../services/indexVwapOrbSession');
const { forRunner } = require('../services/positionExecution');
const mongoose = require('mongoose');

for (const underlying of ['NIFTY','BANKNIFTY','SENSEX']) for (const direction of ['LONG','SHORT']) {
  test(`${underlying} ${direction}: completed-session sequential replay has one exact signal and no unexpected entries`, () => {
    for (const scenario of ['signal','no-breakout','no-retest','failed-retest','failed-vwap','missing-opening','zero-volume']) {
      const result = replay(underlying,direction,scenario);
      const signals = result.trace.filter(x => x.signal);
      assert.equal(signals.length, scenario === 'signal' ? 1 : 0, scenario);
      if (signals.length) {
        const s = signals[0].signal;
        assert.equal(s.signalClosedAt, OPEN + 31*60000);
        assert.ok(s.breakoutClosedAt < s.retestClosedAt && s.retestClosedAt <= s.pivot.formedAt);
        assert.ok(s.pivot.formedAt < s.pivot.confirmedAt && s.pivot.confirmedAt < s.signalClosedAt);
        assert.equal(Math.abs(s.takeProfit-s.entryPrice), 2*s.riskPoints);
      }
    }
  });
  test(`${underlying} ${direction}: real runner listener to paper fill and EOD recovery, duplicate close consumes once`, async t => {
    const f = await fixture(t); collections(t,[Session,Availability]);
    const plain = v => !v || typeof v !== 'object' || v instanceof Date || v instanceof mongoose.Types.ObjectId ? v
      : v.$__ && v.toObject ? plain(v.toObject()) : Array.isArray(v) ? Array.from(v,plain) : Object.fromEntries(Object.entries(v).map(([k,x])=>[k,plain(x)]));
    const original = Session.collection.findOneAndUpdate;
    Session.collection.findOneAndUpdate = (q,u)=>original(q,plain(u));
    await availability.provision(f.contexts[0]); await Session.createIndexes();
    let now = OPEN + 60000; const originalNow = Date.now; Date.now=()=>now;t.after(()=>{Date.now=originalNow;});
    const runner = await f.runner(0,'IndexVwapOrb',false);
    runner.config = { underlying, quantity:10, strikeMode:'ATM',strikeDepth:1,premiumMin:0,premiumMax:1000,liveTradingConsent:false };
    const contract = { exchange: underlying==='SENSEX'?'BFO':'NFO',underlying,expiry:'2026-10-30',strike:100,lot_size:10,symboltoken:'77',tradingsymbol:`${underlying}-${direction==='LONG'?'CE':'PE'}`,option_type:direction==='LONG'?'CE':'PE' };
    runner.ceContract={...contract,option_type:'CE'};runner.peContract={...contract,option_type:'PE'};
    const quoteEvidence=[];f.state.quoteTimestamp=()=>{quoteEvidence.push({ltp:f.state.quote,quoteTimestamp:now});return now;};
    const bars=candles(direction);let snapshot=normalizeSession(bars.slice(0,1),now);snapshot.ready=true;
    t.mock.method(f.feeds,'subscribeUnderlying',async()=>snapshot);
    t.mock.method(f.feeds,'getUnderlyingSnapshot',()=>snapshot);
    await f.accounts.run(f.contexts[0],()=>runner.startUnderlyingDataLoop({timeframes:['ONE_MINUTE','FIVE_MINUTE']}));
    const event = interval => ({...f.contexts[0], role:'underlying',underlying,exchange:underlying==='SENSEX'?'BSE':'NSE',symboltoken:underlying==='NIFTY'?'99926000':underlying==='BANKNIFTY'?'99926009':'99919000',interval,closedAt:now});
    for(let count=1;count<=31;count++) {
      now=OPEN+count*60000;snapshot={...normalizeSession(bars.slice(0,count),now),ready:true};
      if(count%5===0) await f.accounts.run(f.contexts[0],()=>runner.candleListener(event('FIVE_MINUTE')));
      await f.accounts.run(f.contexts[0],()=>runner.candleListener(event('ONE_MINUTE')));
    }
    assert.equal(f.stores.Position.length,1,runner.message);
    const acceptedSignal=structuredClone(runner.indexOrbAnalysis);
    await f.accounts.run(f.contexts[0],()=>runner.candleListener(event('ONE_MINUTE')));
    assert.equal(f.stores.OrderIntent.filter(x=>x.purpose==='ENTRY').length,1);
    // Continue the actual listener through 15:19; held exposure and cutoff must
    // prevent any further admission before a stopped-runner EOD recovery.
    for(let count=32;count<=364;count++) {
      now=OPEN+count*60000;snapshot={...normalizeSession(bars.slice(0,count),now),ready:true};
      if(count%5===0) await f.accounts.run(f.contexts[0],()=>runner.candleListener(event('FIVE_MINUTE')));
      await f.accounts.run(f.contexts[0],()=>runner.candleListener(event('ONE_MINUTE')));
    }
    assert.equal(f.stores.OrderIntent.filter(x=>x.purpose==='ENTRY').length,1);
    assert.equal(f.stores.Position[0].averageEntryPrice,100);
    assert.equal(f.stores.Position[0].executionSnapshot.executionMode,'PAPER');
    assert.equal(f.stores.Position[0].executionSnapshot.referenceRisk.entry,direction==='LONG'?121:179);
    const execution=forRunner(runner,{feed:f.feeds});execution.suspendForRecovery();
    const restored=f.engine.replaceForRecovery(f.contexts[0].userId,'IndexVwapOrb');
    restored.accountContext=f.contexts[0];restored.userId=f.contexts[0].userId;restored.isRunning=false;
    const recovered=forRunner(restored,{feed:f.feeds});await recovered.resume();
    now=Date.parse('2026-10-16T15:20:00+05:30');f.state.quote=115;
    await recovered.monitorReferenceRisk();
    assert.equal(f.stores.Position[0].status,'CLOSED');assert.equal(f.stores.Position[0].remainingQuantity,0);
    assert.equal(f.stores.Trade[0].pnl,150);assert.equal(f.stores.Trade[0].exitReason,'EOD');
    assert.equal((await sessions.restore(f.contexts[0],now)).entriesFilled,1);
    assert.equal(f.state.calls.filter(c=>c.path==='/angel/orders/simple').length,0);
    assert.ok(f.state.calls.filter(c=>c.path==='/market/ltp').length>=2);
    paperEvidence.push({underlying,direction,signal:acceptedSignal,
      entryQuote:quoteEvidence.find(q=>q.quoteTimestamp===OPEN+31*60000),exitQuote:quoteEvidence.at(-1),
      quantity:10,mode:'PAPER',remainingQuantity:f.stores.Position[0].remainingQuantity,
      pnl:f.stores.Trade[0].pnl,exitReason:f.stores.Trade[0].exitReason,brokerOrderCalls:0});
  });
}
test('duplicate/out-of-order history and late start preserve signal knowledge without replaying old entries',()=>{
  const bars=candles();const asOf=OPEN+31*60000;
  const { analyzeIndexVwapOrb }=require('../trading/strategies/indexVwapOrb');
  const source=bars.slice(0,31);source.push({...source[10]});source.reverse();
  const snapshot=normalizeSession(source,asOf);
  assert.deepEqual(analyzeIndexVwapOrb({underlying:'NIFTY',asOf,snapshot}),evaluate(bars,31,'NIFTY'));
  assert.equal(evaluate(bars,32,'NIFTY').isEntry,false);
  assert.equal(evaluate(bars,31,'NIFTY',5001).state,'SIGNAL_EXPIRED');
});

async function preparedFaultFixture(t, underlying) {
  const f=await fixture(t);collections(t,[Session,Availability]);
  const plain=v=>!v||typeof v!=='object'||v instanceof Date||v instanceof mongoose.Types.ObjectId?v:v.$__&&v.toObject?plain(v.toObject()):Array.isArray(v)?Array.from(v,plain):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,plain(x)]));
  const original=Session.collection.findOneAndUpdate;Session.collection.findOneAndUpdate=(q,u)=>original(q,plain(u));
  await availability.provision(f.contexts[0]);await Session.createIndexes();
  // Only the in-memory account and localhost broker simulator are enabled.
  await Availability.collection.updateOne({userId:f.contexts[0].userId},{$set:{liveExecutionEnabled:true}});
  let now=OPEN+31*60000;const previous=Date.now;Date.now=()=>now;t.after(()=>{Date.now=previous;});
  const runner=await f.runner(0,'IndexVwapOrb',false);
  runner.config={underlying,quantity:10,strikeMode:'ATM',strikeDepth:1,premiumMin:0,premiumMax:1000,liveTradingConsent:true};
  const signal=evaluate(candles(),31,underlying);
  const contract={...f.contract,exchange:underlying==='SENSEX'?'BFO':'NFO',underlying,expiry:'2026-10-30',strike:100,lot_size:10,option_type:'CE'};
  const intent=await sessions.prepareEntry(f.contexts[0],{signal,config:runner.config,contract,now});
  const execution=forRunner(runner,{feed:f.feeds});
  execution.referenceEntryMargin=async()=>{}; // Simulator has no margin endpoint; existing margin-failure test remains required.
  return {...f,runner,execution,intent,setNow:value=>{now=value;}};
}
for(const underlying of ['NIFTY','BANKNIFTY','SENSEX']) {
  test(`${underlying}: explicit no-fill rejection releases reservation without a trade`,async t=>{
    const f=await preparedFaultFixture(t,underlying);
    f.state.onPlace=async({order,respond})=>{order.filledshares=0;order.orderstatus='rejected';respond({item:{response:{status:false,errorcode:'REJECTED'}}});return true;};
    await f.execution.executePreparedReferenceEntry(f.intent._id);
    const restored=await sessions.restore(f.contexts[0]);
    assert.equal(restored.entriesFilled,0);assert.equal(restored.entriesReserved,0);assert.equal(restored.blocked,false);
    assert.equal(f.stores.Position.length,0);assert.equal(f.stores.Trade.length,0);
  });
  test(`${underlying}: ambiguous localhost transport failure retains reservation and fences another entry`,async t=>{
    const f=await preparedFaultFixture(t,underlying);
    f.state.onPlace=async({req})=>{req.socket.destroy();return true;};
    await assert.rejects(f.execution.executePreparedReferenceEntry(f.intent._id),{code:'RECONCILIATION_REQUIRED'});
    assert.equal(f.stores.OrderIntent[0].status,'UNKNOWN');
    const restored=await sessions.restore(f.contexts[0]);
    assert.equal(restored.blocked,true);assert.equal(restored.entriesReserved,1);
    await assert.rejects(f.execution.executePreparedReferenceEntry(f.intent._id));
    assert.equal(f.state.calls.filter(c=>c.path==='/angel/orders/simple').length,1);
    assert.equal(f.stores.Trade.length,0);
  });
  test(`${underlying}: partial fill counts once; EOD cancels remainder and closes only actual fill`,async t=>{
    const f=await preparedFaultFixture(t,underlying);
    f.state.onPlace=async({body,order})=>{if(body.transactiontype==='BUY'){order.orderstatus='open';order.filledshares='4';order.unfilledshares='6';}return false;};
    await f.execution.executePreparedReferenceEntry(f.intent._id);
    assert.equal((await sessions.restore(f.contexts[0])).entriesFilled,1);
    assert.equal(f.stores.Position[0].remainingQuantity,4);assert.equal(f.stores.Position[0].pendingEntryQuantity,6);
    f.setNow(Date.parse('2026-10-16T15:20:00+05:30'));
    await f.execution.monitorReferenceRisk();
    const sells=f.state.calls.filter(c=>c.path==='/angel/orders/simple'&&c.body.transactiontype==='SELL');
    assert.equal(sells.length,1);assert.equal(Number(sells[0].body.quantity),4);
    assert.equal(f.stores.Position[0].status,'CLOSED');assert.equal(f.stores.Position[0].remainingQuantity,0);
    assert.equal((await sessions.restore(f.contexts[0])).entriesFilled,1);
  });
}
for(const underlying of ['NIFTY','BANKNIFTY','SENSEX']) for(const direction of ['LONG','SHORT']) test(`${underlying} ${direction}: exact cutoff close accepted, one millisecond late refused`,()=>{
  const source=candles();const delayed=source.slice(0,15);
  for(let i=0;i<100;i++) delayed.push({...source[0],time:OPEN/1000+delayed.length*60});
  for(const bar of source.slice(15,31)) delayed.push({...bar,time:OPEN/1000+delayed.length*60});
  delayed[130]={...delayed[130],close:119,high:119};
  while(delayed.length<135) delayed.push({...delayed[130],time:OPEN/1000+delayed.length*60});
  delayed[134]={...delayed[134],close:121,high:122};
  const bars=direction==='SHORT'?delayed.map(c=>({...c,open:300-c.open,high:300-c.low,low:300-c.high,close:300-c.close})):delayed;
  assert.equal(evaluate(bars,135,underlying).isEntry,true);
  assert.equal(evaluate(bars,135,underlying,1).state,'ENTRY_WINDOW_CLOSED');
});
