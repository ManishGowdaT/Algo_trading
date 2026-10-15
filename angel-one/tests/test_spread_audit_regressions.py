"""Regression coverage for the original ZIP contract and audit corrections."""
import ast
import asyncio
import hashlib
import math
import threading
import time
import types
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.services.spreads import api, engine, original_calculations
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.nifty_fixtures import spread_fixture_payloads
from app.services.spreads.transport import REQUEST_DEADLINE, UpstoxProviderError, UpstoxTransport

SOURCE = Path(__file__).parent / 'fixtures/spreads/original_screener.txt'


def reference_module():
    source = SOURCE.read_bytes()
    assert hashlib.sha256(source).hexdigest() == '6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa'
    names = {'ScanParams', 'realized_vols', 'apply_earnings_penalty', 'empirical_breach_prob', 'friction_detail', 'passes_friction', 'build_spreads'}
    tree = ast.parse(source.decode('utf-8-sig'))
    nodes = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names]
    module = types.ModuleType('spread_zip_reference')
    sys.modules[module.__name__] = module
    module.__dict__.update(math=math, np=np, pd=pd, dataclass=dataclass, TRADING_DAYS_PER_YEAR=252, CAL_TO_TRADING=252/365)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'original-ZIP/screener.py', 'exec'), module.__dict__)
    # Production definitions must remain AST-identical, not merely close on examples.
    production = ast.parse(Path(original_calculations.__file__).read_text())
    actual = {n.name: ast.dump(n, include_attributes=False) for n in production.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))}
    for node in nodes:
        assert actual[node.name] == ast.dump(node, include_attributes=False)
    return module


def test_untouched_zip_oracle_candidates_funnels_and_numeric_boundaries():
    ref = reference_module()
    rng = np.random.default_rng(910)
    for case in range(100):
        closes = 100 * np.exp(np.cumsum(rng.normal(0, .012, 400)))
        spot = float(closes[-1])
        strikes = np.arange(math.floor(spot/5)*5-45, math.floor(spot/5)*5+50, 5)
        puts, calls = [], []
        for index, strike in enumerate(strikes):
            for rows, mid in [(puts, .2+index*.6), (calls, .2+(len(strikes)-index)*.6)]:
                rows.append(dict(strike=float(strike), bid=mid*.98, ask=mid*1.02,
                                 impliedVolatility=.45 if index%7 else np.nan, openInterest=250 if index%5 else 10))
        params = dict(dte=[5,14,30,90,180][case%5], width=[5.,10.,15.][case%3], min_vrp=[.5,1.15,2.][case%3], min_oi=100,
                      max_spread_pct=.1, min_cushion=[0.,2.,5.][case%3], min_ror=[5.,15.,50.][case%3], max_strikes=12)
        rv = ref.realized_vols(pd.Series(closes))
        assert rv == engine.realized_vols(closes)
        expected = ref.build_spreads('TEST', spot, pd.DataFrame(puts), pd.DataFrame(calls), '2026-12-31', params['dte'], pd.Series(closes), rv, case%2==0, 8., ref.ScanParams(**params))
        actual = engine.build_spreads('TEST', spot, puts, calls, '2026-12-31', params['dte'], closes, rv, case%2==0, 8., engine.ScanParams(**params))
        assert actual == expected
    for closes in ([100.]*300, [0.]+[100.]*300, [100., np.nan, 0., -1., np.inf]*70):
        for direction in ('down', 'up'):
            expected = ref.empirical_breach_prob(pd.Series(closes), 30, 2, direction)
            actual = engine.empirical_breach_prob(closes, 30, 2, direction)
            assert actual == expected or (math.isnan(actual) and math.isnan(expected))


def test_original_defaults_bounds_and_picker():
    request = api.NiftyScanRequest()
    assert request.dte == 30 and request.width == 5 and request.expiry is None
    assert 'max_strikes' not in api.NiftyScanRequest.model_fields
    for field, value in [('dte',4), ('min_vrp',.49), ('min_oi',10001), ('max_spread_pct',0), ('min_cushion',31), ('min_ror',4)]:
        with pytest.raises(ValueError):
            api.NiftyScanRequest(**{field:value})
    today = datetime.now(api.IST).date()
    provider = FixtureMarketDataProvider(spread_fixture_payloads())
    contracts = provider.get_option_contracts('NSE_INDEX|Nifty 50')
    picked = engine.pick_expiration(sorted({c.expiry.isoformat() for c in contracts}), 30, as_of=today)
    assert picked
    # Fixture API has no live calls or bearer requirements.
    from unittest.mock import patch
    with patch.dict('os.environ', {'SPREADS_DATA_MODE':'fixtures'}):
        result = api._scan_underlying('NIFTY', request, None, '')
    assert result['expiry'] == picked[0] and result['dte'] == picked[1]


