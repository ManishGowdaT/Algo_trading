from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
import hmac
import logging
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4
import anyio
from time import monotonic
from uuid import uuid4
from app.services.account_dispatch import AccountCapacityError, AccountContext, AccountDispatch
from app.services.spreads.api import router as spreads_router

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import load_config
from app.services.broker_session import BrokerSessionManager
from app.services.instrument_master import InstrumentMasterCache
from app.services.order_store import OrderStore


BASE_DIR = Path(__file__).resolve().parent.parent
logger = logging.getLogger("angel_one.api")


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", None) or str(uuid4())


def _safe_http_detail(detail: Any) -> Any:
    if not isinstance(detail, str):
        return detail
    message = detail.strip()
    if not message:
        return "The request could not be completed."
    # Preserve useful broker/provider messages while avoiding accidental
    # credential, traceback, and local-path disclosure.
    if re.search(r"traceback \(most recent call last\)|\bFile \"[^\"]+\", line \d+", message, re.I):
        return "The request could not be completed."
    message = re.sub(
        r"(?i)(api.?key|mpin|totp.?secret|password|access.?token|refresh.?token|authorization)\s*[:=]\s*[^,;\s]+",
        r"\1=[REDACTED]",
        message,
    )
    message = re.sub(r"(?:[A-Za-z]:\\|/)(?:[^\s:]+[/\\])+[^\s:]+", "[path]", message)
    return message[:500]


def _is_rate_limited(message: str) -> bool:
    lowered = message.lower()
    return any(marker in lowered for marker in (
        "too many request",
        "rate limit",
        "exceeding access rate",
        "status code 429",
        "http 429",
    ))


class PlaceOrderRequest(BaseModel):
    payload: Dict[str, Any] = Field(default_factory=dict)

    @validator("payload")
    def validate_payload_fields(cls, payload: Dict[str, Any]) -> Dict[str, Any]:
        if not payload or len(payload) > 20:
            raise ValueError("Order payload must contain between 1 and 20 fields")
        allowed_fields = {
            "variety", "tradingsymbol", "symboltoken", "transactiontype", "exchange",
            "ordertype", "producttype", "duration", "price", "triggerprice",
            "squareoff", "stoploss", "quantity", "disclosedquantity", "ordertag",
        }
        unknown_fields = set(payload) - allowed_fields
        if unknown_fields:
            raise ValueError("Order payload contains an unsupported field")
        for key, value in payload.items():
            if value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (str, int, float)):
                raise ValueError(f"Order field {key} must be a scalar value")
            if isinstance(value, str) and len(value) > 128:
                raise ValueError(f"Order field {key} is too long")
            if isinstance(value, float) and not math.isfinite(value):
                raise ValueError(f"Order field {key} must be finite")
        return payload


class SimpleOrderRequest(BaseModel):
    exchange: str = Field(min_length=1, max_length=10)
    tradingsymbol: str = Field(min_length=1, max_length=64)
    symboltoken: str = Field(min_length=1, max_length=32)
    transactiontype: str = Field(min_length=1, max_length=16)
    producttype: str = Field(min_length=1, max_length=24)
    quantity: int = Field(gt=0, le=1_000_000)
    ordertype: str = Field(default="MARKET", min_length=1, max_length=16)
    price: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    triggerprice: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    variety: str = Field(default="NORMAL", min_length=1, max_length=16)


class CancelOrderRequest(BaseModel):
    variety: str = Field(default="NORMAL", min_length=1, max_length=16)


class ExecutionOwnerRequest(BaseModel):
    ownerId: str = Field(min_length=1, max_length=160)
    generation: int = Field(ge=1)


class ExitPositionRequest(BaseModel):
    exchange: str = Field(min_length=1, max_length=10)
    tradingsymbol: str = Field(min_length=1, max_length=64)
    symboltoken: str = Field(min_length=1, max_length=32)
    quantity: int = Field(gt=0, le=1_000_000)
    producttype: str = Field(default="INTRADAY", min_length=1, max_length=24)
    transactiontype: str = Field(min_length=1, max_length=16)


