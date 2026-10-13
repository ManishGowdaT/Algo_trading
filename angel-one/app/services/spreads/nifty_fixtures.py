"""Clearly synthetic, deterministic NIFTY payloads for offline workflow tests."""

from __future__ import annotations

import math
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo


NIFTY_KEY = "NSE_INDEX|Nifty 50"
BANKNIFTY_KEY = "NSE_INDEX|Nifty Bank"
FIXTURE_UNDERLYINGS = {
    "NIFTY": {"key": NIFTY_KEY, "kind": "INDEX", "spot": 25_000.0, "lot_size": 1},
    "BANKNIFTY": {"key": BANKNIFTY_KEY, "kind": "INDEX", "spot": 52_000.0, "lot_size": 1},
    "RELIANCE": {"key": "NSE_EQ|INE002A01018", "kind": "EQUITY", "spot": 1_450.0, "lot_size": 250},
    "HDFCBANK": {"key": "NSE_EQ|INE040A01034", "kind": "EQUITY", "spot": 1_700.0, "lot_size": 550},
}
IST = ZoneInfo("Asia/Kolkata")


def nifty_fixture_payloads(*, today: date | None = None) -> dict:
    """Return Upstox-shaped sample payloads; never use these as live market data."""
    today = today or datetime.now(IST).date()
    expiry = today + timedelta(days=30)
    while expiry.weekday() != 3:  # representative weekly NSE expiry (Thursday)
        expiry += timedelta(days=1)
    expiry_text = expiry.isoformat()

    trading_days = []
    cursor = today
    while len(trading_days) < 320:
        if cursor.weekday() < 5:
            trading_days.append(cursor)
        cursor -= timedelta(days=1)
    trading_days.reverse()

    candles = []
    closes = []
    for index, day in enumerate(trading_days):
        close = 25_000.0 * math.exp(0.025 * math.sin(index / 7.0))
        closes.append(close)
        candles.append([
            datetime.combine(day, time(15, 30), tzinfo=IST).isoformat(),
            round(close - 8, 2), round(close + 30, 2), round(close - 35, 2),
            round(close, 2), 1_250_000 + index * 100, 0,
        ])
    spot = round(closes[-1], 2)

    contracts = []
    rows = []
    for strike in range(23_000, 27_001, 50):
        put_key = f"NSE_FO|NIFTY-{expiry_text}-{strike}-PE"
        call_key = f"NSE_FO|NIFTY-{expiry_text}-{strike}-CE"
        put_mid = max(2.0, 20.0 + (strike - 23_500) * 0.30)
        call_mid = max(2.0, 20.0 + (26_500 - strike) * 0.30)

        def option_payload(instrument_key: str, mid: float) -> dict:
            return {
                "instrument_key": instrument_key,
                "market_data": {
                    "bid_price": round(mid - 0.5, 2), "ask_price": round(mid + 0.5, 2),
                    "oi": 25_000, "bid_qty": 1_000, "ask_qty": 1_000, "volume": 8_000,
                },
                "option_greeks": {"iv": 25.0},
            }

        rows.append({
            "strike_price": strike,
            "underlying_spot_price": spot,
            "put_options": option_payload(put_key, put_mid),
            "call_options": option_payload(call_key, call_mid),
        })
        for key, kind in ((put_key, "PE"), (call_key, "CE")):
            contracts.append({
                "underlying_symbol": "NIFTY", "expiry": expiry_text,
                "instrument_key": key,
                "trading_symbol": f"NIFTY-FIXTURE-{strike}-{kind}",
                "instrument_type": kind, "strike_price": strike,
                "lot_size": 1, "tick_size": 0.05, "segment": "NSE_FO",
            })

    # Upstox V3 returns recent candles first. The production adapter sorts them.
    return {
        f"contracts:{NIFTY_KEY}": contracts,
        f"chain:{NIFTY_KEY}:{expiry_text}": rows,
        f"history:{NIFTY_KEY}": {"candles": list(reversed(candles))},
    }


def spread_fixture_payloads(*, today: date | None = None) -> dict:
    """NIFTY plus BANKNIFTY and sample NSE F&O stock fixtures for offline tests."""
    payloads = nifty_fixture_payloads(today=today)
    today = today or datetime.now(IST).date()
    expiry = today + timedelta(days=30)
    while expiry.weekday() != 3:
        expiry += timedelta(days=1)
    expiry_text = expiry.isoformat()

    trading_days = []
    cursor = today
    while len(trading_days) < 320:
        if cursor.weekday() < 5:
            trading_days.append(cursor)
        cursor -= timedelta(days=1)
    trading_days.reverse()

    for symbol, info in FIXTURE_UNDERLYINGS.items():
        if symbol == "NIFTY":
            continue
        instrument_key = info["key"]
        closes = [info["spot"] * math.exp(0.025 * math.sin(index / 7.0)) for index in range(len(trading_days))]
        candles = [[
            datetime.combine(day, time(15, 30), tzinfo=IST).isoformat(),
            round(close - 8, 2), round(close + 30, 2), round(close - 35, 2),
            round(close, 2), 125_000 + index * 100, 0,
        ] for index, (day, close) in enumerate(zip(trading_days, closes))]
        spot = round(closes[-1], 2)
        step = 100 if symbol == "BANKNIFTY" else (50 if info["kind"] == "INDEX" else 10)
        center = round(spot / step) * step
        extent = 2_400 if symbol == "BANKNIFTY" else 1_000
        contracts = []
        rows = []
        for strike in range(center - extent, center + extent + 1, step):
            put_key = f"NSE_FO|{symbol}-{expiry_text}-{strike}-PE"
            call_key = f"NSE_FO|{symbol}-{expiry_text}-{strike}-CE"
            distance = abs(strike - center)
            premium_base, premium_slope = (350.0, 0.20) if symbol == "BANKNIFTY" else (40.0, 0.30)
            put_mid = max(2.0, premium_base - distance * premium_slope)
            call_mid = max(2.0, premium_base - distance * premium_slope)

            def option_payload(key: str, mid: float) -> dict:
                return {"instrument_key": key, "market_data": {
                    "bid_price": round(mid - 0.5, 2), "ask_price": round(mid + 0.5, 2),
                    "oi": 25_000, "bid_qty": 1_000, "ask_qty": 1_000, "volume": 8_000,
                }, "option_greeks": {"iv": 25.0}}

            rows.append({"strike_price": strike, "underlying_spot_price": spot,
                         "put_options": option_payload(put_key, put_mid),
                         "call_options": option_payload(call_key, call_mid)})
            for key, kind in ((put_key, "PE"), (call_key, "CE")):
                contracts.append({"underlying_symbol": symbol, "expiry": expiry_text,
                    "instrument_key": key, "trading_symbol": f"{symbol}-FIXTURE-{strike}-{kind}",
                    "instrument_type": kind, "strike_price": strike,
                    "lot_size": info["lot_size"], "tick_size": 0.05, "segment": "NSE_FO"})
        payloads[f"contracts:{instrument_key}"] = contracts
        payloads[f"chain:{instrument_key}:{expiry_text}"] = rows
        payloads[f"history:{instrument_key}"] = {"candles": list(reversed(candles))}
        if info["kind"] == "EQUITY":
            payloads[f"search:{symbol}"] = [{
                "segment": "NSE_EQ", "trading_symbol": symbol, "instrument_key": instrument_key,
                "name": symbol, "isin": instrument_key.split("|", 1)[1],
            }]
    return payloads

