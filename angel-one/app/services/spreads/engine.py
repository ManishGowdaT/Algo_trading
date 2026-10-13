"""Faithful, provider-neutral port of the ZIP's five-layer spread engine.

This module contains calculations only. It has no broker, network, order, or
application-route dependencies. See ``capability_blockers`` before using live
Upstox data: the original scanner requires adjusted closes and earnings data.
"""

from __future__ import annotations

import math
import numpy as np
import pandas as pd
from datetime import date, datetime, timedelta
from typing import Iterable, Mapping, Sequence

from .provider import EarningsData, HistoryData, OptionChain


TRADING_DAYS_PER_YEAR = 252
CAL_TO_TRADING = 252.0 / 365.0


def get_earnings_info(
    earnings_dates: Iterable[date],
    dated_closes: Sequence[tuple[date, float]],
    expiration: date,
    *,
    as_of: date | None = None,
) -> tuple[bool, float]:
    """Port of the original event flag and 3-year maximum post-event gap.

    This accepts earnings dates as data. Upstox does not currently supply that
    data; callers must not pass an empty list to imply there are no events.
    """
    today = as_of or date.today()
    events = list(earnings_dates)
    inside = any(today < day <= expiration for day in events)
    max_gap = 0.0
    cutoff = today - timedelta(days=3 * 365)
    pct_changes = dict(zip([day for day, _ in dated_closes],
                           pd.Series([close for _, close in dated_closes], dtype=float).pct_change()))
    positions = {day: index for index, (day, _) in enumerate(dated_closes)}
    for event_day in events:
        if event_day < cutoff or event_day > today:
            continue
        for candidate_day in (event_day, event_day + timedelta(days=1),
                              event_day + timedelta(days=2), event_day + timedelta(days=3)):
            position = positions.get(candidate_day)
            if position is not None:
                change = pct_changes.get(candidate_day)
                if position > 0 and change is not None and not math.isnan(change):
                    max_gap = max(max_gap, abs(change) * 100.0)
                break
    return inside, max_gap


def pick_expiration(expirations: Iterable[str], target_dte: int,
                    *, as_of: date | None = None) -> tuple[str, int] | None:
    """Choose the valid expiration nearest target DTE, excluding DTE below 3."""
    today = as_of or date.today()
    best = None
    best_diff = 10**9
    best_dte = 0
    for expiration in expirations:
        try:
            day = datetime.strptime(expiration, "%Y-%m-%d").date()
        except (TypeError, ValueError):
            continue
        dte = (day - today).days
        if dte < 3:
            continue
        difference = abs(dte - target_dte)
        if difference < best_diff:
            best, best_diff, best_dte = expiration, difference, dte
    return (best, best_dte) if best else None


def clean_option_rows(rows):
    return _clean_frame(pd.DataFrame([dict(row) for row in rows if isinstance(row, Mapping)])).to_dict("records")


def option_chain_rows(chain: OptionChain, side: str) -> list[dict]:
    """Adapt Upstox chain quotes into the source scanner's row field names."""
    if side not in {"puts", "calls"}:
        raise ValueError("side must be puts or calls")
    pairs = chain.puts if side == "puts" else chain.calls
    return clean_option_rows({
        "strike": strike,
        **quote.as_scanner_row(),
    } for strike, quote in pairs)


def atm_iv(chain, spot):
    ivs = []
    for rows in (option_chain_rows(chain, "puts"), option_chain_rows(chain, "calls")):
        df = pd.DataFrame(rows)
        if df.empty or "impliedVolatility" not in df.columns:
            continue
        d = df.dropna(subset=["impliedVolatility"])
        d = d[d["impliedVolatility"] > 0]
        d = d.assign(dist=(d["strike"] - spot).abs()).nsmallest(3, "dist")
        ivs.extend(float(x) for x in d["impliedVolatility"])
    return float(np.median(ivs)) if ivs else float("nan")


def edge_discovery_metrics(ticker, closes, volumes, shock_threshold=1.5):
    close = pd.Series(closes, dtype=float)
    vol = pd.Series(volumes, dtype=float)
    if len(close) < 30:
        return None
    close, vol = close.dropna(), vol.dropna()
    if len(close) < 22 or len(vol) < 22:
        return None
    spot = float(close.iloc[-1])
    avg20 = float(vol.iloc[-21:-1].mean())
    shock = float(vol.iloc[-1]) / avg20 if avg20 > 0 else 0.0
    lr = np.log(close / close.shift(1)).dropna()
    rv21 = float(lr.iloc[-21:].std(ddof=1) * math.sqrt(252)) if len(lr) >= 21 else float("nan")
    change = float(close.iloc[-1] / close.iloc[-2] - 1) * 100.0
    return {"ticker": ticker, "spot": round(spot, 2), "chg": round(change, 2),
            "rv21": round(rv21, 4) if not math.isnan(rv21) else None,
            "iv14": None, "vrp14": None, "shock": round(shock, 2),
            "vrp_pass": False, "shock_pass": bool(shock > shock_threshold),
            "_rv21_raw": rv21, "_spot_raw": spot}