class LoginRequest(BaseModel):
    apiKey: str = Field(min_length=1, max_length=256)
    clientCode: str = Field(min_length=1, max_length=64)
    mpin: str = Field(min_length=1, max_length=64)
    totpSecret: str = Field(min_length=1, max_length=128)


class LtpRequest(BaseModel):
    exchange: str = Field(min_length=1, max_length=10)
    tradingsymbol: str = Field(min_length=1, max_length=64)
    symboltoken: str = Field(min_length=1, max_length=32)


class RequiredMarginRequest(BaseModel):
    exchange: str = Field(min_length=1, max_length=10)
    tradingsymbol: str = Field(min_length=1, max_length=64)
    symboltoken: str = Field(min_length=1, max_length=32)
    transactiontype: str = Field(min_length=1, max_length=16)
    producttype: str = Field(min_length=1, max_length=24)
    # Keep zero/negative integers reaching the endpoint's established 400
    # validation response; the route still rejects them before broker access.
    quantity: int = Field(le=1_000_000)
    ordertype: str = Field(default="MARKET", min_length=1, max_length=16)
    price: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)


cfg = load_config(dotenv_path=str(BASE_DIR / ".env"))


def _api_docs_enabled(*, environment: str, render_environment: str = "") -> bool:
    """Expose interactive API documentation only for local development."""
    is_render = render_environment.strip().lower() == "true"
    is_development = environment.strip().lower() in {"dev", "development"}
    return is_development and not is_render


