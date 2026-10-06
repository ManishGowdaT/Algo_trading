from __future__ import annotations

from dataclasses import dataclass
import inspect
import math
from threading import Lock
from time import monotonic
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

from SmartApi import SmartConnect  # type: ignore

from app.core.totp import generate_totp


@dataclass
class AngelSession:
    jwt_token: str
    refresh_token: str
    feed_token: str
    client_code: str


class AngelClient:
    def __init__(self, *, api_key: str, client_code: str, totp_secret: str) -> None:
        self._api_key = api_key
        self._client_code = client_code
        self._totp_secret = totp_secret
        self._smart = SmartConnect(api_key=self._api_key)
        self._session: Optional[AngelSession] = None
        self._quote_lock = Lock()
        self._quote_symbols = {}
        self._quote_cache = {}
        self._quote_last_attempt = float('-inf')

    @property
    def is_logged_in(self) -> bool:
        return self._session is not None

    def login(self, mpin: str) -> Dict[str, Any]:
        totp = generate_totp(self._totp_secret)
        data = self._smart.generateSession(self._client_code, mpin, totp)

        if not isinstance(data, dict):
            raise RuntimeError("Unexpected login response from SmartAPI")

        if not data.get("status"):
            message = data.get("message") or "SmartAPI login failed"
            raise RuntimeError(str(message))

        tokens = data.get("data") or {}
        jwt_token = str(tokens.get("jwtToken") or "")
        refresh_token = str(tokens.get("refreshToken") or "")
        feed_token = str(self._smart.getfeedToken() or "")

        if not jwt_token:
            raise RuntimeError("SmartAPI login succeeded but jwtToken was missing")

        self._session = AngelSession(
            jwt_token=jwt_token,
            refresh_token=refresh_token,
            feed_token=feed_token,
            client_code=self._client_code,
        )

        return {
            "status": True,
            "message": "Angel One login successful",
            "client_code": self._client_code,
            "jwt_token": jwt_token,
            "feed_token": feed_token,
            "api_key": self._api_key,
        }

    def get_session_info(self) -> Dict[str, Any]:
        if self._session is None:
            return {"status": False, "message": "Not logged in"}
        return {
            "status": True,
            "client_code": self._session.client_code,
            "jwt_token": self._session.jwt_token,
            "feed_token": self._session.feed_token,
            "api_key": self._api_key,
        }

    def get_profile(self) -> Dict[str, Any]:
        self._require_session()
        profile = self._smart.getProfile(self._session.refresh_token)  # type: ignore[arg-type]
        if not isinstance(profile, dict):
            raise RuntimeError("Unexpected profile response from SmartAPI")
        return profile

    def search(self, *, exchange: str, query: str) -> Dict[str, Any]:
        self._require_session()
        # SmartAPI provides searchScrip in some versions. Use getattr for compatibility.
        fn = getattr(self._smart, "searchScrip", None)
        if fn is None:
            raise RuntimeError("search is not supported by the installed SmartAPI client")
        result = fn(exchange=exchange, searchscrip=query)
        if not isinstance(result, dict):
            raise RuntimeError("Unexpected search response from SmartAPI")
        return result

    def place_order(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._require_session()
        clean_payload: Dict[str, Any] = {k: v for k, v in payload.items() if v is not None}

        raw_post = getattr(self._smart, "_postRequest", None)
        if callable(raw_post):
            # An exception can follow an accepted order. Never submit again
            # through another endpoint; Node owns durable reconciliation.
            full = raw_post("api.order.placefullresponse", clean_payload)
            if isinstance(full, dict):
                return full
            if full is None:
                return {"status": False, "outcome": "UNKNOWN", "message": "SmartAPI returned empty response"}
            return {"status": True, "data": {"orderid": str(full)}}

        place_full = getattr(self._smart, "placeOrderFullResponse", None)
        if callable(place_full):
            result = place_full(payload)
            if isinstance(result, dict):
                return result
            if result is None:
                return {"status": False, "outcome": "UNKNOWN", "message": "SmartAPI returned empty response"}
            return {"status": True, "data": {"orderid": str(result)}}

        result = self._smart.placeOrder(payload)
        if isinstance(result, dict):
            return result
        if result is None:
            return {"status": False, "outcome": "UNKNOWN", "message": "SmartAPI returned empty response"}
        return {"status": True, "data": {"orderid": str(result)}}

    def order_book(self) -> Dict[str, Any]:
        self._require_session()

        fn = getattr(self._smart, "orderBook", None)
        if callable(fn):
            result = fn()
            if not isinstance(result, dict):
                raise RuntimeError("Unexpected order book response from SmartAPI")
            return result

        raw_post = getattr(self._smart, "_postRequest", None)
        if callable(raw_post):
            result = raw_post("api.order.book", {})
            if not isinstance(result, dict):
                raise RuntimeError("Unexpected order book response from SmartAPI")
            return result

        raise RuntimeError("orderBook is not supported by the installed SmartAPI client")

    def cancel_order(self, *, order_id: str, variety: str = "NORMAL") -> Dict[str, Any]:
        self._require_session()
        oid = order_id.strip()
        if not oid:
            raise RuntimeError("Invalid order id")

        fn = getattr(self._smart, "cancelOrder", None)
        if callable(fn):
            # Resolve calling convention before mutation, never by retrying an
            # exception that may have occurred after the broker accepted it.
            try:
                inspect.signature(fn).bind(order_id=oid, variety=variety)
            except TypeError:
                result = fn(oid, variety)
            else:
                result = fn(order_id=oid, variety=variety)
            if not isinstance(result, dict):
                raise RuntimeError("Unexpected cancel order response from SmartAPI")
            return result

        raw_post = getattr(self._smart, "_postRequest", None)
        if callable(raw_post):
            result = raw_post("api.order.cancel", {"orderid": oid, "variety": variety})
            if not isinstance(result, dict):
                raise RuntimeError("Unexpected cancel order response from SmartAPI")
            return result

        raise RuntimeError("cancelOrder is not supported by the installed SmartAPI client")

    def positions(self) -> Dict[str, Any]:
        self._require_session()

        for name in ("position", "positions", "getPosition"):
            fn = getattr(self._smart, name, None)
            if callable(fn):
                result = fn()
                if not isinstance(result, dict):
                    raise RuntimeError("Unexpected positions response from SmartAPI")
                return result

        raw_post = getattr(self._smart, "_postRequest", None)
        if callable(raw_post):
            result = raw_post("api.position", {})
            if not isinstance(result, dict):
                raise RuntimeError("Unexpected positions response from SmartAPI")
            return result

        raise RuntimeError("positions are not supported by the installed SmartAPI client")

    def get_ltp(self, *, exchange: str, tradingsymbol: str, symboltoken: str, require_fresh: bool = False) -> Dict[str, Any]:
        self._require_session()
        ex = exchange.strip().upper()
        ts = tradingsymbol.strip()
        token = symboltoken.strip()
        if not ex or not ts or not token:
            raise RuntimeError("Invalid ltp request")
        if require_fresh:
            return self._get_timestamped_quote(ex, ts, token)

        fn = getattr(self._smart, "ltpData", None)
        if fn is None:
            raise RuntimeError("ltpData is not supported by the installed SmartAPI client")

        result = fn(exchange=ex, tradingsymbol=ts, symboltoken=token)
        if not isinstance(result, dict):
            raise RuntimeError("Unexpected ltp response")

        data: Any = result.get("data")
        ltp: Optional[float] = None
        if isinstance(data, dict):
            v = data.get("ltp")
            if isinstance(v, (int, float)):
                ltp = float(v)
            elif isinstance(v, str):
                try:
                    ltp = float(v)
                except ValueError:
                    ltp = None
        close_val = float(data.get("close") or 0) if isinstance(data, dict) and data.get("close") is not None else 0.0
        open_val = float(data.get("open") or 0) if isinstance(data, dict) and data.get("open") is not None else 0.0
        high_val = float(data.get("high") or 0) if isinstance(data, dict) and data.get("high") is not None else 0.0
        low_val = float(data.get("low") or 0) if isinstance(data, dict) and data.get("low") is not None else 0.0

        return {
            "exchange": ex,
            "tradingsymbol": ts,
            "symboltoken": token,
            "ltp": ltp,
            "close": close_val,
            "open": open_val,
            "high": high_val,
            "low": low_val,
        }

    def _get_timestamped_quote(self, exchange: str, symbol: str, token: str) -> Dict[str, Any]:
        # Account-local state: at most 50 instruments, no waiting broker retry,
        # and at most one FULL request per second across concurrent monitors.
        with self._quote_lock:
            now = monotonic()
            self._quote_symbols = {key: value for key, value in self._quote_symbols.items() if now - value[1] < 60}
            key = (exchange, token)
            if key not in self._quote_symbols and len(self._quote_symbols) >= 50:
                raise RuntimeError('Timestamped quote instrument capacity reached')
            self._quote_symbols[key] = (symbol, now)
            if now - self._quote_last_attempt >= 1:
                self._quote_last_attempt = now
                self._quote_cache.clear()  # A failed refresh cannot resurrect old quotes.
                fn = getattr(self._smart, 'getMarketData', None)
                if fn is None:
                    raise RuntimeError('Timestamped FULL quotes are not supported by this SmartAPI client')
                tokens = {}
                for ex, instrument in self._quote_symbols:
                    tokens.setdefault(ex, []).append(instrument)
                result = fn('FULL', tokens)
                if not isinstance(result, dict) or result.get('status') is not True:
                    raise RuntimeError('Timestamped broker quote unavailable')
                for row in (result.get('data') or {}).get('fetched', []):
                    row_key = (str(row.get('exchange', '')).upper(), str(row.get('symbolToken', '')))
                    expected = self._quote_symbols.get(row_key)
                    if not expected or row.get('tradingSymbol') != expected[0]:
                        continue
                    try:
                        price = float(row['ltp'])
                        # Broker exchange time is India local time; never use
                        # the server's timezone or response receipt time.
                        timestamp = datetime.strptime(row['exchFeedTime'], '%d-%b-%Y %H:%M:%S').replace(
                            tzinfo=timezone(timedelta(hours=5, minutes=30))).timestamp() * 1000
                        if not math.isfinite(price) or price <= 0:
                            continue
                    except (KeyError, TypeError, ValueError):
                        continue
                    self._quote_cache[row_key] = { 'exchange': row_key[0], 'tradingsymbol': expected[0],
                        'symboltoken': row_key[1], 'ltp': price, 'quoteTimestamp': timestamp,
                        'quoteSource': 'ANGEL_FULL', **{field: row.get(field, 0) for field in ['open', 'high', 'low', 'close']} }
            quote = self._quote_cache.get(key)
            if quote is None or quote['tradingsymbol'] != symbol:
                raise RuntimeError('Verified timestamped quote is not yet available; monitoring is degraded')
            return dict(quote)

    def get_candles(
        self,
        *,
        exchange: str,
        symboltoken: str,
        interval: str,
        from_dt: datetime,
        to_dt: datetime,
    ) -> List[Dict[str, Any]]:
        self._require_session()

        ex = exchange.strip().upper()
        token = symboltoken.strip()
        iv = interval.strip().upper()
        if not ex or not token or not iv:
            raise RuntimeError("Invalid candle request")
        if from_dt >= to_dt:
            raise RuntimeError("Invalid candle window")

        # SmartAPI typically expects: YYYY-MM-DD HH:MM
        def fmt(dt: datetime) -> str:
            ist = timezone(timedelta(hours=5, minutes=30))
            local = dt.astimezone(ist) if dt.tzinfo is not None else dt.replace(tzinfo=ist)
            # SmartAPI expects local market time string; tz suffix must not be included.
            return local.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M")

        payload: Dict[str, Any] = {
            "exchange": ex,
            "symboltoken": token,
            "interval": iv,
            "fromdate": fmt(from_dt),
            "todate": fmt(to_dt),
        }

        raw: Any = None
        for name in ("getCandleData", "candleData", "getCandleDataV2"):
            fn = getattr(self._smart, name, None)
            if callable(fn):
                try:
                    raw = fn(payload)
                except TypeError:
                    raw = fn(**payload)
                break

        if raw is None:
            raw_post = getattr(self._smart, "_postRequest", None)
            if callable(raw_post):
                raw = raw_post("api.candle.data", payload)

        if not isinstance(raw, dict):
            raise RuntimeError("Unexpected candle response from SmartAPI")

        if raw.get("status") is False:
            msg = str(raw.get("message") or "SmartAPI returned failure status")
            raise RuntimeError(msg)

        data: Any = raw.get("data")
        if not isinstance(data, list):
            data = []

        candles: List[Dict[str, Any]] = []
        for row in data:
            if not isinstance(row, Sequence) or len(row) < 5:
                continue
            ts = row[0]
            o = row[1]
            h = row[2]
            l = row[3]
            c = row[4]
            if not isinstance(ts, str):
                continue
            try:
                o_f = float(o)
                h_f = float(h)
                l_f = float(l)
                c_f = float(c)
            except Exception:
                continue
            candles.append({"ts": ts, "open": o_f, "high": h_f, "low": l_f, "close": c_f})

        return candles

    def margins(self) -> Dict[str, Any]:
        self._require_session()

        for name in (
            "rmsLimit",
            "getRMS",
            "getRmsLimit",
            "getrmsLimit",
            "getMargin",
        ):
            fn = getattr(self._smart, name, None)
            if callable(fn):
                result = fn()
                if not isinstance(result, dict):
                    raise RuntimeError("Unexpected margins response from SmartAPI")
                return result

        raw_post = getattr(self._smart, "_postRequest", None)
        if callable(raw_post):
            # Endpoint key differs between versions; try a small set.
            for key in (
                "api.rms.limit",
                "api.user.rms",
                "api.margin.rms",
            ):
                try:
                    result = raw_post(key, {})
                except Exception:
                    continue
                if isinstance(result, dict):
                    return result

        raise RuntimeError("margins are not supported by the installed SmartAPI client")

    def required_margin(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        self._require_session()

        clean_payload: Dict[str, Any] = {k: v for k, v in payload.items() if v is not None}

        for name in (
            "marginCalculator",
            "getMarginCalculator",
            "marginRequired",
            "marginRequiredV2",
            "getMarginRequired",
        ):
            fn = getattr(self._smart, name, None)
            if callable(fn):
                try:
                    result = fn(clean_payload)
                except TypeError:
                    result = fn(**clean_payload)
                if not isinstance(result, dict):
                    raise RuntimeError("Unexpected required margin response from SmartAPI")
                return result

        raw_post = getattr(self._smart, "_postRequest", None)
        if callable(raw_post):
            for key in (
                "api.margin.required",
                "api.order.margin",
                "api.margin.calculator",
            ):
                try:
                    result = raw_post(key, clean_payload)
                except Exception:
                    continue
                if isinstance(result, dict):
                    return result

        return {"supported": False, "message": "Required margin is not supported by the installed SmartAPI client"}

    def get_index_ltp(self, *, underlying: str) -> Dict[str, Any]:
        self._require_session()

        und = underlying.strip().upper()
        if und not in {"NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX"}:
            raise RuntimeError("Unsupported underlying")

        search = self.search(exchange="NSE", query=und)
        raw: Any = search.get("data")
        if not isinstance(raw, list):
            raw = []

        candidates: List[Dict[str, Any]] = [x for x in raw if isinstance(x, dict)]

        def score(x: Dict[str, Any]) -> int:
            ts = str(x.get("tradingsymbol") or x.get("tradingSymbol") or x.get("symbol") or "").upper()
            name = str(x.get("name") or x.get("companyname") or x.get("symbolname") or "").upper()
            s = 0
            if und in ts:
                s += 3
            if und in name:
                s += 2
            if "INDEX" in ts or "INDEX" in name:
                s += 3
            if ts.endswith("-INDEX"):
                s += 3
            return s

        candidates = sorted(candidates, key=score, reverse=True)
        if not candidates:
            raise RuntimeError("Unable to find index symbol")

        best = candidates[0]
        tradingsymbol = str(best.get("tradingsymbol") or best.get("tradingSymbol") or best.get("symbol") or "")
        symboltoken = str(best.get("symboltoken") or best.get("token") or best.get("symbolToken") or "")
        if not tradingsymbol or not symboltoken:
            raise RuntimeError("Unable to find index token")

        fn = getattr(self._smart, "ltpData", None)
        if fn is None:
            raise RuntimeError("ltpData is not supported by the installed SmartAPI client")

        result = fn(exchange="NSE", tradingsymbol=tradingsymbol, symboltoken=symboltoken)
        if not isinstance(result, dict):
            raise RuntimeError("Unexpected ltp response")

        data: Any = result.get("data")
        ltp: Optional[float] = None
        if isinstance(data, dict):
            v = data.get("ltp")
            if isinstance(v, (int, float)):
                ltp = float(v)
            elif isinstance(v, str):
                try:
                    ltp = float(v)
                except ValueError:
                    ltp = None
        if ltp is None:
            raise RuntimeError("LTP was missing")

        return {"underlying": und, "exchange": "NSE", "tradingsymbol": tradingsymbol, "symboltoken": symboltoken, "ltp": ltp}

    def _require_session(self) -> None:
        if self._session is None:
            raise RuntimeError("Not logged in. Call /angel/login first.")

    def logout(self) -> Dict[str, Any]:
        if self._session is None:
            return {"status": True, "message": "Already logged out"}

        terminate = getattr(self._smart, "terminateSession", None)
        try:
            if callable(terminate):
                terminate(self._session.client_code)
        finally:
            self._session = None

        return {"status": True, "message": "Logged out"}
