"""Unmodified calculation definitions from uploaded spread-terminal/screener.py.
Source SHA256: 6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa.
Provider acquisition is deliberately excluded. Do not edit formulas here.
"""
import math
from dataclasses import dataclass
import numpy as np
import pandas as pd
TRADING_DAYS_PER_YEAR = 252
CAL_TO_TRADING = 252.0 / 365.0

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

def apply_earnings_penalty(p: float, cushion: float, max_gap: float) -> float:
    if max_gap <= 0 or cushion <= 0:
        return min(p * 1.25 + 0.05, 0.95)
    severity = max_gap / cushion
    scaled = p * (1.0 + severity) + max(0.0, severity - 1.0) * 0.10
    return float(min(max(scaled, p), 0.95))

def empirical_breach_prob(close: pd.Series, dte_cal: int,
                          cushion_pct: float, direction: str) -> float:
    n = max(1, round(dte_cal * CAL_TO_TRADING))
    rets = (close.shift(-n) / close - 1.0).dropna() * 100.0
    if len(rets) < 60:
        return float("nan")
    return float((rets <= -cushion_pct).mean() if direction == "down"
                 else (rets >= cushion_pct).mean())

def friction_detail(row: pd.Series) -> dict:
    mid = (row["bid"] + row["ask"]) / 2.0
    spread_pct = (row["ask"] - row["bid"]) / mid if mid > 0 else float("inf")
    return {"mid": mid, "spread_pct": spread_pct, "oi": int(row["openInterest"])}

def passes_friction(detail: dict, p: ScanParams) -> bool:
    return (detail["mid"] > 0
            and detail["spread_pct"] <= p.max_spread_pct
            and detail["oi"] >= p.min_oi)

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