def test_multi_normalizes_deduplicates_bounds_concurrency_and_stable_ev(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    active = peak = 0
    lock = threading.Lock()
    def scan(symbol, request, authorized, token):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(.02)
        with lock:
            active -= 1
        return dict(symbol=symbol, ok=True, candidates=[dict(ticker=symbol, ev=-1),dict(ticker=symbol, ev=-2)], funnel={key:1 for key in ['considered','cushion','friction','paired','ror','vrp','final']}, meta={})
    monkeypatch.setattr(api, '_scan_underlying', scan)
    result = asyncio.run(api.scan_multiple(api.MultiScanRequest(underlyings=[' z ','A','b','C','D','E','a']), None, ''))
    assert 1 < peak <= 4
    assert result['tickers_ok'] == 6 and result['tickers_failed'] == 0
    assert [r['symbol'] for r in result['underlyings']] == ['A','B','C','D','E','Z']
    assert [c['ev'] for c in result['candidates']] == [-1]*6+[-2]*6
    assert [c['ticker'] for c in result['candidates'][:6]] == ['A','B','C','D','E','Z']
    assert api._json_safe({'a':[np.nan, float('inf'), (1,)]}) == {'a':[None,None,[1]]}


def test_transport_cache_isolated_deepcopied_expires_and_deadline(monkeypatch):
    from app.services.spreads import transport as module
    class Client:
        calls = 0
        def get(self, *args, **kwargs):
            self.calls += 1
            return types.SimpleNamespace(status_code=200, headers={}, json=lambda: {'status':'success','data':[{'oi':self.calls}]})
    now = [100.]
    monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
    client = Client()
    first = UpstoxTransport('token-one', client=client)
    data = first.get('/v2/option/chain', {'instrument_key':'NSE_INDEX|Nifty 50'})
    data[0]['oi'] = 999
    assert first.get('/v2/option/chain', {'instrument_key':'NSE_INDEX|Nifty 50'}) == [{'oi':1}]
    UpstoxTransport('token-two', client=client).get('/v2/option/chain', {'instrument_key':'NSE_INDEX|Nifty 50'})
    assert client.calls == 2
    now[0] += 121
    first.get('/v2/option/chain', {'instrument_key':'NSE_INDEX|Nifty 50'})
    assert client.calls == 3
    context = REQUEST_DEADLINE.set(now[0]-1)
    try:
        with pytest.raises(UpstoxProviderError, match='deadline'):
            first.get('/v2/option/chain')
        assert client.calls == 3
    finally:
        REQUEST_DEADLINE.reset(context)


def test_discovery_uses_raw_vrp_threshold_before_rounding():
    item = engine.edge_discovery_metrics('TEST', [100*math.exp(.01*math.sin(i)) for i in range(40)], [100]*39+[200])
    iv = item['_rv21_raw'] * 1.204
    row = engine.rank_edge_discovery([item], {'TEST':iv})[0]
    assert row['vrp14'] == 1.20 and row['vrp_pass'] and row['edge']


def test_raw_upstox_inputs_scan_without_validation_gates_and_keep_provenance():
    from dataclasses import replace
    provider = FixtureMarketDataProvider(spread_fixture_payloads())
    key = 'NSE_INDEX|Nifty 50'
    expiry = provider.get_option_contracts(key)[0].expiry
    history, chain = provider.get_history(key), provider.get_option_chain(key, expiry)
    earnings = provider.get_earnings_info(key, expiry)
    from app.services.spreads.provider import DataCapability
    unverified = DataCapability(True, 'unverified', 'raw live fields')
    result = engine.scan_provider_data('NIFTY', replace(history, completeness=unverified), replace(chain, open_interest=unverified), earnings, expiry, 30)
    assert result['ok'] and result['funnel'] is not None
    assert 'capability_blockers' not in result
    assert any('contract-count OI' in text for text in result['data_warnings'])
    assert any('completeness' in text for text in result['data_warnings'])


def test_endpoint_user_quotas_cache_hits_and_original_retry_delays(monkeypatch):
    from app.services.spreads import transport as module
    now, calls, delays = [100.], [], []
    monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
    from app.services.spreads.rate_limit import MarketDataQuota
    monkeypatch.setattr(module, 'market_data_quota', MarketDataQuota(clock=lambda: now[0]))
    def sleep(delay):
        delays.append(delay)
        now[0] += delay
    monkeypatch.setattr(module.time, 'sleep', sleep)
    def get(*args, **kwargs):
        calls.append(now[0])
        return types.SimpleNamespace(status_code=200, headers={}, json=lambda: {'status':'success','data':[]})
    monkeypatch.setattr(module.httpx, 'get', get)
    first = UpstoxTransport('spacing-token-one')
    first.get('/v2/option/contract')
    first.get('/v2/option/contract')  # Cached: no sleep or HTTP call.
    UpstoxTransport('spacing-token-two').get('/v2/option/chain')
    assert len(calls) == 2 and calls[1] == calls[0]
    assert delays == []  # Independent users/APIs do not block each other.
    retry_delays = []
    transport = UpstoxTransport('retry-policy', client=object(), sleep=retry_delays.append, jitter=lambda: 1)
    for attempt in range(3):
        transport._backoff(attempt)
    assert retry_delays == [1.75, 2.75, 4.75]


def test_batch_keeps_completed_results_after_event_loop_cutoff(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    # Reproduce late thread-result delivery; the previous outer wait discarded it.
    async def premature_wait(*args, **kwargs):
        raise AssertionError('Do not discard worker results with an outer asyncio.wait')
    monkeypatch.setattr(api.asyncio, 'wait', premature_wait)
    def slow_scan(symbol, request, authorized, token):
        time.sleep(.03)
        return {'symbol':symbol, 'ok':True, 'candidates':[], 'funnel':{}, 'meta':{}}
    monkeypatch.setattr(api, '_scan_underlying', slow_scan)
    result = asyncio.run(api.scan_multiple(api.MultiScanRequest(underlyings=['NIFTY']), None, ''))
    assert result['tickers_ok'] == 1 and result['tickers_failed'] == 0


def test_expired_batch_budget_reports_error_without_starting_provider(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    monkeypatch.setattr(api, 'SCAN_BUDGET_SECONDS', 0)
    monkeypatch.setattr(api, '_scan_underlying', lambda *args: pytest.fail('Expired worker started'))
    result = asyncio.run(api.scan_multiple(api.MultiScanRequest(underlyings=['NIFTY']), None, ''))
    assert result['tickers_failed'] == 1 and 'deadline' in result['errors'][0]['error']


def test_discovery_pipeline_metrics_and_rank_match_original_zip():
    source = SOURCE.read_text(encoding='utf-8-sig')
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'edge_discovery')
    symbols = [f'S{i}' for i in range(15)]
    histories = {symbol: pd.DataFrame({'Close':[100*math.exp(.01*math.sin(i/(j+1))) for i in range(85)],
                                      'Volume':[100.] * 84 + [100.+j*10]}) for j, symbol in enumerate(symbols)}
    metrics = [engine.edge_discovery_metrics(symbol, frame.Close, frame.Volume) for symbol, frame in histories.items()]
    ivs = {row['ticker']:row['_rv21_raw'] * (1.204 if i%2 else 1.19) for i,row in enumerate(metrics)}
    namespace = dict(pd=pd, np=np, math=math, RateLimited=RuntimeError,
                     yf=types.SimpleNamespace(Ticker=lambda symbol: types.SimpleNamespace(history=lambda **kwargs: histories[symbol])),
                     _yf_call=lambda fn, **kwargs: fn(),
                     _atm_iv=lambda ticker, spot, dte: ivs[next(symbol for symbol in symbols if ticker.history() is histories[symbol])])
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'original-ZIP/edge_discovery', 'exec'), namespace)
    expected = namespace['edge_discovery'](symbols, iv_shortlist=len(symbols))
    actual = engine.rank_edge_discovery(metrics, ivs)
    assert [{key:value for key,value in row.items() if key not in {'iv_status','vrp_status'}} for row in actual] == expected