docs_enabled = _api_docs_enabled(
    environment=cfg.env,
    render_environment=os.getenv("RENDER", ""),
)
app = FastAPI(
    title="Angel One Trading Backend",
    version="0.1.0",
    debug=False,
    docs_url="/docs" if docs_enabled else None,
    redoc_url="/redoc" if docs_enabled else None,
    openapi_url="/openapi.json" if docs_enabled else None,
)
app.include_router(spreads_router)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    request.state.request_id = str(uuid4())
    response = await call_next(request)
    response.headers.setdefault("X-Request-ID", request.state.request_id)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    return response


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(request: Request, exc: RequestValidationError):
    # Do not echo submitted values (login credentials, tokens, order data) in
    # validation responses. Keep FastAPI's detail-array shape for clients.
    details = [
        {"loc": error.get("loc", []), "msg": error.get("msg", "Invalid value"), "type": error.get("type", "value_error")}
        for error in exc.errors()
    ]
    request_id = _request_id(request)
    return JSONResponse(
        status_code=422,
        content={"detail": details, "requestId": request_id},
        headers={"X-Request-ID": request_id},
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    request_id = _request_id(request)
    status_code = exc.status_code
    detail = _safe_http_detail(exc.detail) if status_code < 500 else "Service temporarily unavailable."
    if status_code >= 500:
        logger.warning("handled_http_error request_id=%s status=%s", request_id, status_code)
    return JSONResponse(
        status_code=status_code,
        content={"detail": detail, "requestId": request_id},
        headers={"X-Request-ID": request_id},
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception):
    request_id = _request_id(request)
    frames = exc.__traceback__
    frame = None
    while frames is not None:
        frame = frames
        frames = frames.tb_next
    logger.error(
        "unhandled_exception request_id=%s type=%s location=%s:%s message=%s",
        request_id,
        type(exc).__name__,
        Path(frame.tb_frame.f_code.co_filename).name if frame else "unknown",
        frame.tb_lineno if frame else "unknown",
        _safe_http_detail(str(exc)),
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error.", "requestId": request_id},
        headers={"X-Request-ID": request_id},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# INTERNAL_SERVICE_KEY is canonical; retain INTERNAL_API_SECRET for existing deployments.
INTERNAL_SERVICE_KEY = (
    os.getenv("INTERNAL_SERVICE_KEY")
    or os.getenv("INTERNAL_API_SECRET")
    or ""
).strip()
_broker_request_counts: Dict[str, int] = {}


@app.on_event("startup")
def validate_deployment_security() -> None:
    production = os.getenv("APP_ENV", cfg.env).strip().lower() in {"prod", "production"} or os.getenv("RENDER", "").strip().lower() == "true"
    if not production:
        return
    if len(INTERNAL_SERVICE_KEY) < 32:
        raise RuntimeError("INTERNAL_SERVICE_KEY must contain at least 32 characters in production")
    if not cfg.angel.base_url.startswith("https://"):
        raise RuntimeError("ANGEL_BASE_URL must use HTTPS in production")
    if not cfg.cors_origins or any(not origin.startswith("https://") for origin in cfg.cors_origins):
        raise RuntimeError("CORS_ORIGINS must contain explicit HTTPS origins in production")


@app.middleware("http")
async def require_internal_service_key(request: Request, call_next):
    """Keep broker/data endpoints private behind the Node API."""
    protected_prefixes = ("/angel", "/market", "/instruments")
    protected_path = request.url.path in {"/internal/ready", "/internal/execution-fence"}
    if request.method != "OPTIONS" and (request.url.path.startswith(protected_prefixes) or protected_path):
        supplied = request.headers.get("X-Internal-Service-Key", "")
        if not INTERNAL_SERVICE_KEY or not hmac.compare_digest(
            supplied.encode("utf-8"), INTERNAL_SERVICE_KEY.encode("utf-8")
        ):
            logger.warning("internal_auth_rejected request_id=%s path=%s", _request_id(request), request.url.path.split("?")[0])
            return JSONResponse(status_code=401, content={"detail": "Internal service authentication required"})
    if request.method != 'OPTIONS' and request.url.path.startswith(protected_prefixes):
        login_request_id = str(uuid4()) if request.url.path == '/angel/login' else None
        execution_mutation = ((request.url.path.startswith('/angel/orders/') and request.method != 'GET')
            or (request.url.path == '/angel/orders' and request.method == 'POST')
            or (request.url.path == '/angel/positions/exit' and request.method == 'POST'))
        try:
            context = AccountContext.from_headers(request.headers)
            if execution_mutation and (not context.execution_owner_id or context.execution_lease_generation is None):
                raise PermissionError('Durable execution owner context required')
            lifecycle = request.url.path in {'/angel/login', '/angel/logout'} or execution_mutation
            deadline = monotonic() + 30
            while True:
                try:
                    worker = dispatch.acquire(context, lifecycle, request.url.path == '/angel/login', wait=False, request_id=login_request_id)
                    break
                except BlockingIOError:
                    if monotonic() >= deadline:
                        raise TimeoutError('Broker account is busy')
                    await anyio.sleep(0.01)
        except AccountCapacityError as exc:
            return JSONResponse(status_code=503, content={'detail': str(exc)})
        except PermissionError as exc:
            if 'context' in locals() and request.url.path == '/angel/login':
                manager = dispatch.abort_login(context, login_request_id)
                if manager is not None:
                    await anyio.to_thread.run_sync(manager.shutdown)
            return JSONResponse(status_code=403, content={'detail': str(exc)})
        except TimeoutError as exc:
            if 'context' in locals() and request.url.path == '/angel/login':
                manager = dispatch.abort_login(context, login_request_id)
                if manager is not None:
                    await anyio.to_thread.run_sync(manager.shutdown)
            return JSONResponse(status_code=503, content={'detail': str(exc)})
        except BaseException:
            if 'context' in locals() and request.url.path == '/angel/login':
                manager = dispatch.abort_login(context, login_request_id)
                if manager is not None:
                    with anyio.CancelScope(shield=True):
                        await anyio.to_thread.run_sync(manager.shutdown)
            raise
        request.state.account_context = context
        request.state.broker_worker = worker
        request.state.broker_session = worker.manager
        token = dispatch.bind_current(worker)
        try:
            with anyio.CancelScope(shield=True):
                response = await call_next(request)
            if request.url.path == '/angel/login' and (response.status_code >= 400 or worker.session_id is None):
                manager = dispatch.finish_failed_login(worker, context, response.status_code, login_request_id)
                if manager is not None:
                    await anyio.to_thread.run_sync(manager.shutdown)
            if request.url.path == '/angel/logout' and response.status_code < 400:
                manager = dispatch.finish_logout(worker, context)
                if manager is not None:
                    await anyio.to_thread.run_sync(manager.shutdown)
            return response
        except BaseException:
            if request.url.path == '/angel/login':
                manager = dispatch.finish_failed_login(worker, context, None, login_request_id)
                if manager is not None:
                    with anyio.CancelScope(shield=True):
                        await anyio.to_thread.run_sync(manager.shutdown)
            raise
        finally:
            dispatch.reset_current(token)
            dispatch.release(worker, lifecycle)
    response = await call_next(request)
    return response


@app.middleware("http")
async def instrument_broker_requests(request: Request, call_next):
    """Observe broker routes outside auth/dispatch so every return path counts."""
    protected_prefixes = ("/angel", "/market", "/instruments")
    if request.method == "OPTIONS" or not request.url.path.startswith(protected_prefixes):
        return await call_next(request)
    started = monotonic()
    response = None
    try:
        response = await call_next(request)
        return response
    finally:
        route = re.sub(r"/orders/[^/]+/", "/orders/:orderId/", request.url.path).split("?")[0][:120]
        _broker_request_counts[route] = _broker_request_counts.get(route, 0) + 1
        context = getattr(request.state, "account_context", None)
        logger.info(
            "broker_audit request_id=%s user_id=%s broker_account_id=%s session_generation=%s method=%s route=%s status=%s duration_ms=%s",
            _request_id(request), context.user_id if context else "unknown",
            context.account_id if context else "unknown", context.session_generation if context else "unknown",
            request.method, route, response.status_code if response else 500,
            round((monotonic() - started) * 1000),
        )


dispatch = AccountDispatch(BrokerSessionManager)


@app.post('/internal/execution-fence')
def install_execution_fence(req: ExecutionOwnerRequest, request: Request) -> Dict[str, Any]:
    try:
        context = AccountContext.from_headers(request.headers)
        dispatch.install_execution_owner(context, req.ownerId, req.generation)
        return {'accepted': True, 'ownerGeneration': req.generation}
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


class CurrentBrokerSession:
    """Request-local facade; account credentials live only in their workers."""
    def __getattr__(self, name):
        return getattr(dispatch.current_manager(), name)


angel = CurrentBrokerSession()

store = OrderStore(db_path=str(BASE_DIR / "orders.sqlite"))
instruments = InstrumentMasterCache()


@app.on_event("shutdown")
def shutdown_services() -> None:
    dispatch.shutdown()


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True}


@app.get("/internal/ready")
def internal_ready() -> Dict[str, Any]:
    """Authenticated readiness probe for the Node service.

    The public /health endpoint remains the Render liveness probe. This
    endpoint additionally verifies that Node and Python share the internal
    service key, without requiring an Angel broker session.
    """
    return {"ready": True}


@app.post("/angel/login")
def angel_login(req: LoginRequest, request: Request) -> Dict[str, Any]:
    context = request.state.account_context
    if req.clientCode.strip().upper() != context.client_id:
        raise HTTPException(status_code=403, detail='Broker client identity mismatch')
    try:
        owner_user_id = request.headers.get("X-Active-User-Id")
        info = angel.connect(
            api_key=req.apiKey,
            client_code=req.clientCode,
            mpin=req.mpin,
            totp_secret=req.totpSecret,
            owner_user_id=owner_user_id,
        )
        worker = request.state.broker_worker
        dispatch.complete_login(context=context, worker=worker, session_id=worker.manager._session_id)
        info['session_id'] = worker.manager._session_id
        return info
    except Exception as exc:  # noqa: BLE001
        diagnostic_message = str(exc)
        for credential in (req.apiKey, req.clientCode, req.mpin, req.totpSecret):
            if credential:
                diagnostic_message = diagnostic_message.replace(credential, "[REDACTED]")
        logger.warning("broker_login_failed request_id=%s type=%s rate_limited=%s", _request_id(request), type(exc).__name__, _is_rate_limited(diagnostic_message))
        if _is_rate_limited(diagnostic_message):
            raise HTTPException(
                status_code=429,
                detail="Angel One is temporarily rate limiting connection attempts. Please wait before trying again.",
            )
        raise HTTPException(status_code=400, detail="Angel One login failed")


@app.get("/angel/session-tokens")
def get_session_tokens() -> Dict[str, Any]:
    if not angel.is_logged_in:
        raise HTTPException(status_code=401, detail="Not logged in")
    return angel.get_internal_session_info()


@app.get("/angel/status")
def angel_status() -> Dict[str, Any]:
    return angel.get_status()

@app.post("/angel/logout")
def angel_logout() -> Dict[str, Any]:
    try:
        return angel.logout()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/angel/profile")
def angel_profile() -> Dict[str, Any]:
    try:
        return angel.get_profile()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/angel/search")
def angel_search(
    query: str = Query(..., min_length=1, max_length=100),
    exchange: str = Query("NSE", min_length=1, max_length=10),
) -> Dict[str, Any]:
    try:
        return angel.search(exchange=exchange, query=query)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.get("/market/candles")
def market_candles(
    exchange: str = Query(..., min_length=1, max_length=10),
    symboltoken: str = Query(..., min_length=1, max_length=32),
    interval: str = Query("FIVE_MINUTE", min_length=1, max_length=24),
    lookback_minutes: int = Query(375, ge=1, le=10_080),
    date: Optional[str] = Query(None, max_length=10),
) -> Dict[str, Any]:
    try:
        if date is not None:
            try:
                parsed_date = datetime.strptime(date, "%Y-%m-%d")
                if parsed_date.strftime("%Y-%m-%d") != date:
                    raise ValueError("non-canonical date")
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="date must use YYYY-MM-DD format") from exc
        supported_intervals = {
            "ONE_MINUTE", "THREE_MINUTE", "FIVE_MINUTE", "TEN_MINUTE",
            "FIFTEEN_MINUTE", "THIRTY_MINUTE", "ONE_HOUR", "ONE_DAY",
        }
        if interval not in supported_intervals:
            raise HTTPException(status_code=400, detail="Unsupported candle interval")
        ist = timezone(timedelta(hours=5, minutes=30))
        if date:
            target_date = datetime.strptime(date, "%Y-%m-%d").date()
            from_dt = datetime.combine(target_date, time(9, 15)).replace(tzinfo=ist)
            to_dt = datetime.combine(target_date, time(15, 30)).replace(tzinfo=ist)
        else:
            now_ist = datetime.now(ist)
            to_dt = min(now_ist, now_ist.replace(hour=15, minute=30, second=0, microsecond=0))
            from_dt = to_dt - timedelta(minutes=max(1, lookback_minutes))
            if from_dt >= to_dt:
                from_dt = to_dt - timedelta(minutes=max(1, lookback_minutes))

        candles = angel.get_candles(
            exchange=exchange,
            symboltoken=symboltoken,
            interval=interval,
            from_dt=from_dt,
            to_dt=to_dt,
        )
        return {"items": candles}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        msg_lower = msg.lower()
        if "not logged in" in msg_lower:
            raise HTTPException(status_code=401, detail=msg)
        if "exceeding access rate" in msg_lower or "access denied" in msg_lower or "rate limit" in msg_lower or "429" in msg_lower:
            raise HTTPException(status_code=429, detail=msg)
        if "invalid candle window" in msg_lower or "no data" in msg_lower:
            return {"items": []}
        if "invalid token" in msg_lower or "symboltoken" in msg_lower or "invalid candle request" in msg_lower:
            raise HTTPException(status_code=400, detail=msg)
        raise HTTPException(status_code=500, detail=msg)


