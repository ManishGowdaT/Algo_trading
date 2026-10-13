"""Resolve NSE F&O underlyings against Upstox identities, never Angel tokens."""

from __future__ import annotations

import re
import threading

from .transport import UpstoxProviderError

INDEX_KEYS = {
    "NIFTY": "NSE_INDEX|Nifty 50",
    "BANKNIFTY": "NSE_INDEX|Nifty Bank",
}


# Server-owned identities from the actual Upstox option universe, not client hints.
_discovered = {}
_identity_day = None
_identity_lock = threading.Lock()


def retain_universe_identities(items, as_of):
    global _identity_day
    with _identity_lock:
        # Replace the authoritative snapshot, including removal of ambiguous or expired names.
        _discovered.clear()
        _identity_day = as_of
        for item in items:
            _discovered[item['symbol']] = {key: item[key] for key in
                ('symbol', 'instrument_key', 'kind', 'segment', 'name') if key in item}


def normalize_symbol(symbol: str) -> str:
    value = str(symbol or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9&._-]{1,30}", value):
        raise ValueError("Enter a valid NSE underlying symbol")
    return value


def resolve_underlying(transport, symbol: str, *, universe_loader=None) -> dict:
    normalized = normalize_symbol(symbol)
    with _identity_lock:
        identity = _discovered.get(normalized)
        if identity:
            return dict(identity)
    if normalized in INDEX_KEYS:
        return {"symbol": normalized, "instrument_key": INDEX_KEYS[normalized], "kind": "INDEX", "segment": "NSE_INDEX"}

    data = transport.get("/v2/instruments/search", {
        "query": normalized, "exchanges": "NSE", "segments": "EQ", "page_number": 1, "records": 30,
    })
    if not isinstance(data, list):
        raise UpstoxProviderError("Upstox returned an invalid instrument-search response")
    exact = [item for item in data if isinstance(item, dict)
             and item.get("segment") == "NSE_EQ"
             and str(item.get("trading_symbol", "")).upper() == normalized
             and isinstance(item.get("instrument_key"), str)]
    keys = {item["instrument_key"] for item in exact}
    if not keys and universe_loader is not None:
        # Also recover an index selected before discovery or after a service restart.
        master = universe_loader()
        retain_universe_identities(master['items'], master['as_of'])
        with _identity_lock:
            identity = _discovered.get(normalized)
            if identity:
                return dict(identity)
    if not keys:
        raise UpstoxProviderError(f"No NSE cash-market instrument found for {normalized}", status_code=404)
    if len(keys) != 1:
        raise UpstoxProviderError(f"Instrument symbol {normalized} is ambiguous; select a specific NSE listing", status_code=409)
    item = exact[0]
    return {"symbol": normalized, "instrument_key": item["instrument_key"], "kind": "EQUITY",
            "segment": "NSE_EQ", "name": item.get("name"), "isin": item.get("isin")}
