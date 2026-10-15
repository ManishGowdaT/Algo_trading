"""Read-only Upstox market-data adapter for the Spread Terminal scanner."""

from __future__ import annotations

import math
from calendar import monthrange
from dataclasses import replace
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
from .history_validation import validate_history


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
        self._oi_contract_cache = {}

    def request_metrics(self):
        metrics = getattr(self._transport, 'request_metrics', None)
        return metrics() if callable(metrics) else {}

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
        completeness, validation = validate_history(
            bars, start=start, end=today, raw_count=len(candles),
            skipped_count=len(candles) - len(bars), observation_date=today,
        )
        bars.sort(key=lambda bar: bar.timestamp)
        return HistoryData(
            instrument_key=instrument_key, bars=tuple(bars), requested_years=years,
            completeness=completeness, validation=validation,
            raw_provider_rows=tuple(candles),
            adjustment=(
                DataCapability(True, "not_applicable", "NSE index close history is not subject to equity corporate-action adjustment.")
                if instrument_key.startswith("NSE_INDEX|") else
                DataCapability(False, "unverified", "Raw Upstox equity OHLCV; split, bonus, consolidation, dividend, rights and merger/demerger treatment is unverified. No adjustment factors or volume transformations are applied.")
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
                raise UpstoxProviderError('Upstox returned malformed option-contract metadata; listed strike grid is unavailable')
            if item.get('underlying_key') not in (None, underlying_key):
                raise UpstoxProviderError('Upstox option-contract underlying identity conflicts with request')
            instrument_key = item.get("instrument_key")
            symbol = item.get("trading_symbol")
            instrument_type = item.get("instrument_type")
            strike = _number(item.get("strike_price"))
            raw_lot = _number(item.get("lot_size"))
            lot_size = int(raw_lot) if raw_lot is not None and raw_lot > 0 and raw_lot.is_integer() else None
            if (not isinstance(instrument_key, str) or not instrument_key or
                    not isinstance(symbol, str) or not symbol or instrument_type not in {"CE", "PE"} or
                    strike is None or strike <= 0):
                raise UpstoxProviderError('Upstox returned malformed option-contract metadata; listed strike grid is unavailable')
            contracts.append(OptionContract(
                underlying_symbol=str(item.get("underlying_symbol") or ""),
                underlying_key=underlying_key, expiry=_expiry(item.get("expiry")),
                instrument_key=instrument_key, trading_symbol=symbol,
                instrument_type=instrument_type, strike=strike, lot_size=lot_size,
                tick_size=_number(item.get("tick_size")),
            ))
        result = tuple(contracts)
        self._oi_contract_cache[underlying_key] = result
        return result

    def _contracts_for_oi(self, underlying_key):
        if underlying_key not in self._oi_contract_cache:
            self.get_option_contracts(underlying_key)
        return self._oi_contract_cache[underlying_key]

    def _normalize_option_oi(self, value, contracts, instrument_key, expiry, strike, side):
        raw = _number(value)
        matches = [c for c in contracts if c.instrument_key == instrument_key
                   and c.expiry == expiry and c.strike == strike and c.instrument_type == side]
        lots = {c.lot_size for c in matches}
        lot = next(iter(lots)) if len(lots) == 1 else None
        if lot is None or isinstance(lot, bool) or lot <= 0 or int(lot) != lot:
            return None, raw, None, 'missing_or_invalid_contract_lot_size'
        if raw is None or raw < 0:
            return None, raw, lot, 'missing_or_invalid_oi_quantity'
        count = raw / lot
        if not count.is_integer():
            return None, raw, lot, 'non_integral_quantity_per_lot'
        return int(count), raw, lot, 'verified_quantity_to_contracts'

    def get_option_chain(self, underlying_key: str, expiry: date, *, iv_spot: float | None = None) -> OptionChain:
        data = self._transport.get("/v2/option/chain", {
            "instrument_key": underlying_key, "expiry_date": expiry.isoformat(),
        })
        if not isinstance(data, list):
            raise UpstoxProviderError("Upstox returned invalid option-chain data")
        contracts = self._contracts_for_oi(underlying_key)
        oi_issues = {}
        puts: list[tuple[float, OptionQuote]] = []
        calls: list[tuple[float, OptionQuote]] = []
        spot = None
        oi_seen = False
        iv_seen = False
        for row in data:
            if not isinstance(row, dict):
                continue
            if row.get('underlying_key') not in (None, underlying_key):
                raise UpstoxProviderError('Upstox option-chain underlying identity conflicts with request')
            if row.get('expiry') is not None and _expiry(row['expiry']) != expiry:
                raise UpstoxProviderError('Upstox option-chain expiry conflicts with request')
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
                oi, raw_oi, oi_lot, oi_status = self._normalize_option_oi(
                    market.get("oi"), contracts, instrument_key, expiry, strike,
                    "PE" if side == "put_options" else "CE")
                if oi is None:
                    oi_issues[oi_status] = oi_issues.get(oi_status, 0) + 1
                oi_seen = oi_seen or oi is not None
                iv_seen = iv_seen or iv is not None
                target.append((strike, OptionQuote(
                    instrument_key=instrument_key,
                    bid=_number(market.get("bid_price")), ask=_number(market.get("ask_price")),
                    implied_volatility=iv, open_interest=oi,
                    raw_iv=raw_iv, iv_source="option_chain" if iv is not None and iv > 0 else None,
                    raw_oi_quantity=raw_oi, oi_lot_size=oi_lot,
                    oi_normalization_status=oi_status,
                    bid_quantity=_integer(market.get("bid_qty")),
                    ask_quantity=_integer(market.get("ask_qty")),
                    volume=_integer(market.get("volume")),
                )))
        # Live comparison on 2026-10-13 established V3 iv is already decimal.
        # V2 option-chain iv above is percentage points. Never infer scale from
        # magnitude, and never replace an existing finite positive chain IV.
        iv_pairs = puts + calls
        if iv_spot is not None and math.isfinite(iv_spot):
            # Discovery needs only the nearest three valid-IV rows on each side.
            # A missing IV farther than the third already valid row cannot alter
            # that original selection. Ties retain ascending strike order.
            iv_pairs = []
            for pairs in (puts, calls):
                valid_seen = 0
                for strike, quote in sorted(pairs, key=lambda pair: (abs(pair[0]-iv_spot), pair[0])):
                    if quote.bid is None or quote.ask is None or quote.bid <= 0 or quote.ask < quote.bid:
                        continue
                    iv_pairs.append((strike, quote))
                    if quote.implied_volatility is not None and quote.implied_volatility > 0:
                        valid_seen += 1
                    if valid_seen == 3:
                        break
        invalid_keys = list(dict.fromkeys(quote.instrument_key for _, quote in iv_pairs
            if quote.implied_volatility is None or quote.implied_volatility <= 0))
        fallback, iv_errors = self._get_option_greeks_result(invalid_keys) if invalid_keys else ({}, [])
        def fill_missing(pairs):
            return [(strike, replace(quote, implied_volatility=fallback[quote.instrument_key],
                                             raw_iv=fallback[quote.instrument_key], iv_source="v3_option_greeks")
                     if (quote.implied_volatility is None or quote.implied_volatility <= 0)
                     and quote.instrument_key in fallback else quote)
                    for strike, quote in pairs]
        puts, calls = fill_missing(puts), fill_missing(calls)
        iv_seen = any(quote.implied_volatility is not None and quote.implied_volatility > 0
                      for _, quote in puts + calls)
        puts.sort(key=lambda item: item[0])
        calls.sort(key=lambda item: item[0])
        return OptionChain(
            underlying_key=underlying_key, expiry=expiry, spot=spot,
            puts=tuple(puts), calls=tuple(calls),
            open_interest=DataCapability(oi_seen, "verified" if not oi_issues else "unavailable",
                "Upstox quantity OI divided by matched authoritative contract lot size; "
                f"unusable OI values remain missing, not estimated. Invalid cases: {oi_issues}"),
            implied_volatility=DataCapability(iv_seen, "reported" if iv_seen else "unavailable",
                                              "Option-chain IV percentage points converted to decimal; missing/invalid IV uses matched V3 decimal IV when available."),
            quote_timestamp=DataCapability(False, "unavailable", "The option-chain response does not provide a per-quote timestamp."),
            iv_errors=tuple(iv_errors),
        )

    def get_option_greeks(self, instrument_keys: list[str]) -> dict[str, float]:
        """Read matched decimal V3 IV in batches; no synthetic/error fallback."""
        return self._get_option_greeks_result(instrument_keys)[0]

    def _get_option_greeks_result(self, instrument_keys):
        keys = list(dict.fromkeys(instrument_keys))
        result, errors = {}, []
        for start in range(0, len(keys), 50):
            batch = keys[start:start + 50]
            try:
                data = self._transport.get('/v3/market-quote/option-greek',
                                           {'instrument_key': ','.join(batch)})
            except UpstoxProviderError as exception:
                errors.append({'instrument_keys': batch, 'status': exception.status_code,
                               'code': exception.code, 'reason': 'V3 Option Greeks request failed'})
                continue
            if not isinstance(data, dict):
                errors.append({'instrument_keys': batch, 'status': None, 'code': None,
                               'reason': 'V3 Option Greeks returned an invalid response'})
                continue
            for item in data.values():
                if not isinstance(item, dict):
                    continue
                key, iv = item.get('instrument_token'), _number(item.get('iv'))
                if isinstance(key, str) and key in batch and iv is not None and iv > 0:
                    result[key] = iv
        return result, errors

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
