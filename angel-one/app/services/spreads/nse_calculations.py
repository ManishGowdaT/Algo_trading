"""NSE market-structure profile. Universal math calls the untouched ZIP helpers.

Only hedge selection and the positive-credit granularity gate differ from the
ZIP build_spreads body below. No probability, threshold tuning or EV changes.
"""
import math
from fractions import Fraction
import numpy as np
import pandas as pd
from .original_calculations import (ScanParams, friction_detail, passes_friction,
    empirical_breach_prob, apply_earnings_penalty, CAL_TO_TRADING)

ORIGINAL_ZIP_BASELINE = "ORIGINAL_ZIP_BASELINE"
NSE_RESEARCH_V1 = "NSE_RESEARCH_V1"


def contract_tick_inr(contract, tick_unit):
    if contract.tick_size is None or not math.isfinite(contract.tick_size) or contract.tick_size <= 0:
        return None
    # Upstox developer topic17796 explicitly confirms Option Contracts ticks are paise.
    # Synthetic fixtures already express tick_size in rupees; no magnitude inference.
    return Fraction(str(contract.tick_size)) / (100 if tick_unit == 'paise' else 1)


def midpoint_quantum(short_tick, long_tick):
    denominator = math.lcm(short_tick.denominator, long_tick.denominator)
    a = short_tick.numerator * (denominator // short_tick.denominator)
    b = long_tick.numerator * (denominator // long_tick.denominator)
    return Fraction(math.gcd(a, b), denominator * 2)


def pair_resolver(contracts, expiry, width_steps, tick_unit, issues):
    if tick_unit not in {'paise', 'rupees'}:
        raise ValueError('Explicit contract tick unit is required')
    index = {}
    for contract in contracts:
        if contract.expiry == expiry:
            index.setdefault((contract.instrument_type, contract.strike), []).append(contract)
    grids = {side: sorted({strike for kind,strike in index if kind == side}) for side in ('CE','PE')}

    def reject(reason, short, **extra):
        issues.append({'short_strike':float(short.strike), 'reason':reason, **extra})
        return None

    def resolve(sign, short, frame):
        side = 'PE' if sign < 0 else 'CE'
        grid = grids[side]
        if float(short.strike) not in grid:
            return reject('short_strike_not_listed', short)
        position = grid.index(float(short.strike))
        hedge_position = position + sign * width_steps
        if hedge_position < 0 or hedge_position >= len(grid):
            return reject('listed_hedge_steps_unavailable', short)
        hedge = grid[hedge_position]
        rows = frame[frame.strike == hedge]
        if len(rows) != 1 or len(frame[frame.strike == short.strike]) != 1:
            return reject('missing_or_ambiguous_listed_hedge_quote', short, long_strike=hedge)
        long = rows.iloc[0]
        legs = []
        for row in (short,long):
            matches = [c for c in index.get((side,float(row.strike)), []) if c.instrument_key == row.get('instrument_key')]
            if not matches or len({(c.instrument_key,c.underlying_key,c.lot_size,c.tick_size) for c in matches}) != 1:
                return reject('missing_or_conflicting_contract_metadata', short, long_strike=hedge)
            legs.append(matches[0])
        if legs[0].underlying_key != legs[1].underlying_key or legs[0].lot_size != legs[1].lot_size or legs[0].lot_size is None or legs[0].lot_size <= 0:
            return reject('incompatible_leg_lot_sizes', short, long_strike=hedge)
        ticks = [contract_tick_inr(c,tick_unit) for c in legs]
        if any(t is None for t in ticks):
            return reject('missing_or_invalid_contract_tick', short, long_strike=hedge)
        valid = all(abs(float(row[field]) / float(tick) - round(float(row[field]) / float(tick))) <= 1e-7
                    for row,tick in zip((short,long),ticks) for field in ('bid','ask'))
        return long, {'strategy_profile':NSE_RESEARCH_V1, 'width_steps':width_steps,
            'strike_interval':abs(grid[position+sign]-float(short.strike)),
            'minimum_credit_points':float(midpoint_quantum(*ticks)),
            'short_tick_inr':float(ticks[0]), 'long_tick_inr':float(ticks[1]),
            'quote_ticks_valid':valid}
    return resolve


def build_spreads(ticker: str, spot: float, puts, calls, expiration: str,
                  dte: int, close: pd.Series, rv: dict, earnings: bool,
                  max_gap: float, p: ScanParams, resolve_pair, rejections=None):
    candidates, funnel = [], {
        "considered": 0, "cushion": 0, "friction": 0,
        "paired": 0, "ror": 0, "vrp": 0, "final": 0,
    }
    def reject(reason, label, short, long=None):
        if rejections is not None:
            rejections.append({'reason': reason, 'strategy': label, 'short_strike': float(short),
                               **({'long_strike': float(long)} if long is not None else {})})

    def friction_reason(detail, leg):
        if detail['oi'] < 0:
            return f'{leg}_MISSING_OI'
        if detail['oi'] < p.min_oi:
            return f'{leg}_OI'
        if detail['spread_pct'] > p.max_spread_pct:
            return f'{leg}_BID_ASK'
        return f'{leg}_INVALID_QUOTE'

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
                reject('CUSHION', label, k_short)
                continue
            funnel["cushion"] += 1

            f_short = friction_detail(srow)
            if not passes_friction(f_short, p):
                reject(friction_reason(f_short, 'SHORT'), label, k_short)
                continue

            selected = resolve_pair(sign, srow, df)
            if selected is None:
                continue
            lrow, market = selected
            f_long = friction_detail(lrow)
            if not passes_friction(f_long, p):
                reject(friction_reason(f_long, 'LONG'), label, k_short, lrow.strike)
                continue
            funnel["friction"] += 1

            credit = f_short["mid"] - f_long["mid"]
            width = abs(float(lrow["strike"]) - k_short)
            if not market["quote_ticks_valid"] or credit < market["minimum_credit_points"] - 1e-12 or credit >= width:
                reject('INVALID_TICK_OR_CREDIT', label, k_short, lrow.strike)
                continue
            funnel["paired"] += 1

            # Return on Risk gate � cheapest filter, runs before any IV work
            max_loss = width - credit
            ror_pct = (credit / max_loss) * 100.0
            if ror_pct < p.min_ror:
                reject('ROR', label, k_short, lrow.strike)
                continue
            funnel["ror"] += 1

            iv = float(srow["impliedVolatility"])
            if math.isnan(iv) or iv <= 0:
                reject('MISSING_IV', label, k_short, lrow.strike)
                continue
            vrp = iv / rv21
            if vrp < p.min_vrp:
                reject('VRP', label, k_short, lrow.strike)
                continue
            funnel["vrp"] += 1

            p_raw = empirical_breach_prob(close, dte, cushion, direction)
            if math.isnan(p_raw):
                reject('INSUFFICIENT_PROBABILITY_SAMPLE', label, k_short, lrow.strike)
                continue
            p_adj = (apply_earnings_penalty(p_raw, cushion, max_gap)
                     if earnings else p_raw)

            ev = (credit * (1 - p_adj) - max_loss * p_adj) * 100.0
            funnel["final"] += 1

            candidates.append({
                **market,
                "credit_points_unrounded": credit,
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
