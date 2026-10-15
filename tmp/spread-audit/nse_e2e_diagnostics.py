"""Audit only: independent arithmetic on archived inputs, no network/orders.

Run from repo root. This file supplies no production data or behavior.
"""
import asyncio
from collections import Counter
from dataclasses import replace
from datetime import date, datetime, timedelta
import hashlib
import json
import math
from pathlib import Path
import statistics
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'angel-one'))
from app.services.spreads import engine, nse_calculations as nse
from app.services.spreads.provider import DataCapability, HistoryData, PriceBar, EarningsData
from app.services.spreads.instruments import retain_universe_identities, resolve_underlying
from app.services.spreads.discovery_cache import DiscoveryCache
from app.services.spreads.history_validation import validate_history
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
import pandas as pd

OUT = ROOT / 'tmp/spread-audit'
evidence = {'scope':'Archived 2026-10-13 inputs replayed on current code; NOT a fresh live scan',
            'arithmetic':[], 'batches':[], 'underlying_rejections':[], 'reproductions':{}}


def rv_independent(closes):
    returns = [math.log(b/a) for a,b in zip(closes,closes[1:])]
    return {f'rv{window}':statistics.stdev(returns[-window:])*math.sqrt(252)
            for window in (10,21,63,252) if len(returns)>=window}


def probability(closes,dte,cushion,direction):
    horizon=max(1,round(dte*252/365))
    returns=[(closes[i+horizon]/closes[i]-1)*100 for i in range(len(closes)-horizon)]
    if len(returns)<60:
        return float('nan'),horizon,len(returns)
    breached=sum(value<=-cushion if direction=='down' else value>=cushion for value in returns)
    return breached/len(returns),horizon,len(returns)


def penalty(p,cushion,gap):
    if gap<=0 or cushion<=0:
        return min(p*1.25+.05,.95)
    severity=gap/cushion
    return min(max(p*(1+severity)+max(0,severity-1)*.10,p),.95)


