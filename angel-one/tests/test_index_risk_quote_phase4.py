from types import SimpleNamespace
from app import main


def test_reference_index_quote_resolves_actual_symbol_and_demands_exchange_time(monkeypatch):
    calls = []
    monkeypatch.setattr(main, 'instruments', SimpleNamespace(get_index_spot=lambda **kwargs: ('Nifty 50', '99926000')))
    def quote(**kwargs):
        calls.append(kwargs)
        return {'exchange': 'NSE', 'symboltoken': '99926000', 'ltp': 25000, 'quoteTimestamp': 1}
    monkeypatch.setattr(main, 'angel', SimpleNamespace(get_ltp=quote))
    result = main.index_ltp('NIFTY', requireFresh=True)
    assert result['quoteTimestamp'] == 1
    assert calls == [{'exchange': 'NSE', 'tradingsymbol': 'Nifty 50', 'symboltoken': '99926000', 'require_fresh': True}]


def test_ordinary_index_quote_keeps_legacy_call_shape(monkeypatch):
    calls = []
    monkeypatch.setattr(main, 'instruments', SimpleNamespace(get_index_spot=lambda **kwargs: ('SENSEX', '99919000')))
    monkeypatch.setattr(main, 'angel', SimpleNamespace(get_ltp=lambda **kwargs: calls.append(kwargs) or {'ltp': 80000}))
    assert main.index_ltp('SENSEX', requireFresh=False) == {'ltp': 80000}
    assert 'require_fresh' not in calls[0]