@app.get("/market/ltp")
def market_ltp(
    exchange: str = Query(..., min_length=1, max_length=10),
    tradingsymbol: str = Query(..., min_length=1, max_length=64),
    symboltoken: str = Query(..., min_length=1, max_length=32),
    requireFresh: bool = Query(False),
) -> Dict[str, Any]:
    try:
        args = dict(exchange=exchange, tradingsymbol=tradingsymbol, symboltoken=symboltoken)
        if requireFresh:
            args['require_fresh'] = True
        return angel.get_ltp(**args)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.get("/angel/margins")
def angel_margins() -> Dict[str, Any]:
    try:
        return angel.margins()
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.post("/angel/margins/required")
def required_margin(req: RequiredMarginRequest) -> Dict[str, Any]:
    qty = int(req.quantity)
    if qty <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be > 0")

    tx = req.transactiontype.strip().upper()
    if tx not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="Invalid transactiontype")

    ordertype = req.ordertype.strip().upper()
    if ordertype not in {"MARKET", "LIMIT", "SL", "SL-L"}:
        raise HTTPException(status_code=400, detail="Unsupported order type")

    price: Optional[float] = req.price
    if ordertype in {"MARKET", "SL"}:
        price = 0.0
    if ordertype in {"LIMIT", "SL-L"} and (price is None or price <= 0):
        raise HTTPException(status_code=400, detail="This order type requires a valid price")

    payload: Dict[str, Any] = {
        "exchange": req.exchange,
        "tradingsymbol": req.tradingsymbol,
        "symboltoken": req.symboltoken,
        "transactiontype": tx,
        "producttype": req.producttype,
        "quantity": str(qty),
        "ordertype": ordertype,
        "price": str(price if price is not None else 0),
    }

    try:
        return angel.required_margin(payload)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.get("/angel/orderbook")
