"""Explicit offline fixture provider for Spread Terminal development and tests."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from typing import Any
from urllib.parse import unquote

from .upstox_adapter import UpstoxMarketDataProvider
from .provider import DataCapability, EarningsData


class FixtureTransport:
    """Serve Upstox-shaped response data without contacting any broker."""

    def __init__(self, fixtures: dict[str, Any]):
        self._fixtures = fixtures

    def get(self, path: str, params: dict | None = None) -> dict | list:
        params = params or {}
        if path == "/v2/instruments/search":
            key = f"search:{params.get('query', '').upper()}"
            if key not in self._fixtures:
                return []
        elif path == "/v2/option/contract":
            key = f"contracts:{params.get('instrument_key', '')}"
        elif path == "/v2/option/chain":
            key = f"chain:{params.get('instrument_key', '')}:{params.get('expiry_date', '')}"
        elif path.startswith("/v3/historical-candle/"):
            # Fixture is selected by instrument key; date bounds are intentionally ignored.
            key = f"history:{unquote(path.split('/')[3])}"
        else:
            raise KeyError("No fixture registered for this Upstox read endpoint")
        if key not in self._fixtures:
            raise KeyError(f"No fixture registered for {key}")
        return deepcopy(self._fixtures[key])


class FixtureMarketDataProvider(UpstoxMarketDataProvider):
    """Uses the production Upstox response normalization over supplied fixtures."""

    def __init__(self, fixtures: dict[str, Any]):
        self._fixtures = fixtures
        super().__init__(transport=FixtureTransport(fixtures))

    def get_history(self, instrument_key: str, years: int = 3):
        history = super().get_history(instrument_key, years)
        history = replace(history, completeness=DataCapability(True, "fixture", "Synthetic complete daily candles."))
        if instrument_key.startswith("NSE_INDEX|"):
            return history
        # Fixture-only capabilities are explicitly synthetic and never used in live mode.
        return type(history)(
            instrument_key=history.instrument_key, bars=history.bars,
            requested_years=history.requested_years,
            adjustment=DataCapability(True, "fixture", "Synthetic fixture history; no live equity adjustment equivalence is claimed."),
            volume=history.volume,
            completeness=history.completeness,
        )

    def _contracts_for_oi(self, underlying_key):
        return ()

    def _normalize_option_oi(self, value, contracts, instrument_key, expiry, strike, side):
        # Existing synthetic fixtures already contain scanner contract-count OI.
        from .upstox_adapter import _integer
        return _integer(value), None, None, 'fixture_contract_count'

    def get_option_chain(self, underlying_key, expiry):
        chain = super().get_option_chain(underlying_key, expiry)
        return replace(chain, open_interest=DataCapability(True, "fixture", "Synthetic scanner-unit OI, not live unit validation."))

    def get_earnings_info(self, underlying_key: str, expiration):
        if underlying_key.startswith("NSE_INDEX|"):
            return super().get_earnings_info(underlying_key, expiration)
        return EarningsData(True, False, 0.0, DataCapability(
            True, "fixture", "Synthetic fixture earnings calendar and historical gap; not live company data."
        ))

