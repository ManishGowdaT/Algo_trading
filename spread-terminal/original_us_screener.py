"""
screener.py — 5-layer credit spread quant engine (importable module).

Layers:
  L1  Multi-horizon realized volatility (10/21/63/252d close-to-close log returns)
  L2  Binary Event Engine — earnings-within-DTE flag + 3y max post-earnings gap penalty
  L3  Variance Risk Premium filter — IV / RV21 >= threshold
  L4  Fat-tail empirical distribution — rolling DTE-matched returns -> P_breach
  L5  Bid-ask friction + open-interest liquidity filter

Every scan returns candidates *and* a per-layer survival funnel so the UI can
explain exactly where setups died.
"""

from __future__ import annotations

import math
import os
import random
import sys
import threading
import time as _time
import warnings
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

from applog import get_logger

log = get_logger("screener")

warnings.filterwarnings("ignore")

TRADING_DAYS_PER_YEAR = 252
CAL_TO_TRADING = 252.0 / 365.0


# --------------------------------------------------------------------------- #
# Yahoo request resiliency
# --------------------------------------------------------------------------- #
# Yahoo Finance rate-limits aggressively (HTTP 429). yfinance surfaces this as
# YfRateLimitError or, inside option_chain(), as an empty frame — which used to
# masquerade as "empty or malformed chain". We pace every outbound call to a
# minimum interval, retry rate-limit failures with exponential backoff + jitter,
# and cache history/chains briefly so Edge Discovery and a follow-up scan don't
# double-fetch the same names. All knobs are env-overridable.
_YF_MIN_INTERVAL = float(os.environ.get("YF_MIN_INTERVAL", "0.4"))  # sec/call
_YF_MAX_RETRIES = int(os.environ.get("YF_MAX_RETRIES", "4"))
_YF_CACHE_TTL = float(os.environ.get("YF_CACHE_TTL", "120"))        # seconds

_throttle_lock = threading.Lock()
_last_call = [0.0]
_cache_lock = threading.Lock()
_cache: dict[tuple, tuple[float, object]] = {}


class RateLimited(Exception):
    """Raised when Yahoo throttling survives all retries."""


def _is_rate_limited(exc: Exception) -> bool:
    blob = (type(exc).__name__ + " " + str(exc)).lower()
    return ("ratelimit" in blob or "429" in blob
            or "too many requests" in blob or "rate limit" in blob)


def _throttle() -> None:
    """Enforce a global minimum spacing between Yahoo-bound calls (thread-safe)."""
    with _throttle_lock:
        wait = _YF_MIN_INTERVAL - (_time.monotonic() - _last_call[0])
        if wait > 0:
            _time.sleep(wait)
        _last_call[0] = _time.monotonic()


def _yf_call(fn, *, label: str):
    """Paced call with backoff on rate-limit. Raises RateLimited if it persists."""
    last: Exception | None = None
    for attempt in range(_YF_MAX_RETRIES):
        _throttle()
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if _is_rate_limited(exc) and attempt < _YF_MAX_RETRIES - 1:
                backoff = (2 ** attempt) + random.uniform(0, 0.75)
                log.warning("rate limited on %s — retry %d/%d in %.1fs",
                            label, attempt + 1, _YF_MAX_RETRIES, backoff)
                _time.sleep(backoff)
                continue
            break
    if last and _is_rate_limited(last):
        raise RateLimited(str(last)) from last
    if last:
        raise last


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if hit and (_time.monotonic() - hit[0]) < _YF_CACHE_TTL:
            return hit[1]
    return None


def _cache_put(key, value) -> None:
    with _cache_lock:
        _cache[key] = (_time.monotonic(), value)


@dataclass
class ScanParams:
    dte: int = 30
    width: float = 5.0
    min_vrp: float = 1.15
    min_oi: int = 100
    max_spread_pct: float = 0.10
    min_cushion: float = 2.0
    min_ror: float = 15.0
    max_strikes: int = 12


# --------------------------------------------------------------------------- #
# Layer 0 — defensive data fetch (paced, cached, rate-limit aware)
# --------------------------------------------------------------------------- #
def fetch_history(tk: yf.Ticker, years: int = 3) -> pd.DataFrame | None:
    sym = getattr(tk, "ticker", "?")
    ckey = ("hist", sym, years)
    cached = _cache_get(ckey)
    if cached is not None:
        return cached
    hist = _yf_call(
        lambda: tk.history(period=f"{years}y", interval="1d", auto_adjust=True),
        label=f"history({sym})")
    if hist is None or hist.empty or "Close" not in hist.columns:
        return None
    hist = hist.dropna(subset=["Close"])
    out = hist if len(hist) >= 270 else None
    if out is not None:
        _cache_put(ckey, out)
    return out