def test_earnings_gap_calculation_matches_original_zip():
    source = SOURCE.read_text(encoding='utf-8-sig')
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == 'get_earnings_info')
    today = date.today()
    days = [today-timedelta(days=10-i) for i in range(11)]
    closes = [100., 102., 97., 103., 100., 110., 108., 107., 112., 110., 105.]
    events = [today-timedelta(days=5), today+timedelta(days=3)]
    ticker = types.SimpleNamespace(get_earnings_dates=lambda limit: pd.DataFrame({'EPS':[1.,2.]}, index=pd.to_datetime(events)))
    namespace = dict(pd=pd,np=np,math=math,date=date,timedelta=timedelta,yf=types.SimpleNamespace(Ticker=object))
    exec(compile(ast.Module(body=[node],type_ignores=[]), 'original-ZIP/get_earnings_info', 'exec'), namespace)
    expected = namespace['get_earnings_info'](ticker, pd.Series(closes,index=pd.to_datetime(days)), today+timedelta(days=30))
    assert engine.get_earnings_info(events,list(zip(days,closes)),today+timedelta(days=30),as_of=today) == expected


def test_lot_money_uses_unrounded_source_inputs_without_changing_original_ev(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    payloads = spread_fixture_payloads()
    key = 'NSE_INDEX|Nifty 50'
    for contract in payloads[f'contracts:{key}']:
        contract['lot_size'] = 75
    provider = FixtureMarketDataProvider(payloads)
    monkeypatch.setattr(api, '_provider', lambda mode, token: provider)
    result = api._scan_underlying('NIFTY', api.NiftyScanRequest(width=50), None, '')
    assert result['candidates']
    chain = provider.get_option_chain(key, date.fromisoformat(result['expiry']))
    closes = [bar.close for bar in provider.get_history(key).bars if bar.close is not None]
    for row in result['candidates']:
        quotes = dict(chain.puts if row['type'] == 'BULL PUT' else chain.calls)
        short, long = quotes[row['short_strike']], quotes[row['long_strike']]
        credit = (short.bid+short.ask-long.bid-long.ask)/2
        loss = row['width']-credit
        cushion = abs(row['short_strike']-closes[-1])/closes[-1]*100
        probability = engine.empirical_breach_prob(closes, result['dte'], cushion, 'down' if row['type'] == 'BULL PUT' else 'up')
        unit_ev = credit*(1-probability)-loss*probability
        assert row['ev'] == round(unit_ev*100, 0)
        assert row['ev_per_lot_inr'] == round(unit_ev*75, 2)
        assert row['credit_per_lot_inr'] == round(credit*75, 2)
        assert row['short_instrument_key'] == short.instrument_key
        assert row['long_instrument_key'] == long.instrument_key


def test_discovered_nonstandard_indices_and_stock_keys_are_retained(monkeypatch):
    from app.services.spreads import instruments
    monkeypatch.setattr(instruments, '_discovered', {})
    monkeypatch.setattr(instruments, '_identity_day', None)
    rows = [dict(symbol=symbol, instrument_key=key, kind=kind, segment=segment)
            for symbol,key,kind,segment in [
                ('FINNIFTY','NSE_INDEX|Nifty Fin Service','INDEX','NSE_INDEX'),
                ('MIDCPNIFTY','NSE_INDEX|NIFTY MID SELECT','INDEX','NSE_INDEX'),
                ('NIFTYNXT50','NSE_INDEX|Nifty Next 50','INDEX','NSE_INDEX'),
                ('TEST-EQ','NSE_EQ|master-identity','EQUITY','NSE_EQ')]]
    instruments.retain_universe_identities(rows, datetime.now(api.IST).date().isoformat())
    class NoSearch:
        def get(self, *args): pytest.fail('Discovered identity must not be resolved again through EQ search')
    for row in rows:
        actual = instruments.resolve_underlying(NoSearch(), row['symbol'])
        assert actual == row
        actual['instrument_key'] = 'mutated'
        assert instruments.resolve_underlying(NoSearch(), row['symbol']) == row


def test_duplicate_strikes_do_not_use_last_quote_for_per_lot_money(monkeypatch):
    from dataclasses import replace
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    provider = FixtureMarketDataProvider(spread_fixture_payloads())
    original = provider.get_option_chain
    def duplicated(key, expiry):
        chain = original(key, expiry)
        def pairs(rows):
            return rows + tuple((strike, replace(quote, bid=quote.bid+.1, ask=quote.ask+.1)) for strike,quote in rows)
        return replace(chain, puts=pairs(chain.puts), calls=pairs(chain.calls))
    provider.get_option_chain = duplicated
    monkeypatch.setattr(api, '_provider', lambda *args: provider)
    request = api.NiftyScanRequest(width=100, min_cushion=0, max_spread_pct=.3, min_ror=5)
    result = api._scan_underlying('NIFTY', request, None, '')
    assert result['ok'] and result['candidates']
    key = result['instrument_key']; expiry = date.fromisoformat(result['expiry'])
    expected = engine.scan_provider_data('NIFTY', provider.get_history(key), duplicated(key, expiry), provider.get_earnings_info(key, expiry), expiry, result['dte'], engine.ScanParams(**request.model_dump(exclude={'expiry','dte','strategy_profile','width_steps'}), dte=result['dte']))
    for candidate, original_candidate in zip(result['candidates'], expected['candidates']):
        assert all(candidate[key] == value for key,value in original_candidate.items())
        assert candidate['monetary_status'] == 'ambiguous_duplicate_strike'
        assert candidate['ev_per_lot_inr'] is None and candidate['credit_per_lot_inr'] is None
    assert result['funnel'] == expected['funnel']


def test_discovery_api_retains_master_key_for_subsequent_expiry_resolution(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.spreads import instruments
    from app.services.spreads.discovery_cache import DiscoveryCache
    from types import SimpleNamespace
    monkeypatch.setenv('SPREADS_DATA_MODE', 'upstox')
    monkeypatch.setenv('INTERNAL_SERVICE_KEY', 'identity-test')
    monkeypatch.setattr(instruments, '_discovered', {})
    monkeypatch.setattr(instruments, '_identity_day', None)
    monkeypatch.setattr(api, 'discovery_cache', DiscoveryCache())
    key = 'NSE_INDEX|Nifty Fin Service'
    master = dict(size=1, as_of=datetime.now(api.IST).date().isoformat(), source='test-upstox-master', items=[dict(symbol='FINNIFTY', instrument_key=key, kind='INDEX', segment='NSE_INDEX')])
    monkeypatch.setattr(api, '_discovery_inputs', lambda *args: (SimpleNamespace(get_universe=lambda: master), object()))
    monkeypatch.setattr(api, 'discover', lambda *args, **kwargs: SimpleNamespace(items=[{'ticker':'FINNIFTY'}], errors=[], capabilities={}))
    seen = []
    class Provider:
        def resolve_underlying(self, symbol):
            return instruments.resolve_underlying(self, symbol)
        def get(self, *args): pytest.fail('Discovery key discarded: attempted EQ search')
        def get_option_contracts(self, instrument_key):
            seen.append(instrument_key)
            return [SimpleNamespace(expiry=datetime.now(api.IST).date()+timedelta(days=30))]
    monkeypatch.setattr(api, '_provider', lambda *args: Provider())
    headers = {'X-Internal-Service-Key':'identity-test', 'X-Spreads-User-Id':'identity-user', 'X-Upstox-Access-Token':'fixture-token'}
    with TestClient(app) as client:
        data = client.post('/spreads/discover', headers=headers).json()
        for _ in range(100):
            if not data['refreshing']: break
            time.sleep(.01)
            data = client.get('/spreads/trending', headers=headers).json()
        assert not data['refreshing'] and data['all'][0]['ticker'] == 'FINNIFTY'
        setup = client.get('/spreads/underlyings/FINNIFTY/expiries', headers=headers)
        assert setup.status_code == 200, setup.text
        assert setup.json()['instrument_key'] == key
    assert seen == [key]


def test_missing_index_identity_recovers_from_master_after_restart(monkeypatch):
    from app.services.spreads import instruments
    monkeypatch.setattr(instruments, '_discovered', {})
    monkeypatch.setattr(instruments, '_identity_day', None)
    row = dict(symbol='NIFTYNXT50', instrument_key='NSE_INDEX|Nifty Next 50', kind='INDEX', segment='NSE_INDEX')
    calls = []
    class EmptyEQSearch:
        def get(self, *args): return []
    def master():
        calls.append(1)
        return {'as_of':datetime.now(api.IST).date().isoformat(), 'items':[row]}
    assert instruments.resolve_underlying(EmptyEQSearch(), 'NIFTYNXT50', universe_loader=master) == row
    assert instruments.resolve_underlying(EmptyEQSearch(), 'NIFTYNXT50', universe_loader=master) == row
    assert len(calls) == 1
