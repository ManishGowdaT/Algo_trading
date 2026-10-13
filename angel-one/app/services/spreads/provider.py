"""Provider-neutral input contract for the original spread scanner port."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Protocol


@dataclass(frozen=True)
class DataCapability:
    available: bool
    status: str
    explanation: str


@dataclass(frozen=True)
class PriceBar:
    timestamp: datetime
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    volume: float | None
    open_interest: float | None = None


@dataclass(frozen=True)
class HistoryData:
    instrument_key: str
    bars: tuple[PriceBar, ...]
    requested_years: int
    adjustment: DataCapability
    volume: DataCapability
    completeness: DataCapability = DataCapability(False, "unverified", "Daily candle completeness needs live validation.")

    @property
    def scanner_history_eligible(self) -> bool:
        """The original fetch_history gate requires at least 270 close rows."""
        return sum(bar.close is not None for bar in self.bars) >= 270


@dataclass(frozen=True)
class OptionContract:
    underlying_symbol: str
    underlying_key: str
    expiry: date
    instrument_key: str
    trading_symbol: str
    instrument_type: str
    strike: float
    lot_size: int
    tick_size: float | None


@dataclass(frozen=True)
class OptionQuote:
    instrument_key: str
    bid: float | None
    ask: float | None
    implied_volatility: float | None
    open_interest: int | None
    bid_quantity: int | None
    ask_quantity: int | None
    volume: int | None

    def as_scanner_row(self) -> dict:
        """Yahoo-compatible field names for the Phase 4 calculation port."""
        return {
            "bid": self.bid,
            "ask": self.ask,
            "impliedVolatility": self.implied_volatility,
            "openInterest": self.open_interest,
            "instrument_key": self.instrument_key,
        }


@dataclass(frozen=True)
class OptionChain:
    underlying_key: str
    expiry: date
    spot: float | None
    puts: tuple[tuple[float, OptionQuote], ...]
    calls: tuple[tuple[float, OptionQuote], ...]
    open_interest: DataCapability
    implied_volatility: DataCapability
    quote_timestamp: DataCapability


@dataclass(frozen=True)
class EarningsData:
    available: bool
    earnings_inside: bool | None
    max_historical_gap_pct: float | None
    capability: DataCapability


class MarketDataProvider(Protocol):
    """Read-only interface; no account, Angel One, or order methods."""

    def resolve_underlying(self, symbol: str) -> dict: ...
    def get_history(self, instrument_key: str, years: int = 3) -> HistoryData: ...
    def get_option_contracts(self, underlying_key: str) -> tuple[OptionContract, ...]: ...
    def get_option_chain(self, underlying_key: str, expiry: date) -> OptionChain: ...
    def get_earnings_info(self, underlying_key: str, expiration: date) -> EarningsData: ...
