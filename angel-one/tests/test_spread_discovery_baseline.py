"""Phase 1 discovery baseline: execute untouched ZIP definitions offline."""
import ast
import hashlib
import math
import types
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.services.spreads import engine

FIXTURES = Path(__file__).parent / 'fixtures/spreads'


def load_reference(filename, names, **dependencies):
    source = (FIXTURES / filename).read_text(encoding='utf-8-sig')
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names]
    namespace = dict(math=math, np=np, pd=pd, date=date, timedelta=timedelta,
                     yf=types.SimpleNamespace(Ticker=object), **dependencies)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), f'original-ZIP/{filename}', 'exec'), namespace)
    return namespace


def test_original_source_hashes():
    assert hashlib.sha256((FIXTURES/'original_screener.txt').read_bytes()).hexdigest() == '6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa'
    assert hashlib.sha256((FIXTURES/'original_main.txt').read_bytes()).hexdigest() == 'e11cfa47f7f6638943c8f7f8bc1e281360c2ddd546e304c0591b966c70426a13'


def test_original_us_universe_normalization_and_liquidity_are_provider_rules():
    ref = load_reference('original_main.txt', {'_normalize_symbol', '_quote_is_liquid'})
    assert ref['_normalize_symbol'](' nvda ') == 'NVDA'
    for symbol in ('^NIFTY', 'BANKNIFTY', 'BRK.B', 'ES=F', ''):
        assert ref['_normalize_symbol'](symbol) is None
    quote = {'quoteType':'EQUITY', 'regularMarketPrice':5, 'regularMarketVolume':1_000_000}
    assert ref['_quote_is_liquid'](quote)
    assert not ref['_quote_is_liquid']({**quote,'regularMarketPrice':4.99})
    assert not ref['_quote_is_liquid']({**quote,'regularMarketVolume':999_999})
    assert ref['_quote_is_liquid']({})  # Original best-effort rule accepts missing fields.


@pytest.mark.parametrize('length', [21, 29, 30, 85])
def test_history_stage_gates_and_four_month_request_match_source(length):
    calls = []
    history = pd.DataFrame({'Close':np.linspace(100,120,length), 'Volume':[100.]*(length-1)+[150.]})
    def history_call(**kwargs):
        calls.append(kwargs)
        return history
    ref = load_reference('original_screener.txt', {'edge_discovery'},
        RateLimited=RuntimeError, _yf_call=lambda fn, **kwargs:fn(),
        _atm_iv=lambda *args:float('nan'))
    ref['yf'] = types.SimpleNamespace(Ticker=lambda symbol:types.SimpleNamespace(history=history_call))
    expected = ref['edge_discovery'](['TEST'])
    metrics = engine.edge_discovery_metrics('TEST', history.Close, history.Volume)
    actual = engine.rank_edge_discovery([metrics], {}) if metrics else []
    # B2 deliberately removes the reference's unavailable-VRP reward.
    for row in expected:
        if row['vrp14'] is None: row['score'] -= 1
    assert [{key:value for key,value in row.items() if key not in {'iv_status','vrp_status'}} for row in actual] == expected
    assert calls == [{'period':'4mo','interval':'1d','auto_adjust':True}]


def test_full_universe_iv_coverage_matches_original_zip_methodology():
    histories = {f'S{i}':pd.DataFrame({'Close':[100*math.exp(.01*math.sin(j)) for j in range(85)],
                                    'Volume':[100.]*84+[100.+i*10]}) for i in range(15)}
    iv_calls = []
    def iv(ticker, spot, dte):
        iv_calls.append((ticker.symbol,dte))
        return .3
    ref = load_reference('original_screener.txt', {'edge_discovery'},
        RateLimited=RuntimeError, _yf_call=lambda fn, **kwargs:fn(), _atm_iv=iv)
    ref['yf'] = types.SimpleNamespace(Ticker=lambda symbol:types.SimpleNamespace(symbol=symbol,history=lambda **kwargs:histories[symbol]))
    expected = ref['edge_discovery'](list(histories), iv_shortlist=len(histories))
    metrics = [engine.edge_discovery_metrics(symbol,frame.Close,frame.Volume) for symbol,frame in histories.items()]
    assert set(iv_calls) == {(f'S{i}',14) for i in range(len(histories))}
    actual = engine.rank_edge_discovery(metrics,{symbol:.3 for symbol,_ in iv_calls})
    assert [{key:value for key,value in row.items() if key not in {'iv_status','vrp_status'}} for row in actual] == expected


def test_atm_iv_uses_three_nearest_valid_strikes_per_side():
    rows = pd.DataFrame({'strike':[80.,90.,95.,100.,105.,110.], 'impliedVolatility':[.1,.2,np.nan,.4,.5,0.]})
    ref = load_reference('original_screener.txt', {'_atm_iv'},
        pick_expiration=lambda ticker,dte:('2026-11-12',14),
        safe_option_chain=lambda ticker,expiry:(rows,rows))
    assert ref['_atm_iv'](object(),100) == pytest.approx(.4)


def test_trending_payload_is_top_five_plus_all_and_recursive_json_safe():
    items = [{'ticker':f'S{i}','iv14':float('nan')} for i in range(8)]
    ref = load_reference('original_main.txt', {'_json_safe','_trending_payload'},
        _trending={'updated':123.,'items':items,'refreshing':False}, _universe_state={'source':'dynamic','size':35})
    result = ref['_trending_payload']()
    assert set(result) == {'updated','refreshing','top','all','universe'}
    assert len(result['top']) == 5 and len(result['all']) == 8
    assert result['top'][0]['iv14'] is None
