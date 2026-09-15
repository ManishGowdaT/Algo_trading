import os

from fastapi.testclient import TestClient


def _build_client() -> TestClient:
    os.environ.setdefault("ANGEL_API_KEY", "test")
    os.environ.setdefault("ANGEL_CLIENT_CODE", "test")
    os.environ.setdefault("ANGEL_TOTP_SECRET", "test")
    os.environ.setdefault("INTERNAL_SERVICE_KEY", "test-internal-key")

    from app.main import app

    return TestClient(app)

client = _build_client()
HEADERS = {"X-Internal-Service-Key": "test-internal-key"}


def test_required_margin_rejects_non_positive_quantity() -> None:
    res = client.post(
        "/angel/margins/required",
        headers=HEADERS,
        json={
            "exchange": "NSE",
            "tradingsymbol": "TCS",
            "symboltoken": "11536",
            "transactiontype": "BUY",
            "producttype": "INTRADAY",
            "quantity": 0,
            "ordertype": "MARKET",
        },
    )
    assert res.status_code == 400


def test_required_margin_rejects_invalid_transactiontype() -> None:
    res = client.post(
        "/angel/margins/required",
        headers=HEADERS,
        json={
            "exchange": "NSE",
            "tradingsymbol": "TCS",
            "symboltoken": "11536",
            "transactiontype": "HOLD",
            "producttype": "INTRADAY",
            "quantity": 1,
            "ordertype": "MARKET",
        },
    )
    assert res.status_code == 400
