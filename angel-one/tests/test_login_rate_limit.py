from fastapi.testclient import TestClient

from app.main import app, angel


def test_login_returns_clear_429_for_provider_rate_limit(monkeypatch) -> None:
    def raise_rate_limit(**_kwargs):
        raise RuntimeError("Too Many Requests")

    monkeypatch.setattr(angel, "connect", raise_rate_limit)
    client = TestClient(app)
    response = client.post(
        "/angel/login",
        headers={"X-Internal-Service-Key": "test-internal-key"},
        json={
            "apiKey": "test-api-key",
            "clientCode": "client-code",
            "mpin": "1234",
            "totpSecret": "test-totp-secret",
        },
    )

    assert response.status_code == 429
    assert response.json()["detail"] == "Angel One is temporarily rate limiting connection attempts. Please wait before trying again."
