import httpx
import pytest

from app.services.spreads.transport import UpstoxProviderError, UpstoxTransport


class StubResponse:
    def __init__(self, status_code, payload, headers=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = headers or {}

    def json(self):
        return self._payload


class StubClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def test_transport_retries_rate_limit_then_returns_data_without_exposing_token():
    client = StubClient([
        StubResponse(429, {"status": "error", "errors": []}, {"Retry-After": "0"}),
        StubResponse(200, {"status": "success", "data": [{"id": 1}]}),
    ])
    delays = []
    transport = UpstoxTransport("secret-token", client=client, sleep=delays.append, jitter=lambda: 0)
    assert transport.get("/v2/option/contract", {"instrument_key": "NSE_INDEX|Nifty 50"}) == [{"id": 1}]
    assert len(client.calls) == 2
    assert delays == [0]
    assert client.calls[0][1]["headers"]["Authorization"] == "Bearer secret-token"


def test_transport_rejects_auth_errors_with_safe_message():
    client = StubClient([StubResponse(401, {"status": "error", "errors": [{"errorCode": "UDAPI100050"}]})])
    transport = UpstoxTransport("secret-token", client=client, sleep=lambda _: None)
    with pytest.raises(UpstoxProviderError, match="invalid or expired") as caught:
        transport.get("/v2/option/contract")
    assert caught.value.code == "UDAPI100050"
    assert "secret-token" not in str(caught.value)


@pytest.mark.parametrize("path", [
    "/v2/orders",
    "/v2/order/place",
    "/v2/order/modify",
    "/v3/order/place",
    "/v2/option/chain/../order/place",
    "https://api.upstox.com/v2/option/chain",
    "/v2/option/chain?redirect=/v2/order/place",
])
def test_transport_never_allows_paths_outside_market_data_allowlist(path):
    transport = UpstoxTransport("secret-token", client=StubClient([]))
    with pytest.raises(ValueError, match="read-only"):
        transport.get(path)


def test_transport_allows_only_documented_market_data_path_shapes():
    client = StubClient([StubResponse(200, {"status": "success", "data": {}})])
    transport = UpstoxTransport("secret-token", client=client)
    path = "/v3/historical-candle/NSE_INDEX%7CNifty%2050/days/1/2026-10-12/2023-10-12"

    assert transport.get(path) == {}


@pytest.mark.parametrize("base_url", [
    "https://api.upstox.com.evil.example",
    "https://user@api.upstox.com",
    "https://api.upstox.com:444",
    "https://api.upstox.com/proxy",
])
def test_transport_rejects_noncanonical_upstox_hosts(base_url):
    with pytest.raises(ValueError, match="official HTTPS host"):
        UpstoxTransport("secret-token", base_url=base_url)


def test_transport_uses_https_only():
    with pytest.raises(ValueError, match="HTTPS"):
        UpstoxTransport("secret-token", base_url="http://api.example.test")

