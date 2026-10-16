"""Read-only raw SmartAPI 1M index sample validation; never connects or trades.

Usage: python validate_index_ohlcv.py sample.json --output report.json
Sample: {"underlying":"NIFTY", "date":"2026-10-16", "exchange":"NSE",
         "symboltoken":"99926000", "interval":"ONE_MINUTE",
         "source":"ANGEL_ONE_RAW_HISTORICAL", "data":[[timestamp,O,H,L,C,V],...]}
Run separately for each index. A source label is metadata, not authenticity proof.
"""
import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
INSTRUMENTS = {'NIFTY': ('NSE', '99926000'), 'BANKNIFTY': ('NSE', '99926009'), 'SENSEX': ('BSE', '99919000')}


def validate(sample):
    errors, series, volumes, seen = [], [], [], set()
    underlying = sample.get('underlying')
    expected = INSTRUMENTS.get(underlying)
    if expected is None or (sample.get('exchange'), str(sample.get('symboltoken'))) != expected:
        errors.append('INDEX_IDENTITY_MISMATCH')
    if sample.get('interval') != 'ONE_MINUTE': errors.append('REQUIRES_ONE_MINUTE')
    if sample.get('source') != 'ANGEL_ONE_RAW_HISTORICAL': errors.append('RAW_SOURCE_NOT_DECLARED')
    try:
        start = datetime.fromisoformat(sample['date']).replace(hour=9, minute=15, tzinfo=IST)
    except (KeyError, TypeError, ValueError):
        return {'underlying': underlying, 'valid': False, 'errors': ['INVALID_SESSION_DATE']}
    end = start.replace(hour=11, minute=30)
    rows = sample.get('data')
    if not isinstance(rows, list): rows = []; errors.append('NO_RAW_ROWS')
    prior = None
    weighted, total = 0.0, 0.0
    selected = []
    for i, row in enumerate(rows):
        if not isinstance(row, list) or len(row) < 6:
            errors.append(f'ROW_{i}_MISSING_OHLCV'); continue
        try:
            ts = datetime.fromisoformat(row[0].replace('Z', '+00:00'))
            if ts.tzinfo is None: raise ValueError('ambiguous timestamp')
            ts = ts.astimezone(IST)
            if not start <= ts < end: continue
            if ts.second or ts.microsecond: raise ValueError('unaligned')
            if ts in seen: errors.append(f'ROW_{i}_DUPLICATE')
            if prior is not None and ts <= prior: errors.append(f'ROW_{i}_NON_MONOTONIC')
            seen.add(ts); prior = ts
            if any(v is None or isinstance(v, bool) for v in row[1:6]): raise ValueError('missing values')
            o, h, l, c, v = [float(x) for x in row[1:6]]
            if not all(math.isfinite(x) for x in (o,h,l,c,v)) or min(o,h,l,c) <= 0 or v < 0:
                raise ValueError('invalid values')
            if h < max(o,c) or l > min(o,c) or h < l: raise ValueError('invalid OHLC')
            weighted += ((h+l+c)/3)*v; total += v; volumes.append(v)
            selected.append((ts,h,l))
            series.append({'closeTime':(ts+timedelta(minutes=1)).isoformat(), 'vwap':weighted/total if total else None})
        except (TypeError,ValueError,AttributeError,OverflowError): errors.append(f'ROW_{i}_INVALID')
    expected_times = {start+timedelta(minutes=i) for i in range(135)}
    missing = sorted(expected_times-seen)
    if missing: errors.append('INCOMPLETE_0915_1130_WINDOW')
    if total <= 0: errors.append('ZERO_CUMULATIVE_VOLUME')
    opening = [(h,l) for ts,h,l in selected if ts < start.replace(hour=9,minute=30)]
    valid = not errors
    return {'underlying':underlying,'date':sample['date'],'valid':valid,'errors':errors,
            'barsValidated':len(series),'missingBars':len(missing),'zeroVolumeBars':sum(v==0 for v in volumes),
            'totalVolume':total,'sessionVwapAt1130':weighted/total if valid else None,
            'openingRange':{'high':max(h for h,l in opening),'low':min(l for h,l in opening)} if valid and len(opening)==15 else None,
            'vwapSeries':series if valid else [],'authenticity':'REQUIRES_CAPTURE_PROVENANCE_REVIEW',
            'window':'[09:15,11:30) IST bar-open times; VWAP includes bars closed by 11:30'}


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sample',type=Path); parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    raw=args.sample.read_bytes()
    result=validate(json.loads(raw))
    import hashlib
    result['sampleSha256']=hashlib.sha256(raw).hexdigest()
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='vwapSeries'}))
    raise SystemExit(0 if result['valid'] else 2)
