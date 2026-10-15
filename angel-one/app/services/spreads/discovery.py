"""Original two-stage discovery orchestration over provider-neutral inputs."""
from __future__ import annotations

import logging
import math
import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from dataclasses import dataclass
from datetime import date

from .engine import atm_iv, edge_discovery_metrics, rank_edge_discovery
from .transport import UpstoxProviderError, QUOTA_WAIT_OBSERVER

logger = logging.getLogger('spreads.discovery')


@dataclass(frozen=True)
class DiscoveryResult:
    items: list[dict]
    errors: list[dict]
    capabilities: dict[str, dict]
    stats: dict


def _error(symbol, stage, exception=None, message=None):
    status = exception.status_code if isinstance(exception, UpstoxProviderError) else None
    safe = message or ('Upstox rate limit reached; retry shortly.' if status == 429 else
                       'Upstox connection unavailable; reconnect.' if status in {401,403} else
                       'Discovery provider input could not be loaded.')
    logger.warning('discovery_input_failed symbol=%s stage=%s status=%s', symbol, stage, status)
    return {'ticker':symbol, 'stage':stage, 'error':safe, 'status':status, 'provider_failed':exception is not None}


def discover(universe: list[dict], adapter, *, as_of: date | None = None,
             vrp_threshold: float = 1.20, shock_threshold: float = 1.5,
             max_workers: int = 6, on_progress=None) -> DiscoveryResult:
    """Run original history and ATM-IV stages for the complete eligible universe.

    Adapter failures are isolated per name. Stage one drops a failed name;
    stage two retains it with unknown IV. Errors/capabilities are additive
    metadata, never score inputs. No earnings calls, APIs or background scans.
    """
    if isinstance(max_workers, bool) or not 1 <= max_workers <= 6:
        raise ValueError('Discovery workers must be between one and six')
    started = time.monotonic()

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
        def waiting(seconds):
            with progress_lock:
                if on_progress:
                    on_progress({'stage':stage, 'completed':completed[0], 'total':total,
                                 'quota_wait_seconds':round(seconds, 1)})
        observer = QUOTA_WAIT_OBSERVER.set(waiting)
        try:
            return function(value)
        finally:
            QUOTA_WAIT_OBSERVER.reset(observer)
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
    by_symbol = {entry['symbol']:entry for entry in universe}
    metrics_by_symbol = {item['ticker']:item for item in items}
    symbols = [entry['symbol'] for entry in universe]
    completed[0] = 0
    if on_progress:
        on_progress({'stage':'iv','completed':0,'total':len(symbols)})

    def stage2(symbol):
        try:
            metrics = metrics_by_symbol.get(symbol)
            scope = {'spot': metrics['_spot_raw'] if metrics else None} if getattr(adapter, 'supports_atm_iv_scope', False) else {}
            chain = adapter.get_atm_chain(by_symbol[symbol]['instrument_key'], as_of=as_of, **scope)
            if chain is None:
                return symbol, float('nan'), 'unavailable', 'unavailable', _error(symbol,'iv',message='No usable discovery option expiry.'), None
            metrics = metrics_by_symbol.get(symbol)
            iv = atm_iv(chain, metrics['_spot_raw']) if metrics else float('nan')
            if math.isnan(iv):
                if getattr(chain, 'iv_errors', ()):
                    failure = chain.iv_errors[0]
                    error = _error(symbol, 'iv', message=failure['reason'])
                    error.update(status=failure.get('status'), code=failure.get('code'), provider_failed=True)
                    return symbol, iv, 'failed', 'failed', error, {'iv':'failed', 'oi':chain.open_interest.status}
                reason = ('Historical spot is unavailable, so the original ATM strike selection cannot be evaluated.'
                          if metrics is None else 'No usable positive IV was present in the original ATM selection.')
                return symbol, iv, 'unavailable', 'unavailable', _error(symbol,'iv',message=reason), {'iv':chain.implied_volatility.status,'oi':chain.open_interest.status}
            rv21 = metrics['_rv21_raw'] if metrics else float('nan')
            vrp_status = 'available' if rv21 and rv21 > 0 and not math.isnan(rv21) else 'unavailable'
            return symbol, iv, 'available', vrp_status, None, {'iv':chain.implied_volatility.status,'oi':chain.open_interest.status}
        except Exception as exception:
            return symbol, float('nan'), 'failed', 'failed', _error(symbol,'iv',exception), None

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(copy_context().run, tracked, 'iv', stage2, symbol, len(symbols)) for symbol in symbols]
        iv_results = [future.result() for future in futures]
    ivs, iv_status, vrp_status = {}, {}, {}
    for symbol, iv, iv_state, vrp_state, error, capability in iv_results:
        ivs[symbol] = iv
        iv_status[symbol], vrp_status[symbol] = iv_state, vrp_state
        if error:
            errors.append(error)
        if capability and symbol in capabilities:
            capabilities[symbol].update(capability)
    ranked = rank_edge_discovery(items, ivs, vrp_threshold=vrp_threshold,
        shock_threshold=shock_threshold, iv_status_by_ticker=iv_status, vrp_status_by_ticker=vrp_status)
    attempts = {'eligible_underlyings':len(universe), 'history_attempted':len(universe),
                'history_available':len(items), 'atm_iv_attempted':len(symbols),
                'atm_iv_available':sum(state == 'available' for state in iv_status.values()),
                'atm_iv_unavailable':sum(state == 'unavailable' for state in iv_status.values()),
                'atm_iv_failed':sum(state == 'failed' for state in iv_status.values()),
                'history_failed':sum(error['stage'] == 'history' and error.get('provider_failed', False) for error in errors),
                'failed_requests':sum(error.get('provider_failed', False) for error in errors),
                'total_runtime_seconds':round(time.monotonic()-started, 2),
                'complete':True}
    attempts['failed'] = attempts['failed_requests']
    provider_metrics = getattr(adapter, 'request_metrics', None)
    if callable(provider_metrics):
        attempts.update(provider_metrics())
    return DiscoveryResult(ranked, errors, capabilities, attempts)


def edge_discovery(universe, adapter, **kwargs):
    """Compatibility shape: the original function returns the ranked list."""
    return discover(universe, adapter, **kwargs).items


trending_scan = edge_discovery
