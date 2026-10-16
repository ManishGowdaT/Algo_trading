"""Offline replay of authenticated 16 October captures with independent expectations."""
import json
import math
import os
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'angel-one'))
os.environ['SPREADS_DATA_MODE'] = 'upstox'
from app.services.spreads import api, upstox_adapter
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider
from app.services.spreads.provider import EarningsData, DataCapability

class Clock(datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 16, 9, 32, tzinfo=tz)

api.datetime = Clock
upstox_adapter.datetime = Clock
out = []
for name in ['4845a715-bf02-4fca-b574-447b41ff8b59', '7333ae5b-9f3b-49a2-a510-4ee9739457b7']:
    captured = json.loads((ROOT / 'tmp/spread-audit' / (name + '.json')).read_text())
    class Transport:
        def get(self, path, params=None):
            for response in captured['raw_upstox']:
                if response['path'] == path or (path.startswith('/v3/historical-candle/') and response['path'].startswith('/v3/historical-candle/')):
                    return response['data']
            raise AssertionError('Replay has no captured response: ' + path)
    provider = UpstoxMarketDataProvider(transport=Transport())
    provider.resolve_underlying = lambda symbol: captured['underlying']
    event = captured['earnings']
    provider.get_earnings_info = lambda *args: EarningsData(event['available'], event['earnings_inside'], event['max_historical_gap_pct'], DataCapability(**event['capability']))
    api._provider = lambda *args: provider
    request = api.NiftyScanRequest(strategy_profile='NSE_PAYOFF_RESEARCH_V2', expiry=date(2026, 11, 23),
                                  min_vrp=1, min_cushion=1.5, min_ror=10)
    scan = api._scan_underlying(captured['ticker'], request, None, 'offline-replay-no-token')
    assert scan['ok']
    closes = captured['normalized']['closes']
    spot = captured['chain']['spot']
    horizon = round(scan['dte'] * 252 / 365)
    for c in scan['candidates']:
        short, long = c['short_strike'], c['long_strike']
        assert short > spot if c['type'] == 'BEAR CALL' else short < spot
        assert c['cushion_pct'] == round(abs(short-spot)/spot*100, 2)
        credit = c['leg_inputs']['short']['midpoint'] - c['leg_inputs']['long']['midpoint']
        payoffs = []
        for i in range(len(closes)-horizon):
            terminal = spot * closes[i+horizon] / closes[i]
            loss = min(max(terminal-short if c['type']=='BEAR CALL' else short-terminal, 0), abs(long-short))
            payoffs.append(credit-loss)
        expected_mean = math.fsum(payoffs)/len(payoffs)
        assert c['ev'] == round(expected_mean*100)
        assert c['ev_per_lot_inr'] == round(expected_mean*c['lot_size'], 2)
        assert c['probability_sample_count'] == len(payoffs)
        assert c['p_raw'] == c['p_adj']
    if captured['ticker'] == 'INFY':
        assert not any(c['type']=='BEAR CALL' and c['short_strike']==1140 for c in scan['candidates'])
    out.append(scan)
target = ROOT / 'tmp/spread-audit/payoff-v2-replay.json'
target.write_text(json.dumps({'status':'PASS', 'scope':'Offline replay of 16 October authenticated captures. No new broker requests.', 'scans':out}, indent=2, allow_nan=False))
print(json.dumps({'status':'PASS', 'scans':[(s['symbol'], len(s['candidates']), s['meta']['spot']) for s in out],
                  'independent_candidates':sum(len(s['candidates']) for s in out), 'INFY_1140_short_call_excluded':True}))
