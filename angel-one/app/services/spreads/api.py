"""Private, read-only Indian Spread Terminal endpoints."""

from __future__ import annotations

import asyncio
import math
import time
import threading
import hmac
import logging
import os
from datetime import date, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from .engine import ScanParams, scan_provider_data, pick_expiration, empirical_breach_prob, apply_earnings_penalty
from .fixture_adapter import FixtureMarketDataProvider
from .instruments import normalize_symbol, retain_universe_identities
from .nifty_fixtures import spread_fixture_payloads
from .transport import UpstoxProviderError, REQUEST_DEADLINE
from .upstox_adapter import UpstoxMarketDataProvider
from .discovery import discover
from .discovery_adapter import DiscoveryDataAdapter, FixtureDiscoveryDataAdapter
from .discovery_cache import discovery_cache
from .universe import UpstoxUniverseProvider, FixtureUniverseProvider
from .earnings_source import yahoo_earnings_source
from .scan_audit import CURRENT_AUDIT, RecordingTransport, ScanAudit, batch_snapshot
from . import nse_calculations as nse


logger = logging.getLogger("spreads.api")
router = APIRouter(prefix="/spreads", tags=["Spreads"])
IST = ZoneInfo("Asia/Kolkata")


class NiftyScanRequest(BaseModel):
    strategy_profile: Literal['ORIGINAL_ZIP_BASELINE', 'NSE_RESEARCH_V1'] = 'ORIGINAL_ZIP_BASELINE'
    width_steps: int = Field(default=1, ge=1, le=50)
    audit_snapshot: bool = Field(default=False, exclude=True)  # Never a dumped calculation parameter.
    expiry: date | None = None  # Explicit override; default uses original target-DTE picker.
    dte: int = Field(default=30, ge=5, le=180)
    # Only the width RANGE is extended for NSE; original default remains 5.
    width: float = Field(default=5, gt=0, le=5000, allow_inf_nan=False)
    min_vrp: float = Field(default=1.15, ge=0.5, le=3, allow_inf_nan=False)
    min_oi: int = Field(default=100, ge=0, le=10000)
    max_spread_pct: float = Field(default=0.10, gt=0, le=0.5, allow_inf_nan=False)
    min_cushion: float = Field(default=2, ge=0, le=30, allow_inf_nan=False)
    min_ror: float = Field(default=15, ge=5, le=100, allow_inf_nan=False)


class MultiScanRequest(NiftyScanRequest):
    underlyings: list[str] = Field(min_length=1, max_length=50)
    expiries: dict[str, date] = Field(default_factory=dict)


_scan_slots = threading.BoundedSemaphore(4)
# Provider calls remain individually bounded. Allow queued underlyings and retries
# to finish instead of cancelling completed calculations at an outer 45-second cut-off.
SCAN_BUDGET_SECONDS = 180


