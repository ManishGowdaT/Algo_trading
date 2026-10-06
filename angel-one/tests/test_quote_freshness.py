from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from app.services import angel_client
from app.services.angel_client import AngelClient, AngelSession


def make_client(monkeypatch, clock, calls, transform=lambda row: row):
    def full(mode, tokens):
        calls.append((mode, tokens))
        return {'status': True, 'data': {'fetched': [transform({
            'exchange': ex, 'symbolToken': token, 'tradingSymbol': 'OPT-'+token,
            'ltp': 100, 'exchFeedTime': '06-Oct-2026 10:00:00',
        }) for ex, group in tokens.items() for token in group]}}
    monkeypatch.setattr(angel_client, 'SmartConnect', lambda **kwargs: SimpleNamespace(getMarketData=full))
    monkeypatch.setattr(angel_client, 'monotonic', lambda: clock[0])
    client = AngelClient(api_key='test', client_code='test', totp_secret='test')
    client._session = AngelSession('jwt', 'refresh', 'feed', 'test')
    return client


def quote(client, token='1'):
    return client.get_ltp(exchange='NFO', tradingsymbol='OPT-'+token, symboltoken=token, require_fresh=True)


def test_full_quotes_batch_at_one_request_per_second_and_preserve_exchange_time(monkeypatch):
    clock, calls = [0.0], []
    client = make_client(monkeypatch, clock, calls)
    result = quote(client)
    expected = datetime(2026, 10, 6, 10, tzinfo=timezone(timedelta(hours=5, minutes=30))).timestamp()*1000
    assert result['quoteTimestamp'] == expected
    assert result['quoteSource'] == 'ANGEL_FULL'
    assert quote(client) == result
    with pytest.raises(RuntimeError, match='not yet available'):
        quote(client, '2')
    assert len(calls) == 1
    clock[0] = 1.01
    assert quote(client, '2')['symboltoken'] == '2'
    assert calls[-1] == ('FULL', {'NFO': ['1', '2']})
    assert quote(client)['ltp'] == 100
    assert len(calls) == 2


@pytest.mark.parametrize('field,value', [('exchFeedTime', ''), ('exchFeedTime', None), ('symbolToken', 'foreign'), ('tradingSymbol', 'foreign'), ('ltp', float('nan'))])
def test_invalid_or_wrong_instrument_quotes_never_enter_cache(monkeypatch, field, value):
    client = make_client(monkeypatch, [0], [], lambda row: {**row, field: value})
    with pytest.raises(RuntimeError, match='not yet available'):
        quote(client)


def test_account_quote_caches_and_failure_budgets_are_independent(monkeypatch):
    clock, calls_a, calls_b = [0], [], []
    a = make_client(monkeypatch, clock, calls_a)
    b = make_client(monkeypatch, clock, calls_b)
    quote(a); quote(b)
    assert len(calls_a) == len(calls_b) == 1
    clock[0] = 1.01
    a._smart.getMarketData = lambda *args: {'status': False}
    with pytest.raises(RuntimeError, match='unavailable'):
        quote(a)
    with pytest.raises(RuntimeError, match='not yet available'):
        quote(a)
    assert quote(b)['ltp'] == 100
    assert len(calls_b) == 2


def test_ordinary_ltp_reads_keep_the_existing_broker_path(monkeypatch):
    calls = []
    monkeypatch.setattr(angel_client, 'SmartConnect', lambda **kwargs: SimpleNamespace(ltpData=lambda **args: calls.append(args) or {'data': {'ltp': 100}}))
    client = AngelClient(api_key='test', client_code='test', totp_secret='test')
    client._session = AngelSession('jwt', 'refresh', 'feed', 'test')
    result = client.get_ltp(exchange='NFO', tradingsymbol='OPT-1', symboltoken='1')
    assert result['ltp'] == 100
    assert 'quoteTimestamp' not in result
    assert calls == [{'exchange': 'NFO', 'tradingsymbol': 'OPT-1', 'symboltoken': '1'}]
