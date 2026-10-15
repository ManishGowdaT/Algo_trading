from datetime import date, datetime, timedelta
from types import SimpleNamespace
import pytest
import pandas as pd
from app.services.spreads import engine, instruments, nse_calculations as nse
from app.services.spreads.provider import *
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
from app.services.spreads.discovery_cache import DiscoveryCache

def history_bad():
    bars=tuple(PriceBar(datetime(2026,1,1)+timedelta(days=i),10,12,9,11,100) for i in range(300))
    return HistoryData('TEST',bars,3,DataCapability(False,'unverified','unknown'),DataCapability(True,'reported','reported'),DataCapability(False,'incomplete','duplicate'),{'duplicate_dates':['2026-01-01']})

def test_b1_known_defective_history_is_not_eligible():
    history=history_bad()
    assert not history.scanner_history_eligible
    assert engine.capability_blockers(history,EarningsData(True,False,0,DataCapability(True,'test','test')))

def test_b2_missing_vrp_receives_no_measured_percentile_reward():
    rows=[dict(ticker=t,spot=100,chg=0,rv21=.2,iv14=None,vrp14=None,shock=1,shock_pass=False,vrp_pass=False,_rv21_raw=.2,_spot_raw=100) for t in ['HIGH','LOW','MISSING']]
    ranked=engine.rank_edge_discovery(rows,{'HIGH':.4,'LOW':.2,'MISSING':float('nan')})
    assert [r['ticker'] for r in ranked]==['HIGH','LOW','MISSING']
    missing=ranked[-1]
    assert missing['vrp14'] is None and not missing['edge']

@pytest.mark.parametrize('sign,short',[(1,100),(-1,110)])
@pytest.mark.parametrize('steps',[1,2])
def test_b3_invalid_intermediate_lot_does_not_compress_grid(sign,short,steps):
    side='CE' if sign>0 else 'PE'
    class Transport:
        def get(self,*args):
            return [dict(instrument_key=f'NSE_FO|{k}',trading_symbol=str(k),instrument_type=side,expiry='2026-11-23',strike_price=k,lot_size=None if k==105 else 10,tick_size=5) for k in [100,105,110]]
    contracts=UpstoxMarketDataProvider(transport=Transport()).get_option_contracts('NSE_EQ|TEST')
    rows=pd.DataFrame([dict(strike=k,instrument_key=f'NSE_FO|{k}',bid=2,ask=2.05) for k in [100,105,110]])
    issues=[]
    pair=nse.pair_resolver(contracts,date(2026,11,23),steps,'paise',issues)(sign,rows[rows.strike==short].iloc[0],rows)
    if steps==1:
        assert pair is None and issues
    else:
        assert pair is not None and pair[0].strike==(110 if sign>0 else 100)

def test_b4_stale_identity_refreshes_exact_authoritative_key():
    instruments.retain_universe_identities([dict(symbol='TESTSTALE',instrument_key='NSE_EQ|OLD',kind='EQUITY',segment='NSE_EQ')],'2000-01-01')
    new=dict(symbol='TESTSTALE',instrument_key='NSE_EQ|NEW',kind='EQUITY',segment='NSE_EQ')
    calls=[]
    try:
        result=instruments.resolve_underlying(None,'TESTSTALE',universe_loader=lambda:calls.append(1) or {'as_of':date.today().isoformat(),'items':[new]})
        assert result['instrument_key']=='NSE_EQ|NEW' and calls==[1]
    finally: instruments.retain_universe_identities([],None)

def test_b5_empty_refresh_preserves_previous_ranking_not_complete_attempt():
    cache=DiscoveryCache(clock=lambda:1000)
    key=cache.key('owner','fixture','')
    cache.entries[key]={'updated':999,'all':[{'ticker':'OLD'}],'universe':{'size':1},'errors':[],'capabilities':{},'stats':{'complete':True}}
    async def load():return {'all':[],'errors':[],'stats':{'complete':True,'atm_iv_attempted':2},'universe':{'size':2}}
    def drive(coroutine):
        while True:
            try: coroutine.send(None)
            except StopIteration as done: return done.value
    drive(cache._refresh(key,load))
    result=drive(cache.get(key,load))
    assert result['all']==[{'ticker':'OLD'}]
    assert result['updated']==999
    assert result['stats']['complete'] is False
    assert result['latest_attempt']['status']=='EMPTY'
    assert result['latest_attempt']['stats']['atm_iv_attempted']==2

@pytest.mark.parametrize('mode',['FAILED','PARTIAL'])
def test_b5_failed_and_partial_attempts_never_claim_success(mode):
    cache=DiscoveryCache(clock=lambda:1000)
    key=cache.key('owner','fixture','')
    cache.entries[key]={'updated':999,'all':[{'ticker':'OLD'}],'universe':{},'errors':[],'capabilities':{},'stats':{'complete':True}}
    async def load():
        if mode=='FAILED':raise RuntimeError('private error')
        return {'all':[{'ticker':'NEW'}], 'errors':[{'error':'one failed'}], 'stats':{'complete':True},'universe':{}}
    coroutine=cache._refresh(key,load)
    while True:
        try:coroutine.send(None)
        except StopIteration:break
    result=cache.entries[key]
    assert result['latest_attempt']['status']==mode
    assert result['stats']['complete'] is False
    assert 'private error' not in str(result)

def test_b7_missing_oi_is_not_zero_and_cannot_pass_zero_threshold():
    rows=engine.clean_option_rows([dict(strike=110,bid=1,ask=1.01,impliedVolatility=.3,openInterest=oi) for oi in [None,0]])
    assert len(rows)==2 and rows[0]['oi_available'] is False and rows[0]['openInterest']==-1
    assert not engine.passes_friction(engine.friction_detail(pd.Series(rows[0])),engine.ScanParams(min_oi=0))
    assert rows[1]['oi_available'] is True and rows[1]['openInterest']==0
    assert engine.passes_friction(engine.friction_detail(pd.Series(rows[1])),engine.ScanParams(min_oi=0))

def test_b8_oi_warning_describes_normalized_contracts_and_missing_mapping():
    chain=SimpleNamespace(open_interest=DataCapability(False,'unavailable','invalid mapping'),puts=(),calls=())
    result=engine.scan_provider_data('TEST',history_bad(),chain,EarningsData(True,False,0,DataCapability(True,'test','test')),date(2026,11,23),30)
    assert not any('reported OI directly' in warning for warning in result['data_warnings'])
    assert any('contract' in warning and 'unavailable' in warning for warning in result['data_warnings'])
