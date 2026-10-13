from datetime import date
import math
import pytest
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
from app.services.spreads.transport import UpstoxProviderError, _is_read_only_market_data_path
from app.services.spreads.engine import atm_iv


class Transport:
    def __init__(self, greeks, chain=None):
        self.greeks, self.chain, self.calls = greeks, chain, []
    def get(self, path, params=None):
        self.calls.append((path, params))
        if path == '/v2/option/chain':
            return self.chain
        if path == '/v2/option/contract':
            return [{'instrument_key': 'NSE_FO|'+key, 'trading_symbol':key, 'instrument_type':side,
                     'expiry':'2026-10-27', 'strike_price':100, 'lot_size':10}
                    for key,side in [('put','PE'),('call','CE')]]
        assert path == '/v3/market-quote/option-greek' 
        if isinstance(self.greeks, Exception):
            raise self.greeks
        return self.greeks(params) if callable(self.greeks) else self.greeks


def option(key, iv):
    return {'instrument_key': key, 'option_greeks': {'iv': iv},
            'market_data': {'bid_price': 3, 'ask_price': 4, 'oi': 1500}}


def test_live_proven_decimal_scale_and_instrument_token_mapping():
    transport = Transport({'not-the-instrument-key': {'instrument_token': 'NSE_FO|103346', 'iv': .31494140625}})
    provider = UpstoxMarketDataProvider(transport=transport)
    assert provider.get_option_greeks(['NSE_FO|103346']) == {'NSE_FO|103346': .31494140625}
    assert .31494140625 == pytest.approx(31.49 / 100, abs=.00005)


@pytest.mark.parametrize('iv', [None, 0, -1, 'bad', True, float('nan'), float('inf')])
def test_invalid_iv_is_not_fabricated(iv):
    provider = UpstoxMarketDataProvider(transport=Transport({'x': {'instrument_token': 'NSE_FO|1', 'iv': iv}}))
    assert provider.get_option_greeks(['NSE_FO|1']) == {}


def test_partial_response_ignores_unrequested_keys_and_keeps_decimal_values():
    provider = UpstoxMarketDataProvider(transport=Transport({'x': {'instrument_token': 'NSE_FO|1', 'iv': .2},
        'y': {'instrument_token': 'NSE_FO|999', 'iv': .9}}))
    assert provider.get_option_greeks(['NSE_FO|1', 'NSE_FO|2']) == {'NSE_FO|1': .2}


def test_50_key_batching_and_deduplication():
    transport = Transport(lambda params: {key: {'instrument_token': key, 'iv': .2} for key in params['instrument_key'].split(',')})
    keys = [f'NSE_FO|{i}' for i in range(101)]
    assert len(UpstoxMarketDataProvider(transport=transport).get_option_greeks(keys + keys)) == 101
    assert [len(params['instrument_key'].split(',')) for _, params in transport.calls] == [50, 50, 1]


def test_api_failure_retains_unavailable():
    provider = UpstoxMarketDataProvider(transport=Transport(UpstoxProviderError('Unavailable', status_code=503)))
    assert provider.get_option_greeks(['NSE_FO|1']) == {}


def test_preferred_chain_iv_side_strike_expiry_oi_and_original_atm_median():
    expiry = date(2026, 10, 27)
    transport = Transport({'a': {'instrument_token': 'NSE_FO|put', 'iv': .4},
                           'b': {'instrument_token': 'NSE_FO|call', 'iv': .9}},
        [{'strike_price': 100, 'underlying_spot_price': 100,
          'put_options': option('NSE_FO|put', None), 'call_options': option('NSE_FO|call', 20)}])
    chain = UpstoxMarketDataProvider(transport=transport).get_option_chain('NSE_EQ|TEST', expiry)
    assert chain.expiry == expiry and chain.underlying_key == 'NSE_EQ|TEST'
    assert chain.puts[0][0] == chain.calls[0][0] == 100
    assert chain.puts[0][1].instrument_key == 'NSE_FO|put'
    assert chain.puts[0][1].implied_volatility == .4
    assert chain.calls[0][1].implied_volatility == .2
    assert chain.puts[0][1].open_interest == 150
    assert transport.calls[-1][1]['instrument_key'] == 'NSE_FO|put'
    assert atm_iv(chain, 100) == pytest.approx(.3)
    assert atm_iv(chain, 100) / .15 == pytest.approx(2)


def test_valid_chain_iv_does_not_call_v3():
    transport = Transport(AssertionError('must not call'), [{'strike_price': 100,
        'put_options': option('NSE_FO|put', 25)}])
    chain = UpstoxMarketDataProvider(transport=transport).get_option_chain('NSE_EQ|TEST', date(2026, 10, 27))
    assert chain.puts[0][1].implied_volatility == .25
    assert len(transport.calls) == 2


def test_both_sources_missing_remain_unavailable():
    transport = Transport({}, [{'strike_price': 100, 'put_options': option('NSE_FO|put', None)}])
    chain = UpstoxMarketDataProvider(transport=transport).get_option_chain('NSE_EQ|TEST', date(2026, 10, 27))
    assert math.isnan(atm_iv(chain, 100))
    assert _is_read_only_market_data_path('/v3/market-quote/option-greek')
    assert not _is_read_only_market_data_path('/v3/order/place')
