import ast
import math
import threading
import time
import types
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from app.services.spreads.discovery import discover, edge_discovery, trending_scan
from app.services.spreads.discovery_adapter import FixtureDiscoveryDataAdapter
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.nifty_fixtures import spread_fixture_payloads
from app.services.spreads.engine import atm_iv
from app.services.spreads.transport import UpstoxProviderError, REQUEST_DEADLINE


def test_full_fixture_pipeline_matches_untouched_zip_oracle():
    today = date(2026,10,12)
    adapter = FixtureDiscoveryDataAdapter(FixtureMarketDataProvider(spread_fixture_payloads(today=today)))
    universe = [{'symbol':symbol,'instrument_key':key} for symbol,key in [
        ('NIFTY','NSE_INDEX|Nifty 50'),('BANKNIFTY','NSE_INDEX|Nifty Bank'),('RELIANCE','NSE_EQ|INE002A01018'),('HDFCBANK','NSE_EQ|INE040A01034')]]
    histories = {item['symbol']:adapter.get_history(item['instrument_key'],as_of=today) for item in universe}
    keys = {item['symbol']:item['instrument_key'] for item in universe}
    def ticker(symbol):
        history = histories[symbol]
        return types.SimpleNamespace(symbol=symbol,history=lambda **kwargs:pd.DataFrame({'Close':history.closes,'Volume':history.volumes}))
    source = (Path(__file__).parent/'fixtures/spreads/original_screener.txt').read_text(encoding='utf-8-sig')
    node = next(node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name=='edge_discovery')
    ref = dict(math=math,np=np,pd=pd,yf=types.SimpleNamespace(Ticker=ticker),RateLimited=RuntimeError,
               _yf_call=lambda function,**kwargs:function(),
               _atm_iv=lambda tk,spot,dte:atm_iv(adapter.get_atm_chain(keys[tk.symbol],as_of=today),spot))
    exec(compile(ast.Module(body=[node],type_ignores=[]),'original-ZIP/edge_discovery','exec'),ref)
    expected = ref['edge_discovery']([item['symbol'] for item in universe])
    result = discover(universe,adapter,as_of=today)
    status_fields = {'iv_status','vrp_status'}
    assert [{key:value for key,value in row.items() if key not in status_fields} for row in result.items] == expected
    assert all(row['iv_status'] in {'available','unavailable','failed'} for row in result.items)
    assert set(result.capabilities) == set(keys)
    assert trending_scan is edge_discovery
    assert [{key:value for key,value in row.items() if key not in status_fields}
            for row in edge_discovery(universe,adapter,as_of=today)] == expected


class Adapter:
    def __init__(self):
        self.lock=threading.Lock(); self.active=0; self.peak=0; self.iv_calls=[]; self.deadlines=[]
    def get_history(self,key,as_of=None):
        if key=='BAD': raise UpstoxProviderError('PRIVATE ERROR token=secret',status_code=429)
        with self.lock:
            self.active+=1; self.peak=max(self.peak,self.active)
        time.sleep(.01)
        with self.lock:
            self.active-=1; self.deadlines.append(REQUEST_DEADLINE.get())
        i=int(key)
        cap=types.SimpleNamespace(status='reported')
        return types.SimpleNamespace(eligibility_error=None,closes=[100*math.exp(.01*math.sin(j)) for j in range(40)],
            volumes=[100]*39+[150+i*.0001],adjustment=cap,volume=cap,completeness=cap)
    def get_atm_chain(self,key,as_of=None):
        self.iv_calls.append(key)
        raise UpstoxProviderError('PRIVATE ERROR token=secret',status_code=401)


def test_v3_failure_is_failed_not_provider_unavailable(monkeypatch):
    import app.services.spreads.discovery as module
    monkeypatch.setattr(module, 'atm_iv', lambda *args: float('nan'))
    adapter = Adapter()
    cap = types.SimpleNamespace(status='reported')
    adapter.get_atm_chain = lambda *args, **kwargs: types.SimpleNamespace(
        iv_errors=({'reason':'V3 Option Greeks request failed','status':429,'code':'LIMIT'},),
        implied_volatility=cap, open_interest=cap)
    result = discover([{'symbol':'TEST','instrument_key':'0'}], adapter)
    assert result.items[0]['iv_status'] == 'failed'
    assert result.stats['atm_iv_failed'] == 1
    assert result.stats['atm_iv_unavailable'] == 0
    assert result.errors[0]['status'] == 429


