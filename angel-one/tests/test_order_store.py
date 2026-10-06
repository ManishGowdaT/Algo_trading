from __future__ import annotations

from app.services.order_store import OrderStore


def test_order_store_add_and_list(tmp_path):
    db_path = tmp_path / "orders.sqlite"
    store = OrderStore(db_path=str(db_path))

    store.add(id="1", request={"a": 1}, response={"status": True})
    store.add(id="2", request={"b": 2}, response={"status": False})

    items = store.list(limit=10)
    ids = [i.id for i in items]
    assert "1" in ids
    assert "2" in ids


def test_account_scoped_history_clear_preserves_other_users(tmp_path):
    store = OrderStore(db_path=str(tmp_path / "owned-orders.sqlite"))
    store.add(id="a-1", request={"symbol": "A"}, response={"status": True}, user_id="user-a", account_id="account-a")
    store.add(id="b-1", request={"symbol": "B"}, response={"status": True}, user_id="user-b", account_id="account-b")

    assert store.clear(user_id="user-a", account_id="account-a") == 1
    assert [item.id for item in store.list(user_id="user-a", account_id="account-a")] == []
    assert [item.id for item in store.list(user_id="user-b", account_id="account-b")] == ["b-1"]


def test_order_store_never_persists_plaintext_credential_fields(tmp_path):
    store = OrderStore(db_path=str(tmp_path / "redacted-orders.sqlite"))
    store.add(id="safe", request={"tradingsymbol": "ABC", "apiKey": "plain-secret", "nested": {"mpin": "1234"}},
              response={"message": "authorization=Bearer-secret", "data": {"accessToken": "token-secret"}})
    item = store.list()[0]
    assert item.request == {"tradingsymbol": "ABC", "nested": {}}
    assert item.response == {"message": "authorization=[REDACTED]", "data": {}}