def safe_option_chain(tk: yf.Ticker, expiration: str):
    sym = getattr(tk, "ticker", "?")
    ckey = ("chain", sym, expiration)
    cached = _cache_get(ckey)
    if cached is not None:
        return cached

    chain = _yf_call(lambda: tk.option_chain(expiration),
                     label=f"option_chain({sym} {expiration})")

    def _clean(df: pd.DataFrame) -> pd.DataFrame:
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

    result = (_clean(chain.puts), _clean(chain.calls))
    _cache_put(ckey, result)
    return result


def pick_expiration(tk: yf.Ticker, target_dte: int) -> tuple[str, int] | None:
    sym = getattr(tk, "ticker", "?")
    ckey = ("exps", sym)
    exps = _cache_get(ckey)
    if exps is None:
        exps = _yf_call(lambda: tk.options, label=f"options({sym})")
        if exps:
            _cache_put(ckey, exps)
    if not exps:
        return None
    today = date.today()
    best, best_diff, best_dte = None, 10**9, 0
    for e in exps:
        try:
            d = datetime.strptime(e, "%Y-%m-%d").date()
        except ValueError:
            continue
        dte = (d - today).days
        if dte < 3:
            continue
        diff = abs(dte - target_dte)
        if diff < best_diff:
            best, best_diff, best_dte = e, diff, dte
    return (best, best_dte) if best else None


# --------------------------------------------------------------------------- #
# Layer 1 — multi-horizon realized volatility
# --------------------------------------------------------------------------- #
def realized_vols(close: pd.Series) -> dict[str, float]:
    log_ret = np.log(close / close.shift(1)).dropna()
    out = {}
    for win in (10, 21, 63, 252):
        if len(log_ret) >= win:
            out[f"rv{win}"] = float(
                log_ret.iloc[-win:].std(ddof=1) * math.sqrt(TRADING_DAYS_PER_YEAR)
            )
        else:
            out[f"rv{win}"] = float("nan")
    return out


# --------------------------------------------------------------------------- #
# Layer 2 — Binary Event Engine
# --------------------------------------------------------------------------- #
def get_earnings_info(tk: yf.Ticker, close: pd.Series,
                      expiration: date) -> tuple[bool, float]:
    """(earnings inside today < d <= expiration, 3y max abs post-earnings gap %)."""
    today = date.today()
    earnings_dates: list[date] = []
    try:
        ed = tk.get_earnings_dates(limit=24)
        if ed is not None and not ed.empty:
            earnings_dates = [ts.date() for ts in ed.index if hasattr(ts, "date")]
    except Exception:
        pass
    if not any(d > today for d in earnings_dates):
        try:
            cal = tk.calendar
            raw = cal.get("Earnings Date") if isinstance(cal, dict) else (
                cal.loc["Earnings Date"].values
                if isinstance(cal, pd.DataFrame) and "Earnings Date" in cal.index
                else None
            )
            if raw is not None:
                vals = raw if isinstance(raw, (list, tuple, np.ndarray)) else [raw]
                earnings_dates += [pd.to_datetime(v).date() for v in vals]
        except Exception:
            pass

    inside = any(today < d <= expiration for d in earnings_dates)

    max_gap, cutoff = 0.0, today - timedelta(days=3 * 365)
    pct = close.pct_change()
    idx_dates = [ts.date() for ts in close.index]
    idx_pos = {d: i for i, d in enumerate(idx_dates)}
    for d in earnings_dates:
        if d < cutoff or d > today:
            continue
        for cand in (d, d + timedelta(days=1), d + timedelta(days=2),
                     d + timedelta(days=3)):
            pos = idx_pos.get(cand)
            if pos is not None:
                if pos > 0 and not math.isnan(pct.iloc[pos]):
                    max_gap = max(max_gap, abs(float(pct.iloc[pos])) * 100.0)
                break
    return inside, max_gap


def apply_earnings_penalty(p: float, cushion: float, max_gap: float) -> float:
    if max_gap <= 0 or cushion <= 0:
        return min(p * 1.25 + 0.05, 0.95)
    severity = max_gap / cushion
    scaled = p * (1.0 + severity) + max(0.0, severity - 1.0) * 0.10
    return float(min(max(scaled, p), 0.95))


