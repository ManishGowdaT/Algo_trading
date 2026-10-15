from datetime import date, datetime
from zoneinfo import ZoneInfo
from dataclasses import replace
import pytest
from app.services.spreads import engine, api
from app.services.spreads.history_validation import validate_history, SessionCalendar
from app.services.spreads.provider import PriceBar
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.nifty_fixtures import spread_fixture_payloads
from app.services.spreads import nse_calculations as nse
from app.services.spreads.provider import OptionContract
import pandas as pd


def test_expiry_ties_are_independent_of_input_order():
    assert engine.pick_expiration(['2026-11-20', '2026-11-10'], 30, as_of=date(2026,10,16)) == ('2026-11-10',25)


@pytest.mark.parametrize('field', ['strike', 'bid', 'ask'])
@pytest.mark.parametrize('value', [float('inf'), float('-inf')])
def test_nonfinite_quote_fields_cannot_enter_scanner(field, value):
    row = dict(strike=100, bid=2, ask=3, openInterest=100, impliedVolatility=.3)
    row[field] = value
    assert engine.clean_option_rows([row]) == []


def test_current_day_requires_finality_and_preserves_raw_bar():
    day = date(2026,10,15)
    bars = [PriceBar(datetime(2026,10,15,tzinfo=ZoneInfo('Asia/Kolkata')),10,12,9,11,100)]
    kwargs = dict(start=day,end=day,raw_count=1,skipped_count=0,observation_date=day)
    capability, report = validate_history(bars, **kwargs)
    assert capability.status == 'incomplete'
    assert report['unconfirmed_session_dates'] == ['2026-10-15']
    assert len(bars) == 1 and bars[0].close == 11
    calendar = SessionCalendar(day,day,frozenset([day]),'test completed-session source')
    assert validate_history(bars,calendar=calendar,**kwargs)[0].status == 'verified'


def test_fixture_scan_exposes_inputs_and_reconciles_rejections(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE','fixtures')
    result = api._scan_underlying('NIFTY',api.NiftyScanRequest(strategy_profile='NSE_RESEARCH_V1'),None,'')
    assert result['ok']
    assert result['candidates']
    assert result['freshness']['quote_time_status'] == 'UNKNOWN'
    assert result['costs']['estimated_cost_inr'] is None
    assert 'cash settled' in result['settlement_note']
    assert result['observation_policy']['reference_date']
    assert result['funnel']['considered'] == result['funnel']['final'] + len(result['nse_market_structure_issues'])
    for row in result['candidates']:
        assert row['probability_sample_count'] >= 60
        inputs = row['leg_inputs']
        credit = inputs['short']['midpoint'] - inputs['long']['midpoint']
        assert row['credit_per_lot_inr'] == round(credit * row['lot_size'],2)


def test_missing_lot_does_not_crash_baseline_scan(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE','fixtures')
    provider = FixtureMarketDataProvider(spread_fixture_payloads())
    original = provider.get_option_contracts
    provider.get_option_contracts = lambda key: tuple(replace(c,lot_size=None) for c in original(key))
    monkeypatch.setattr(api,'_provider',lambda *args:provider)
    result = api._scan_underlying('NIFTY',api.NiftyScanRequest(width=50),None,'')
    assert result['ok'] and result['candidates']
    assert all(row['credit_per_lot_inr'] is None for row in result['candidates'])


@pytest.mark.parametrize('steps', [1, 2, 3])
@pytest.mark.parametrize('side,sign', [('PE', -1), ('CE', 1)])
def test_one_two_three_steps_on_nonuniform_grid(side, sign, steps):
    expiry = date(2026,11,20)
    grid = [80, 90, 100, 105, 115, 130, 150]
    contracts = [OptionContract('TEST','NSE_EQ|TEST',expiry,f'{side}|{strike}',
                               f'TEST {strike}',side,strike,100,5) for strike in grid]
    frame = pd.DataFrame([dict(strike=strike,instrument_key=f'{side}|{strike}',bid=2,ask=2.05) for strike in grid])
    long, metadata = nse.pair_resolver(contracts,expiry,steps,'paise',[])(sign,frame.iloc[3],frame)
    assert long.strike == grid[3 + sign * steps]
    assert metadata['width_steps'] == steps
