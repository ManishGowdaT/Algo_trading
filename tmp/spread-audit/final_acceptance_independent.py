"""Acceptance-only expected values use Python math/statistics, never production calculators."""
import sys,json,math,statistics,os
from pathlib import Path
from datetime import date, datetime
from fastapi import FastAPI
from fastapi.testclient import TestClient
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'angel-one'))
from app.services.spreads import api
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
from app.services.spreads.provider import EarningsData,DataCapability
OUT=ROOT/'tmp/spread-audit'
os.environ['SPREADS_DATA_MODE']='fixtures';os.environ['INTERNAL_SERVICE_KEY']='acceptance-local-test'
app=FastAPI();app.include_router(api.router)
headers={'X-Internal-Service-Key':'acceptance-local-test'}
evidence={'scope':'Current code; synthetic fixtures and archived 13 October provider responses. No live broker requests.','calculations':[],'batches':[],'archived':[]}

def verify(scan,history,chain,event_gap=0):
    closes=[b.close for b in history.bars]
    returns=[math.log(b/a) for a,b in zip(closes,closes[1:])]
    rv={f'rv{n}':statistics.stdev(returns[-n:])*math.sqrt(252) for n in (10,21,63,252)}
    for key,value in rv.items(): assert scan['meta']['rv'][key]==round(value,4),(key,value)
    for c in scan['candidates']:
        pairs=dict(chain.puts if c['type']=='BULL PUT' else chain.calls)
        short,long=pairs[c['short_strike']],pairs[c['long_strike']]
        sm=(short.bid+short.ask)/2;lm=(long.bid+long.ask)/2
        credit=sm-lm;width=abs(c['short_strike']-c['long_strike']);loss=width-credit
        cushion=abs(c['short_strike']-closes[-1])/closes[-1]*100
        ror=credit/loss*100;vrp=short.implied_volatility/rv['rv21']
        n=max(1,round(scan['dte']*252/365));forward=[(closes[i+n]/closes[i]-1)*100 for i in range(len(closes)-n)]
        count=sum(x<=-cushion if c['type']=='BULL PUT' else x>=cushion for x in forward)
        raw=count/len(forward);adj=raw
        if c['earnings']:
            gap=event_gap
            if gap<=0 or cushion<=0: adj=min(raw*1.25+.05,.95)
            else:
                severity=gap/cushion
                adj=min(max(raw*(1+severity)+max(0,severity-1)*.10,raw),.95)
        ev=(credit*(1-adj)-loss*adj)*100
        expected={'credit':round(credit,2),'width':width,'cushion_pct':round(cushion,2),'ror_pct':round(ror,1),'vrp':round(vrp,2),'p_raw':round(raw,4),'p_adj':round(adj,4),'ev':round(ev,0),'credit_per_lot_inr':round(credit*c['lot_size'],2),'max_loss_per_lot_inr':round(loss*c['lot_size'],2),'probability_sample_count':len(forward)}
        for key,value in expected.items(): assert math.isclose(c[key],value,abs_tol=1e-8),(scan['symbol'],key,c[key],value)
        assert math.isclose(c['credit_points_unrounded'],credit,abs_tol=1e-10)
        for q in (short,long):
            if q.raw_oi_quantity is not None: assert q.open_interest==q.raw_oi_quantity/c['lot_size']
        evidence['calculations'].append({'symbol':scan['symbol'],'profile':scan['strategy_profile'],'type':c['type'],'short':c['short_strike'],'long':c['long_strike'],'short_mid':sm,'long_mid':lm,'short_raw_oi':short.raw_oi_quantity,'short_oi_contracts':short.open_interest,'long_raw_oi':long.raw_oi_quantity,'long_oi_contracts':long.open_interest,'lot':c['lot_size'],'rv':rv,'expected':expected})