# --------------------------------------------------------------------------- #
# Layer 4 — empirical fat-tail breach probability
# --------------------------------------------------------------------------- #
def empirical_breach_prob(close: pd.Series, dte_cal: int,
                          cushion_pct: float, direction: str) -> float:
    n = max(1, round(dte_cal * CAL_TO_TRADING))
    rets = (close.shift(-n) / close - 1.0).dropna() * 100.0
    if len(rets) < 60:
        return float("nan")
    return float((rets <= -cushion_pct).mean() if direction == "down"
                 else (rets >= cushion_pct).mean())


# --------------------------------------------------------------------------- #
# Layer 5 — friction
# --------------------------------------------------------------------------- #
def friction_detail(row: pd.Series) -> dict:
    mid = (row["bid"] + row["ask"]) / 2.0
    spread_pct = (row["ask"] - row["bid"]) / mid if mid > 0 else float("inf")
    return {"mid": mid, "spread_pct": spread_pct, "oi": int(row["openInterest"])}


def passes_friction(detail: dict, p: ScanParams) -> bool:
    return (detail["mid"] > 0
            and detail["spread_pct"] <= p.max_spread_pct
            and detail["oi"] >= p.min_oi)


# --------------------------------------------------------------------------- #
# Spread construction
# --------------------------------------------------------------------------- #
def build_spreads(ticker: str, spot: float, puts, calls, expiration: str,
                  dte: int, close: pd.Series, rv: dict, earnings: bool,
                  max_gap: float, p: ScanParams):
    candidates, funnel = [], {
        "considered": 0, "cushion": 0, "friction": 0,
        "paired": 0, "ror": 0, "vrp": 0, "final": 0,
    }
    rv21 = rv.get("rv21", float("nan"))

    configs = [
        ("BULL PUT", puts, lambda s: s < spot, "down", -1),
        ("BEAR CALL", calls, lambda s: s > spot, "up", +1),
    ]
    for label, df, is_otm, direction, sign in configs:
        if df is None or df.empty or math.isnan(rv21) or rv21 <= 0:
            continue
        otm = df[df["strike"].apply(is_otm)].copy()
        if otm.empty:
            continue
        otm["dist"] = (otm["strike"] - spot).abs()
        otm = otm.sort_values("dist").head(p.max_strikes)
        strikes_all = df["strike"].values

        for _, srow in otm.iterrows():
            funnel["considered"] += 1
            k_short = float(srow["strike"])
            cushion = abs(k_short - spot) / spot * 100.0
            if cushion < p.min_cushion:
                continue
            funnel["cushion"] += 1

            f_short = friction_detail(srow)
            if not passes_friction(f_short, p):
                continue

            k_long_t = k_short - p.width if sign < 0 else k_short + p.width
            mask = np.isclose(strikes_all, k_long_t, atol=0.011)
            if not mask.any():
                continue
            lrow = df[mask].iloc[0]
            f_long = friction_detail(lrow)
            if not passes_friction(f_long, p):
                continue
            funnel["friction"] += 1

            credit = f_short["mid"] - f_long["mid"]
            width = abs(float(lrow["strike"]) - k_short)
            if credit <= 0.01 or credit >= width:
                continue
            funnel["paired"] += 1

            # Return on Risk gate — cheapest filter, runs before any IV work
            max_loss = width - credit
            ror_pct = (credit / max_loss) * 100.0
            if ror_pct < p.min_ror:
                continue
            funnel["ror"] += 1

            iv = float(srow["impliedVolatility"])
            if math.isnan(iv) or iv <= 0:
                continue
            vrp = iv / rv21
            if vrp < p.min_vrp:
                continue
            funnel["vrp"] += 1

            p_raw = empirical_breach_prob(close, dte, cushion, direction)
            if math.isnan(p_raw):
                continue
            p_adj = (apply_earnings_penalty(p_raw, cushion, max_gap)
                     if earnings else p_raw)

            ev = (credit * (1 - p_adj) - max_loss * p_adj) * 100.0
            funnel["final"] += 1

            candidates.append({
                "ticker": ticker, "type": label, "expiration": expiration,
                "short_strike": k_short, "long_strike": float(lrow["strike"]),
                "width": width, "credit": round(credit, 2),
                "ror_pct": round(ror_pct, 1),
                "cushion_pct": round(cushion, 2),
                "vrp": round(vrp, 2), "iv": round(iv, 4),
                "rv21": round(rv21, 4),
                "earnings": earnings, "max_gap": round(max_gap, 2),
                "p_raw": round(p_raw, 4), "p_adj": round(p_adj, 4),
                "ev": round(ev, 0),
                "layers": {
                    "l1": {k: round(v, 4) if not math.isnan(v) else None
                           for k, v in rv.items()},
                    "l2": {"earnings_inside": earnings,
                           "max_gap_pct": round(max_gap, 2)},
                    "l3": {"iv": round(iv, 4), "rv21": round(rv21, 4),
                           "ratio": round(vrp, 2)},
                    "l4": {"p_raw": round(p_raw, 4), "p_adj": round(p_adj, 4),
                           "horizon_td": max(1, round(dte * CAL_TO_TRADING))},
                    "l5": {"short": {"spread_pct": round(f_short["spread_pct"], 4),
                                     "oi": f_short["oi"]},
                           "long": {"spread_pct": round(f_long["spread_pct"], 4),
                                    "oi": f_long["oi"]}},
                },
            })
    return candidates, funnel


