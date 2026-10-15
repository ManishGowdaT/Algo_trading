from datetime import date
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
import ast
import copy
import math
import numpy as np
import pandas as pd
import pytest
from pydantic import ValidationError
from app.services.spreads import engine, nse_calculations as nse, api, original_calculations as original
from app.services.spreads.provider import OptionContract
from app.services.spreads.scan_audit import replay

EXPIRY=date(2026,11,23)

def contract(strike,side='CE',lot=125,tick=5):
    return OptionContract('TEST','NSE_EQ|TEST',EXPIRY,f'{side}|{strike}',f'TEST {strike} {side}',side,strike,lot,tick)

def row(strike,side='CE',bid=2,ask=2.05,oi=150,iv=.3):
    return dict(strike=float(strike),instrument_key=f'{side}|{strike}',bid=bid,ask=ask,openInterest=oi,impliedVolatility=iv)

@pytest.mark.parametrize('grid,short,expected', [([90,95,100,105,110],100,105),([90,100,110,130],100,110),([900,950,1000,1050],1000,1050)])
def test_actual_listed_strike_ladders_no_fixed_five_assumption(grid,short,expected):
    contracts=[contract(k) for k in grid]; frame=pd.DataFrame([row(k) for k in grid]);issues=[]
    long,meta=nse.pair_resolver(contracts,EXPIRY,1,'paise',issues)(1,frame[frame.strike==short].iloc[0],frame)
    assert long.strike==expected and meta['strike_interval']==expected-short
    assert not issues

def test_nonuniform_steps_do_not_skip_an_unquoted_listed_hedge():
    contracts=[contract(k) for k in [100,105,110,130]];frame=pd.DataFrame([row(k) for k in [100,110,130]]); issues=[]
    assert nse.pair_resolver(contracts,EXPIRY,1,'paise',issues)(1,frame.iloc[0],frame) is None
    assert issues[0]['long_strike']==105
    long,_=nse.pair_resolver(contracts,EXPIRY,2,'paise',[])(1,frame.iloc[0],frame)
    assert long.strike==110

def test_bull_put_hedge_is_next_lower_actual_listed_strike():
    grid=[90,95,100];frame=pd.DataFrame([row(k,'PE') for k in grid])
    long,_=nse.pair_resolver([contract(k,'PE') for k in grid],EXPIRY,1,'paise',[])(-1,frame.iloc[-1],frame)
    assert long.strike==95

@pytest.mark.parametrize('a,b,expected',[(1,1,.005),(5,5,.025),(1,5,.005)])
def test_verified_paise_ticks_and_positive_midpoint_credit_quantum(a,b,expected):
    assert float(nse.midpoint_quantum(nse.contract_tick_inr(contract(100,tick=a),'paise'), nse.contract_tick_inr(contract(105,tick=b),'paise')))==expected
    assert float(nse.contract_tick_inr(contract(100,tick=.05),'rupees'))==.05

@pytest.mark.parametrize('bad', [None,0,-1,float('nan')])
def test_missing_tick_never_guessed(bad):
    frame=pd.DataFrame([row(100),row(105)]);issues=[]
    assert nse.pair_resolver([contract(100,tick=bad),contract(105)],EXPIRY,1,'paise',issues)(1,frame.iloc[0],frame) is None
    assert issues[0]['reason']=='missing_or_invalid_contract_tick'

def test_mixed_lots_or_offgrid_quotes_are_explicit():
    frame=pd.DataFrame([row(100),row(105)]);issues=[]
    assert nse.pair_resolver([contract(100,lot=125),contract(105,lot=250)],EXPIRY,1,'paise',issues)(1,frame.iloc[0],frame) is None
    assert issues[0]['reason']=='incompatible_leg_lot_sizes'
    frame['bid']=frame['bid'].astype(float)
    frame.loc[0,'bid']=2.01;issues=[]
    _,meta=nse.pair_resolver([contract(100),contract(105)],EXPIRY,1,'paise',issues)(1,frame.iloc[0],frame)
    assert not meta['quote_ticks_valid']  # build gate records the first rejection exactly once

