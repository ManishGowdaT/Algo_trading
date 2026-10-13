import asyncio

from fastapi.testclient import TestClient

from app.main import app
from app.services.spreads.discovery_cache import DiscoveryCache


def test_ttl_force_refresh_singleflight_stale_and_defensive_copies():
    async def run():
        clock=[1000.]; calls=[]; gate=asyncio.Event()
        cache=DiscoveryCache(clock=lambda:clock[0])
        key=cache.key('owner','upstox','token')
        async def load():
            calls.append(1)
            await gate.wait()
            return {'all':[{'ticker':'NIFTY'}],'universe':{'size':1},'errors':[],'capabilities':{}}
        gate.set()
        result=await cache.get(key,load)
        result['all'][0]['ticker']='changed'
        assert (await cache.get(key,load))['all'][0]['ticker']=='NIFTY'
        assert len(calls)==1
        clock[0]+=901; gate.clear()
        stale=await cache.get(key,load)
        assert stale['refreshing'] and stale['updated']==1000.
        a=asyncio.create_task(cache.get(key,load,force=True))
        b=asyncio.create_task(cache.get(key,load,force=True))
        await asyncio.sleep(0); gate.set()
        assert (await a)['updated']==1901. and (await b)['updated']==1901.
        assert len(calls)==2
    asyncio.run(run())


def test_cache_isolates_users_tokens_modes_bounds_and_preserves_empty_refresh():
    async def run():
        cache=DiscoveryCache(limit=2)
        async def load(): return {'all':[{'ticker':'TEST'}],'universe':{},'errors':[],'capabilities':{}}
        keys=[cache.key('A','fixtures',''),cache.key('B','fixtures',''),cache.key('B','upstox','one'),cache.key('B','upstox','two')]
        assert len(set(keys))==4 and 'one' not in str(keys)
        for key in keys: await cache.get(key,load)
        assert len(cache.entries)==2
        old=cache.entries[keys[-1]]['updated']
        async def empty(): return {'all':[],'universe':{},'errors':[{'error':'missing history'}],'capabilities':{}}
        result=await cache.get(keys[-1],empty,force=True)
        assert result['all']==[{'ticker':'TEST'}] and result['updated']==old and result['errors']
        async def failed(): raise ValueError('PRIVATE secret')
        result=await cache.get(keys[-1],failed,force=True)
        assert 'PRIVATE' not in str(result) and result['all']
    asyncio.run(run())


def test_timeout_does_not_cancel_singleflight_and_subsequent_wait_completes():
    async def run():
        cache=DiscoveryCache(); key=cache.key('A','fixtures',''); gate=asyncio.Event()
        async def load():
            await gate.wait()
            return {'all':[],'universe':{},'errors':[],'capabilities':{}}
        import pytest
        with pytest.raises(TimeoutError): await cache.get(key,load,force=True,timeout=.001)
        assert key in cache.tasks
        gate.set()
        assert not (await cache.get(key,load,force=True))['refreshing']
    asyncio.run(run())


def test_private_discovery_routes_fixture_contract_and_authentication(monkeypatch):
    monkeypatch.setenv('SPREADS_DATA_MODE','fixtures')
    monkeypatch.setenv('INTERNAL_SERVICE_KEY','test-key')
    headers={'X-Internal-Service-Key':'test-key','X-Spreads-User-Id':'phase5-fixture-user'}
    with TestClient(app) as client:
        assert client.post('/spreads/discover').status_code==401
        assert client.get('/spreads/trending',headers={'X-Internal-Service-Key':'test-key'}).status_code==422
        result=client.post('/spreads/discover',headers=headers)
        assert result.status_code==200,result.text
        data=result.json()
        import time
        for _ in range(50):
            if not data['refreshing']: break
            time.sleep(.02)
            data=client.get('/spreads/trending',headers=headers).json()
        assert {'top','all','updated','refreshing','universe','errors','capabilities','data_mode'} <= data.keys()
        assert data['data_mode']=='fixtures' and data['universe']['source']=='fixture_nse_bod'
        assert len(data['all'])==4 and data['top']==data['all'][:5]
        assert data['updated']>0 and not data['refreshing']
        assert client.get('/spreads/trending',headers=headers).json()['updated']==data['updated']
        monkeypatch.setenv('SPREADS_DATA_MODE','upstox')
        assert client.get('/spreads/trending',headers=headers).status_code==401


def test_nonblocking_progress_and_empty_failure_poll_does_not_restart():
    async def run():
        cache=DiscoveryCache(); key=cache.key('A','fixtures',''); gate=asyncio.Event(); calls=[]
        async def load():
            calls.append(1); await gate.wait()
            return {'all':[],'errors':[{'error':'no inputs'}],'universe':{},'capabilities':{}}
        result=await cache.get(key,load,force=True,wait=False)
        assert result['refreshing'] and result['progress']['stage']=='universe'
        await asyncio.sleep(0)
        assert (await cache.get(key,load,wait=False))['refreshing']
        gate.set(); await asyncio.sleep(0); await asyncio.sleep(0)
        result=await cache.get(key,load,wait=False)
        assert not result['refreshing'] and result['errors'] and len(calls)==1
    asyncio.run(run())


def test_stale_empty_refresh_polls_do_not_restart_or_relabel_old_ranking():
    async def run():
        now = [1000.]
        cache = DiscoveryCache(clock=lambda: now[0])
        key = cache.key('owner', 'upstox', 'token')
        async def initial():
            return {'all':[{'ticker':'TEST'}], 'universe':{'source':'old'}, 'capabilities':{'TEST':{'history':'old'}}, 'errors':[]}
        await cache.get(key, initial)
        now[0] += 901
        calls = []
        async def empty():
            calls.append(1)
            return {'all':[], 'universe':{'source':'new'}, 'capabilities':{}, 'errors':[{'error':'missing inputs'}]}
        await cache.get(key, empty, force=True)
        for _ in range(3):
            result = await cache.get(key, empty, wait=False)
            assert not result['refreshing'] and result['updated'] == 1000.
            assert result['universe']['source'] == 'old'
            assert result['capabilities']['TEST']['history'] == 'old'
        assert len(calls) == 1
        await cache.get(key, empty, force=True)
        assert len(calls) == 2
    asyncio.run(run())
