"""Read captured inputs only; no production calculators or broker requests."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BATCH = ROOT / 'batch-303cd255-87d5-4f12-8ed4-23d1d09e5a88.json'
batch = json.loads(BATCH.read_text())
rows, sources = [], []
for scan in batch['result']['underlyings']:
    if scan['symbol'] not in ('INFY', 'RELIANCE'):
        continue
    capture_path = Path(scan['scan_audit']['file'])
    capture = json.loads(capture_path.read_text())
    inputs = capture['normalized']
    closes = inputs['closes']
    horizon = max(1, round(inputs['dte'] * 252 / 365))
    returns = [b / a - 1 for a, b in zip(closes, closes[horizon:])]
    gap = inputs['max_gap']
    sources.append({'symbol': scan['symbol'], 'capture': str(capture_path),
                    'earnings': capture['earnings'], 'latest_candle': capture['latest_historical_candle'],
                    'observations': len(returns), 'horizon_sessions': horizon,
                    'chain_spot': capture['chain']['spot'], 'calculation_spot': inputs['spot'],
                    'quote_timestamp': capture['chain']['quote_timestamp']})
    for c in scan['candidates']:
        quotes = inputs['calls'] if c['type'] == 'BEAR CALL' else inputs['puts']
        short = next(q for q in quotes if q['instrument_key'] == c['short_instrument_key'])
        long = next(q for q in quotes if q['instrument_key'] == c['long_instrument_key'])
        credit = (short['bid'] + short['ask'] - long['bid'] - long['ask']) / 2
        width = abs(c['short_strike'] - c['long_strike'])
        cushion = abs(c['short_strike'] - inputs['spot']) / inputs['spot']
        hits = sum(r >= cushion if c['type'] == 'BEAR CALL' else r <= -cushion for r in returns)
        raw = hits / len(returns)
        adjusted = raw
        if inputs['earnings']:
            if gap <= 0 or cushion <= 0:
                adjusted = min(raw * 1.25 + .05, .95)
            else:
                severity = gap / (cushion * 100)
                adjusted = min(max(raw * (1 + severity) + max(0, severity - 1) * .10, raw), .95)
        unadjusted_score = 100 * (credit - width * raw)
        score = 100 * (credit - width * adjusted)
        assert round(raw, 4) == c['p_raw']
        assert round(adjusted, 4) == c['p_adj']
        assert round(score) == c['ev']
        assert len(returns) == c['probability_sample_count']
        assert abs(credit - c['credit_points_unrounded']) < 1e-10
        rows.append({'symbol': scan['symbol'], 'type': c['type'], 'short': c['short_strike'],
                     'long': c['long_strike'], 'credit': credit, 'width': width,
                     'raw_breach_count': hits, 'samples': len(returns),
                     'p_raw': raw, 'p_adj': adjusted, 'earnings_inside': inputs['earnings'],
                     'max_gap_pct': gap, 'score_without_earnings_adjustment': unadjusted_score,
                     'earnings_score_change': score - unadjusted_score,
                     'final_score_unrounded': score, 'displayed_score': c['ev']})
out = {'status': 'PASS', 'scope': 'Fresh 16 October diagnostic capture; all 8 candidates independently reconciled. Earlier screenshot was not retained.',
       'sources': sources, 'rows': rows}
(ROOT / 'live-negative-ev-explanation.json').write_text(json.dumps(out, indent=2))
for r in rows:
    print(f"{r['symbol']} {r['type']} {r['short']:g}/{r['long']:g}: {r['raw_breach_count']}/{r['samples']}; p {r['p_raw']:.4%}->{r['p_adj']:.4%}; score {r['score_without_earnings_adjustment']:.2f} {r['earnings_score_change']:+.2f} = {r['final_score_unrounded']:.2f} -> {r['displayed_score']:g}")
print('PASS: independently verified midpoints, credit, sample counts, probabilities, earnings adjustment and EV for 8 candidates.')
