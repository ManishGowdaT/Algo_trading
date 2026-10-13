"""Rank executable-side credit spread snapshots, without probability claims."""
import math


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else 0.0
    except (TypeError, ValueError):
        return 0.0


def rank_spreads(chain, contracts, width=100, min_oi=100, min_ror=5):
    lots = {c['instrument_key']: int(c.get('lot_size', 0)) for c in contracts}
    results = []
    for side, label, direction in [('put_options', 'BULL PUT', -1), ('call_options', 'BEAR CALL', 1)]:
        rows = {number(r.get('strike_price')): r for r in chain}
        for strike, row in rows.items():
            spot = number(row.get('underlying_spot_price'))
            if spot <= 0 or (direction == -1 and strike >= spot) or (direction == 1 and strike <= spot):
                continue
            hedge = rows.get(strike + direction * width)
            if not hedge:
                continue
            short, long = row.get(side) or {}, hedge.get(side) or {}
            sm, lm = short.get('market_data') or {}, long.get('market_data') or {}
            lot = lots.get(short.get('instrument_key'), 0)
            if lot <= 0 or lots.get(long.get('instrument_key')) != lot:
                continue
            if any(number(m.get('bid_price')) <= 0 or number(m.get('ask_price')) < number(m.get('bid_price')) or number(m.get('oi')) < min_oi for m in (sm, lm)):
                continue
            if number(sm.get('bid_qty')) < lot or number(lm.get('ask_qty')) < lot:
                continue
            credit = number(sm.get('bid_price')) - number(lm.get('ask_price'))
            if not 0 < credit < width:
                continue
            ror = credit / (width-credit) * 100
            if ror < min_ror:
                continue
            results.append(dict(type=label, short_strike=strike, long_strike=strike+direction*width,
                short_key=short['instrument_key'], long_key=long['instrument_key'], lot_size=lot,
                credit=round(credit, 2), max_profit=round(credit*lot, 2),
                max_loss=round((width-credit)*lot, 2), ror_pct=round(ror, 2),
                breakeven=round(strike+direction*credit, 2),
                cushion_pct=round(abs(spot-strike)/spot*100, 2)))
    results.sort(key=lambda c: (-c['ror_pct'], -c['cushion_pct'], c['type'], c['short_strike']))
    return [dict(c, rank=i+1) for i, c in enumerate(results)]
