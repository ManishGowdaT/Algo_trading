"""NSE option-underlying universe; provider sourcing, not discovery scoring."""
from __future__ import annotations

import gzip
import json
from datetime import date, datetime
from zoneinfo import ZoneInfo

import httpx

from .instruments import normalize_symbol
from .transport import UpstoxProviderError

IST = ZoneInfo('Asia/Kolkata')
NSE_INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'
MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 128 * 1024 * 1024


def _expiry(value):
    try:
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, IST).date()
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def build_universe(rows, *, as_of: date | None = None) -> dict:
    if not isinstance(rows, list):
        raise UpstoxProviderError('Invalid Upstox NSE instrument master')
    today = as_of or datetime.now(IST).date()
    listings = {row.get('instrument_key'): row for row in rows if isinstance(row, dict)
                and row.get('segment') in {'NSE_EQ', 'NSE_INDEX'}
                and isinstance(row.get('instrument_key'), str)}
    groups = {}
    identities = {}
    ambiguous = set()
    rejected = 0
    seen_contracts = set()
    for row in rows:
        if not isinstance(row, dict) or row.get('segment') != 'NSE_FO' or row.get('instrument_type') not in {'CE', 'PE'}:
            continue
        expiry = _expiry(row.get('expiry'))
        key = row.get('underlying_key')
        contract = row.get('instrument_key')
        kind = row.get('underlying_type')
        try:
            symbol = normalize_symbol(row.get('underlying_symbol'))
            lot = int(row.get('lot_size'))
            valid = (expiry is not None and expiry >= today and lot > 0
                     and kind in {'INDEX', 'EQUITY'} and isinstance(key, str)
                     and key.startswith('NSE_INDEX|' if kind == 'INDEX' else 'NSE_EQ|')
                     and isinstance(contract, str) and contract.startswith('NSE_FO|'))
        except (ValueError, TypeError, OverflowError):
            valid = False
        if not valid:
            rejected += 1
            continue
        if contract in seen_contracts:
            continue
        seen_contracts.add(contract)
        if symbol in identities and identities[symbol] != key:
            ambiguous.add(symbol)
        identities[symbol] = key
        listing = listings.get(key, {})
        item = groups.setdefault((symbol, key), {
            'symbol': symbol, 'instrument_key': key, 'kind': kind,
            'segment': 'NSE_INDEX' if kind == 'INDEX' else 'NSE_EQ',
            'name': listing.get('name') or row.get('name') or symbol,
            'expiries': set(), 'contract_count': 0,
        })
        item['expiries'].add(expiry.isoformat())
        item['contract_count'] += 1
    items = []
    for (symbol, _), item in sorted(groups.items()):
        if symbol not in ambiguous:
            items.append({**item, 'expiries': sorted(item['expiries'])})
    return {'source': 'upstox_nse_bod', 'as_of': today.isoformat(), 'size': len(items),
            'items': items, 'ambiguous_symbols': sorted(ambiguous), 'rejected_contracts': rejected,
            'note': 'NSE underlyings with non-expired option contracts in the Upstox BOD master; not Yahoo most-active/top-gainer selection. No price, volume or discovery-score filter is applied here.'}


class UpstoxUniverseProvider:
    """Download only the fixed public NSE BOD file, without user credentials."""
    def __init__(self, *, client=None):
        self.client = client

    def get_universe(self, *, as_of=None):
        try:
            with (httpx.Client(timeout=30, follow_redirects=False) if self.client is None else _Borrowed(self.client)) as client:
                with client.stream('GET', NSE_INSTRUMENTS_URL, headers={'Accept': 'application/gzip'}) as response:
                    if response.status_code != 200:
                        raise UpstoxProviderError('Could not load Upstox NSE instrument master', status_code=502)
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > MAX_DOWNLOAD_BYTES:
                            raise UpstoxProviderError('Upstox NSE instrument master exceeds download limit')
                        chunks.append(chunk)
            import io
            with gzip.GzipFile(fileobj=io.BytesIO(b''.join(chunks))) as archive:
                payload = archive.read(MAX_JSON_BYTES + 1)
            if len(payload) > MAX_JSON_BYTES:
                raise UpstoxProviderError('Upstox NSE instrument master exceeds JSON limit')
            return build_universe(json.loads(payload), as_of=as_of)
        except UpstoxProviderError:
            raise
        except (httpx.HTTPError, ValueError, OSError, EOFError, TypeError):
            raise UpstoxProviderError('Could not decode Upstox NSE instrument master') from None


class _Borrowed:
    def __init__(self, client): self.client = client
    def __enter__(self): return self.client
    def __exit__(self, *args): return False


class FixtureUniverseProvider:
    """Explicit synthetic master for offline discovery development."""
    def __init__(self, rows):
        self.rows = rows

    def get_universe(self, *, as_of=None):
        result = build_universe(self.rows, as_of=as_of)
        return {**result, 'source':'fixture_nse_bod',
                'note':'Synthetic NSE option-underlying fixture; not a live universe or recommendation.'}
