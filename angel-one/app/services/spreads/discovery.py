"""Original two-stage discovery orchestration over provider-neutral inputs."""
from __future__ import annotations

import logging
import math
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from dataclasses import dataclass
from datetime import date

from .engine import atm_iv, edge_discovery_metrics, edge_discovery_shortlist, rank_edge_discovery
from .transport import UpstoxProviderError

logger = logging.getLogger('spreads.discovery')


@dataclass(frozen=True)
class DiscoveryResult:
    items: list[dict]
    errors: list[dict]
    capabilities: dict[str, dict]


def _error(symbol, stage, exception=None, message=None):
    status = exception.status_code if isinstance(exception, UpstoxProviderError) else None
    safe = message or ('Upstox rate limit reached; retry shortly.' if status == 429 else
                       'Upstox connection unavailable; reconnect.' if status in {401,403} else
                       'Discovery provider input could not be loaded.')
    logger.warning('discovery_input_failed symbol=%s stage=%s status=%s', symbol, stage, status)
    return {'ticker':symbol, 'stage':stage, 'error':safe, 'status':status}


def discover(universe: list[dict], adapter, *, as_of: date | None = None,
             vrp_threshold: float = 1.20, shock_threshold: float = 1.5,
             max_workers: int = 6, iv_shortlist: int = 10, on_progress=None) -> DiscoveryResult:
    """Preserve source input order, two stages, unknown IV and pandas ranking.

    Adapter failures are isolated per name. Stage one drops a failed name;
    stage two retains it with unknown IV. Errors/capabilities are additive
    metadata, never score inputs. No earnings calls, APIs or background scans.
    """
    if isinstance(max_workers, bool) or not 1 <= max_workers <= 6:
        raise ValueError('Discovery workers must be between one and six')
    if isinstance(iv_shortlist, bool) or iv_shortlist < 0:
        raise ValueError('Discovery IV shortlist must be non-negative')

    def stage1(item):
        symbol = item['symbol']
        try:
            history = adapter.get_history(item['instrument_key'], as_of=as_of)
            if history.eligibility_error:
                return None, _error(symbol,'history',message=history.eligibility_error), None
            metrics = edge_discovery_metrics(symbol, history.closes, history.volumes, shock_threshold)
            if metrics is None:
                return None, _error(symbol,'history',message='Insufficient discovery history.'), None
            capabilities = {key:getattr(history,key).status for key in ('adjustment','volume','completeness')}
            return metrics, None, capabilities
        except Exception as exception:
            return None, _error(symbol,'history',exception), None

    import threading
    progress_lock = threading.Lock()
    completed = [0]
    def tracked(stage, function, value, total):
        try:
            return function(value)
        finally:
            with progress_lock:
                completed[0] += 1
                if on_progress:
                    on_progress({'stage':stage,'completed':completed[0],'total':total})

    # Propagate request deadlines into workers without sharing Context objects.
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(copy_context().run, tracked, 'history', stage1, item, len(universe)) for item in universe]
        history_results = [future.result() for future in futures]
    items, errors, capabilities = [], [], {}
    for entry, (metrics, error, capability) in zip(universe, history_results):
        if error:
            errors.append(error)
        if metrics is not None:
            items.append(metrics)
            capabilities[entry['symbol']] = capability
    if not items:
        return DiscoveryResult([], errors, capabilities)
    by_symbol = {entry['symbol']:entry for entry in universe}
    metrics_by_symbol = {item['ticker']:item for item in items}
    shortlist = edge_discovery_shortlist(items, iv_shortlist)
    completed[0] = 0
    if on_progress:
        on_progress({'stage':'iv','completed':0,'total':len(shortlist)})

    def stage2(symbol):
        try:
            chain = adapter.get_atm_chain(by_symbol[symbol]['instrument_key'], as_of=as_of)
            if chain is None:
                return symbol, float('nan'), _error(symbol,'iv',message='No usable discovery option expiry.'), None
            iv = atm_iv(chain, metrics_by_symbol[symbol]['_spot_raw'])
            error = _error(symbol,'iv',message='No usable ATM IV in the cleaned option chain.') if math.isnan(iv) else None
            return symbol, iv, error, {'iv':chain.implied_volatility.status,'oi':chain.open_interest.status}
        except Exception as exception:
            return symbol, float('nan'), _error(symbol,'iv',exception), None

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(copy_context().run, tracked, 'iv', stage2, symbol, len(shortlist)) for symbol in shortlist]
        iv_results = [future.result() for future in futures]
    ivs = {}
    for symbol, iv, error, capability in iv_results:
        ivs[symbol] = iv
        if error:
            errors.append(error)
        if capability:
            capabilities[symbol].update(capability)
    return DiscoveryResult(rank_edge_discovery(items, ivs, vrp_threshold=vrp_threshold,
        shock_threshold=shock_threshold, iv_shortlist=iv_shortlist), errors, capabilities)


def edge_discovery(universe, adapter, **kwargs):
    """Compatibility shape: the original function returns the ranked list."""
    return discover(universe, adapter, **kwargs).items


trending_scan = edge_discovery
