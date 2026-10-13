"""Offline audit: original ZIP calculation functions vs current port; no network."""
import ast
import json
import math
import sys
import types
import zipfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "angel-one"))
from app.services.spreads import engine

with zipfile.ZipFile(Path.home() / "Downloads" / "spread-terminal.zip") as archive:
    original = archive.read("spread-terminal/screener.py").decode("utf-8-sig")
tree = ast.parse(original)
names = {"ScanParams", "realized_vols", "apply_earnings_penalty", "empirical_breach_prob",
         "friction_detail", "passes_friction", "build_spreads"}
nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
         and node.name in names]
reference = types.ModuleType("spread_zip_audit_reference")
sys.modules[reference.__name__] = reference
reference.__dict__.update(math=math, np=np, pd=pd, dataclass=dataclass,
                          TRADING_DAYS_PER_YEAR=252, CAL_TO_TRADING=252 / 365)
exec(compile(ast.Module(body=nodes, type_ignores=[]), "original-ZIP/screener.py", "exec"), reference.__dict__)

rng = np.random.default_rng(910)
matches = 0
candidate_count = 0
differences = []
for case in range(100):
    closes = 100 * np.exp(np.cumsum(rng.normal(0, 0.012, 400)))
    series = pd.Series(closes)
    original_rv = reference.realized_vols(series)
    port_rv = engine.realized_vols(closes)
    assert all(np.isclose(original_rv[key], port_rv[key], atol=1e-14)
               for key in original_rv), "RV numerical parity failed"
    spot = float(closes[-1])
    strikes = np.arange(math.floor(spot / 5) * 5 - 45, math.floor(spot / 5) * 5 + 50, 5)
    puts, calls = [], []
    for index, strike in enumerate(strikes):
        iv = 0.45 if index % 7 else float("nan")
        oi = 250 if index % 5 else 10
        for rows, mid in [(puts, 0.2 + index * 0.6), (calls, 0.2 + (len(strikes) - index) * 0.6)]:
            rows.append(dict(strike=float(strike), bid=mid * 0.98, ask=mid * 1.02,
                             impliedVolatility=iv, openInterest=oi))
    params = dict(dte=[5, 14, 30, 90, 180][case % 5], width=[5., 10., 15.][case % 3],
                  min_vrp=[0.5, 1.15, 2.][case % 3], min_oi=100,
                  max_spread_pct=.1, min_cushion=[0., 2., 5.][case % 3],
                  min_ror=[5., 15., 50.][case % 3], max_strikes=12)
    args = ("AUDIT", spot, pd.DataFrame(puts), pd.DataFrame(calls), "2026-12-31",
            params["dte"], series, original_rv, case % 2 == 0, 8.)
    expected = reference.build_spreads(*args, reference.ScanParams(**params))
    actual = engine.build_spreads("AUDIT", spot, puts, calls, "2026-12-31", params["dte"],
                                 closes, port_rv, case % 2 == 0, 8., engine.ScanParams(**params))
    candidate_count += len(expected[0])
    if expected == actual:
        matches += 1
    else:
        differences.append({"case": case, "reference_count": len(expected[0]),
                            "port_count": len(actual[0]), "funnel_equal": expected[1] == actual[1]})
print(json.dumps({"offline_cases": 100, "matching_cases": matches,
                  "reference_candidates_compared": candidate_count, "differences": differences,
                  "scope": "calculation functions only; not API aggregation, UI, provider, or live parity"}, indent=2))