def test_concurrency_full_universe_partial_failures_and_deadline_context():
    adapter=Adapter()
    universe=[{'symbol':f'S{i}','instrument_key':str(i)} for i in range(15)]+[{'symbol':'BAD','instrument_key':'BAD'}]
    context=REQUEST_DEADLINE.set(123456.)
    try: result=discover(universe,adapter)
    finally: REQUEST_DEADLINE.reset(context)
    assert 1 < adapter.peak <= 6
    assert set(adapter.iv_calls)=={str(i) for i in range(15)} | {'BAD'}
    assert len(result.items)==15 and len(result.errors)==17
    assert all(row['iv14'] is None and row['vrp14'] is None for row in result.items)
    assert all(row['iv_status']=='failed' and row['vrp_status']=='failed' for row in result.items)
    assert result.stats['eligible_underlyings']==16
    assert result.stats['atm_iv_attempted']==16
    assert result.stats['atm_iv_failed']==16
    assert result.stats['history_failed']==1
    assert all(value==123456. for value in adapter.deadlines)
    assert 'PRIVATE' not in str(result.errors) and 'secret' not in str(result.errors)
    assert all('_rv21_raw' not in row and '_spot_raw' not in row for row in result.items)


def test_dynamic_universe_sizes_all_receive_iv_attempts_and_statuses(monkeypatch):
    import app.services.spreads.discovery as discovery_module
    monkeypatch.setattr(discovery_module, 'atm_iv', lambda chain, spot: .25)

    class FullUniverseAdapter(Adapter):
        def get_history(self,key,as_of=None):
            i=int(key)
            cap=types.SimpleNamespace(status='reported')
            return types.SimpleNamespace(eligibility_error=None,
                closes=[100*math.exp(.01*math.sin(j)) for j in range(40)],
                volumes=[100]*39+[150+i*.0001], adjustment=cap, volume=cap, completeness=cap)
        def get_atm_chain(self,key,as_of=None):
            self.iv_calls.append(key)
            cap=types.SimpleNamespace(status='reported')
            return types.SimpleNamespace(implied_volatility=cap, open_interest=cap)

    for count in (13, 23, 219):
        adapter=FullUniverseAdapter()
        progress=[]
        universe=[{'symbol':f'S{i}','instrument_key':str(i)} for i in range(count)]
        result=discover(universe,adapter,on_progress=progress.append)
        assert len(adapter.iv_calls)==count
        assert result.stats['eligible_underlyings']==count
        assert result.stats['atm_iv_attempted']==count
        assert result.stats['atm_iv_available']==count
        assert [p for p in progress if p['stage']=='history'][-1] == {'stage':'history','completed':count,'total':count}
        assert [p for p in progress if p['stage']=='iv'][-1] == {'stage':'iv','completed':count,'total':count}


def test_iv_statuses_distinguish_unavailable_and_failed_and_history_failure_still_attempts(monkeypatch):
    import app.services.spreads.discovery as discovery_module
    def fake_atm_iv(chain, spot):
        return .2 if getattr(chain, 'label', None) == 'GOOD' else float('nan')
    monkeypatch.setattr(discovery_module, 'atm_iv', fake_atm_iv)

    class StatusAdapter(Adapter):
        def get_history(self,key,as_of=None):
            if key == 'HISTORY_FAIL':
                raise UpstoxProviderError('history unavailable',status_code=503)
            cap=types.SimpleNamespace(status='reported')
            return types.SimpleNamespace(eligibility_error=None,
                closes=[100*math.exp(.01*math.sin(j)) for j in range(40)], volumes=[100]*39+[200],
                adjustment=cap, volume=cap, completeness=cap)
        def get_atm_chain(self,key,as_of=None):
            self.iv_calls.append(key)
            if key == 'CHAIN_FAIL': raise UpstoxProviderError('chain failed',status_code=429)
            if key == 'NO_EXPIRY': return None
            cap=types.SimpleNamespace(status='reported')
            return types.SimpleNamespace(label=key, implied_volatility=cap, open_interest=cap)

    adapter=StatusAdapter()
    symbols=['GOOD','NO_IV','NO_EXPIRY','CHAIN_FAIL','HISTORY_FAIL']
    progress=[]
    result=discover([{'symbol':key,'instrument_key':key} for key in symbols],adapter,on_progress=progress.append)
    assert set(adapter.iv_calls)==set(symbols)
    states={row['ticker']:row['iv_status'] for row in result.items}
    assert states=={'GOOD':'available','NO_IV':'unavailable','NO_EXPIRY':'unavailable','CHAIN_FAIL':'failed'}
    assert states.get('HISTORY_FAIL') is None  # no rank row without original history inputs
    assert result.stats['atm_iv_attempted']==5
    assert result.stats['atm_iv_available']==1
    assert result.stats['atm_iv_unavailable']==3
    assert result.stats['atm_iv_failed']==1
    assert {(error['stage'], error['status']) for error in result.errors if error['ticker']=='HISTORY_FAIL'} == {
        ('history',503), ('iv',None)}
    assert [p for p in progress if p['stage']=='iv'][-1]=={'stage':'iv','completed':5,'total':5}


def test_empty_pipeline_does_not_request_iv():
    adapter=Adapter()
    result=discover([{'symbol':'BAD','instrument_key':'BAD'}],adapter)
    assert result.items==[] and len(result.errors)==2 and adapter.iv_calls==['BAD']
    assert result.stats['atm_iv_attempted']==1 and result.stats['complete'] is True
    assert discover([],adapter).items==[]
