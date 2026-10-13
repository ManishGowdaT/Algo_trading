"""Temporary read-only live audit launcher; no fallback or normalization change."""
import json
import math
import sys
from pathlib import Path
from datetime import date, datetime

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'angel-one'))
from app.main import app
from app.services.spreads import api, transport
from app.services.spreads.discovery_adapter import DiscoveryDataAdapter
from app.services.spreads.engine import atm_iv, edge_discovery_metrics, pick_expiration

transport._READ_ONLY_PATHS = transport._READ_ONLY_PATHS | {'/v3/market-quote/option-greek'}
original = api._get_expiries
TARGETS = {'PNBHOUSING', 'SAIL', 'NTPC', 'APOLLOHOSP'}


def audited(symbol, authorized, token):
    result = original(symbol, authorized, token)
    if result['symbol'] not in TARGETS or api._mode() != 'upstox':
        return result
    provider = api._provider('upstox', token)
    key = result['instrument_key']
    today = datetime.now(api.IST).date()
    contracts = provider.get_option_contracts(key)
    selected = pick_expiration(sorted({c.expiry.isoformat() for c in contracts}), 14, as_of=today)
    expiry = date.fromisoformat(selected[0])
    history = DiscoveryDataAdapter(provider).get_history(key, as_of=today)
    metrics = edge_discovery_metrics(symbol, history.closes, history.volumes)
    spot = metrics['_spot_raw']
    chain = provider.get_option_chain(key, expiry)
    raw_chain = provider._transport.get('/v2/option/chain', {'instrument_key': key, 'expiry_date': expiry.isoformat()})
    chain_iv = {}
    for row in raw_chain:
        for side in ('put_options', 'call_options'):
            option = row.get(side) or {}
            chain_iv[option.get('instrument_key')] = (option.get('option_greeks') or {}).get('iv')
    chosen = []
    for side in ('CE', 'PE'):
        chosen.extend(sorted([c for c in contracts if c.expiry == expiry and c.instrument_type == side], key=lambda c: abs(c.strike - spot))[:25])
    evidence = {'symbol': symbol, 'underlying_key': key, 'expiry': expiry.isoformat(),
                'observed_at': datetime.now(api.IST).isoformat(), 'spot': spot,
                'rv21': metrics['_rv21_raw'], 'chain_atm_iv': atm_iv(chain, spot), 'options': []}
    try:
        raw = provider._transport.get('/v3/market-quote/option-greek', {'instrument_key': ','.join(c.instrument_key for c in chosen)})
        greek = {v.get('instrument_token'): v for v in raw.values() if isinstance(v, dict)}
        for c in chosen:
            g = greek.get(c.instrument_key, {})
            v3 = g.get('iv')
            ci = chain_iv.get(c.instrument_key)
            evidence['options'].append({'key': c.instrument_key, 'strike': c.strike, 'side': c.instrument_type,
                'expiry': c.expiry.isoformat(), 'lot': c.lot_size, 'chain_raw_iv': ci,
                'chain_normalized_iv': ci / 100 if isinstance(ci, (int, float)) else None,
                'v3_raw_iv': v3, 'v3_oi': g.get('oi'),
                'v3_to_chain_decimal_ratio': v3 / (ci / 100) if isinstance(v3, (int, float)) and isinstance(ci, (int, float)) and ci > 0 else None})
        evidence['returned_keys'] = len(greek)
    except transport.UpstoxProviderError as exc:
        evidence['error'] = {'http_status': exc.status_code, 'code': exc.code, 'message': str(exc)}
    # No authorization headers, response cookies or access tokens are persisted.
    (ROOT / 'tmp' / f'live-v3-{symbol}.json').write_text(json.dumps(evidence, indent=2, allow_nan=True), encoding='utf-8')
    result['scan_availability']['reason'] = 'Live IV validation saved for ' + symbol + '. ' + ('V3 request failed: ' + str(evidence['error']) if 'error' in evidence else f"V3 returned {evidence['returned_keys']} option instruments.")
    return result


api._get_expiries = audited
if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8000)
