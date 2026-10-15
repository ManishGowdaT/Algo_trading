"""Yahoo earnings dates only; prices/options always remain with Upstox."""
from collections import OrderedDict
from datetime import date, datetime, timedelta
import threading
import time

import pandas as pd

from .engine import get_earnings_info
from .instruments import normalize_symbol
from .provider import DataCapability, EarningsData
from .upstox_adapter import IST


class YahooEarningsSource:
    def __init__(self, *, ticker_factory=None, clock=time.monotonic):
        self.factory, self.clock = ticker_factory, clock
        self.cache = OrderedDict()
        self.lock = threading.Lock()

    def _dates(self, symbol, today):
        key = (symbol,today)
        with self.lock:
            cached = self.cache.get(key)
            if cached and self.clock()-cached[0] < 900:
                return cached[1]
        factory = self.factory
        if factory is None:
            import yfinance as yf
            factory = yf.Ticker
        ticker = factory(normalize_symbol(symbol)+'.NS')
        events = []
        calendar_known = False
        try:
            frame = ticker.get_earnings_dates(limit=24)
            if frame is not None and not frame.empty:
                events = [timestamp.date() for timestamp in frame.index if hasattr(timestamp,'date')]
        except Exception:
            pass
        # Same 24-date acquisition and future-calendar fallback as the ZIP.
        if not any(day > today for day in events):
            try:
                calendar = ticker.calendar
                raw = calendar.get('Earnings Date') if isinstance(calendar,dict) else calendar.loc['Earnings Date'].values if isinstance(calendar,pd.DataFrame) and 'Earnings Date' in calendar.index else None
                if raw is not None:
                    values = raw if isinstance(raw,(list,tuple)) or hasattr(raw,'__iter__') and not isinstance(raw,str) else [raw]
                    calendar_dates = [pd.to_datetime(value).date() for value in values]
                    events.extend(calendar_dates)
                    calendar_known = bool(calendar_dates)
            except Exception:
                pass
        events = tuple(dict.fromkeys(events))
        # Missing source data is never cached as a successful no-event result.
        if events:
            with self.lock:
                self.cache[key] = (self.clock(),(events,calendar_known))
                self.cache.move_to_end(key)
                while len(self.cache)>128:
                    self.cache.popitem(last=False)
        return events,calendar_known

    def get_earnings(self, symbol, history, expiration, *, as_of=None):
        today = as_of or datetime.now(IST).date()
        unavailable = lambda reason:EarningsData(False,None,None,DataCapability(False,'unavailable',reason))
        try:
            events,calendar_known = self._dates(symbol,today)
        except Exception:
            return unavailable('Yahoo earnings source could not be loaded. Install yfinance and retry; no earnings values were assumed.')
        from .scan_audit import CURRENT_AUDIT
        capture = CURRENT_AUDIT.get()
        if capture:
            try:
                capture.record_dates(events,today,expiration,history)
            except Exception as exc:
                capture.snapshot['earnings_capture_error_type'] = type(exc).__name__
        historical = [day for day in events if today-timedelta(days=3*365) <= day <= today]
        if not historical or not (any(day>today for day in events) or calendar_known):
            return unavailable('Yahoo did not return both historical and upcoming NSE earnings dates. Missing dates are not treated as no earnings.')
        closes = [(bar.timestamp.astimezone(IST).date(),bar.close) for bar in history.bars if bar.close is not None]
        if not any(event<=day<=event+timedelta(days=3) for event in historical for day,_ in closes):
            return unavailable('Historical earnings dates do not overlap the supplied Upstox price history.')
        inside,gap = get_earnings_info(events,closes,expiration,as_of=today)
        return EarningsData(True,inside,gap,DataCapability(True,'yahoo_dates_upstox_closes',
            'Yahoo NSE earnings dates (limit 24 plus calendar fallback); original event/gap calculation using Upstox closes. Announcement timing is unknown: date-only events do not identify before/during/after-market releases. Symbol-to-company mapping, historical date coverage and equity corporate-action treatment are not certified.'))


yahoo_earnings_source = YahooEarningsSource()
