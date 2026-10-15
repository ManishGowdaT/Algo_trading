"""Small Upstox-only HTTP transport with bounded retries and safe errors."""

from __future__ import annotations

import random
import re
import time
import json
import hashlib
import threading
from copy import deepcopy
from collections import OrderedDict
from contextvars import ContextVar
from typing import Any
from urllib.parse import quote, urlsplit

import httpx
from .rate_limit import market_data_quota, retry_after_seconds


UPSTOX_API_BASE = "https://api.upstox.com"
QUOTA_WAIT_OBSERVER = ContextVar("spread_quota_wait_observer", default=None)
RATE_OWNER = ContextVar("spread_rate_owner", default=None)
REQUEST_DEADLINE = ContextVar("spread_request_deadline", default=None)
_cache = OrderedDict()
_cache_lock = threading.Lock()
_CACHE_TTL = 120
_CACHE_LIMIT = 512


def _remaining():
    deadline = REQUEST_DEADLINE.get()
    remaining = deadline - time.monotonic() if deadline is not None else float("inf")
    if remaining <= 0:
        raise UpstoxProviderError("Spread market-data deadline exceeded", status_code=504)
    return remaining


_READ_ONLY_PATHS = frozenset({
    "/v2/instruments/search",
    "/v2/option/contract",
    "/v2/option/chain",
    "/v3/market-quote/option-greek",
})
_HISTORICAL_CANDLE_PATH = re.compile(
    r"/v3/historical-candle/[A-Za-z0-9_.~%+-]+/days/1/\d{4}-\d{2}-\d{2}/\d{4}-\d{2}-\d{2}"
)


def _is_read_only_market_data_path(path: str) -> bool:
    if not isinstance(path, str) or "?" in path or "#" in path or "\\" in path:
        return False
    return path in _READ_ONLY_PATHS or _HISTORICAL_CANDLE_PATH.fullmatch(path) is not None


class UpstoxProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def encoded_instrument_key(instrument_key: str) -> str:
    if not isinstance(instrument_key, str) or "|" not in instrument_key or len(instrument_key) > 120:
        raise ValueError("Invalid Upstox instrument key")
    return quote(instrument_key, safe="")