# --------------------------------------------------------------------------- #
# Public entrypoints
# --------------------------------------------------------------------------- #
def scan_ticker(ticker: str, p: ScanParams) -> dict:
    """Full 5-layer scan for one ticker. Never raises; returns error in dict."""
    result = {"ticker": ticker, "ok": False, "error": None,
              "candidates": [], "funnel": None, "meta": None}
    try:
        tk = yf.Ticker(ticker)
        hist = fetch_history(tk)
        if hist is None:
            result["error"] = "insufficient or missing price history"
            log.warning("%s: %s", ticker, result["error"])
            return result
        close = hist["Close"]
        spot = float(close.iloc[-1])
        rv = realized_vols(close)

        picked = pick_expiration(tk, p.dte)
        if not picked:
            result["error"] = "no usable option expirations"
            log.warning("%s: %s", ticker, result["error"])
            return result
        expiration, dte = picked
        exp_date = datetime.strptime(expiration, "%Y-%m-%d").date()

        earnings, max_gap = get_earnings_info(tk, close, exp_date)
        puts, calls = safe_option_chain(tk, expiration)
        if (puts is None or puts.empty) and (calls is None or calls.empty):
            result["error"] = "empty or malformed option chain"
            log.warning("%s: option chain empty for %s (rate-limit or no "
                        "two-sided markets)", ticker, expiration)
            return result

        cands, funnel = build_spreads(ticker, spot, puts, calls, expiration,
                                      dte, close, rv, earnings, max_gap, p)
        result.update(ok=True, candidates=cands, funnel=funnel, meta={
            "spot": round(spot, 2), "expiration": expiration, "dte": dte,
            "earnings": earnings, "max_gap": round(max_gap, 2),
            "rv": {k: (round(v, 4) if not math.isnan(v) else None)
                   for k, v in rv.items()},
        })
        log.info("%s: ok — %d candidate(s) from %d considered (exp %s, dte %d%s)",
                 ticker, funnel["final"], funnel["considered"], expiration, dte,
                 ", EARNINGS" if earnings else "")
    except RateLimited:
        result["error"] = "rate limited by Yahoo — wait a few minutes and retry"
        log.error("%s: RATE LIMITED by Yahoo after %d retries",
                  ticker, _YF_MAX_RETRIES)
    except Exception as exc:  # noqa: BLE001 — never crash the API worker
        result["error"] = f"{type(exc).__name__}: {exc}"
        log.warning("%s: unexpected failure: %s: %s",
                    ticker, type(exc).__name__, exc)
        log.debug("%s traceback:", ticker, exc_info=True)
    return result


def _atm_iv(tk: yf.Ticker, spot: float, target_dte: int = 14) -> float:
    """Median implied vol of the 3 strikes nearest spot, puts+calls, on the
    expiration closest to `target_dte` calendar days. NaN if unavailable."""
    picked = pick_expiration(tk, target_dte)
    if not picked:
        return float("nan")
    puts, calls = safe_option_chain(tk, picked[0])
    ivs: list[float] = []
    for df in (puts, calls):
        if df is None or df.empty or "impliedVolatility" not in df.columns:
            continue
        d = df.dropna(subset=["impliedVolatility"])
        d = d[d["impliedVolatility"] > 0]
        if d.empty:
            continue
        d = d.assign(dist=(d["strike"] - spot).abs()).nsmallest(3, "dist")
        ivs.extend(float(x) for x in d["impliedVolatility"])
    return float(np.median(ivs)) if ivs else float("nan")