def test_no_mathematical_formula_assignments_changed():
    def assignments(module):
        tree=ast.parse(Path(module.__file__).read_text(encoding='utf-8',errors='replace'))
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='build_spreads')
        keys={'cushion','credit','width','max_loss','ror_pct','iv','vrp','p_raw','p_adj','ev'}
        return {n.targets[0].id:ast.dump(n.value,include_attributes=False) for n in ast.walk(function)
                if isinstance(n,ast.Assign) and len(n.targets)==1 and isinstance(n.targets[0],ast.Name) and n.targets[0].id in keys}
    assert assignments(original)==assignments(nse)

@pytest.mark.parametrize('seed',range(10))
def test_native_uniform_ladder_matches_zip_when_width_and_credit_gates_agree(seed):
    closes=100*np.exp(np.cumsum(np.random.default_rng(seed).normal(0,.002,400)))
    spot=float(closes[-1]); grid=list(range(80,125)); contracts=[contract(k,s) for s in ['PE','CE'] for k in grid]
    rows={s:[row(k,s,bid=4+.3*(k-80) if s=='PE' else 20-.3*(k-80),ask=4.05+.3*(k-80) if s=='PE' else 20.05-.3*(k-80)) for k in grid] for s in ['PE','CE']}
    puts,calls=[engine.clean_option_rows(rows[s]) for s in ['PE','CE']]
    p=engine.ScanParams(width=1);rv=engine.realized_vols(closes)
    expected,ef=engine.build_spreads('TEST',spot,puts,calls,str(EXPIRY),30,closes,rv,False,0,p)
    actual,af=nse.build_spreads('TEST',spot,pd.DataFrame(puts),pd.DataFrame(calls),str(EXPIRY),30,pd.Series(closes),rv,False,0,p,nse.pair_resolver(contracts,EXPIRY,1,'paise',[]))
    assert actual and expected
    assert af==ef
    assert [{k:c[k] for k in e} for c,e in zip(actual,expected)]==expected
    assert len(actual)==len(expected)

def test_explicit_profiles_default_baseline_and_validate_inputs():
    assert api.NiftyScanRequest().strategy_profile=='ORIGINAL_ZIP_BASELINE'
    for payload in [{'strategy_profile':'unknown'},{'width_steps':0},{'width_steps':1.5}]:
        with pytest.raises(ValidationError):api.NiftyScanRequest(**payload)

def test_fixture_api_native_preserves_lots_money_profiles_and_history_warning(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE','fixtures')
    result=api._scan_underlying('NIFTY',api.NiftyScanRequest(strategy_profile='NSE_RESEARCH_V1'),None,'')
    assert result['ok'] and result['strategy_profile']=='NSE_RESEARCH_V1'
    assert result['width_mode']=='listed_strike_steps'
    assert result['candidates'], 'money checks must exercise actual fixture candidates'
    for c in result['candidates']:
        assert c['width']>0 and c['lot_size']>0
        assert c['credit_per_lot_inr']==round(c['credit_points_unrounded']*c['lot_size'],2)
        assert c['max_loss_per_lot_inr']==round((c['width']-c['credit_points_unrounded'])*c['lot_size'],2)
    assert any('adjusted-history' in x for x in result['data_warnings'])


def test_native_credit_gate_uses_half_tick_quantum_and_keeps_negative_ev():
    # Synthetic boundary test only, not a claim about current NSE listed strike spacing.
    contracts=[contract(100,tick=1),contract(100.02,tick=1)]
    calls=[row(100,bid=.03,ask=.03),row(100.02,bid=.02,ask=.03)]
    close=pd.Series(99*np.exp(.001*np.arange(400)),dtype=float)
    p=engine.ScanParams(width=.02,min_cushion=0,max_spread_pct=.5)
    rv={'rv21':.1}
    native,funnel=nse.build_spreads('TEST',99,pd.DataFrame(),pd.DataFrame(calls),str(EXPIRY),30,close,rv,False,0,p,nse.pair_resolver(contracts,EXPIRY,1,'paise',[]))
    baseline,bf=engine.build_spreads('TEST',99,[],calls,str(EXPIRY),30,close,rv,False,0,p)
    assert len(native)==1 and not baseline
    assert native[0]['minimum_credit_points']==.005
    assert native[0]['credit_points_unrounded']==pytest.approx(.005)
    # Negative EV is not excluded by either profile: verify original probability math with a loss-heavy history.
    expected=(native[0]['credit_points_unrounded']*(1-native[0]['p_adj'])-(native[0]['width']-native[0]['credit_points_unrounded'])*native[0]['p_adj'])*100
    assert native[0]['ev']==round(expected,0)
    assert native[0]['ev'] < 0
