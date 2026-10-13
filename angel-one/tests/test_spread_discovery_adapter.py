from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from app.services.spreads.discovery_adapter import DiscoveryDataAdapter, FixtureDiscoveryDataAdapter, four_month_start
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.nifty_fixtures import spread_fixture_payloads
from app.services.spreads.engine import edge_discovery_metrics, atm_iv
from app.services.spreads.transport import UpstoxProviderError

TODAY = date(2026,10,12)


class Transport:
    def __init__(self, payload): self.payload, self.calls = payload, []
    def get(self, path): self.calls.append(path); return self.payload


def candles(count=40, volume=100):
    return [[f'{(TODAY-timedelta(days=i)).isoformat()}T00:00:00+05:30', 100,110,90,100+i,volume] for i in range(count)]


def test_four_calendar_months_and_leap_month_end():
    assert four_month_start(TODAY) == date(2026,6,12)
    assert four_month_start(date(2024,6,30)) == date(2024,2,29)
    assert four_month_start(date(2026,1,31)) == date(2025,9,30)


def test_exact_discovery_range_daily_request_chronology_and_no_scan_gate():
    transport = Transport({'candles':candles() + [['2026-01-01T00:00:00+05:30',1,1,1,1,1]]})
    adapter = DiscoveryDataAdapter(SimpleNamespace(),transport=transport)
    result = adapter.get_history('NSE_EQ|TEST',as_of=TODAY)
    assert transport.calls == ['/v3/historical-candle/NSE_EQ%7CTEST/days/1/2026-10-12/2026-06-12']
    assert len(result.bars) == 40 and result.closes == list(range(139,99,-1))
    assert result.eligibility_error is None
    assert result.adjustment.status == 'unverified'
    assert edge_discovery_metrics('TEST',result.closes,result.volumes) is not None


def test_missing_volume_is_not_invented_and_zero_is_not_missing():
    for volume, eligible in [(None,False),(0,True)]:
        result = DiscoveryDataAdapter(SimpleNamespace(),transport=Transport({'candles':candles(volume=volume)})).get_history('NSE_INDEX|Nifty 50',as_of=TODAY)
        assert (result.eligibility_error is None) == eligible
        assert result.volumes == [volume]*40
        if eligible:
            assert edge_discovery_metrics('NIFTY',result.closes,result.volumes)['shock'] == 0


def test_original_history_and_independent_missing_close_gates():
    rows = candles(29)
    result = DiscoveryDataAdapter(SimpleNamespace(),transport=Transport({'candles':rows})).get_history('NSE_EQ|TEST',as_of=TODAY)
    assert '30' in result.eligibility_error
    rows = candles(40)
    for row in rows[:19]: row[4] = None
    result = DiscoveryDataAdapter(SimpleNamespace(),transport=Transport({'candles':rows})).get_history('NSE_EQ|TEST',as_of=TODAY)
    assert '22 non-missing daily closes' in result.eligibility_error


def test_atm_expiry_nearest_14_excludes_under_three_and_normalizes_tie_order():
    calls = []
    provider = SimpleNamespace(get_option_contracts=lambda key:[SimpleNamespace(expiry=TODAY+timedelta(days=d)) for d in [2,16,12,16]],
                               get_option_chain=lambda key,expiry:calls.append((key,expiry)) or 'chain')
    assert DiscoveryDataAdapter(provider,transport=object()).get_atm_chain('NSE_EQ|TEST',as_of=TODAY) == 'chain'
    assert calls == [('NSE_EQ|TEST',TODAY+timedelta(days=12))]
    provider.get_option_contracts = lambda key:[]
    assert DiscoveryDataAdapter(provider,transport=object()).get_atm_chain('NSE_EQ|TEST',as_of=TODAY) is None


def test_fixture_history_chain_iv_units_and_no_earnings_dependency():
    provider = FixtureMarketDataProvider(spread_fixture_payloads(today=TODAY))
    adapter = FixtureDiscoveryDataAdapter(provider)
    history = adapter.get_history('NSE_INDEX|Nifty 50',as_of=TODAY)
    assert 30 <= len(history.bars) < 270 and history.adjustment.status == 'fixture'
    chain = adapter.get_atm_chain('NSE_INDEX|Nifty 50',as_of=TODAY)
    assert chain and atm_iv(chain,history.closes[-1]) == pytest.approx(.25)
    # Stock discovery requires no earnings/calendar call.
    provider.get_earnings_info = lambda *args:pytest.fail('Discovery must not request earnings')
    assert adapter.get_history('NSE_EQ|INE002A01018',as_of=TODAY).eligibility_error is None


def test_malformed_history_returns_actionable_provider_error():
    with pytest.raises(UpstoxProviderError,match='discovery history'):
        DiscoveryDataAdapter(SimpleNamespace(),transport=Transport({})).get_history('NSE_EQ|TEST',as_of=TODAY)
