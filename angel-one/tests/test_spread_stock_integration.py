from dataclasses import replace
from datetime import datetime

from fastapi.testclient import TestClient

from app.main import app
from app.services.spreads import api
from app.services.spreads.discovery_adapter import FixtureDiscoveryDataAdapter
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.nifty_fixtures import spread_fixture_payloads
from app.services.spreads.provider import EarningsData, DataCapability
from app.services.spreads.discovery import discover


def setup(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE','fixtures')
    monkeypatch.setenv('INTERNAL_SERVICE_KEY','stock-test-key')
    return FixtureMarketDataProvider(spread_fixture_payloads())


def test_discovered_stock_resolves_expiry_and_uses_stock_lots(monkeypatch):
    provider = setup(monkeypatch)
    result = discover([{'symbol':'RELIANCE','instrument_key':'NSE_EQ|INE002A01018'}],FixtureDiscoveryDataAdapter(provider))
    assert result.items[0]['ticker']=='RELIANCE'
    with TestClient(app) as client:
        headers={'X-Internal-Service-Key':'stock-test-key'}
        expiry=client.get('/spreads/underlyings/RELIANCE/expiries',headers=headers).json()
        assert expiry['scan_availability']['available']
        scan=client.post('/spreads/scan',headers=headers,json={'underlyings':['RELIANCE','NIFTY'],'width':10,'min_cushion':0,'max_spread_pct':.3,'min_ror':5}).json()
    assert scan['success_count']==2
    stocks=[row for row in scan['candidates'] if row['ticker']=='RELIANCE']
    assert stocks and all(row['lot_size']==250 for row in stocks)
    assert all(row['short_instrument_key'] and row['long_instrument_key'] for row in stocks)
    assert scan['candidates']==sorted(scan['candidates'],key=lambda row:row['ev'],reverse=True)


def test_missing_stock_earnings_preserves_index_success_and_errors(monkeypatch):
    provider=setup(monkeypatch)
    original=provider.get_earnings_info
    provider.get_earnings_info=lambda key,expiry:original(key,expiry) if key.startswith('NSE_INDEX|') else EarningsData(False,None,None,DataCapability(False,'unavailable','Missing stock earnings'))
    monkeypatch.setattr(api,'_provider',lambda mode,token:provider)
    with TestClient(app) as client:
        result=client.post('/spreads/scan',headers={'X-Internal-Service-Key':'stock-test-key'},json={'underlyings':['RELIANCE','NIFTY'],'width':100}).json()
    assert result['success_count']==1 and result['failure_count']==1
    assert 'earnings calendar' in result['errors'][0]['error']
    assert set(result['funnels'])=={'NIFTY'} and set(result['meta'])=={'NIFTY'}
    assert all(row['ticker']=='NIFTY' for row in result['candidates'])


def test_mismatched_or_missing_contract_lots_never_invent_money(monkeypatch):
    provider=setup(monkeypatch)
    original=provider.get_option_contracts
    def contracts(key):
        rows=original(key)
        if key.startswith('NSE_EQ|'):
            # Preserve contract expiry availability but break quote identity.
            return tuple(replace(row,instrument_key='NSE_FO|wrong-'+row.instrument_key) for row in rows)
        return rows
    provider.get_option_contracts=contracts
    monkeypatch.setattr(api,'_provider',lambda mode,token:provider)
    result=api._scan_underlying('RELIANCE',api.NiftyScanRequest(width=10,min_cushion=0,max_spread_pct=.3,min_ror=5),None,'')
    assert result['ok'] and result['candidates']
    assert all(row['lot_size'] is None and row['ev_per_lot_inr'] is None and row['lot_size_status']=='unavailable' for row in result['candidates'])
    assert all(isinstance(row['ev'],float) for row in result['candidates'])


def test_live_stock_availability_is_explicit_without_fabricating_earnings(monkeypatch):
    provider=setup(monkeypatch)
    monkeypatch.setenv('SPREADS_DATA_MODE','upstox')
    monkeypatch.setattr(api,'_provider',lambda mode,token:provider)
    with TestClient(app) as client:
        headers={'X-Internal-Service-Key':'stock-test-key','X-Upstox-Access-Token':'mock-token'}
        stock=client.get('/spreads/underlyings/RELIANCE/expiries',headers=headers).json()
        index=client.get('/spreads/underlyings/NIFTY/expiries',headers=headers).json()
    assert stock['scan_availability']['available'] is None
    assert stock['scan_availability']['status'] == 'requires_validation'
    assert 'Yahoo earnings' in stock['scan_availability']['reason']
    assert index['scan_availability']['available']


def test_live_stock_scan_uses_supplementary_source_and_keeps_earnings_penalty(monkeypatch):
    provider=setup(monkeypatch)
    monkeypatch.setenv('SPREADS_DATA_MODE','upstox')
    provider.get_earnings_info=lambda key,expiry:EarningsData(False,None,None,DataCapability(False,'unavailable','Upstox has no earnings dates'))
    calls=[]
    def source(symbol,history,expiration,as_of=None):
        calls.append(symbol)
        return EarningsData(True,True,8.,DataCapability(True,'yahoo_dates_upstox_closes','Mock Yahoo dates / Upstox closes'))
    monkeypatch.setattr(api.yahoo_earnings_source,'get_earnings',source)
    monkeypatch.setattr(api,'_provider',lambda mode,token:provider)
    result=api._scan_underlying('RELIANCE',api.NiftyScanRequest(width=10,min_cushion=0,max_spread_pct=.3,min_ror=5),None,'mock-token')
    assert result['ok'] and result['candidates'] and calls==['RELIANCE']
    assert result['capabilities']['earnings']=='yahoo_dates_upstox_closes'
    assert all(row['earnings'] and row['max_gap']==8. and row['p_adj']>=row['p_raw'] for row in result['candidates'])
