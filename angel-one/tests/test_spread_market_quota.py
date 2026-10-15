from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import pytest
from app.services.spreads.rate_limit import MarketDataQuota, retry_after_seconds
from app.services.spreads.transport import UpstoxProviderError


class Clock:
    def __init__(self):
        self.now = 0.0
        self.waits = []
    def __call__(self):
        return self.now
    def sleep(self, seconds):
        self.waits.append(seconds)
        self.now += seconds


@pytest.mark.parametrize('window,limit', [(1, 50), (60, 500), (1800, 2000)])
def test_each_documented_rolling_window(window, limit):
    clock = Clock()
    quota = MarketDataQuota(clock=clock, windows=((window, limit),))
    for _ in range(limit):
        quota.acquire(('user', 'chain'), sleep=clock.sleep, remaining=lambda: 2001)
    assert quota.acquire(('user', 'chain'), sleep=clock.sleep, remaining=lambda: 2001) == window
    assert clock.now == window


def test_api_and_user_budgets_are_independent():
    clock = Clock()
    quota = MarketDataQuota(clock=clock, windows=((1, 1),))
    for key in [('a', 'chain'), ('a', 'history'), ('b', 'chain')]:
        assert quota.acquire(key, sleep=clock.sleep, remaining=lambda: 10) == 0
    assert not clock.waits


def test_deadline_does_not_consume_a_request_or_sleep_past_budget():
    clock = Clock()
    quota = MarketDataQuota(clock=clock, windows=((60, 1),))
    quota.acquire('a', sleep=clock.sleep, remaining=lambda: 100)
    with pytest.raises(UpstoxProviderError, match='quota wait'):
        quota.acquire('a', sleep=clock.sleep, remaining=lambda: 2)
    assert len(quota.entries['a']) == 1 and not clock.waits


def test_concurrent_reservations_are_atomic():
    quota = MarketDataQuota(windows=((1, 2),))
    def reserve(_):
        try:
            quota.acquire('same', sleep=lambda _: None, remaining=lambda: .001)
            return True
        except UpstoxProviderError:
            return False
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert sum(pool.map(reserve, range(8))) == 2


def test_cooldown_shared_and_retry_after_not_capped_to_four_seconds():
    clock = Clock()
    quota = MarketDataQuota(clock=clock)
    quota.cooldown('a', 12)
    assert quota.acquire('a', sleep=clock.sleep, remaining=lambda: 20) == 12
    assert retry_after_seconds('12') == 12
    assert retry_after_seconds('Wed, 14 Oct 2026 10:00:12 GMT', now=datetime(2026,10,14,10,tzinfo=timezone.utc)) == 12
    for value in ['garbage', 'NaN', 'inf']:
        assert retry_after_seconds(value) is None


def test_server_owner_survives_token_rotation_and_dependency_resets(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app.services.spreads import api, transport
    monkeypatch.setenv('INTERNAL_SERVICE_KEY', 'test-internal')
    recorded = []
    monkeypatch.setattr(transport, 'market_data_quota', SimpleNamespace(
        acquire=lambda key, **kwargs: recorded.append(key)))
    monkeypatch.setattr(transport.httpx, 'get', lambda *args, **kwargs: SimpleNamespace(
        status_code=200, headers={}, json=lambda: {'status':'success', 'data':[]}))
    async def run():
        dependency = api._authorize_internal('test-internal', 'server-owner')
        await anext(dependency)
        try:
            transport.UpstoxTransport('first-token-quota-test').get('/v2/option/chain')
            transport.UpstoxTransport('rotated-token-quota-test').get('/v2/option/chain')
        finally:
            await dependency.aclose()
        assert transport.RATE_OWNER.get() is None
    asyncio.run(run())
    assert recorded == [('server-owner','/v2/option/chain')] * 2
