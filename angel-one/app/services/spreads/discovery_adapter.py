"""Four-month discovery inputs, separate from three-year spread scan history."""
from __future__ import annotations

from calendar import monthrange
from dataclasses import dataclass
from datetime import date, datetime

from .engine import pick_expiration
from .provider import DataCapability, OptionChain, PriceBar
from .transport import UpstoxProviderError, encoded_instrument_key
from .upstox_adapter import IST, _number, _parse_timestamp


@dataclass(frozen=True)
class DiscoveryHistory:
    instrument_key: str
    start: date
    end: date
    bars: tuple[PriceBar, ...]
    adjustment: DataCapability
    volume: DataCapability
    completeness: DataCapability

    @property
    def closes(self):
        return [bar.close for bar in self.bars]

    @property
    def volumes(self):
        return [bar.volume for bar in self.bars]

    @property
    def eligibility_error(self):
        # Original discovery gates; no 270-close spread-history requirement.
        if len(self.bars) < 30:
            return 'Discovery requires at least 30 daily history rows.'
        if sum(value is not None for value in self.closes) < 22:
            return 'Discovery requires at least 22 non-missing daily closes.'
        if sum(value is not None for value in self.volumes) < 22:
            return 'Discovery requires at least 22 non-missing daily volumes.'
        return None


def four_month_start(end: date) -> date:
    absolute_month = end.year * 12 + end.month - 1 - 4
    year, month = divmod(absolute_month, 12)
    month += 1
    return date(year, month, min(end.day, monthrange(year, month)[1]))


class DiscoveryDataAdapter:
    def __init__(self, market_provider, *, transport=None, fixture=False):
        self.market_provider = market_provider
        self.transport = transport if transport is not None else market_provider._transport
        self.fixture = fixture

    def request_metrics(self):
        metrics = getattr(self.market_provider, 'request_metrics', None)
        return metrics() if callable(metrics) else {}

    def get_history(self, instrument_key: str, *, as_of: date | None = None) -> DiscoveryHistory:
        end = as_of or datetime.now(IST).date()
        start = four_month_start(end)
        path = f'/v3/historical-candle/{encoded_instrument_key(instrument_key)}/days/1/{end.isoformat()}/{start.isoformat()}'
        payload = self.transport.get(path)
        candles = payload.get('candles') if isinstance(payload, dict) else None
        if not isinstance(candles, list):
            raise UpstoxProviderError('Upstox returned invalid discovery history')
        bars = []
        for candle in candles:
            if not isinstance(candle, (list, tuple)) or len(candle) < 6:
                continue
            timestamp = _parse_timestamp(candle[0])
            if timestamp is None or not start <= timestamp.astimezone(IST).date() <= end:
                continue
            bars.append(PriceBar(timestamp, *[_number(value) for value in candle[1:6]],
                                 _number(candle[6]) if len(candle) > 6 else None))
        bars.sort(key=lambda bar: bar.timestamp)
        index = instrument_key.startswith('NSE_INDEX|')
        return DiscoveryHistory(
            instrument_key, start, end, tuple(bars),
            DataCapability(self.fixture or index, 'fixture' if self.fixture else 'not_applicable' if index else 'unverified',
                           'Synthetic adjusted-history inputs.' if self.fixture else 'Returned Upstox closes; equity corporate-action adjustment equivalence is unverified.'),
            DataCapability(any(bar.volume is not None for bar in bars), 'fixture' if self.fixture else 'reported' if any(bar.volume is not None for bar in bars) else 'unavailable',
                           'Reported daily volume only; no futures-volume proxy or invented index volume.'),
            DataCapability(self.fixture, 'fixture' if self.fixture else 'unverified',
                           'Returned daily candles retained; partial-candle completeness is not certified.'),
        )

    def get_atm_chain(self, instrument_key: str, *, as_of: date | None = None) -> OptionChain | None:
        today = as_of or datetime.now(IST).date()
        contracts = self.market_provider.get_option_contracts(instrument_key)
        # Normalize provider ordering to chronological order, as in spread scanning.
        expiries = sorted({contract.expiry.isoformat() for contract in contracts})
        picked = pick_expiration(expiries, 14, as_of=today)
        return self.market_provider.get_option_chain(instrument_key, date.fromisoformat(picked[0])) if picked else None


class FixtureDiscoveryDataAdapter(DiscoveryDataAdapter):
    def __init__(self, market_provider):
        super().__init__(market_provider, fixture=True)
