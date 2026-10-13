from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pandas as pd

from app.services.spreads.earnings_source import YahooEarningsSource
from app.services.spreads.engine import get_earnings_info, apply_earnings_penalty
from app.services.spreads.provider import PriceBar
from app.services.spreads.upstox_adapter import IST

TODAY=date(2026,10,13)


def history():
    days=[TODAY-timedelta(days=i) for i in range(10,-1,-1)]
    closes=[100,100,100,100,110,105,104,106,102,101,100]
    return SimpleNamespace(bars=tuple(PriceBar(datetime.combine(day,datetime.min.time(),tzinfo=IST),close,close,close,close,100) for day,close in zip(days,closes)))


def test_dates_only_original_gap_and_penalty_and_cache():
    events=[TODAY-timedelta(days=6),TODAY+timedelta(days=5)]
    calls=[]
    def factory(symbol):
        calls.append(symbol)
        return SimpleNamespace(get_earnings_dates=lambda limit:pd.DataFrame({'EPS':[1,2]},index=pd.to_datetime(events)))
    source=YahooEarningsSource(ticker_factory=factory)
    data=history(); result=source.get_earnings('TATAELXSI',data,TODAY+timedelta(days=30),as_of=TODAY)
    expected=get_earnings_info(events,[(bar.timestamp.date(),bar.close) for bar in data.bars],TODAY+timedelta(days=30),as_of=TODAY)
    assert result.available and (result.earnings_inside,result.max_historical_gap_pct)==expected
    assert result.earnings_inside and result.max_historical_gap_pct > 9
    assert apply_earnings_penalty(.1,2,result.max_historical_gap_pct) > .1
    source.get_earnings('TATAELXSI',data,TODAY+timedelta(days=30),as_of=TODAY)
    assert calls==['TATAELXSI.NS']


def test_calendar_fallback_today_matches_original_exclusive_today_rule():
    past=TODAY-timedelta(days=6)
    ticker=SimpleNamespace(get_earnings_dates=lambda limit:pd.DataFrame({'EPS':[1]},index=pd.to_datetime([past])),calendar={'Earnings Date':[TODAY]})
    result=YahooEarningsSource(ticker_factory=lambda symbol:ticker).get_earnings('TECHM',history(),TODAY+timedelta(days=30),as_of=TODAY)
    assert result.available and not result.earnings_inside


def test_empty_or_only_future_dates_never_assume_zero_historical_gap():
    for events in ([],[TODAY+timedelta(days=5)]):
        ticker=SimpleNamespace(get_earnings_dates=lambda limit:pd.DataFrame(index=pd.to_datetime(events),columns=['EPS']),calendar={})
        result=YahooEarningsSource(ticker_factory=lambda symbol:ticker).get_earnings('TECHM',history(),TODAY+timedelta(days=30),as_of=TODAY)
        assert not result.available and result.earnings_inside is None and result.max_historical_gap_pct is None


def test_provider_failure_has_safe_error_and_no_private_details():
    def factory(symbol): raise RuntimeError('PRIVATE token')
    result=YahooEarningsSource(ticker_factory=factory).get_earnings('TECHM',history(),TODAY+timedelta(days=30),as_of=TODAY)
    assert not result.available and 'PRIVATE' not in result.capability.explanation
