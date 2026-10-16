"""Versioned historical payoff research; never used by the original profiles."""
import math
from . import nse_calculations as nse

PROFILE = 'NSE_PAYOFF_RESEARCH_V2'


def scenario_payoffs(closes, dte, spot, short, long, credit, is_call):
    if not math.isfinite(spot) or spot <= 0:
        raise ValueError('V2 requires a positive finite chain-reported underlying spot; no historical-close fallback.')
    values = list(closes)
    if any(not math.isfinite(v) or v <= 0 for v in values):
        raise ValueError('V2 requires positive finite historical closes.')
    horizon = max(1, round(dte * 252 / 365))
    outcomes = []
    for start, end in zip(values, values[horizon:]):
        terminal = spot * (end / start)
        if not math.isfinite(terminal):
            raise ValueError('Non-finite V2 historical terminal scenario.')
        liability = (max(terminal - short, 0) - max(terminal - long, 0) if is_call
                     else max(short - terminal, 0) - max(long - terminal, 0))
        outcomes.append(credit - liability)
    return outcomes


def build_spreads(ticker, spot, puts, calls, expiration, dte, close, rv,
                  earnings, max_gap, params, resolve_pair, rejections):
    # Preserve market-structure/liquidity gates. V2 does not use the V1 earnings
    # probability heuristic: historical scenarios already contain event periods.
    candidates, funnel = nse.build_spreads(ticker, spot, puts, calls, expiration,
        dte, close, rv, False, max_gap, params, resolve_pair, rejections)
    for candidate in candidates:
        outcomes = scenario_payoffs(close, dte, spot, candidate['short_strike'],
            candidate['long_strike'], candidate['credit_points_unrounded'], candidate['type'] == 'BEAR CALL')
        mean = math.fsum(outcomes) / len(outcomes)
        candidate.update(strategy_profile=PROFILE, earnings=earnings,
            ev=round(mean * 100, 0), payoff_mean_per_unit=mean,
            probability_sample_count=len(outcomes), reference_spot=spot,
            payoff_model='historical_vertical_expiry_payoff',
            earnings_treatment='unconditional_history_no_probability_uplift',
            historical_loss_probability=sum(value < 0 for value in outcomes) / len(outcomes))
        candidate['layers']['l2']['earnings_inside'] = earnings
    return candidates, funnel