def _json_safe(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _mode() -> str:
    mode = os.getenv("SPREADS_DATA_MODE", "fixtures").strip().lower()
    if mode not in {"fixtures", "upstox"}:
        raise HTTPException(503, "SPREADS_DATA_MODE must be either fixtures or upstox.")
    production = os.getenv("APP_ENV", "").strip().lower() in {"prod", "production"} or os.getenv("RENDER", "").strip().lower() == "true"
    if production and mode != "upstox":
        raise HTTPException(503, "Fixture market data is disabled in production. Configure live Upstox mode.")
    return mode


def _authorize_internal(
    supplied: Annotated[str, Header(alias="X-Internal-Service-Key")] = "",
) -> None:
    internal_key = (os.getenv("INTERNAL_SERVICE_KEY") or os.getenv("INTERNAL_API_SECRET") or "").strip()
    if not internal_key or not hmac.compare_digest(supplied.encode(), internal_key.encode()):
        raise HTTPException(401, "Internal service authentication required.")


def _access_token(
    supplied: Annotated[str, Header(alias="X-Upstox-Access-Token")] = "",
) -> str:
    mode = _mode()
    if mode == "fixtures":
        return ""
    if not supplied or len(supplied) > 8192:
        raise HTTPException(401, "Connect Upstox to load Spread Terminal market data.")
    return supplied


def _provider(mode: str, access_token: str):
    if mode == "fixtures":
        return FixtureMarketDataProvider(spread_fixture_payloads())
    return UpstoxMarketDataProvider(access_token)


def _discovery_inputs(mode, token):
    provider = _provider(mode, token)
    if mode == 'fixtures':
        rows = []
        for key, contracts in provider._fixtures.items():
            if key.startswith('contracts:'):
                underlying_key = key.removeprefix('contracts:')
                rows.extend({**contract, 'underlying_key':underlying_key,
                             'underlying_type':'INDEX' if underlying_key.startswith('NSE_INDEX|') else 'EQUITY'}
                            for contract in contracts)
        return FixtureUniverseProvider(rows), FixtureDiscoveryDataAdapter(provider)
    return UpstoxUniverseProvider(), DiscoveryDataAdapter(provider)


async def _discovery_response(owner, token, force):
    if not owner or len(owner) > 128:
        raise HTTPException(422, 'A server-owned Spread user identity is required.')
    mode = _mode()
    cache_key = discovery_cache.key(owner,mode,token)
    async def load():
        def work():
            # Full-universe discovery is deliberately paced through Upstox.
            # Keep one bounded deadline for the entire history + IV pass.
            started = time.monotonic()
            context = REQUEST_DEADLINE.set(started+900)
            try:
                universe_provider, adapter = _discovery_inputs(mode, token)
                universe = universe_provider.get_universe()
                if mode == 'upstox':
                    retain_universe_identities(universe['items'], universe['as_of'])
                logger.info('discovery_universe_loaded size=%s mode=%s', universe['size'], mode)
                def progress(value):
                    discovery_cache.progress[cache_key] = value
                result = discover(universe['items'], adapter, on_progress=progress)
                stats = {**getattr(result, 'stats', {}), 'total_runtime_seconds':round(time.monotonic()-started, 2)}
                logger.info('discovery_completed ranked=%s errors=%s mode=%s stats=%s',len(result.items),len(result.errors),mode,stats)
                return {'all':result.items, 'errors':result.errors, 'capabilities':result.capabilities, 'stats':stats,
                        'universe':{key:value for key,value in universe.items() if key != 'items'}}
            finally:
                REQUEST_DEADLINE.reset(context)
        return await asyncio.to_thread(work)
    try:
        payload = await discovery_cache.get(cache_key,load,force=force,wait=False)
        return _json_safe({**payload, 'data_mode':mode, 'data_note':_data_note(mode)})
    except TimeoutError:
        raise HTTPException(504, 'Discovery is still refreshing; retry shortly.') from None
    except RuntimeError:
        raise HTTPException(429, 'Discovery is busy; retry shortly.') from None


@router.get('/trending')
async def get_discovery(
    _authorized: Annotated[None, Depends(_authorize_internal)],
    access_token: Annotated[str, Depends(_access_token)],
    owner: Annotated[str, Header(alias='X-Spreads-User-Id')] = '',
):
    return await _discovery_response(owner, access_token, False)


@router.post('/discover')
async def refresh_discovery(
    _authorized: Annotated[None, Depends(_authorize_internal)],
    access_token: Annotated[str, Depends(_access_token)],
    owner: Annotated[str, Header(alias='X-Spreads-User-Id')] = '',
):
    return await _discovery_response(owner, access_token, True)


@router.get("/nifty/expiries")
def get_nifty_expiries(
    _authorized: Annotated[None, Depends(_authorize_internal)],
    access_token: Annotated[str, Depends(_access_token)],
):
    return _get_expiries("NIFTY", _authorized, access_token)


@router.get("/underlyings/{symbol}/expiries")
def get_underlying_expiries(
    symbol: str,
    _authorized: Annotated[None, Depends(_authorize_internal)],
    access_token: Annotated[str, Depends(_access_token)],
):
    return _get_expiries(symbol, _authorized, access_token)


def _get_expiries(symbol: str, _authorized, access_token: str):
    mode = _mode()
    try:
        provider = _provider(mode, access_token)
        underlying = provider.resolve_underlying(symbol)
        contracts = provider.get_option_contracts(underlying["instrument_key"])
        today = datetime.now(IST).date()
        expiries = sorted({contract.expiry.isoformat() for contract in contracts if contract.expiry >= today})
        if not expiries:
            raise HTTPException(422, f"{underlying['symbol']} has no active NSE F&O option contracts available from Upstox.")
        return {
            "symbol": underlying["symbol"], "instrument_key": underlying["instrument_key"],
            "kind": underlying["kind"], "name": underlying.get("name"),
            "expiries": expiries, "data_mode": mode, "data_note": _data_note(mode),
            "scan_availability": {
                "available": True if mode == 'fixtures' or underlying['kind'] == 'INDEX' else None,
                "status": 'available' if mode == 'fixtures' or underlying['kind'] == 'INDEX' else 'requires_validation',
                "earnings_source": 'fixture' if mode == 'fixtures' else 'not_applicable' if underlying['kind'] == 'INDEX' else 'yahoo_dates_upstox_closes',
                "reason": None if mode == 'fixtures' or underlying['kind'] == 'INDEX' else
                'Stock scan will fetch Yahoo earnings dates and calculate historical gaps from Upstox closes. Availability is checked during the scan.',
            },
        }
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    except UpstoxProviderError as exc:
        raise HTTPException(exc.status_code if exc.status_code in {401, 403, 404, 409, 422, 429} else 502, str(exc)) from exc
    except Exception as exc:
        logger.warning("underlying_expiries_failed mode=%s error_type=%s", mode, type(exc).__name__)
        raise HTTPException(502, "Could not load NSE F&O expiries from the configured market-data provider.") from None


@router.post("/nifty/scan")
def scan_nifty(
    request: NiftyScanRequest,
    _authorized: Annotated[None, Depends(_authorize_internal)],
    access_token: Annotated[str, Depends(_access_token)],
):
    return _scan_underlying("NIFTY", request, _authorized, access_token)


@router.post("/underlyings/{symbol}/scan")
def scan_underlying(
    symbol: str,
    request: NiftyScanRequest,
    _authorized: Annotated[None, Depends(_authorize_internal)],
    access_token: Annotated[str, Depends(_access_token)],
):
    return _scan_underlying(symbol, request, _authorized, access_token)


@router.post("/scan")
async def scan_multiple(
    request: MultiScanRequest,
    _authorized: Annotated[None, Depends(_authorize_internal)],
    access_token: Annotated[str, Depends(_access_token)],
):
    started = time.monotonic()
    try:
        symbols = sorted({normalize_symbol(value) for value in request.underlyings})
        expiry_map = {normalize_symbol(key): value for key, value in request.expiries.items()}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    if set(expiry_map) - set(symbols):
        raise HTTPException(422, "Expiry overrides must belong to selected underlyings.")

    def scan_one(symbol):
        deadline = started + SCAN_BUDGET_SECONDS
        context = REQUEST_DEADLINE.set(deadline)
        # Global bound covers simultaneous batches as well as a single request.
        acquired = _scan_slots.acquire(timeout=max(0, deadline - time.monotonic()))
        try:
            if not acquired or time.monotonic() >= deadline:
                return {"ticker": symbol, "symbol": symbol, "ok": False,
                        "error": "Spread batch deadline exceeded", "candidates": [],
                        "funnel": None, "meta": None, "expiry": None, "dte": None}
            params = NiftyScanRequest(**{
                **request.model_dump(exclude={"underlyings", "expiries"}),
                "expiry": expiry_map.get(symbol, request.expiry),
                "audit_snapshot": request.audit_snapshot,
            })
            try:
                return _scan_underlying(symbol, params, _authorized, access_token)
            except HTTPException as exc:
                return {"ticker": symbol, "symbol": symbol, "ok": False,
                        "error": str(exc.detail), "candidates": [], "funnel": None,
                        "meta": None, "expiry": None, "dte": None}
        finally:
            if acquired:
                _scan_slots.release()
            REQUEST_DEADLINE.reset(context)

    tasks = [asyncio.create_task(asyncio.to_thread(scan_one, symbol)) for symbol in symbols]
    # Await every bounded worker so a completed result is never discarded merely
    # because the event-loop deadline fires before its to_thread delivery.
    scans = await asyncio.gather(*tasks)
    successful = [scan for scan in scans if scan.get("ok")]
    candidates = [candidate for scan in successful for candidate in scan.get("candidates", [])]
    # Original main.py: stable descending sort of the rounded original EV, including negatives.
    candidates.sort(key=lambda candidate: candidate["ev"], reverse=True)
    keys = ("considered", "cushion", "friction", "paired", "ror", "vrp", "final")
    response = _json_safe({
        "ok": bool(successful), "data_mode": _mode(), "data_note": _data_note(_mode()),
        "strategy_profile": request.strategy_profile,
        "width_mode": 'listed_strike_steps' if request.strategy_profile == nse.NSE_RESEARCH_V1 else 'fixed_price_points',
        "width_steps": request.width_steps if request.strategy_profile == nse.NSE_RESEARCH_V1 else None,
        "underlyings": scans, "success_count": len(successful),
        "failure_count": len(scans) - len(successful), "candidates": candidates,
        "funnel": {key: sum((scan.get("funnel") or {}).get(key, 0) for scan in successful)
                   for key in keys} if successful else None,
        "elapsed": round(time.monotonic() - started, 1),
        "tickers_ok": len(successful),
        "tickers_failed": len(scans) - len(successful),
        "funnels": {scan["symbol"]: scan["funnel"] for scan in successful},
        "meta": {scan["symbol"]: scan["meta"] for scan in successful},
        "errors": [{"ticker": scan["symbol"], "error": scan["error"]}
                   for scan in scans if not scan.get("ok")],
        "ranking_note": "Original stable descending rounded EV ranking (100-unit convention); negative EV is retained. Per-lot INR values do not change ranking.",
    })
    if request.audit_snapshot:
        try:
            response['scan_audit'] = batch_snapshot(response, request.model_dump())
        except Exception as exc:
            response['scan_audit'] = {'status':'failed','error_type':type(exc).__name__}
    return response


def _scan_underlying(symbol: str, request: NiftyScanRequest, _authorized, access_token: str):
    mode = _mode()
    today = datetime.now(IST).date()
    deadline_context = REQUEST_DEADLINE.set(REQUEST_DEADLINE.get() or time.monotonic() + SCAN_BUDGET_SECONDS)
    capture = ScanAudit(symbol) if request.audit_snapshot else None
    audit_context = CURRENT_AUDIT.set(capture)
    try:
        provider = _provider(mode, access_token)
        if capture and mode == 'upstox':
            provider._transport = RecordingTransport(provider._transport, capture)
        underlying = provider.resolve_underlying(symbol)
        symbol = underlying["symbol"]
        underlying_key = underlying["instrument_key"]
        contracts = provider.get_option_contracts(underlying_key)
        picked = pick_expiration(sorted({contract.expiry.isoformat() for contract in contracts}), request.dte, as_of=today)
        expiration = request.expiry or (date.fromisoformat(picked[0]) if picked else None)
        if expiration is None or (expiration - today).days < 3:
            raise HTTPException(422, "No available option expiry at least 3 calendar days away.")
        dte = (expiration - today).days
        if expiration not in {contract.expiry for contract in contracts}:
            raise HTTPException(422, f"Choose an available {symbol} option expiry.")
        history = provider.get_history(underlying_key, years=3)
        chain = provider.get_option_chain(underlying_key, expiration)
        earnings = provider.get_earnings_info(underlying_key, expiration)
        if mode == 'upstox' and underlying['kind'] == 'EQUITY' and not earnings.available:
            earnings = yahoo_earnings_source.get_earnings(symbol,history,expiration,as_of=today)
        params = ScanParams(
            dte=dte, width=request.width, min_vrp=request.min_vrp,
            min_oi=request.min_oi, max_spread_pct=request.max_spread_pct,
            min_cushion=request.min_cushion, min_ror=request.min_ror,
            max_strikes=12,
        )
        if capture:
            try:
                capture.inputs(underlying, contracts, history, chain, earnings, expiration, dte, params)
            except Exception as exc:
                capture.snapshot['capture_error_type'] = type(exc).__name__
        market_issues = []
        native_builder = None
        if request.strategy_profile == nse.NSE_RESEARCH_V1:
            resolve = nse.pair_resolver(contracts, expiration, request.width_steps,
                                       'paise' if mode == 'upstox' else 'rupees', market_issues)
            def native_builder(ticker, spot, puts, calls, expiry, days, close, rv, earnings_inside, gap, p):
                import pandas as pd
                return nse.build_spreads(ticker, spot, pd.DataFrame(puts), pd.DataFrame(calls),
                    expiry, days, pd.Series(close, dtype=float), rv, earnings_inside, gap, p, resolve)
        result = scan_provider_data(symbol, history, chain, earnings,
                                    expiration, dte, params, spread_builder=native_builder)
        result['strategy_profile'] = request.strategy_profile
        result['width_mode'] = 'listed_strike_steps' if native_builder else 'fixed_price_points'
        if native_builder:
            result['width_steps'] = request.width_steps
            result['nse_market_structure_issues'] = market_issues
            result['history_parity_status'] = 'UNVERIFIED' if history.adjustment.status not in {'verified','not_applicable','fixture'} else history.adjustment.status
            result.setdefault('data_warnings', []).append(
                'NSE_RESEARCH_V1 is a separate market-structure research profile; economic thresholds are unchanged. '
                'The adjusted-history mismatch remains unresolved for equities; profile adaptation does not establish backtest validity.')
        for candidate in result["candidates"]:
            candidate['strategy_profile'] = request.strategy_profile
            side = "PE" if candidate["type"] == "BULL PUT" else "CE"
            pairs = chain.puts if side == "PE" else chain.calls
            quotes = dict(pairs)
            # The original scanner retains duplicate rows. Do not collapse those
            # rows to the last quote for additive contract/money metadata.
            duplicate_strikes = {strike for strike, _ in pairs if sum(s == strike for s, _ in pairs) > 1}
            ambiguous_quotes = any(candidate[key] in duplicate_strikes for key in ('short_strike', 'long_strike'))
            if ambiguous_quotes:
                quotes = {strike: quote for strike, quote in pairs if strike not in duplicate_strikes}
            candidate['monetary_status'] = 'ambiguous_duplicate_strike' if ambiguous_quotes else 'pending_contract_validation' 
            matches = [[contract for contract in contracts
                          if contract.expiry == expiration and contract.instrument_type == side
                          and contract.underlying_key == underlying_key
                          and contract.strike == candidate[key]
                          and quotes.get(candidate[key]) is not None
                          and contract.instrument_key == quotes[candidate[key]].instrument_key]
                    for key in ("short_strike", "long_strike")]
            # Use exact quoted leg identity, never the first contract sharing a strike.
            legs = [matching[0] if matching and len({(leg.instrument_key, leg.lot_size) for leg in matching}) == 1 else None for matching in matches]
            lot = legs[0].lot_size if all(legs) and legs[0].lot_size == legs[1].lot_size and legs[0].lot_size > 0 else None
            candidate.update(short_instrument_key=legs[0].instrument_key if legs[0] else None,
                             long_instrument_key=legs[1].instrument_key if legs[1] else None,
                             lot_size=lot, lot_size_status=("fixture" if mode == "fixtures" else "contract") if lot else "unavailable")
            # Recompute unrounded amounts from the original quote/probability inputs;
            # never derive money from rounded displayed EV or change its ordering.
            short, long = quotes.get(candidate["short_strike"]), quotes.get(candidate["long_strike"])
            if lot and short and long:
                candidate['monetary_status'] = 'available'
                credit = (short.bid + short.ask - long.bid - long.ask) / 2
                candidate['credit_points_unrounded'] = credit
                candidate['actual_width_points'] = candidate['width']
                loss = candidate["width"] - credit
                closes = [bar.close for bar in history.bars if bar.close is not None]
                cushion = abs(candidate["short_strike"] - closes[-1]) / closes[-1] * 100
                probability = empirical_breach_prob(closes, dte, cushion, "down" if side == "PE" else "up")
                if earnings.earnings_inside:
                    probability = apply_earnings_penalty(probability, cushion, earnings.max_historical_gap_pct or 0)
                candidate.update(credit_per_lot_inr=round(credit * lot, 2), max_loss_per_lot_inr=round(loss * lot, 2),
                                 ev_per_lot_inr=round((credit * (1 - probability) - loss * probability) * lot, 2))
            else:
                candidate.update(credit_per_lot_inr=None, max_loss_per_lot_inr=None, ev_per_lot_inr=None)
        result.update({
            "symbol": symbol, "instrument_key": underlying_key,
            "kind": underlying["kind"], "expiry": expiration.isoformat(), "dte": dte,
            "data_mode": mode, "data_note": _data_note(mode),
            "capabilities": {
                "daily_candle_completeness": history.completeness.status,
                "history_adjustment": history.adjustment.status,
                "earnings": earnings.capability.status,
                "option_open_interest": chain.open_interest.status,
                "option_implied_volatility": chain.implied_volatility.status,
                "quote_timestamp": chain.quote_timestamp.status,
            },
        })
        result['earnings_source_note'] = earnings.capability.explanation
        if capture:
            try:
                result['scan_audit'] = capture.finish(result)
            except Exception as exc:
                result['scan_audit'] = {'status':'failed','audit_id':capture.id,'error_type':type(exc).__name__}
        return _json_safe(result)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    except UpstoxProviderError as exc:
        raise HTTPException(exc.status_code if exc.status_code in {401, 403, 404, 409, 422, 429} else 502, str(exc)) from exc
    except Exception as exc:
        # Do not log exception text: upstream errors can contain request details.
        logger.warning("underlying_scan_failed mode=%s error_type=%s", mode, type(exc).__name__)
        raise HTTPException(502, "Spread scan failed while loading market data.") from None
    finally:
        if capture and not capture.finished:
            try:
                capture.finish({'ok':False,'data_mode':mode,'error':'Scan ended before a complete audit snapshot could be captured.'})
            except Exception:
                logger.warning('scan_audit_failed audit_id=%s', capture.id)
        CURRENT_AUDIT.reset(audit_context)
        REQUEST_DEADLINE.reset(deadline_context)


def _data_note(mode: str) -> str:
    if mode == "fixtures":
        return "Fixture data only: deterministic synthetic sample quotes for workflow testing, not live market data."
    return "Upstox market data. Research only; no Upstox order placement is available."