class UpstoxTransport:
    """Makes allow-listed read requests and never logs tokens or response bodies."""

    def __init__(self, access_token: str, *, client: Any = None, sleep=time.sleep, jitter=random.random,
                 timeout: float = 15, max_attempts: int = 4, base_url: str = UPSTOX_API_BASE):
        if not isinstance(access_token, str) or not access_token.strip() or len(access_token) > 8192:
            raise ValueError("A valid Upstox access token is required")
        parsed_base = urlsplit(base_url)
        if (parsed_base.scheme != "https" or parsed_base.hostname != "api.upstox.com"
                or parsed_base.username or parsed_base.password
                or parsed_base.port not in (None, 443)
                or parsed_base.path not in ("", "/") or parsed_base.query or parsed_base.fragment):
            raise ValueError("Upstox API transport requires the official HTTPS host")
        if not 1 <= max_attempts <= 5:
            raise ValueError("max_attempts must be between 1 and 5")
        self._authorization = f"Bearer {access_token.strip()}"
        self._client = client
        self._sleep = sleep
        self._jitter = jitter
        self._timeout = timeout
        self._max_attempts = max_attempts
        self._base_url = base_url.rstrip("/")
        self._identity = hashlib.sha256(access_token.strip().encode()).hexdigest()
        self._metrics_lock = threading.Lock()
        self._metrics = {'option_chain_requests':0, 'v3_greeks_requests':0, 'rate_limit_responses':0}
        # Injected clients have an isolated namespace, preventing test/client data bleed.
        self._scope = client if client is not None else "live"

    def request_metrics(self):
        with self._metrics_lock:
            return dict(self._metrics)

    def get(self, path: str, params: dict[str, Any] | None = None) -> dict:
        if not _is_read_only_market_data_path(path):
            raise ValueError("Only Upstox read-only market-data paths are allowed")
        _remaining()
        key = (self._scope, self._identity, path, json.dumps(params or {}, sort_keys=True))
        with _cache_lock:
            cached = _cache.get(key)
            if cached and time.monotonic() - cached[0] < _CACHE_TTL:
                _cache.move_to_end(key)
                return deepcopy(cached[1])
            _cache.pop(key, None)
        headers = {"Authorization": self._authorization, "Accept": "application/json"}
        response = None
        api = "/v3/historical-candle" if path.startswith("/v3/historical-candle/") else path
        quota_key = (RATE_OWNER.get() or self._identity, api)
        for attempt in range(self._max_attempts):
            if self._client is None:
                market_data_quota.acquire(quota_key, sleep=self._sleep, remaining=_remaining, on_wait=QUOTA_WAIT_OBSERVER.get())
            metric_key = ('option_chain_requests' if path == '/v2/option/chain' else
                          'v3_greeks_requests' if path == '/v3/market-quote/option-greek' else None)
            if metric_key:
                with self._metrics_lock:
                    self._metrics[metric_key] += 1
            try:
                timeout = min(self._timeout, _remaining())
                if self._client is None:
                    response = httpx.get(self._base_url + path, params=params, headers=headers,
                                          timeout=timeout, follow_redirects=False)
                else:
                    response = self._client.get(self._base_url + path, params=params, headers=headers,
                                                timeout=timeout, follow_redirects=False)
            except httpx.TimeoutException as exc:
                if attempt + 1 == self._max_attempts:
                    raise UpstoxProviderError("Upstox market-data request timed out") from exc
                self._backoff(attempt)
                continue
            except httpx.HTTPError as exc:
                if attempt + 1 == self._max_attempts:
                    raise UpstoxProviderError("Upstox market-data service is unreachable") from exc
                self._backoff(attempt)
                continue

            if response.status_code == 429 or response.status_code >= 500:
                if response.status_code == 429:
                    with self._metrics_lock:
                        self._metrics['rate_limit_responses'] += 1
                if attempt + 1 < self._max_attempts:
                    retry_after = response.headers.get("Retry-After", "")
                    delay = retry_after_seconds(retry_after) if retry_after else None
                    if response.status_code == 429 and self._client is None:
                        cooldown = delay if delay is not None else (2 ** attempt) + self._jitter() * .75
                        market_data_quota.cooldown(quota_key, cooldown)
                    self._backoff(attempt, delay)
                    continue
            break

        if response is None:
            raise UpstoxProviderError("Upstox market-data request failed")
        try:
            payload = response.json()
        except (ValueError, TypeError) as exc:
            raise UpstoxProviderError("Upstox returned invalid market-data JSON", status_code=response.status_code) from exc

        if response.status_code == 401:
            raise UpstoxProviderError("Upstox access token is invalid or expired; reconnect Upstox",
                                      status_code=401, code=self._error_code(payload))
        if response.status_code == 403:
            raise UpstoxProviderError("Upstox denied market-data access; check account and API permissions",
                                      status_code=403, code=self._error_code(payload))
        if response.status_code == 429:
            raise UpstoxProviderError("Upstox rate limit reached; retry shortly", status_code=429,
                                      code=self._error_code(payload))
        if response.status_code >= 400:
            raise UpstoxProviderError("Upstox rejected the market-data request", status_code=response.status_code,
                                      code=self._error_code(payload))
        if not isinstance(payload, dict) or payload.get("status") != "success" or "data" not in payload:
            raise UpstoxProviderError("Upstox returned an unsuccessful market-data response",
                                      status_code=response.status_code, code=self._error_code(payload))
        with _cache_lock:
            _cache[key] = (time.monotonic(), deepcopy(payload["data"]))
            _cache.move_to_end(key)
            while len(_cache) > _CACHE_LIMIT:
                _cache.popitem(last=False)
        return payload["data"]

    def _backoff(self, attempt: int, retry_after: float | None = None) -> None:
        delay = retry_after if retry_after is not None else (2 ** attempt) + self._jitter() * 0.75
        if delay >= _remaining():
            raise UpstoxProviderError("Spread market-data deadline exceeded", status_code=504)
        self._sleep(max(0.0, delay))

    @staticmethod
    def _error_code(payload: Any) -> str | None:
        rows = payload.get("errors", []) if isinstance(payload, dict) else []
        if isinstance(rows, dict):
            rows = [rows]
        candidates = ([payload] if isinstance(payload, dict) else []) + (rows if isinstance(rows, list) else [])
        for row in candidates:
            code = row.get("errorCode", row.get("error_code")) if isinstance(row, dict) else None
            if isinstance(code, str) and len(code) <= 40:
                return code
        return None
