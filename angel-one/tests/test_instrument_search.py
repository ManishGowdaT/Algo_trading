import pytest
from app.services.instrument_master import InstrumentMasterCache


ROWS = [
    {"exch_seg": "NSE", "token": "2885", "symbol": "RELIANCE-EQ", "name": "RELIANCE", "instrumenttype": "", "lotsize": "1"},
    {"exch_seg": "BSE", "token": "500325", "symbol": "RELIANCE", "name": "RELIANCE", "lotsize": "1"},
    {"exch_seg": "NFO", "token": "77", "symbol": "NIFTY30DEC209926000CE", "name": "NIFTY", "expiry": "30DEC2099", "instrumenttype": "OPTIDX", "lotsize": "65"},
    {"exch_seg": "NFO", "token": "88", "symbol": "RELIANCE30DEC20992500PE", "name": "RELIANCE", "expiry": "30DEC2099", "instrumenttype": "OPTSTK"},
    {"exch_seg": "NFO", "token": "99", "symbol": "NIFTY01JAN202026000CE", "name": "NIFTY", "expiry": "01JAN2020", "instrumenttype": "OPTIDX"},
]


def test_search_supports_equities_and_stock_options_and_excludes_expired_contracts():
    directory = InstrumentMasterCache(fetcher=lambda _: ROWS)
    assert len(directory.search("RELIANCE")) == 3
    assert len(directory.search("RELIANCE", "NSE")) == 1
    assert directory.search("NIFTY 26000 CE")[0]["symboltoken"] == "77"
    assert directory.search("UNRECOGNIZED") == []
    assert len(directory.search("RELIANCE", limit=1)) == 1


def test_token_resolution_keeps_exchange_identity_and_rejects_expired_or_unknown():
    directory = InstrumentMasterCache(fetcher=lambda _: ROWS)
    assert directory.resolve("NFO", "88")["instrumentType"] == "OPTSTK"
    for exchange, token in [("NSE", "77"), ("NFO", "99"), ("NFO", "999")]:
        with pytest.raises(ValueError):
            directory.resolve(exchange, token)


def test_search_results_are_copies_and_directory_download_is_cached():
    downloads = []
    directory = InstrumentMasterCache(fetcher=lambda url: downloads.append(url) or ROWS)
    result = directory.search("RELIANCE", "NSE")[0]
    result["symboltoken"] = "bad"
    assert directory.resolve("NSE", "2885")["symboltoken"] == "2885"
    assert len(downloads) == 1