def angel_orderbook() -> Dict[str, Any]:
    try:
        return angel.order_book()
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.post("/angel/orders/{order_id}/cancel")
def angel_cancel_order(order_id: str, req: CancelOrderRequest = CancelOrderRequest()) -> Dict[str, Any]:
    try:
        return angel.cancel_order(order_id=order_id, variety=req.variety)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.get("/angel/positions")
def angel_positions() -> Dict[str, Any]:
    try:
        return angel.positions()
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.post("/angel/positions/exit")
def angel_exit_position(req: ExitPositionRequest, request: Request) -> Dict[str, Any]:
    tx = req.transactiontype.strip().upper()
    if tx not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="Invalid transactiontype")
    qty = int(req.quantity)
    if qty <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be > 0")

    # Exit is implemented as MARKET order in opposite direction.
    payload: Dict[str, Any] = {
        "variety": "NORMAL",
        "tradingsymbol": req.tradingsymbol,
        "symboltoken": req.symboltoken,
        "transactiontype": tx,
        "exchange": req.exchange,
        "ordertype": "MARKET",
        "producttype": req.producttype,
        "duration": "DAY",
        "price": "0",
        "squareoff": "0",
        "stoploss": "0",
        "quantity": str(qty),
    }

    # If this is a short position, the client should pass BUY; we also support that via a suffix in symbol.
    # For safety, allow caller to include transactiontype as part of tradingsymbol is not supported here.
    # Frontend will decide side based on net quantity.
    try:
        response = angel.place_order(payload)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))

    context = request.state.account_context
    attempt = store.add(id=str(uuid4()), request=payload, response=response, user_id=context.user_id, account_id=context.account_id)
    return {"item": store.to_dict(attempt)}


