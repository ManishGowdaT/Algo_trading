"""Read-only Upstox market-data adapter for the Spread Terminal scanner."""

from __future__ import annotations

import math
from calendar import monthrange
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .instruments import resolve_underlying as resolve_upstox_underlying
from .provider import (
    DataCapability,
    EarningsData,
    HistoryData,
    MarketDataProvider,
    OptionChain,
    OptionContract,
    OptionQuote,
    PriceBar,
)
from .transport import UpstoxTransport, UpstoxProviderError, encoded_instrument_key


IST = ZoneInfo("Asia/Kolkata")


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _integer(value: Any) -> int | None:
    number = _number(value)
    return int(number) if number is not None and number >= 0 else None


def _expiry(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError) as exc:
        raise UpstoxProviderError("Upstox returned an invalid contract expiry") from exc


def _subtract_years(day: date, years: int) -> date:
    year = day.year - years
    return date(year, day.month, min(day.day, monthrange(year, day.month)[1]))


class UpstoxMarketDataProvider(MarketDataProvider):
    """Fetch Upstox instruments, candles, contracts and option-chain quotes.

    The access token is supplied by the caller for the authenticated user. This
    adapter has no Angel One dependency and exposes no order-placement method.
    """

    def __init__(self, access_token: str | None = None, *, transport: Any = None):
        self._load_master_on_missing = transport is None
        if transport is None:
            if access_token is None:
                raise ValueError("An Upstox access token is required")
            transport = UpstoxTransport(access_token)
        self._transport = transport

    def resolve_underlying(self, symbol: str) -> dict:
        # Public NSE master is the authoritative fallback for non-EQ F&O names.
        from .universe import UpstoxUniverseProvider
        loader = UpstoxUniverseProvider().get_universe if self._load_master_on_missing else None
        return resolve_upstox_underlying(self._transport, symbol, universe_loader=loader)

    def get_history(self, instrument_key: str, years: int = 3) -> HistoryData:
        if not isinstance(years, int) or isinstance(years, bool) or not 1 <= years <= 10:
            raise ValueError("History years must be between 1 and 10")
        today = datetime.now(IST).date()
        start = _subtract_years(today, years)
        path = f"/v3/historical-candle/{encoded_instrument_key(instrument_key)}/days/1/{today.isoformat()}/{start.isoformat()}"
        data = self._transport.get(path)
        candles = data.get("candles") if isinstance(data, dict) else None
        if not isinstance(candles, list):
            raise UpstoxProviderError("Upstox returned invalid historical candle data")

        bars: list[PriceBar] = []
        for candle in candles:
            if not isinstance(candle, (list, tuple)) or len(candle) < 6:
                continue
            timestamp = _parse_timestamp(candle[0])
            if timestamp is None:
                continue
            bars.append(PriceBar(
                timestamp=timestamp,
                open=_number(candle[1]), high=_number(candle[2]), low=_number(candle[3]),
                close=_number(candle[4]), volume=_number(candle[5]),
                open_interest=_number(candle[6]) if len(candle) > 6 else None,
            ))
        bars.sort(key=lambda bar: bar.timestamp)
        return HistoryData(
            instrument_key=instrument_key, bars=tuple(bars), requested_years=years,
            adjustment=(
                DataCapability(True, "not_applicable", "NSE index close history is not subject to equity corporate-action adjustment.")
                if instrument_key.startswith("NSE_INDEX|") else
                DataCapability(False, "unverified", "Upstox candle adjustment equivalence to Yahoo adjusted equity history has not been verified.")
            ),
            volume=DataCapability(any(bar.volume is not None for bar in bars), "reported" if any(bar.volume is not None for bar in bars) else "unavailable",
                                  "Raw Upstox candle volume; index-volume semantics may differ from Yahoo."),
        )

    def get_option_contracts(self, underlying_key: str) -> tuple[OptionContract, ...]:
        data = self._transport.get("/v2/option/contract", {"instrument_key": underlying_key})
        if not isinstance(data, list):
            raise UpstoxProviderError("Upstox returned invalid option-contract data")
        contracts: list[OptionContract] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            instrument_key = item.get("instrument_key")
            symbol = item.get("trading_symbol")
            instrument_type = item.get("instrument_type")
            strike = _number(item.get("strike_price"))
            lot_size = _integer(item.get("lot_size"))
            if (not isinstance(instrument_key, str) or not instrument_key or
                    not isinstance(symbol, str) or instrument_type not in {"CE", "PE"} or
                    strike is None or lot_size is None or lot_size <= 0):
                continue
            contracts.append(OptionContract(
                underlying_symbol=str(item.get("underlying_symbol") or ""),
                underlying_key=underlying_key, expiry=_expiry(item.get("expiry")),
                instrument_key=instrument_key, trading_symbol=symbol,
                instrument_type=instrument_type, strike=strike, lot_size=lot_size,
                tick_size=_number(item.get("tick_size")),
            ))
        return tuple(contracts)

    def get_option_chain(self, underlying_key: str, expiry: date) -> OptionChain:
        data = self._transport.get("/v2/option/chain", {
            "instrument_key": underlying_key, "expiry_date": expiry.isoformat(),
        })
        if not isinstance(data, list):
            raise UpstoxProviderError("Upstox returned invalid option-chain data")
        puts: list[tuple[float, OptionQuote]] = []
        calls: list[tuple[float, OptionQuote]] = []
        spot = None
        oi_seen = False
        iv_seen = False
        for row in data:
            if not isinstance(row, dict):
                continue
            if spot is None:
                spot = _number(row.get("underlying_spot_price"))
            strike = _number(row.get("strike_price"))
            if strike is None:
                continue
            for side, target in (("put_options", puts), ("call_options", calls)):
                option = row.get(side)
                if not isinstance(option, dict):
                    continue
                market = option.get("market_data") if isinstance(option.get("market_data"), dict) else {}
                greeks = option.get("option_greeks") if isinstance(option.get("option_greeks"), dict) else {}
                instrument_key = option.get("instrument_key")
                if not isinstance(instrument_key, str):
                    continue
                raw_iv = _number(greeks.get("iv"))
                # Upstox reports IV as percentage points; scanner input is decimal.
                iv = raw_iv / 100.0 if raw_iv is not None else None
                oi = _integer(market.get("oi"))
                oi_seen = oi_seen or oi is not None
                iv_seen = iv_seen or iv is not None
                target.append((strike, OptionQuote(
                    instrument_key=instrument_key,
                    bid=_number(market.get("bid_price")), ask=_number(market.get("ask_price")),
                    implied_volatility=iv, open_interest=oi,
                    bid_quantity=_integer(market.get("bid_qty")),
                    ask_quantity=_integer(market.get("ask_qty")),
                    volume=_integer(market.get("volume")),
                )))
        puts.sort(key=lambda item: item[0])
        calls.sort(key=lambda item: item[0])
        return OptionChain(
            underlying_key=underlying_key, expiry=expiry, spot=spot,
            puts=tuple(puts), calls=tuple(calls),
            open_interest=DataCapability(oi_seen, "unverified" if oi_seen else "unavailable",
                                         "Raw Upstox option-chain OI; semantic equivalence to the source scanner has not been verified."),
            implied_volatility=DataCapability(iv_seen, "reported" if iv_seen else "unavailable",
                                              "Upstox IV percentage points converted to decimal scanner units."),
            quote_timestamp=DataCapability(False, "unavailable", "The option-chain response does not provide a per-quote timestamp."),
        )

    def get_earnings_info(self, underlying_key: str, expiration: date) -> EarningsData:
        del expiration
        if underlying_key.startswith("NSE_INDEX|"):
            return EarningsData(True, False, 0.0, DataCapability(
                True, "not_applicable", "An index has no company earnings calendar; the original earnings-event filter does not apply to NIFTY."
            ))
        return EarningsData(False, None, None, DataCapability(
            False, "unavailable", "Upstox endpoints used by this adapter do not provide the earnings calendar or historical earnings gaps required by the original scanner."
        ))


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if result.tzinfo is None:
        result = result.replace(tzinfo=IST)
    return result
