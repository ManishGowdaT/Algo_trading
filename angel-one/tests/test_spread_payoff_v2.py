from dataclasses import replace
import math
import pytest
from fastapi import HTTPException
from app.services.spreads import api, payoff_research as v2
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.nifty_fixtures import spread_fixture_payloads
from app.services.spreads.provider import EarningsData, DataCapability


@pytest.mark.parametrize('is_call,short,long,terminals,expected', [
    (True, 100, 110, [99, 101, 105, 110, 115], [2, 1, -3, -8, -8]),
    (False, 100, 90, [101, 99, 95, 90, 85], [2, 1, -3, -8, -8]),
])
def test_actual_vertical_payoffs_between_strikes_and_at_caps(is_call, short, long, terminals, expected):
    # One-session return scenarios calculated by hand; no production oracle.
    for terminal, payoff in zip(terminals, expected):
        assert v2.scenario_payoffs([100, terminal], 1, 100, short, long, 2, is_call) == [payoff]


@pytest.mark.parametrize('spot', [0, -1, float('nan'), float('inf')])
def test_payoff_rejects_invalid_spot(spot):
    with pytest.raises(ValueError, match='spot'):
        v2.scenario_payoffs([100, 101], 1, spot, 100, 110, 2, True)


def test_projected_return_uses_chain_spot_not_historical_price_level():
    assert v2.scenario_payoffs([200, 202], 1, 100, 100, 110, 2, True) == [1]


@pytest.mark.parametrize('spot', [None, 0, -1, float('nan'), float('inf'), True])
def test_api_v2_never_falls_back_to_historical_close(monkeypatch, spot):
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    provider = FixtureMarketDataProvider(spread_fixture_payloads())
    get_chain = provider.get_option_chain
    provider.get_option_chain = lambda *args: replace(get_chain(*args), spot=spot)
    monkeypatch.setattr(api, '_provider', lambda *args: provider)
    with pytest.raises(HTTPException) as failure:
        api._scan_underlying('NIFTY', api.NiftyScanRequest(strategy_profile=v2.PROFILE), None, '')
    assert failure.value.status_code == 422


def test_api_chain_reference_and_independent_lot_payoffs(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    provider = FixtureMarketDataProvider(spread_fixture_payloads())
    get_chain = provider.get_option_chain
    provider.get_option_chain = lambda *args: replace(get_chain(*args), spot=25500)
    monkeypatch.setattr(api, '_provider', lambda *args: provider)
    result = api._scan_underlying('NIFTY', api.NiftyScanRequest(strategy_profile=v2.PROFILE), None, '')
    assert result['ok'] and result['candidates']
    assert result['meta']['spot'] == 25500
    assert result['observation_policy']['mode'] == 'chain_spot_reference'
    closes = [bar.close for bar in provider.get_history(result['instrument_key']).bars]
    n = round(result['dte'] * 252 / 365)
    for c in result['candidates']:
        short, long = c['short_strike'], c['long_strike']
        assert short < 25500 if c['type'] == 'BULL PUT' else short > 25500
        assert c['cushion_pct'] == round(abs(short - 25500) / 25500 * 100, 2)
        credit = c['leg_inputs']['short']['midpoint'] - c['leg_inputs']['long']['midpoint']
        projected = [25500 * closes[i+n] / closes[i] for i in range(len(closes)-n)]
        # Independent clamped width payoff, not the two-leg production implementation.
        losses = [min(max(short-s if c['type']=='BULL PUT' else s-short, 0), abs(long-short)) for s in projected]
        mean = credit - math.fsum(losses) / len(losses)
        assert c['ev'] == round(mean * 100)
        assert c['ev_per_lot_inr'] == round(mean * c['lot_size'], 2)
        assert c['p_raw'] == c['p_adj']
        assert c['probability_sample_count'] == len(losses)
    baseline = api._scan_underlying('NIFTY', api.NiftyScanRequest(strategy_profile='NSE_RESEARCH_V1'), None, '')
    assert baseline['observation_policy']['mode'] == 'historical_close_reference'
    assert baseline['meta']['spot'] != 25500


def test_earnings_flag_does_not_apply_an_arbitrary_v2_probability_penalty(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    provider = FixtureMarketDataProvider(spread_fixture_payloads())
    monkeypatch.setattr(api, '_provider', lambda *args: provider)
    request = api.NiftyScanRequest(strategy_profile=v2.PROFILE)
    no_event = api._scan_underlying('NIFTY', request, None, '')
    provider.get_earnings_info = lambda *args: EarningsData(True, True, 50, DataCapability(True, 'test', 'Synthetic large event'))
    event = api._scan_underlying('NIFTY', request, None, '')
    assert event['candidates']
    assert [c['ev'] for c in event['candidates']] == [c['ev'] for c in no_event['candidates']]
    assert all(c['earnings'] and c['p_raw'] == c['p_adj'] for c in event['candidates'])
    assert event['research_model']['earnings_treatment'] == 'unconditional_history_no_probability_uplift'


def test_v2_http_json_contract(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    monkeypatch.setenv('SPREADS_DATA_MODE', 'fixtures')
    monkeypatch.setenv('INTERNAL_SERVICE_KEY', 'v2-test-key')
    app = FastAPI()
    app.include_router(api.router)
    response = TestClient(app).post('/spreads/scan', json={'underlyings': ['NIFTY'], 'strategy_profile': v2.PROFILE},
        headers={'X-Internal-Service-Key': 'v2-test-key'})
    assert response.status_code == 200
    data = response.json()
    assert data['strategy_profile'] == v2.PROFILE and data['candidates']
    assert 'before costs' in data['ranking_note']
    assert all(c['payoff_model'] == 'historical_vertical_expiry_payoff' for c in data['candidates'])