def edge_discovery(watchlist: list[str],
                   vrp_threshold: float = 1.20,
                   shock_threshold: float = 1.5,
                   max_workers: int = 6,
                   iv_shortlist: int = 10) -> list[dict]:
    """
    Edge Discovery Pipeline (two-stage, rate-limit friendly).

    Stage 1 (cheap, history-only) for the WHOLE universe:
      Volume Shock Index : day volume / 20d avg
      RV21               : 21d realized vol
    Stage 2 (expensive, one option-chain each) ONLY for the top `iv_shortlist`
    names by volume shock:
      VRP Spike Selector : IV(~14d ATM) / RV21

    This slashes option-chain fetches from len(universe) to `iv_shortlist`,
    which is the single biggest driver of Yahoo rate-limiting. Names outside
    the shortlist still rank on shock + RV; their VRP simply shows as unknown.

    Ranking: tickers clearing BOTH thresholds float to the top, then combined
    percentile-rank score, so the widget is never empty on a quiet tape.
    """
    from concurrent.futures import ThreadPoolExecutor

    # ---- Stage 1: history-only metrics for every name -------------------- #
    def stage1(t: str) -> dict | None:
        try:
            tk = yf.Ticker(t)
            hist = _yf_call(
                lambda: tk.history(period="4mo", interval="1d",
                                   auto_adjust=True),
                label=f"history({t})")
            if hist is None or len(hist) < 30:
                return None
            vol = hist["Volume"].dropna()
            close = hist["Close"].dropna()
            if len(vol) < 22 or len(close) < 22:
                return None
            spot = float(close.iloc[-1])
            avg20 = float(vol.iloc[-21:-1].mean())
            shock = float(vol.iloc[-1]) / avg20 if avg20 > 0 else 0.0
            lr = np.log(close / close.shift(1)).dropna()
            rv21 = (float(lr.iloc[-21:].std(ddof=1) * math.sqrt(252))
                    if len(lr) >= 21 else float("nan"))
            chg = float(close.iloc[-1] / close.iloc[-2] - 1) * 100.0
            return {
                "ticker": t, "spot": round(spot, 2), "chg": round(chg, 2),
                "rv21": round(rv21, 4) if not math.isnan(rv21) else None,
                "iv14": None, "vrp14": None,
                "shock": round(shock, 2),
                "vrp_pass": False,
                "shock_pass": bool(shock > shock_threshold),
                "_rv21_raw": rv21, "_spot_raw": spot,
            }
        except RateLimited:
            return None  # drop this name; never abort the whole pipeline
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        items = [r for r in pool.map(stage1, watchlist) if r is not None]
    if not items:
        return []

    # ---- Stage 2: IV/VRP only for the most active shortlist -------------- #
    shortlist = sorted(items, key=lambda r: r["shock"],
                       reverse=True)[:iv_shortlist]

    def stage2(rec: dict) -> None:
        try:
            tk = yf.Ticker(rec["ticker"])
            iv14 = _atm_iv(tk, rec["_spot_raw"], 14)
            rv21 = rec["_rv21_raw"]
            vrp14 = (iv14 / rv21
                     if rv21 and rv21 > 0 and not math.isnan(iv14)
                     else float("nan"))
            if not math.isnan(iv14):
                rec["iv14"] = round(iv14, 4)
            if not math.isnan(vrp14):
                rec["vrp14"] = round(vrp14, 2)
                rec["vrp_pass"] = bool(vrp14 > vrp_threshold)
        except RateLimited:
            pass  # leave VRP unknown for this name
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        list(pool.map(stage2, shortlist))

    for r in items:
        r.pop("_rv21_raw", None)
        r.pop("_spot_raw", None)

    df = pd.DataFrame(items)
    df["vrp_rank"] = df["vrp14"].rank(pct=True, na_option="bottom")
    df["shock_rank"] = df["shock"].rank(pct=True, na_option="bottom")
    df["edge"] = df["vrp_pass"] & df["shock_pass"]
    df["score"] = df["vrp_rank"] + df["shock_rank"]
    df = df.sort_values(["edge", "score"], ascending=[False, False])
    df["score"] = df["score"].round(2)
    # pandas re-introduces NaN where we had None (numeric columns upcast),
    # so convert NaN -> None on the way out for JSON-safe payloads.
    records = df.drop(columns=["vrp_rank", "shock_rank"]).to_dict("records")
    for r in records:
        for k, v in r.items():
            if isinstance(v, float) and not math.isfinite(v):
                r[k] = None
    return records


# Backward-compatible alias
trending_scan = edge_discovery