@app.get("/instruments/search")
def instrument_search(query: str = Query(..., min_length=2, max_length=80),
                      exchange: str = Query("ALL", pattern="^(ALL|NSE|BSE|NFO|BFO|MCX)$")) -> Dict[str, Any]:
    try:
        return {"items": instruments.search(query, exchange)}
    except Exception:
        raise HTTPException(status_code=503, detail="Instrument directory is unavailable. Try again shortly.")


@app.get("/instruments/resolve")
def instrument_resolve(exchange: str = Query(..., pattern="^(NSE|BSE|NFO|BFO|MCX)$"),
                       symboltoken: str = Query(..., pattern="^[0-9]{1,32}$")) -> Dict[str, Any]:
    try:
        return {"item": instruments.resolve(exchange, symboltoken)}
    except ValueError:
        raise HTTPException(status_code=404, detail="Instrument not found or expired.")
    except Exception:
        raise HTTPException(status_code=503, detail="Instrument directory is unavailable.")


@app.get("/instruments/history")
def instrument_history(exchange: str = Query(..., pattern="^(NSE|BSE|NFO|BFO|MCX)$"),
                       symboltoken: str = Query(..., pattern="^[0-9]{1,32}$"),
                       interval: str = Query("FIVE_MINUTE", pattern="^(ONE_MINUTE|THREE_MINUTE|FIVE_MINUTE|FIFTEEN_MINUTE|THIRTY_MINUTE|ONE_HOUR)$")) -> Dict[str, Any]:
    instrument_resolve(exchange, symboltoken)
    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    try:
        return {"items": angel.get_candles(exchange=exchange, symboltoken=symboltoken,
                                           interval=interval, from_dt=now - timedelta(days=7), to_dt=now)}
    except Exception as e:
        msg = str(e).lower()
        if "rate" in msg or "access denied" in msg or "429" in msg:
            raise HTTPException(status_code=429, detail="Historical data is rate limited. Try again shortly.")
        if "no data" in msg:
            return {"items": []}
        raise HTTPException(status_code=503, detail="Historical data is temporarily unavailable.")


