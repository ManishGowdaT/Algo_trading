import gzip
import json
from datetime import date, datetime

import httpx
import pytest

from app.services.spreads.universe import build_universe, UpstoxUniverseProvider, FixtureUniverseProvider, NSE_INSTRUMENTS_URL, IST
from app.services.spreads.transport import UpstoxProviderError

TODAY = date(2026, 10, 12)


def test_fixture_provider_is_explicit_and_has_stock_and_index_identities():
    provider = FixtureUniverseProvider([option(),option('NIFTY','NSE_INDEX|Nifty 50','INDEX')])
    result = provider.get_universe(as_of=TODAY)
    assert result['source'] == 'fixture_nse_bod'
    assert result['size'] == 2
    assert 'Synthetic' in result['note']


def option(symbol='RELIANCE', key='NSE_EQ|INE002A01018', kind='EQUITY', **overrides):
    return {'segment':'NSE_FO','instrument_type':'CE','instrument_key':f'NSE_FO|{symbol}-1',
            'underlying_symbol':symbol,'underlying_key':key,'underlying_type':kind,
            'expiry':'2026-10-29','lot_size':250, **overrides}


def test_active_indices_stocks_dedup_and_expiry_filtering():
    rows = [option(), option(), option(instrument_key='NSE_FO|2',instrument_type='PE'),
            option('NIFTY','NSE_INDEX|Nifty 50','INDEX'),
            option('BANKNIFTY','NSE_INDEX|Nifty Bank','INDEX'),
            option('EXPIRED',expiry='2026-10-11'), option('FUTURE',instrument_type='FUT'),
            option('OTHER',segment='BSE_FO'), option('BAD',lot_size=0)]
    result = build_universe(rows,as_of=TODAY)
    assert [item['symbol'] for item in result['items']] == ['BANKNIFTY','NIFTY','RELIANCE']
    assert result['size'] == 3
    assert result['items'][-1]['contract_count'] == 2
    assert result['items'][-1]['instrument_key'] == 'NSE_EQ|INE002A01018'


def test_epoch_milliseconds_expiry_and_expiry_day_are_included():
    epoch = int(datetime(2026,10,12,23,59,tzinfo=IST).timestamp()*1000)
    assert build_universe([option(expiry=epoch)],as_of=TODAY)['size'] == 1
    assert build_universe([option(expiry='bad')],as_of=TODAY)['size'] == 0


@pytest.mark.parametrize('lot', [True, 1.5, float('nan'), float('inf'), -1, 0])
def test_invalid_lot_size_is_never_truncated_or_assumed(lot):
    result = build_universe([option(lot_size=lot)], as_of=TODAY)
    assert result['size'] == 0
    assert result['rejected_contracts'] == 1


def test_ambiguous_symbols_are_excluded_instead_of_picking_arbitrary_key():
    rows = [option(),option(key='NSE_EQ|OTHER',instrument_key='NSE_FO|other')]
    result = build_universe(rows,as_of=TODAY)
    assert result['items'] == [] and result['ambiguous_symbols'] == ['RELIANCE']


def test_public_master_download_uses_fixed_url_without_tokens():
    captured = []
    def handle(request):
        captured.append(request)
        return httpx.Response(200,content=gzip.compress(json.dumps([option()]).encode()))
    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        assert UpstoxUniverseProvider(client=client).get_universe(as_of=TODAY)['size'] == 1
    assert str(captured[0].url) == NSE_INSTRUMENTS_URL
    assert 'authorization' not in captured[0].headers


@pytest.mark.parametrize('status,payload',[(302,b''),(500,b''),(200,b'not-gzip')])
def test_no_redirects_or_fabricated_fallback_on_master_failure(status,payload):
    with httpx.Client(transport=httpx.MockTransport(lambda request:httpx.Response(status,content=payload))) as client:
        with pytest.raises(UpstoxProviderError):
            UpstoxUniverseProvider(client=client).get_universe(as_of=TODAY)
