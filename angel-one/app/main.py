from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
import os
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.config import load_config
from app.services.broker_session import BrokerSessionManager
from app.services.instrument_master import InstrumentMasterCache
from app.services.order_store import OrderStore


BASE_DIR = Path(__file__).resolve().parent.parent


class PlaceOrderRequest(BaseModel):
    payload: Dict[str, Any] = Field(default_factory=dict)


class SimpleOrderRequest(BaseModel):
    exchange: str
    tradingsymbol: str
    symboltoken: str
    transactiontype: str
    producttype: str
    quantity: int
    ordertype: str = "MARKET"
    price: Optional[float] = None
    triggerprice: Optional[float] = None
    variety: str = "NORMAL"


class CancelOrderRequest(BaseModel):
    variety: str = "NORMAL"


class ExitPositionRequest(BaseModel):
    exchange: str
    tradingsymbol: str
    symboltoken: str
    quantity: int
    producttype: str = "INTRADAY"
    transactiontype: str


class LoginRequest(BaseModel):
    apiKey: str
    clientCode: str
    mpin: str
    totpSecret: str


class LtpRequest(BaseModel):
    exchange: str
    tradingsymbol: str
    symboltoken: str


class RequiredMarginRequest(BaseModel):
    exchange: str
    tradingsymbol: str
    symboltoken: str
    transactiontype: str
    producttype: str
    quantity: int
    ordertype: str = "MARKET"
    price: Optional[float] = None


app = FastAPI(title="Angel One Trading Backend", version="0.1.0")

cfg = load_config(dotenv_path=str(BASE_DIR / ".env"))
app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        if not INTERNAL_SERVICE_KEY or supplied != INTERNAL_SERVICE_KEY:
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
    except Exception as e:  # noqa: BLE001
        # TEMPORARY DIAGNOSTIC LOGGING: preserve existing error behavior.
        print(
            f"[TEMP AngelLoginDiagnostic] timestamp={datetime.now(timezone.utc).isoformat()} "
            f"exception_type={type(e).__name__} message={e}",
            flush=True,
        )
        raise HTTPException(status_code=400, detail=str(e))


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
def angel_search(query: str, exchange: str = "NSE") -> Dict[str, Any]:
    try:
        return angel.search(exchange=exchange, query=query)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "Not logged in" in msg:
            raise HTTPException(status_code=401, detail=msg)
        raise HTTPException(status_code=400, detail=msg)


@app.get("/market/candles")
def market_candles(
    exchange: str,
    symboltoken: str,
    interval: str = "FIVE_MINUTE",
    lookback_minutes: int = 375,
    date: Optional[str] = None,
) -> Dict[str, Any]:
    try:
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
def market_ltp(exchange: str, tradingsymbol: str, symboltoken: str) -> Dict[str, Any]:
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
    exchange: str,
    underlying: str,
    expiry: Optional[str] = None,
    strike: Optional[float] = None,
    option_type: Optional[str] = None,
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
def index_ltp(underlying: str) -> Dict[str, Any]:
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
def list_orders(limit: int = 50) -> Dict[str, Any]:
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
        response = {"status": False, "error": str(e)}

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
        response = {"status": False, "error": str(e)}

    attempt = store.add(id=attempt_id, request=payload, response=response)
    return {"item": store.to_dict(attempt)}
