from datetime import date
from dataclasses import asdict, replace
import ast
from pathlib import Path

import pandas as pd
import pytest

from app.services.spreads.provider import OptionContract
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.original_calculations import ScanParams, friction_detail, passes_friction

EXPIRY = date(2026, 11, 23)
CONTRACT = OptionContract('NMDC', 'NSE_EQ|NMDC', EXPIRY, 'NSE_FO|short', 'NMDC CE', 'CE', 75., 6750, .05)

class Transport:
    def __init__(self, quantity=810000, lot=6750):
        self.quantity, self.lot = quantity, lot
        self.calls = []
    def get(self, path, params=None):
        self.calls.append(path)
        if path == '/v2/option/contract':
            return [dict(instrument_key=CONTRACT.instrument_key, trading_symbol=CONTRACT.trading_symbol,
                         instrument_type='CE', strike_price=75, expiry=EXPIRY.isoformat(), lot_size=self.lot)]
        if path == '/v2/option/chain':
            return [dict(strike_price=75, call_options=dict(instrument_key=CONTRACT.instrument_key,
                market_data=dict(bid_price=1.65, ask_price=1.69, oi=self.quantity), option_greeks=dict(iv=30.27)))]
        raise AssertionError(path)

@pytest.mark.parametrize('quantity,expected,passes', [(810000,120,True),(506250,75,False),(0,0,False)])
def test_authoritative_lot_normalizes_before_untouched_scanner_filter(quantity, expected, passes):
    transport = Transport(quantity)
    provider = UpstoxMarketDataProvider(transport=transport)
    provider.get_option_contracts(CONTRACT.underlying_key)
    chain = provider.get_option_chain(CONTRACT.underlying_key, EXPIRY)
    quote = chain.calls[0][1]
    assert quote.open_interest == expected
    assert quote.as_scanner_row()['openInterest'] == expected
    assert friction_detail(pd.Series(quote.as_scanner_row()))['oi'] == expected
    assert passes_friction(friction_detail(pd.Series(quote.as_scanner_row())), ScanParams(min_oi=100)) is passes
    assert asdict(quote)['raw_oi_quantity'] == quantity
    assert quote.oi_lot_size == 6750
    assert chain.open_interest.status == 'verified'
    assert transport.calls.count('/v2/option/contract') == 1

@pytest.mark.parametrize('quantity,lot,reason', [
    (None,6750,'missing_or_invalid_oi_quantity'),(-1,6750,'missing_or_invalid_oi_quantity'),
    (True,6750,'missing_or_invalid_oi_quantity'),(float('nan'),6750,'missing_or_invalid_oi_quantity'),
    (810001,6750,'non_integral_quantity_per_lot'),(810000,None,'missing_or_invalid_contract_lot_size'),
    (810000,0,'missing_or_invalid_contract_lot_size'),(810000,-1,'missing_or_invalid_contract_lot_size'),
    (810000,6750.5,'missing_or_invalid_contract_lot_size')])
def test_invalid_provider_inputs_remain_missing_with_explicit_reason(quantity,lot,reason):
    quote = UpstoxMarketDataProvider(transport=Transport(quantity,lot)).get_option_chain(CONTRACT.underlying_key,EXPIRY).calls[0][1]
    assert quote.open_interest is None
    assert quote.as_scanner_row()['openInterest'] is None
    assert quote.oi_normalization_status == reason

@pytest.mark.parametrize('contract', [replace(CONTRACT,expiry=date(2026,12,1)), replace(CONTRACT,instrument_type='PE'),
                                    replace(CONTRACT,strike=80), replace(CONTRACT,instrument_key='other')])
def test_lot_must_match_identity_expiry_strike_and_option_type(contract):
    provider=UpstoxMarketDataProvider(transport=Transport())
    assert provider._normalize_option_oi(810000,[contract],CONTRACT.instrument_key,EXPIRY,75,'CE')[0] is None

def test_conflicting_lot_sizes_are_not_guessed():
    provider=UpstoxMarketDataProvider(transport=Transport())
    assert provider._normalize_option_oi(810000,[CONTRACT,replace(CONTRACT,lot_size=100)],CONTRACT.instrument_key,EXPIRY,75,'CE')[0] is None

def test_existing_fixture_oi_is_already_contract_count_and_is_not_divided():
    chain = Transport(120).get('/v2/option/chain')
    fixture = FixtureMarketDataProvider({f'chain:{CONTRACT.underlying_key}:{EXPIRY}':chain})
    quote = fixture.get_option_chain(CONTRACT.underlying_key,EXPIRY).calls[0][1]
    assert quote.open_interest == 120
    assert quote.oi_normalization_status == 'fixture_contract_count'

def test_original_zip_scanner_definitions_unchanged():
    from app.services.spreads import original_calculations
    names={'ScanParams','realized_vols','empirical_breach_prob','apply_earnings_penalty','friction_detail','passes_friction','build_spreads'}
    source=(Path(__file__).parent/'fixtures/spreads/original_screener.txt').read_text(encoding='utf-8-sig')
    def definitions(text):
        return {n.name:ast.dump(n,include_attributes=False) for n in ast.parse(text).body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in names}
    # Existing source contains a Windows-encoded dash in a comment; AST ignores comments.
    assert definitions(source) == definitions(Path(original_calculations.__file__).read_text(encoding='utf-8', errors='replace'))
