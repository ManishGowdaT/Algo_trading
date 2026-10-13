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
    assert result.items == expected and result.errors == []
    assert set(result.capabilities) == set(keys)
    assert trending_scan is edge_discovery
    assert edge_discovery(universe,adapter,as_of=today) == expected


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


def test_concurrency_shortlist_ties_partial_failures_unknown_iv_and_deadline_context():
    adapter=Adapter()
    universe=[{'symbol':f'S{i}','instrument_key':str(i)} for i in range(15)]+[{'symbol':'BAD','instrument_key':'BAD'}]
    context=REQUEST_DEADLINE.set(123456.)
    try: result=discover(universe,adapter)
    finally: REQUEST_DEADLINE.reset(context)
    assert 1 < adapter.peak <= 6
    # Rounded shocks tie, so stable input order controls the original shortlist.
    assert set(adapter.iv_calls)=={str(i) for i in range(10)}
    assert len(result.items)==15 and len(result.errors)==11
    assert all(row['iv14'] is None and row['vrp14'] is None for row in result.items)
    assert all(value==123456. for value in adapter.deadlines)
    assert 'PRIVATE' not in str(result.errors) and 'secret' not in str(result.errors)
    assert all('_rv21_raw' not in row and '_spot_raw' not in row for row in result.items)


def test_empty_pipeline_does_not_request_iv():
    adapter=Adapter()
    result=discover([{'symbol':'BAD','instrument_key':'BAD'}],adapter)
    assert result.items==[] and len(result.errors)==1 and adapter.iv_calls==[]
    assert discover([],adapter).items==[]
