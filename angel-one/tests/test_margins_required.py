import os

from fastapi.testclient import TestClient
import pytest


def _build_client() -> TestClient:
    os.environ.setdefault("ANGEL_API_KEY", "test")
    os.environ.setdefault("ANGEL_CLIENT_CODE", "test")
    os.environ.setdefault("ANGEL_TOTP_SECRET", "test")
    os.environ.setdefault("INTERNAL_SERVICE_KEY", "test-internal-key")

    from app.main import app

    return TestClient(app)

client = _build_client()
HEADERS = {"X-Internal-Service-Key": "test-internal-key",
           "X-Active-User-Id": "test-user", "X-Broker-Account-Id": "test-account",
           "X-Broker-Client-Id": "TEST", "X-Session-Generation": "1",
           "X-Owner-Generation": "0", "X-Broker-Session-Id": "test-session"}


@pytest.fixture(autouse=True)
def authorized_validation_context(monkeypatch):
    from app import main
    from app.services.account_dispatch import AccountContext, AccountDispatch

    class FakeManager:
        _session_id = None
        _active_user_id = None
        _client_code = None
        @property
        def is_logged_in(self): return self._session_id is not None
        def shutdown(self): pass

    dispatch = AccountDispatch(FakeManager)
    monkeypatch.setattr(main, 'dispatch', dispatch)
    context = AccountContext.from_headers({k.lower(): v for k, v in HEADERS.items()})
    worker = dispatch.acquire(AccountContext(context.user_id, context.account_id, context.client_id,
                                              context.session_generation, context.owner_generation, ''), True, True)
    worker.manager._session_id = context.session_id
    worker.manager._active_user_id = context.user_id
    worker.manager._client_code = context.client_id
    dispatch.complete_login(worker, context, context.session_id)
    dispatch.release(worker, True)


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
