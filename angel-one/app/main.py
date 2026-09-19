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


@app.middleware("http")
async def require_internal_service_key(request: Request, call_next):
    """Keep broker/data endpoints private behind the Node API."""
    protected_prefixes = ("/angel", "/market", "/instruments")
    if request.method != "OPTIONS" and request.url.path.startswith(protected_prefixes):
        supplied = request.headers.get("X-Internal-Service-Key", "")
        if not INTERNAL_SERVICE_KEY or not hmac.compare_digest(
            supplied.encode("utf-8"), INTERNAL_SERVICE_KEY.encode("utf-8")
        ):
            return JSONResponse(status_code=401, content={"detail": "Internal service authentication required"})
    return await call_next(request)

angel = BrokerSessionManager()

store = OrderStore(db_path=str(BASE_DIR / "orders.sqlite"))
instruments = InstrumentMasterCache()


@app.on_event("shutdown")
def shutdown_services() -> None:
    angel.shutdown()


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True}


@app.post("/angel/login")
def angel_login(req: LoginRequest, request: Request) -> Dict[str, Any]:
    try:
        owner_user_id = request.headers.get("X-Active-User-Id")
        return angel.connect(
            api_key=req.apiKey,
            client_code=req.clientCode,
            mpin=req.mpin,
            totp_secret=req.totpSecret,
            owner_user_id=owner_user_id,
        )
    except Exception as exc:  # noqa: BLE001
        # TEMPORARY DIAGNOSTIC LOGGING: remove after SmartAPI rate-limit investigation.
        diagnostic_message = str(exc)
        for credential in (req.apiKey, req.clientCode, req.mpin, req.totpSecret):
            if credential:
                diagnostic_message = diagnostic_message.replace(credential, "[REDACTED]")
        print(
            f"[TEMP AngelLoginDiagnostic] timestamp={datetime.now(timezone.utc).isoformat()} "
            f"exception_type={type(exc).__name__} message={diagnostic_message}",
            flush=True,
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
) -> Dict[str, Any]:
    try:
        return angel.get_ltp(exchange=exchange, tradingsymbol=tradingsymbol, symboltoken=symboltoken)
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
def angel_exit_position(req: ExitPositionRequest) -> Dict[str, Any]:
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

    attempt = store.add(id=str(uuid4()), request=payload, response=response)
    return {"item": store.to_dict(attempt)}


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
def list_orders(limit: int = Query(50, ge=1, le=500)) -> Dict[str, Any]:
    attempts = store.list(limit=limit)
    return {"items": [store.to_dict(a) for a in attempts]}


@app.delete("/angel/orders")
def clear_orders() -> Dict[str, Any]:
    deleted = store.clear()
    return {"deleted": deleted}


@app.post("/angel/logout")
def angel_logout() -> Dict[str, Any]:
    try:
        return angel.logout()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/angel/orders")
def place_order(req: PlaceOrderRequest) -> Dict[str, Any]:
    attempt_id = str(uuid4())
    try:
        response = angel.place_order(req.payload)
    except Exception as e:  # noqa: BLE001
        response = {"status": False, "error": _safe_http_detail(str(e))}

    attempt = store.add(id=attempt_id, request=req.payload, response=response)
    return {"item": store.to_dict(attempt)}


@app.post("/angel/orders/simple")
def place_simple_order(req: SimpleOrderRequest) -> Dict[str, Any]:
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
        response = {"status": False, "error": _safe_http_detail(str(e))}

    attempt = store.add(id=attempt_id, request=payload, response=response)
    return {"item": store.to_dict(attempt)}
