"""Read-only market-data adapters for the integrated spreads research flow."""

from .provider import DataCapability, EarningsData, HistoryData, MarketDataProvider, OptionChain, OptionContract
from .upstox_adapter import UpstoxMarketDataProvider
from .fixture_adapter import FixtureMarketDataProvider

__all__ = [
    "DataCapability", "EarningsData", "HistoryData", "MarketDataProvider",
    "OptionChain", "OptionContract", "UpstoxMarketDataProvider", "FixtureMarketDataProvider",
]
