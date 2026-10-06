from fastapi.testclient import TestClient

from app.main import app
from app.services.broker_session import BrokerSessionManager


def test_login_returns_clear_429_for_provider_rate_limit(monkeypatch) -> None:
    def raise_rate_limit(_self, **_kwargs):
        raise RuntimeError("Too Many Requests")

    monkeypatch.setattr(BrokerSessionManager, "connect", raise_rate_limit)
    client = TestClient(app)
    response = client.post(
        "/angel/login",
        headers={"X-Internal-Service-Key": "test-internal-key",
                 "X-Active-User-Id": "test-user", "X-Broker-Account-Id": "test-account",
                 "X-Broker-Client-Id": "CLIENT-CODE", "X-Session-Generation": "1", "X-Owner-Generation": "0"},
        json={
            "apiKey": "test-api-key",
            "clientCode": "client-code",
            "mpin": "1234",
            "totpSecret": "test-totp-secret",
        },
    )

    assert response.status_code == 429
    assert response.json()["detail"] == "Angel One is temporarily rate limiting connection attempts. Please wait before trying again."
