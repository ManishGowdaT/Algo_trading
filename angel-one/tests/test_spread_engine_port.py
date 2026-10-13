import math
from datetime import date, datetime, timedelta

import pytest

from app.services.spreads.engine import (
    CAL_TO_TRADING,
    ScanParams,
    apply_earnings_penalty,
    build_spreads,
    capability_blockers,
    empirical_breach_prob,
    edge_discovery_metrics,
    edge_discovery_shortlist,
    get_earnings_info,
    pick_expiration,
    rank_edge_discovery,
    realized_vols,
    scan_provider_data,
)
from app.services.spreads.provider import (DataCapability, EarningsData, HistoryData,
                                           OptionChain, OptionQuote, PriceBar)


def test_scan_params_preserve_source_defaults():
    params = ScanParams()
    assert (params.dte, params.width, params.min_vrp, params.min_oi) == (30, 5.0, 1.15, 100)
    assert (params.max_spread_pct, params.min_cushion, params.min_ror, params.max_strikes) == (0.10, 2.0, 15.0, 12)


def test_expiration_picker_uses_nearest_valid_calendar_dte_and_first_tie():
    today = date(2026, 10, 12)
    assert pick_expiration(["2026-10-14", "bad", "2026-11-11", "2026-11-12"],
                           30, as_of=today) == ("2026-11-11", 30)
    assert pick_expiration(["2026-10-13"], 14, as_of=today) is None


def test_realized_volatility_uses_log_returns_sample_std_and_original_windows():
    closes = [100.0 * math.exp(index * 0.001) for index in range(22)]
    rv = realized_vols(closes)
    assert rv["rv10"] == pytest.approx(0.0, abs=1e-7)
    assert rv["rv21"] == pytest.approx(0.0, abs=1e-7)
    assert math.isnan(rv["rv63"])
    assert math.isnan(rv["rv252"])


def test_empirical_probability_uses_original_calendar_to_trading_horizon_and_60_sample_gate():
    horizon = max(1, round(30 * CAL_TO_TRADING))
    prices = [100.0 + index for index in range(100)]
    expected = sum((prices[i + horizon] / prices[i] - 1) * 100 <= -5 for i in range(100 - horizon)) / (100 - horizon)
    assert empirical_breach_prob(prices, 30, 5, "down") == expected
    assert math.isnan(empirical_breach_prob(prices[:horizon + 59], 30, 5, "down"))


def test_earnings_penalty_matches_original_branches_and_gap_selection():
    assert apply_earnings_penalty(0.2, 5, 0) == pytest.approx(0.3)
    assert apply_earnings_penalty(0.2, 5, 10) == pytest.approx(0.7)
    today = date(2026, 10, 12)
    dates = [(today - timedelta(days=2), 100.0), (today - timedelta(days=1), 95.0), (today, 94.0)]
    inside, gap = get_earnings_info([today - timedelta(days=1), today + timedelta(days=3)], dates,
                                    today + timedelta(days=10), as_of=today)
    assert inside is True
    assert gap == pytest.approx(5.0)


def test_spread_generation_preserves_filter_order_funnel_and_result_fields():
    closes = [100 * math.exp(0.025 * math.sin(index / 7)) for index in range(400)]
    rv = realized_vols(closes)
    puts = [
        {"strike": 90.0, "bid": 0.49, "ask": 0.51, "impliedVolatility": 0.35, "openInterest": 500},
        {"strike": 95.0, "bid": 1.85, "ask": 1.95, "impliedVolatility": 0.35, "openInterest": 500},
    ]
    calls = [
        {"strike": 105.0, "bid": 1.85, "ask": 1.95, "impliedVolatility": 0.35, "openInterest": 500},
        {"strike": 110.0, "bid": 0.49, "ask": 0.51, "impliedVolatility": 0.35, "openInterest": 500},
    ]
    candidates, funnel = build_spreads("TEST", closes[-1], puts, calls, "2026-11-11", 30,
                                       closes, rv, False, 0.0, ScanParams())
    assert funnel == {"considered": 4, "cushion": 4, "friction": 2,
                      "paired": 2, "ror": 2, "vrp": 2, "final": 2}
    assert [row["type"] for row in candidates] == ["BULL PUT", "BEAR CALL"]
    for row in candidates:
        assert row["short_strike"] == (95.0 if row["type"] == "BULL PUT" else 105.0)
        assert row["width"] == 5.0
        assert row["credit"] == 1.4
        assert row["ror_pct"] == 38.9
        assert row["layers"]["l4"]["horizon_td"] == round(30 * CAL_TO_TRADING)
        assert set(row) == {"ticker", "type", "expiration", "short_strike", "long_strike", "width",
                            "credit", "ror_pct", "cushion_pct", "vrp", "iv", "rv21", "earnings",
                            "max_gap", "p_raw", "p_adj", "ev", "layers"}


