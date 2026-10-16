from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import pytest
from app.services import angel_client
from app.services.angel_client import AngelClient, AngelSession


def client(monkeypatch, volume):
    row = ['2026-10-16T09:15:00+05:30', 100, 102, 99, 101]
    if volume != 'MISSING':
        row.append(volume)
    monkeypatch.setattr(angel_client, 'SmartConnect', lambda **kwargs: SimpleNamespace(getCandleData=lambda payload: {'status': True, 'data': [row]}))
    c = AngelClient(api_key='test', client_code='test', totp_secret='test')
    c._session = AngelSession('jwt', 'refresh', 'feed', 'test')
    return c


def candles(c, **kwargs):
    start = datetime(2026, 10, 16, 9, 15, tzinfo=timezone(timedelta(hours=5, minutes=30)))
    return c.get_candles(exchange='NSE', symboltoken='99926000', interval='ONE_MINUTE', from_dt=start, to_dt=start + timedelta(minutes=5), **kwargs)


@pytest.mark.parametrize('raw,expected', [(0, 0), ('123', 123), (45.5, 45.5), (None, None), ('MISSING', None), (-1, None), (float('nan'), None), (float('inf'), None), (True, None), ('bad', None)])
def test_opt_in_volume_distinguishes_missing_invalid_and_zero(monkeypatch, raw, expected):
    assert candles(client(monkeypatch, raw), include_volume=True)[0]['volume'] == expected


def test_legacy_candle_shape_unchanged(monkeypatch):
    assert candles(client(monkeypatch, 123)) == [{'ts': '2026-10-16T09:15:00+05:30', 'open': 100, 'high': 102, 'low': 99, 'close': 101}]


def test_market_route_forwards_opt_in_without_changing_legacy_calls(monkeypatch):
    from app import main
    requests = []
    def get_candles(**kwargs):
        requests.append(kwargs)
        return [{'volume': 12}] if kwargs.get('include_volume') else [{'close': 101}]
    monkeypatch.setattr(main, 'angel', SimpleNamespace(get_candles=get_candles))
    args = dict(exchange='NSE', symboltoken='99926000', interval='ONE_MINUTE', date='2026-10-16', lookback_minutes=375)
    assert main.market_candles(**args, include_volume=True) == {'items': [{'volume': 12}]}
    assert requests[-1]['include_volume'] is True
    assert main.market_candles(**args, include_volume=False) == {'items': [{'close': 101}]}
    assert 'include_volume' not in requests[-1]