with TestClient(app) as client:
    response=client.post('/spreads/scan',headers=headers,json={'underlyings':['NIFTY','BANKNIFTY','RELIANCE','HDFCBANK'],'strategy_profile':'NSE_RESEARCH_V1'})
    assert response.status_code==200
    batch=response.json();assert batch['status']=='SUCCESS'
    (OUT/'final-acceptance-api.json').write_text(json.dumps(batch,allow_nan=False))
    for scan in batch['underlyings']:
        provider=api._provider('fixtures','');key=scan['instrument_key']
        verify(scan,provider.get_history(key),provider.get_option_chain(key,date.fromisoformat(scan['expiry'])))
        assert scan['funnel']['considered']==scan['funnel']['final']+len(scan['nse_market_structure_issues'])
    assert [c['ev'] for c in batch['candidates']]==sorted([c['ev'] for c in batch['candidates']],reverse=True)
    evidence['batches'].append({'mode':'fixtures','status':batch['status'],'funnel':batch['funnel'],'candidates':len(batch['candidates'])})
    partial=client.post('/spreads/scan',headers=headers,json={'underlyings':['NIFTY','NOTREAL'],'strategy_profile':'NSE_RESEARCH_V1'}).json()
    assert partial['status']=='PARTIAL' and partial['success_count']==1 and partial['failure_count']==1
    zero=client.post('/spreads/scan',headers=headers,json={'underlyings':['NIFTY'],'strategy_profile':'NSE_RESEARCH_V1','min_oi':10000,'min_cushion':30}).json()
    assert zero['status']=='SUCCESS' and zero['candidates']==[]
    evidence['partial_and_zero']={'partial_status':partial['status'],'zero_status':zero['status'],'zero_candidates':len(zero['candidates'])}

# Replay captured Upstox-shaped responses through CURRENT production normalizer and API.
archive=json.loads((OUT/'batch-86c96a05-c13f-4166-9a3b-d1a26dfec2cd.json').read_text())
original_provider=api._provider
from app.services.spreads import upstox_adapter
class ArchivedClock(datetime):
    @classmethod
    def now(cls,tz=None): return cls(2026,10,13,16,0,tzinfo=tz)
api.datetime=ArchivedClock
upstox_adapter.datetime=ArchivedClock
os.environ['SPREADS_DATA_MODE']='upstox'
for old in archive['result']['underlyings']:
    capture=json.loads((OUT/(old['scan_audit']['audit_id']+'.json')).read_text())
    class Transport:
        def get(self,path,params=None):
            matches=[r for r in capture['raw_upstox'] if r['path']==path or path.startswith('/v3/historical-candle/') and r['path'].startswith('/v3/historical-candle/')]
            if not matches: raise AssertionError('No archived response '+path)
            return matches[0]['data']
    provider=UpstoxMarketDataProvider(transport=Transport())
    provider.resolve_underlying=lambda symbol: capture['underlying']
    e=capture['earnings']
    provider.get_earnings_info=lambda *args:EarningsData(e['available'],e['earnings_inside'],e['max_historical_gap_pct'],DataCapability(**e['capability']))
    api._provider=lambda *args:provider
    for profile in ['NSE_RESEARCH_V1','ORIGINAL_ZIP_BASELINE']:
        scan=api._scan_underlying(capture['ticker'],api.NiftyScanRequest(strategy_profile=profile,expiry=date.fromisoformat(capture['normalized']['expiration'])),None,'acceptance-archive-no-network')
        evidence['archived'].append({'symbol':scan['symbol'],'profile':profile,'ok':scan['ok'],'funnel':scan['funnel'],'candidates':len(scan['candidates']),'warnings':scan['data_warnings']})
        if scan['ok']:
            verify(scan,provider.get_history(scan['instrument_key']),provider.get_option_chain(scan['instrument_key'],date.fromisoformat(scan['expiry'])),e['max_historical_gap_pct'])
api._provider=original_provider
(OUT/'final-acceptance-independent.json').write_text(json.dumps(evidence,indent=2,allow_nan=False))
print(json.dumps({'independently_checked_candidates':len(evidence['calculations']),'batches':evidence['batches'],'archived':[(s['symbol'],s['profile'],s['ok'],s['candidates']) for s in evidence['archived']]}))