def independent_scan(capture,native,steps):
    x=capture['normalized']; params=x['parameters']; close=x['closes']; spot=x['spot']
    rv=rv_independent(close)
    counts=dict.fromkeys(('considered','cushion','friction','paired','ror','vrp','final'),0)
    accepted=[]; rejected=[]
    for label,side,sign in [('BULL PUT','puts',-1),('BEAR CALL','calls',1)]:
        typ='PE' if sign<0 else 'CE'
        rows=x[side]
        grid=sorted({c['strike'] for c in capture['contracts'] if c['expiry']==x['expiration'] and c['instrument_type']==typ})
        short_rows=sorted([r for r in rows if r['strike']<spot if sign<0] if sign<0 else [r for r in rows if r['strike']>spot],key=lambda r:abs(r['strike']-spot))[:params['max_strikes']]
        for short in short_rows:
            counts['considered']+=1
            record={'type':label,'short':short['strike'],'first_failure':None}
            def fail(reason):
                record['first_failure']=reason; rejected.append(record)
            cushion=abs(short['strike']-spot)/spot*100
            record.update(spot=spot, cushion=cushion, short_bid=short['bid'], short_ask=short['ask'], short_oi=short['openInterest'])
            if cushion<params['min_cushion']: fail('cushion');continue
            counts['cushion']+=1
            def liquidity(row,prefix):
                mid=(row['bid']+row['ask'])/2
                if mid<=0:return None,prefix+' midpoint'
                if (row['ask']-row['bid'])/mid>params['max_spread_pct']:return None,prefix+' bid/ask fraction'
                if row['openInterest']<params['min_oi']:return None,prefix+' OI'
                return mid,None
            sm,reason=liquidity(short,'short')
            if reason:fail(reason);continue
            if native:
                pos=grid.index(short['strike']); target=pos+sign*steps
                if not 0<=target<len(grid):fail('listed hedge missing');continue
                target=grid[target]
                matches=[r for r in rows if r['strike']==target]
            else:
                target=short['strike']+sign*params['width']
                matches=[r for r in rows if abs(r['strike']-target)<=.011+1e-5*abs(target)]
            if not matches:fail('missing hedge strike');continue
            long=matches[0];record['long']=long['strike']
            record.update(long_bid=long['bid'], long_ask=long['ask'], long_oi=long['openInterest'])
            lm,reason=liquidity(long,'long')
            if reason:fail(reason);continue
            counts['friction']+=1
            credit=sm-lm; width=abs(long['strike']-short['strike'])
            record.update(short_mid=sm, long_mid=lm, credit=credit, width=width)
            if native:
                contracts=[]
                for leg in (short,long):
                    contracts.append(next(c for c in capture['contracts'] if c['instrument_key']==leg['instrument_key'] and c['expiry']==x['expiration']))
                from fractions import Fraction
                ticks=[Fraction(str(c['tick_size']))/100 for c in contracts]
                den=math.lcm(*(t.denominator for t in ticks))
                nums=[t.numerator*(den//t.denominator) for t in ticks]
                minimum=math.gcd(*nums)/(2*den)
                on_tick=all(abs(leg[field]/float(tick)-round(leg[field]/float(tick)))<=1e-7 for leg,tick in zip((short,long),ticks) for field in ('bid','ask'))
                if not on_tick:fail('quote tick grid');continue
                if credit<minimum-1e-12:fail('credit below midpoint quantum');continue
            elif credit<=.01:fail('credit <= 0.01');continue
            if credit>=width:fail('credit >= width');continue
            counts['paired']+=1
            ror=credit/(width-credit)*100
            record['ror_pct']=ror
            if ror<params['min_ror']:fail('RoR');continue
            counts['ror']+=1
            iv=short['impliedVolatility']
            if iv is None or not math.isfinite(iv) or iv<=0:fail('missing/invalid IV');continue
            vrp=iv/rv['rv21']
            record.update(iv=iv, rv21=rv['rv21'], vrp=vrp)
            if vrp<params['min_vrp']:fail('VRP');continue
            counts['vrp']+=1
            p,h,n=probability(close,x['dte'],cushion,'down' if sign<0 else 'up')
            if not math.isfinite(p):fail('historical probability');continue
            adj=penalty(p,cushion,x['max_gap']) if x['earnings'] else p
            ev=(credit*(1-adj)-(width-credit)*adj)*100
            counts['final']+=1
            accepted.append({'ticker':x['ticker'],'type':label,'short_strike':short['strike'],'long_strike':long['strike'],
                'credit':round(credit,2),'ror_pct':round(ror,1),'cushion_pct':round(cushion,2),'vrp':round(vrp,2),
                'p_raw':round(p,4),'p_adj':round(adj,4),'ev':round(ev,0), 'credit_unrounded':credit,
                'horizon':h,'observations':n})
    return counts,accepted,rejected,rv


for batch_name,native in [('batch-86c96a05-c13f-4166-9a3b-d1a26dfec2cd.json',False),('batch-98083cd6-a4f1-4693-a15f-df06ce8b314e.json',True)]:
    batch=json.loads((OUT/batch_name).read_text()); aggregate=Counter(); combined=[]; rejected=Counter()
    for result in batch['result']['underlyings']:
        capture=json.loads((OUT/(result['scan_audit']['audit_id']+'.json')).read_text())
        x=capture['normalized']
        funnel,rows,failures,rv=independent_scan(capture,native,batch['request']['width_steps'])
        evidence['underlying_rejections'].append({'symbol':result['symbol'], 'profile':batch['request']['strategy_profile'], 'funnel':funnel, 'rejected':failures, 'accepted':rows, 'rv_independent':rv})
        assert funnel==result['funnel'],(result['symbol'],funnel,result['funnel'])
        assert sum(Counter(r['first_failure'] for r in failures).values())+len(rows)==funnel['considered']
        for key,value in rv.items():assert math.isclose(value,engine.realized_vols(x['closes'])[key],rel_tol=1e-12)
        for actual,calc in zip(result['candidates'],rows):
            for key in ('credit','ror_pct','cushion_pct','vrp','p_raw','p_adj','ev'):
                assert math.isclose(actual[key],calc[key],abs_tol=1e-10),(key,actual[key],calc[key])
            short=next(q for strike,q in capture['chain']['calls' if actual['type']=='BEAR CALL' else 'puts'] if strike==actual['short_strike'])
            long=next(q for strike,q in capture['chain']['calls' if actual['type']=='BEAR CALL' else 'puts'] if strike==actual['long_strike'])
            assert short['raw_oi_quantity']/actual['lot_size']==short['open_interest']
            assert long['raw_oi_quantity']/actual['lot_size']==long['open_interest']
            credit=calc['credit_unrounded'];loss=actual['width']-credit
            assert math.isclose(round(credit*actual['lot_size'],2),actual['credit_per_lot_inr'],abs_tol=1e-8)
            assert math.isclose(round(loss*actual['lot_size'],2),actual['max_loss_per_lot_inr'],abs_tol=1e-8)
            evidence['arithmetic'].append({'symbol':result['symbol'],'capture':capture['audit_id'], 'profile':batch['request']['strategy_profile'],
                'independent':calc,'rv_independent':rv,'api':actual,
                'raw_short_oi':short['raw_oi_quantity'],'raw_long_oi':long['raw_oi_quantity'],
                'spot':x['spot'],'latest_candle':capture['latest_historical_candle']})
        aggregate.update(funnel);combined.extend(rows);rejected.update(r['first_failure'] for r in failures)
        if native:
            contracts=[SimpleNamespace(**{**c,'expiry':date.fromisoformat(c['expiry'])}) for c in capture['contracts']]
            issues=[];resolver=nse.pair_resolver(contracts,date.fromisoformat(x['expiration']),batch['request']['width_steps'],'paise',issues)
            current,current_funnel=nse.build_spreads(x['ticker'],x['spot'],pd.DataFrame(x['puts']),pd.DataFrame(x['calls']),x['expiration'],x['dte'],pd.Series(x['closes']),engine.realized_vols(x['closes']),x['earnings'],x['max_gap'],engine.ScanParams(**x['parameters']),resolver)
            assert current_funnel==funnel and len(current)==len(rows)
    combined.sort(key=lambda r:r['ev'],reverse=True)
    assert [(r['ticker'],r['short_strike'],r['long_strike']) for r in combined]==[(r['ticker'],r['short_strike'],r['long_strike']) for r in batch['result']['candidates']]
    assert dict(aggregate)==batch['result']['funnel']
    evidence['batches'].append({'file':batch_name,'funnel':dict(aggregate),'rejections':dict(rejected),'ranking_matches':True})

# Reproduce missing-IV percentile reward in current implementation.
items=[dict(ticker=t,spot=100,chg=0,rv21=.2,iv14=None,vrp14=None,shock=1,shock_pass=False,vrp_pass=False,_rv21_raw=.2,_spot_raw=100) for t in ('HIGH','LOW','MISSING')]
ranked=engine.rank_edge_discovery(items,{'HIGH':.4,'LOW':.2,'MISSING':float('nan')})
assert ranked[0]['ticker']=='MISSING'
evidence['reproductions']['missing_iv_rank_reward']=ranked

# Duplicate sessions remain usable scanner inputs despite diagnostic failure.
base=json.loads((OUT/'7feed0f6-bdac-406e-a973-16a21a846216.json').read_text())
bars=[PriceBar(datetime.fromisoformat(b['timestamp']),b['open'],b['high'],b['low'],b['close'],b['volume']) for b in base['history']['bars']]
bars.insert(100,bars[100])
cap,report=validate_history(bars,start=bars[0].timestamp.date(),end=bars[-1].timestamp.date(),raw_count=len(bars),skipped_count=0)
history=HistoryData('NSE_EQ|TEST',tuple(bars),3,DataCapability(False,'unverified','Audit input'),DataCapability(True,'reported','Audit input'),cap,report)
empty=SimpleNamespace(puts=(),calls=(),open_interest=DataCapability(True,'verified','audit'))
assert history.scanner_history_eligible and not engine.capability_blockers(history,EarningsData(True,False,0,DataCapability(True,'audit','audit')))
evidence['reproductions']['duplicate_history_admitted']={'status':cap.status,'duplicates':report['duplicate_dates'],'eligible':True,'blockers':[]}

# Missing OI becomes 0 and passes the zero threshold, unlike explicit zero quantity.
row=engine.clean_option_rows([{'strike':110,'bid':1,'ask':1.01,'impliedVolatility':.3,'openInterest':None}])[0]
assert row['openInterest']==0 and engine.passes_friction(engine.friction_detail(pd.Series(row)),engine.ScanParams(min_oi=0))
evidence['reproductions']['missing_oi_zero_threshold']={'normalized_missing_oi':row['openInterest'],'passes':True}

# Identity snapshot's stored date is not consulted on lookup.
retain_universe_identities([{'symbol':'AUDITOLD','instrument_key':'NSE_EQ|OLD','kind':'EQUITY','segment':'NSE_EQ'}],'2000-01-01')
class NoNetwork:
    def get(self,*args,**kwargs):raise AssertionError('No lookup expected for reproduced stale cache')
evidence['reproductions']['stale_identity']=resolve_underlying(NoNetwork(),'AUDITOLD')
retain_universe_identities([],None)

# Missing metadata can silently shorten the listed-strike grid.
class IncompleteContracts:
    def get(self, path, params=None):
        return [{'instrument_key':f'NSE_FO|{strike}', 'underlying_key':'NSE_EQ|AUDIT',
                 'trading_symbol':f'AUDIT {strike} CE', 'instrument_type':'CE',
                 'expiry':'2026-11-23', 'strike_price':strike, 'lot_size':lot, 'tick_size':5}
                for strike,lot in [(100,10),(105,None),(110,10)]]
contracts=UpstoxMarketDataProvider(transport=IncompleteContracts()).get_option_contracts('NSE_EQ|AUDIT')
frame=pd.DataFrame([dict(strike=strike,instrument_key=f'NSE_FO|{strike}',bid=2,ask=2.05,openInterest=100,impliedVolatility=.3) for strike in (100,105,110)])
hedge,meta=nse.pair_resolver(contracts,date(2026,11,23),1,'paise',[])(1,frame.iloc[0],frame)
assert hedge.strike==110
assert [c.strike for c in contracts]==[100,110]
evidence['reproductions']['missing_lot_changes_listed_step']={'raw_listed_strikes':[100,105,110], 'normalized_listed_strikes':[100,110], 'requested_steps':1, 'selected_hedge':110, 'actual_next_listed_strike':105}

# Empty/failed refresh reuses old complete stats with old ranking.
async def cache_case():
    cache=DiscoveryCache(clock=lambda:1000)
    key=cache.key('audit','test','not-a-token')
    cache.entries[key]={'updated':999,'all':[{'ticker':'OLD'}],'universe':{'size':1},'errors':[], 'capabilities':{},'stats':{'complete':True,'atm_iv_available':1}}
    await cache._refresh(key,lambda:asyncio.sleep(0,result={'all':[],'errors':[{'error':'new attempt failed'}],'stats':{'complete':False,'atm_iv_available':0}}))
    out=await cache.get(key,lambda:None)
    assert out['stats']['complete'] and out['refresh_empty'] and out['updated']==999
    return out
# Drive this memory-only coroutine without creating Windows socketpair handles.
coroutine=cache_case()
while True:
    try: coroutine.send(None)
    except StopIteration as done:
        evidence['reproductions']['stale_complete_stats']=done.value
        break

# Independently re-evaluate supplied earnings dates against captured closes.
evidence['earnings_recomputation']=[]
for item in evidence['arithmetic']:
    capture=json.loads((OUT/(item['capture']+'.json')).read_text())
    dated=[(date.fromisoformat(b['timestamp'][:10]),b['close']) for b in capture['history']['bars'] if b['close'] is not None]
    positions={day:index for index,(day,value) in enumerate(dated)}
    gaps=[]
    events=capture['earnings'].get('historical_dates_used',[])
    for text in events:
        event=date.fromisoformat(text)
        for offset in range(4):
            index=positions.get(event+timedelta(days=offset))
            if index is not None:
                if index>0:gaps.append(abs(dated[index][1]/dated[index-1][1]-1)*100)
                break
    maximum=max(gaps,default=0)
    assert math.isclose(maximum,capture['normalized']['max_gap'],abs_tol=1e-10)
    evidence['earnings_recomputation'].append({'symbol':item['symbol'], 'historical_events':len(events),
        'recomputed_max_gap':maximum, 'source_identity_date_accuracy':'UNVERIFIED independently'})

(OUT/'nse-e2e-independent-evidence.json').write_text(json.dumps(evidence,indent=2,allow_nan=False))
print(json.dumps({'independent_batches':evidence['batches'],'verified_candidates':len(evidence['arithmetic']), 'reproduced_findings':list(evidence['reproductions'])},indent=2))
