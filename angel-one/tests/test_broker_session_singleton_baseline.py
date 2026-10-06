from app.services import broker_session
from threading import Event, Thread


class FakeAngelClient:
    instances = []

    def __init__(self, *, api_key, client_code, totp_secret):
        self.client_code = client_code
        self.is_logged_in = False
        self.logged_out = False
        self.expired = False
        self.__class__.instances.append(self)

    def login(self, mpin):
        self.is_logged_in = True

    def get_session_info(self):
        return {"client_code": self.client_code, "jwt_token": f"jwt-{self.client_code}"}

    def get_profile(self):
        if self.expired:
            raise RuntimeError("Angel One session expired")
        return {"status": True}

    def logout(self):
        self.logged_out = True
        self.is_logged_in = False
        return {"status": True}


def test_reconnect_replaces_client_inside_one_account_worker(monkeypatch):
    FakeAngelClient.instances.clear()
    monkeypatch.setattr(broker_session, "AngelClient", FakeAngelClient)
    manager = broker_session.BrokerSessionManager()
    try:
        manager.connect(
            api_key="api-a", client_code="CLIENT-A", mpin="1111", totp_secret="secret-a", owner_user_id="user-A"
        )
        first = FakeAngelClient.instances[-1]
        manager.connect(
            api_key="api-b", client_code="CLIENT-B", mpin="2222", totp_secret="secret-b", owner_user_id="user-B"
        )

        assert first.logged_out is True
        assert manager.get_status()["active_user_id"] == "user-B"
        assert manager.get_internal_session_info()["jwt_token"] == "jwt-CLIENT-B"
        assert manager.get_internal_session_info()["active_user_id"] == "user-B"
    finally:
        manager.shutdown()


def test_dispatch_keeps_real_broker_managers_and_health_state_per_account(monkeypatch):
    from app.services.account_dispatch import AccountContext, AccountDispatch

    FakeAngelClient.instances.clear()
    monkeypatch.setattr(broker_session, "AngelClient", FakeAngelClient)
    dispatch = AccountDispatch(broker_session.BrokerSessionManager)
    context_a = AccountContext("user-A", "account-A", "CLIENT-A", 1, 0, "")
    context_b = AccountContext("user-B", "account-B", "CLIENT-B", 1, 0, "")
    worker_a = dispatch.acquire(context_a, lifecycle=True, login=True)
    worker_b = None
    try:
        worker_a.manager.connect(api_key="api-a", client_code="CLIENT-A", mpin="1111", totp_secret="secret-a", owner_user_id="user-A")
        dispatch.complete_login(worker_a, context_a, worker_a.manager._session_id)
        dispatch.release(worker_a, True)

        worker_b = dispatch.acquire(context_b, lifecycle=True, login=True)
        worker_b.manager.connect(api_key="api-b", client_code="CLIENT-B", mpin="2222", totp_secret="secret-b", owner_user_id="user-B")
        dispatch.complete_login(worker_b, context_b, worker_b.manager._session_id)
        dispatch.release(worker_b, True)

        assert worker_a.manager is not worker_b.manager
        assert worker_a.manager.get_internal_session_info()["jwt_token"] == "jwt-CLIENT-A"
        assert worker_b.manager.get_internal_session_info()["jwt_token"] == "jwt-CLIENT-B"

        FakeAngelClient.instances[0].expired = True
        assert worker_a.manager.check_health()["state"] == "SESSION_EXPIRED"
        assert worker_b.manager.check_health()["state"] == "CONNECTED"

        old_session = worker_a.session_id
        reconnect = AccountContext("user-A", "account-A", "CLIENT-A", 2, 0, "")
        worker_a = dispatch.acquire(reconnect, lifecycle=True, login=True)
        worker_a.manager.connect(api_key="api-a2", client_code="CLIENT-A", mpin="1111", totp_secret="secret-a", owner_user_id="user-A")
        dispatch.complete_login(worker_a, reconnect, worker_a.manager._session_id)
        dispatch.release(worker_a, True)
        stale = AccountContext("user-A", "account-A", "CLIENT-A", 1, 0, old_session)
        try:
            dispatch.acquire(stale, lifecycle=False, login=False, wait=False)
            assert False, "stale generation should be rejected"
        except PermissionError:
            pass
        assert worker_b.manager.is_logged_in

        live_a = AccountContext("user-A", "account-A", "CLIENT-A", 2, 0, worker_a.session_id)
        worker_a = dispatch.acquire(live_a, lifecycle=True, login=False)
        worker_a.manager.logout()
        dispatch.finish_logout(worker_a, live_a)
        dispatch.release(worker_a, True)
        assert worker_b.manager.is_logged_in
        assert worker_b.manager.get_internal_session_info()["jwt_token"] == "jwt-CLIENT-B"
    finally:
        dispatch.shutdown()


def test_late_health_check_from_old_session_cannot_overwrite_reconnect(monkeypatch):
    FakeAngelClient.instances.clear()
    monkeypatch.setattr(broker_session, "AngelClient", FakeAngelClient)
    manager = broker_session.BrokerSessionManager()
    entered = Event()
    resume = Event()
    try:
        manager.connect(api_key="api-a", client_code="CLIENT-A", mpin="1111", totp_secret="secret-a", owner_user_id="user-A")
        old_client = FakeAngelClient.instances[-1]
        original_profile = old_client.get_profile

        def delayed_profile():
            entered.set()
            assert resume.wait(2)
            raise RuntimeError("old session token expired")

        old_client.get_profile = delayed_profile
        result = {}
        thread = Thread(target=lambda: result.update(manager.check_health()))
        thread.start()
        assert entered.wait(2)
        manager.connect(api_key="api-a2", client_code="CLIENT-A", mpin="1111", totp_secret="secret-a", owner_user_id="user-A")
        new_session = manager._session_id
        resume.set()
        thread.join(2)
        assert not thread.is_alive()
        assert manager._session_id == new_session
        assert manager.get_status()["connected"] is True
        assert result["state"] == "CONNECTED"
        old_client.get_profile = original_profile
    finally:
        resume.set()
        manager.shutdown()
