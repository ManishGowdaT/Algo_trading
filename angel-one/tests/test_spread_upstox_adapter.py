from datetime import date

import pytest

from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
from app.services.spreads.transport import UpstoxProviderError


class StubTransport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, path, params=None):
        self.calls.append((path, params))
        response_key = (path, tuple(sorted((params or {}).items())))
        if response_key in self.responses:
            value = self.responses[response_key]
        elif path in self.responses:
            value = self.responses[path]
        elif path.startswith("/v3/historical-candle/") and "/v3/historical-candle/" in self.responses:
            value = self.responses["/v3/historical-candle/"]
        else:
            raise KeyError(path)
        if isinstance(value, Exception):
            raise value
        return value


def test_index_identity_and_exact_equity_lookup():
    transport = StubTransport({
        "/v2/instruments/search": [{
            "segment": "NSE_EQ", "trading_symbol": "RELIANCE", "instrument_key": "NSE_EQ|INE002A01018",
            "name": "Reliance Industries", "isin": "INE002A01018",
        }]
    })
    provider = UpstoxMarketDataProvider(transport=transport)
    assert provider.resolve_underlying("NIFTY")["instrument_key"] == "NSE_INDEX|Nifty 50"
    assert provider.resolve_underlying("reliance")["instrument_key"] == "NSE_EQ|INE002A01018"
    assert transport.calls[0][1]["segments"] == "EQ"


def test_history_is_chronological_and_marks_adjustment_semantics_unverified():
    transport = StubTransport({
        "/v3/historical-candle/": {
            "candles": [
                ["2026-10-12T00:00:00+05:30", 102, 105, 101, 104, 900, 10],
                ["2026-10-09T00:00:00+05:30", 99, 103, 98, 102, 800, 9],
            ]
        }
    })
    result = UpstoxMarketDataProvider(transport=transport).get_history("NSE_EQ|RELIANCE", 3)
    assert [bar.close for bar in result.bars] == [102, 104]
    assert result.bars[0].open_interest == 9
    assert result.adjustment.status == "unverified"
    assert result.scanner_history_eligible is False


def test_option_chain_normalizes_iv_but_preserves_unverified_oi():
    expiry = date(2026, 10, 29)
    transport = StubTransport({"/v2/option/chain": [{
        "strike_price": 25000, "underlying_spot_price": 25100,
        "put_options": {"instrument_key": "NSE_FO|put", "market_data": {
            "bid_price": 100, "ask_price": 102, "oi": 123456, "bid_qty": 10,
            "ask_qty": 11, "volume": 55,
        }, "option_greeks": {"iv": 50.78}},
        "call_options": {"instrument_key": "NSE_FO|call", "market_data": {
            "bid_price": 110, "ask_price": 112, "oi": 654321,
        }, "option_greeks": {"iv": 40.0}},
    }]})
    chain = UpstoxMarketDataProvider(transport=transport).get_option_chain("NSE_INDEX|Nifty 50", expiry)
    assert chain.spot == 25100
    assert chain.puts[0][1].implied_volatility == pytest.approx(0.5078)
    assert chain.puts[0][1].open_interest == 123456
    assert chain.open_interest.status == "unverified"
    assert chain.quote_timestamp.status == "unavailable"
    assert transport.calls[0][1] == {"instrument_key": "NSE_INDEX|Nifty 50", "expiry_date": "2026-10-29"}


def test_contract_parser_preserves_nse_lot_size_expiry_and_strike():
    transport = StubTransport({"/v2/option/contract": [{
        "underlying_symbol": "NIFTY", "expiry": "2026-10-29", "instrument_key": "NSE_FO|contract",
        "trading_symbol": "NIFTY26OCT25000PE", "instrument_type": "PE", "strike_price": 25000,
        "lot_size": 65, "tick_size": 0.05,
    }]})
    contracts = UpstoxMarketDataProvider(transport=transport).get_option_contracts("NSE_INDEX|Nifty 50")
    assert contracts[0].expiry == date(2026, 10, 29)
    assert contracts[0].lot_size == 65
    assert contracts[0].strike == 25000


def test_earnings_data_is_explicitly_unavailable():
    data = UpstoxMarketDataProvider(transport=StubTransport({})).get_earnings_info("NSE_EQ|x", date(2026, 10, 29))
    assert data.earnings_inside is None
    assert data.max_historical_gap_pct is None
    assert data.capability.status == "unavailable"


def test_fixture_provider_uses_same_normalization_without_network():
    fixture_provider = FixtureMarketDataProvider({
        "chain:NSE_INDEX|Nifty 50:2026-10-29": [{
            "strike_price": 25000, "underlying_spot_price": 25100,
            "put_options": {"instrument_key": "NSE_FO|put", "market_data": {"oi": 20},
                            "option_greeks": {"iv": 25}},
        }]
    })
    chain = fixture_provider.get_option_chain("NSE_INDEX|Nifty 50", date(2026, 10, 29))
    assert chain.puts[0][1].implied_volatility == pytest.approx(0.25)


def test_malformed_option_contract_response_fails_clearly():
    provider = UpstoxMarketDataProvider(transport=StubTransport({"/v2/option/contract": {"unexpected": []}}))
    with pytest.raises(UpstoxProviderError, match="invalid option-contract"):
        provider.get_option_contracts("NSE_INDEX|Nifty 50")
