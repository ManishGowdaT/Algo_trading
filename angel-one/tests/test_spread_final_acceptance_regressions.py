from datetime import date
from types import SimpleNamespace
import asyncio
import pytest
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
from app.services.spreads.transport import UpstoxProviderError
from app.services.spreads.universe import build_universe
from app.services.spreads.discovery import discover
from app.services.spreads.discovery_cache import DiscoveryCache
from app.services.spreads.provider import OptionChain, OptionQuote, DataCapability


@pytest.mark.parametrize("field,value", [("instrument_key",None),("trading_symbol",None),("strike_price",None),("strike_price",0),("strike_price",-105)])
def test_malformed_listing_cannot_silently_compress_strike_grid(field,value):
    rows=[dict(instrument_key=f"NSE_FO|{k}",trading_symbol=str(k),instrument_type="CE",expiry="2026-11-23",strike_price=k,lot_size=100,tick_size=5) for k in (100,105,110)]
    rows[1][field]=value
    provider=UpstoxMarketDataProvider(transport=SimpleNamespace(get=lambda *args:rows))
    with pytest.raises(UpstoxProviderError,match="contract"):
        provider.get_option_contracts("NSE_EQ|TEST")


def test_conflicting_duplicate_contract_does_not_select_first_identity():
    row=dict(segment="NSE_FO",instrument_type="CE",instrument_key="NSE_FO|DUP",underlying_symbol="TEST",underlying_key="NSE_EQ|A",underlying_type="EQUITY",expiry="2026-11-23",lot_size=100)
    result=build_universe([row,{**row,"underlying_key":"NSE_EQ|B"}],as_of=date(2026,10,15))
    assert result['items']==[]
    assert 'TEST' in result['ambiguous_symbols']


def test_discovery_cannot_claim_atm_iv_without_reference_spot():
    cap=DataCapability(True,'reported','test')
    quote=OptionQuote('NSE_FO|TEST',1,1.05,.3,100,1,1,1)
    chain=OptionChain('NSE_EQ|TEST',date(2026,11,23),100,((95,quote),),(),cap,cap,cap)
    adapter=SimpleNamespace(get_history=lambda *a,**k:SimpleNamespace(eligibility_error='missing history'),get_atm_chain=lambda *a,**k:chain)
    result=discover([dict(symbol='TEST',instrument_key='NSE_EQ|TEST')],adapter)
    assert result.items==[]
    assert result.stats['atm_iv_available']==0
    assert result.stats['atm_iv_unavailable']==1


def test_partial_ranking_never_becomes_last_successful_after_failure():
    async def run():
        cache=DiscoveryCache(clock=lambda:1000)
        key=('owner','fixtures','')
        async def partial():
            return dict(all=[{'ticker':'PARTIAL'}],errors=[{'error':'one unavailable'}],stats={'complete':False},universe={})
        async def failed():
            raise RuntimeError('provider unavailable')
        await cache._refresh(key,partial)
        await cache._refresh(key,failed)
        result=await cache.get(key,failed)
        assert result['latest_attempt']['status']=='FAILED'
        assert result['all']==[{'ticker':'PARTIAL'}]
        assert result.get('last_successful') is None
    asyncio.run(run())