@app.get("/instruments/index-options")
def index_options(
    exchange: str = Query(..., min_length=1, max_length=10),
    underlying: str = Query(..., min_length=1, max_length=32),
    expiry: Optional[str] = Query(None, max_length=10),
    strike: Optional[float] = Query(None, ge=0, le=10_000_000, allow_inf_nan=False),
    option_type: Optional[str] = Query(None, min_length=2, max_length=2),
) -> Dict[str, Any]:
    try:
        expiries, strikes, contracts = instruments.get_index_options(exchange=exchange, underlying=underlying, expiry=expiry)

        filtered = contracts
        if expiry is not None:
            filtered = [c for c in filtered if c.expiry == expiry]
        if strike is not None:
            filtered = [c for c in filtered if c.strike == float(strike)]
        if option_type is not None:
            ot = option_type.strip().upper()
            filtered = [c for c in filtered if c.option_type == ot]

        return {
            "expiries": expiries,
            "strikes": strikes,
            "contracts": [
                {
                    "exchange": c.exchange,
                    "underlying": c.underlying,
                    "expiry": c.expiry,
                    "strike": c.strike,
                    "lot_size": c.lot_size,
                    "option_type": c.option_type,
                    "tradingsymbol": c.tradingsymbol,
                    "symboltoken": c.symboltoken,
                }
                for c in filtered
            ],
        }
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/market/index-ltp")
def index_ltp(underlying: str = Query(..., min_length=1, max_length=32)) -> Dict[str, Any]:
    und = underlying.strip().upper()
    # NIFTY/BANKNIFTY are NSE indices, SENSEX is BSE, CRUDEOILM is MCX.
    primary_ex = "BSE" if und == "SENSEX" else "MCX" if und == "CRUDEOILM" else "NSE"
    search_ex = primary_ex

    try:
        tradingsymbol, symboltoken = instruments.get_index_spot(underlying=und)
        try:
            return angel.get_ltp(exchange=primary_ex, tradingsymbol=tradingsymbol, symboltoken=symboltoken)
        except Exception:
            # Fall back to search-based lookup when instrument-master entry is not queryable.
            # Some SmartAPI environments return missing LTP for certain index tokens.
            pass

        search = angel.search(exchange=search_ex, query=und)
        raw: Any = search.get("data")
        if not isinstance(raw, list):
            raw = []

        candidates = [x for x in raw if isinstance(x, dict)]
        if not candidates:
            raise RuntimeError("Unable to find index symbol")

        def pick(d: Dict[str, Any], *keys: str) -> str:
            for k in keys:
                v = d.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
            return ""

        # Prefer entries that contain INDEX and end with -INDEX.
        def score(x: Dict[str, Any]) -> int:
            ts = pick(x, "tradingsymbol", "tradingSymbol", "symbol").upper()
            name = pick(x, "name", "companyname", "symbolname").upper()
            s = 0
            if und in ts:
                s += 3
            if und in name:
                s += 2
            if "INDEX" in ts or "INDEX" in name:
                s += 3
            if ts.endswith("-INDEX"):
                s += 4
            return s

        best = sorted(candidates, key=score, reverse=True)[0]
        best_ts = pick(best, "tradingsymbol", "tradingSymbol", "symbol")
        best_token = pick(best, "symboltoken", "symbolToken", "token")
        if not best_ts or not best_token:
            raise RuntimeError("Unable to find index token")

        return angel.get_ltp(exchange=primary_ex, tradingsymbol=best_ts, symboltoken=best_token)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.get("/angel/orders")