def rank_edge_discovery(items, iv14_by_ticker, *, vrp_threshold=1.20, shock_threshold=1.5,
                        iv_status_by_ticker=None, vrp_status_by_ticker=None):
    if not items:
        return []
    rows = [dict(item) for item in items]
    for row in rows:
        iv14 = iv14_by_ticker.get(row["ticker"], float("nan"))
        rv21 = row["_rv21_raw"]
        vrp14 = iv14 / rv21 if rv21 and rv21 > 0 and not math.isnan(iv14) else float("nan")
        row["iv_status"] = (iv_status_by_ticker or {}).get(
            row["ticker"], "available" if not math.isnan(iv14) else "unavailable")
        row["vrp_status"] = (vrp_status_by_ticker or {}).get(
            row["ticker"], "available" if not math.isnan(vrp14) else "unavailable")
        if not math.isnan(iv14):
            row["iv14"] = round(iv14, 4)
        if not math.isnan(vrp14):
            row["vrp14"] = round(vrp14, 2)
            row["vrp_pass"] = bool(vrp14 > vrp_threshold)
    for row in rows:
        row.pop("_rv21_raw", None)
        row.pop("_spot_raw", None)
    df = pd.DataFrame(rows)
    df["vrp_rank"] = df["vrp14"].rank(pct=True, na_option="bottom")
    df["shock_rank"] = df["shock"].rank(pct=True, na_option="bottom")
    df["edge"] = df["vrp_pass"] & df["shock_pass"]
    df["score"] = df["vrp_rank"] + df["shock_rank"]
    df = df.sort_values(["edge", "score"], ascending=[False, False])
    df["score"] = df["score"].round(2)
    records = df.drop(columns=["vrp_rank", "shock_rank"]).to_dict("records")
    for row in records:
        for key, value in row.items():
            if isinstance(value, float) and not math.isfinite(value):
                row[key] = None
    return records


def capability_blockers(history: HistoryData, earnings: EarningsData) -> list[str]:
    """Explain source-data requirements that must be met before an exact scan."""
    blockers = []
    if not history.scanner_history_eligible:
        blockers.append("insufficient or missing price history (original requires at least 270 closes)")
    if (not earnings.available or earnings.earnings_inside is None
            or earnings.max_historical_gap_pct is None):
        blockers.append("Required earnings calendar and historical gaps unavailable: " + earnings.capability.explanation)
    return blockers


def scan_provider_data(
    ticker: str, history: HistoryData, chain: OptionChain, earnings: EarningsData,
    expiration: date, dte: int, p: ScanParams | None = None,
    *, spread_builder=None,
) -> dict:
    """Safely run the exact engine when all original input capabilities exist."""
    params = p or ScanParams()
    result = {"ticker": ticker, "ok": False, "error": None,
              "candidates": [], "funnel": None, "meta": None}
    blockers = capability_blockers(history, earnings)
    # User explicitly requested raw Upstox input scanning without validation
    # gates. These provenance notes do not alter or prevent the original math.
    warnings = []
    if chain.open_interest.status not in {"verified", "fixture"}:
        warnings.append("Using Upstox reported OI directly; source-unit equivalence is unverified.")
    if history.completeness.status not in {"verified", "fixture"}:
        warnings.append("Using returned daily candles; candle completeness is unverified.")
        if history.validation:
            warnings.append(history.completeness.explanation)
    if history.adjustment.status not in {"verified", "not_applicable", "fixture"}:
        warnings.append("Using Upstox returned closes; corporate-action adjustment equivalence is unverified.")
    result["data_warnings"] = warnings
    if history.validation:
        result['history_validation'] = history.validation
    if blockers:
        result["error"] = "; ".join(blockers)
        result["capability_blockers"] = blockers
        return result
    closes = [bar.close for bar in history.bars]
    closes = [value for value in closes if value is not None]
    if not closes:
        result["error"] = "insufficient or missing price history"
        return result
    spot = float(closes[-1])
    rv = realized_vols(closes)
    puts = option_chain_rows(chain, "puts")
    calls = option_chain_rows(chain, "calls")
    if not puts and not calls:
        result["error"] = "empty or malformed option chain"
        return result
    candidates, funnel = (spread_builder or build_spreads)(
        ticker, spot, puts, calls, expiration.isoformat(), dte, closes, rv,
        bool(earnings.earnings_inside), float(earnings.max_historical_gap_pct or 0), params,
    )
    result.update(ok=True, candidates=candidates, funnel=funnel, meta={
        "spot": round(spot, 2), "expiration": expiration.isoformat(), "dte": dte,
        "earnings": earnings.earnings_inside,
        "max_gap": round(float(earnings.max_historical_gap_pct or 0), 2),
        "rv": {key: round(value, 4) if not math.isnan(value) else None
               for key, value in rv.items()},
    })
    return result


# Thin representation adapters only; execute the original pandas/NumPy definitions.
from . import original_calculations as _original

ScanParams = _original.ScanParams
apply_earnings_penalty = _original.apply_earnings_penalty
friction_detail = _original.friction_detail
passes_friction = _original.passes_friction

def realized_vols(close):
    return _original.realized_vols(_original.pd.Series(close, dtype=float))

def empirical_breach_prob(close, dte_cal, cushion_pct, direction):
    return _original.empirical_breach_prob(_original.pd.Series(close, dtype=float), dte_cal, cushion_pct, direction)

def build_spreads(ticker, spot, puts, calls, expiration, dte, close, rv, earnings, max_gap, p):
    columns = ["strike", "bid", "ask", "impliedVolatility", "openInterest"]
    return _original.build_spreads(ticker, spot, _original.pd.DataFrame(puts, columns=columns),
        _original.pd.DataFrame(calls, columns=columns), expiration, dte,
        _original.pd.Series(close, dtype=float), rv, earnings, max_gap, p)


def _clean_frame(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.copy()
    for col in ("strike", "bid", "ask", "impliedVolatility"):
        if col not in df.columns:
            df[col] = np.nan
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if "openInterest" not in df.columns:
        df["openInterest"] = 0
    df["openInterest"] = (
        pd.to_numeric(df["openInterest"], errors="coerce").fillna(0).astype(int)
    )
    df = df.dropna(subset=["strike", "bid", "ask"])
    df = df[(df["bid"] > 0) & (df["ask"] > 0) & (df["ask"] >= df["bid"])]
    return df.sort_values("strike").reset_index(drop=True)