def test_upstox_history_and_earnings_gaps_block_exact_scan_without_fabrication():
    history = HistoryData("NSE_INDEX|Nifty 50", tuple(
        PriceBar(datetime(2025, 1, 1) + timedelta(days=i), 1, 1, 1, 100, 1) for i in range(300)),
        3, DataCapability(False, "unverified", "not validated"), DataCapability(True, "reported", "raw"), DataCapability(True, "verified", "complete daily candles"))
    earnings = EarningsData(False, None, None, DataCapability(False, "unavailable", "not provided"))
    blockers = capability_blockers(history, earnings)
    assert len(blockers) == 1
    assert "earnings calendar" in blockers[0]


def test_provider_orchestration_runs_only_with_explicit_required_capabilities():
    closes = [100 * math.exp(0.025 * math.sin(index / 7)) for index in range(400)]
    history = HistoryData("NSE_INDEX|Nifty 50", tuple(
        PriceBar(datetime(2025, 1, 1) + timedelta(days=i), close, close, close, close, 100)
        for i, close in enumerate(closes)), 3,
        DataCapability(True, "verified", "test verified"), DataCapability(True, "reported", "raw"), DataCapability(True, "verified", "complete daily candles"))
    chain = OptionChain("NSE_INDEX|Nifty 50", date(2026, 11, 11), closes[-1],
        ((90.0, OptionQuote("put90", 0.49, 0.51, 0.35, 500, 1, 1, 10)),
         (95.0, OptionQuote("put95", 1.85, 1.95, 0.35, 500, 1, 1, 10))),
        ((105.0, OptionQuote("call105", 1.85, 1.95, 0.35, 500, 1, 1, 10)),
         (110.0, OptionQuote("call110", 0.49, 0.51, 0.35, 500, 1, 1, 10))),
        DataCapability(True, "verified", "test verified"),
        DataCapability(True, "reported", "test data"),
        DataCapability(True, "reported", "test timestamp"))
    earnings = EarningsData(True, False, 0.0, DataCapability(True, "reported", "test data"))
    result = scan_provider_data("TEST", history, chain, earnings, date(2026, 11, 11), 30)
    assert result["ok"] is True
    assert result["funnel"]["final"] == 2
    assert result["meta"]["spot"] == round(closes[-1], 2)


def test_edge_discovery_stage_one_volume_shock_and_shortlist():
    closes = [100.0 + index * 0.2 for index in range(30)]
    volumes = [100.0] * 21 + [200.0]
    row = edge_discovery_metrics("TEST", closes, volumes)
    assert row["shock"] == 2.0
    assert row["shock_pass"] is True
    assert edge_discovery_shortlist([row, {"ticker": "OTHER", "shock": 3.0}], 1) == ["OTHER"]
    assert edge_discovery_metrics("SHORT", closes[:29], volumes) is None


def test_edge_discovery_preserves_vrp_shock_percentile_score_and_edge_sort():
    items = [
        {"ticker": "A", "spot": 100, "chg": 1, "rv21": 0.2, "iv14": None, "vrp14": None,
         "shock": 2.0, "vrp_pass": False, "shock_pass": True, "_rv21_raw": 0.2, "_spot_raw": 100},
        {"ticker": "B", "spot": 100, "chg": 0, "rv21": 0.1, "iv14": None, "vrp14": None,
         "shock": 1.0, "vrp_pass": False, "shock_pass": False, "_rv21_raw": 0.1, "_spot_raw": 100},
        {"ticker": "C", "spot": 100, "chg": -1, "rv21": 0.2, "iv14": None, "vrp14": None,
         "shock": 1.5, "vrp_pass": False, "shock_pass": False, "_rv21_raw": 0.2, "_spot_raw": 100},
    ]
    assert edge_discovery_shortlist(items, 1) == ["A"]
    ranked = rank_edge_discovery(items, {"A": 0.3, "B": 0.13, "C": 0.1}, iv_shortlist=3)
    assert [row["ticker"] for row in ranked] == ["A", "B", "C"]
    assert [row["edge"] for row in ranked] == [True, False, False]
    assert [row["score"] for row in ranked] == [2.0, 1.0, 1.0]
    assert ranked[0]["vrp14"] == 1.5
    assert ranked[1]["vrp_pass"] is True
    assert ranked[2]["vrp_pass"] is False