def list_orders(request: Request, limit: int = Query(50, ge=1, le=500)) -> Dict[str, Any]:
    context = request.state.account_context
    attempts = store.list(limit=limit, user_id=context.user_id, account_id=context.account_id)
    return {"items": [store.to_dict(a) for a in attempts]}


@app.delete("/angel/orders")
def clear_orders(request: Request) -> Dict[str, Any]:
    context = request.state.account_context
    deleted = store.clear(user_id=context.user_id, account_id=context.account_id)
    return {"deleted": deleted}


@app.post("/angel/logout")
def angel_logout() -> Dict[str, Any]:
    try:
        return angel.logout()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/angel/orders")
def place_order(req: PlaceOrderRequest, request: Request) -> Dict[str, Any]:
    attempt_id = str(uuid4())
    try:
        response = angel.place_order(req.payload)
    except Exception as e:  # noqa: BLE001
        response = {"status": False, "outcome": "UNKNOWN", "error": _safe_http_detail(str(e))}

    context = request.state.account_context
    attempt = store.add(id=attempt_id, request=req.payload, response=response, user_id=context.user_id, account_id=context.account_id)
    return {"item": store.to_dict(attempt)}


@app.post("/angel/orders/simple")
def place_simple_order(req: SimpleOrderRequest, request: Request) -> Dict[str, Any]:
    attempt_id = str(uuid4())

    qty = int(req.quantity)
    if qty <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be > 0")

    tx = req.transactiontype.strip().upper()
    if tx not in {"BUY", "SELL"}:
        raise HTTPException(status_code=400, detail="Invalid transactiontype")

    producttype = req.producttype
    ex = req.exchange.strip().upper()
    if ex in {"NFO", "BFO"}:
        # Derivatives do not accept DELIVERY. Use carryforward for positional trades.
        if producttype == "DELIVERY":
            producttype = "CARRYFORWARD"

    ordertype = req.ordertype.strip().upper()
    if ordertype not in {"MARKET", "LIMIT", "SL", "SL-L"}:
        raise HTTPException(status_code=400, detail="Unsupported order type")

    price: Optional[float] = req.price
    trigger: Optional[float] = req.triggerprice
    if ordertype == "MARKET":
        price = 0.0
        trigger = None
    elif ordertype == "LIMIT":
        if price is None or price <= 0:
            raise HTTPException(status_code=400, detail="LIMIT requires price")
        trigger = None
    elif ordertype == "SL":
        if trigger is None or trigger <= 0:
            raise HTTPException(status_code=400, detail="SL requires triggerprice")
        price = 0.0
    elif ordertype == "SL-L":
        if trigger is None or trigger <= 0:
            raise HTTPException(status_code=400, detail="SL-L requires triggerprice")
        if price is None or price <= 0:
            raise HTTPException(status_code=400, detail="SL-L requires price")

    payload: Dict[str, Any] = {
        "variety": req.variety,
        "tradingsymbol": req.tradingsymbol,
        "symboltoken": req.symboltoken,
        "transactiontype": tx,
        "exchange": ex,
        "ordertype": ordertype,
        "producttype": producttype,
        "duration": "DAY",
        "price": str(price if price is not None else 0),
        "triggerprice": str(trigger) if trigger is not None else None,
        "squareoff": "0",
        "stoploss": "0",
        "quantity": str(qty),
    }

    try:
        response = angel.place_order(payload)
    except Exception as e:  # noqa: BLE001
        response = {"status": False, "outcome": "UNKNOWN", "error": _safe_http_detail(str(e))}

    context = request.state.account_context
    attempt = store.add(id=attempt_id, request=payload, response=response, user_id=context.user_id, account_id=context.account_id)
    return {"item": store.to_dict(attempt)}
