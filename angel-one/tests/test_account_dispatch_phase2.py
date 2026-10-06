import os
import asyncio
from pathlib import Path
import socket
import subprocess
from threading import Event, Thread

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import main
from app.services.account_dispatch import AccountCapacityError, AccountContext, AccountDispatch

USER_A = '111111111111111111111111'
ACCOUNT_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'
USER_B = '222222222222222222222222'
ACCOUNT_B = 'bbbbbbbbbbbbbbbbbbbbbbbb'


def headers(user=USER_A, account=ACCOUNT_A, client='CLIENT-A', generation=1, session='session-CLIENT-A-1', execution_owner=None, execution_generation=None):
    result = {'X-Internal-Service-Key': 'test-internal-key', 'X-Active-User-Id': user,
            'X-Broker-Account-Id': account, 'X-Broker-Client-Id': client,
            'X-Session-Generation': str(generation), 'X-Owner-Generation': '0',
            'X-Broker-Session-Id': session}
    if execution_owner is not None:
        result['X-Execution-Owner-Id'] = execution_owner
        result['X-Execution-Lease-Generation'] = str(execution_generation)
    return result


class FakeManager:
    def __init__(self):
        self._client = None
        self._session_id = None
        self._active_user_id = None
        self._client_code = None
        self._state = 'DISCONNECTED'
        self._login_count = 0
        self.calls = []

    def connect(self, **kwargs):
        self.calls.append(('connect', kwargs['owner_user_id']))
        self._active_user_id = kwargs['owner_user_id']
        self._client = object()
        self._client_code = kwargs['client_code'].upper()
        self._state = 'CONNECTED'
        self._login_count += 1
        self._session_id = f"session-{self._client_code}-{self._login_count}"
        return {'status': True, 'client_code': kwargs['client_code']}

    def get_profile(self):
        self.calls.append(('profile', self._active_user_id))
        if self._state != 'CONNECTED':
            raise RuntimeError('Angel One session expired')
        return {'status': True, 'data': {'clientcode': self._client_code}}

    def get_status(self):
        return {'connected': self._client is not None and self._state == 'CONNECTED', 'clientCode': f'****{self._client_code[-4:]}' if self._client_code else None, 'active_user_id': self._active_user_id}

    def get_internal_session_info(self):
        return {'status': True, 'session_id': self._session_id, 'active_user_id': self._active_user_id}

    @property
    def is_logged_in(self):
        return self._client is not None

    def order_book(self):
        self.calls.append(('orderbook', self._active_user_id))
        return {'data': [{'orderid': 'order-A', 'variety': 'NORMAL'}]}

    def cancel_order(self, **kwargs):
        self.calls.append(('cancel', self._active_user_id, kwargs['order_id']))
        return {'status': True}

    def logout(self):
        self.calls.append(('logout', self._active_user_id))
        self._client = None
        self._session_id = None
        self._active_user_id = None
        self._client_code = None
        self._state = 'DISCONNECTED'
        return {'status': True}

    def shutdown(self):
        self._client = None
        self._session_id = None
        self._active_user_id = None
        self._client_code = None
        self._state = 'DISCONNECTED'


@pytest.fixture
def isolated(monkeypatch):
    managers = {}
    def factory():
        manager = FakeManager()
        managers[id(manager)] = manager
        return manager
    gate = AccountDispatch(factory)
    monkeypatch.setattr(main, 'dispatch', gate)
    return TestClient(main.app), managers, gate


def login(client, request_headers=None):
    request_headers = request_headers or headers(session='')
    client_code = request_headers['X-Broker-Client-Id']
    return client.post('/angel/login', headers=request_headers,
                       json={'apiKey': 'fake-api', 'clientCode': client_code, 'mpin': '1111', 'totpSecret': 'fake-secret'})


def test_missing_forged_secret_and_client_context_fail_closed(isolated):
    client, managers, _ = isolated
    assert client.get('/angel/profile', headers={'X-Internal-Service-Key': 'test-internal-key'}).status_code == 403
    assert client.get('/angel/profile', headers={**headers(), 'X-Internal-Service-Key': 'wrong'}).status_code == 401
    mismatch = client.post('/angel/login', headers=headers(client='CLIENT-B', session=''),
                           json={'apiKey': 'fake-api', 'clientCode': 'CLIENT-A', 'mpin': '1111', 'totpSecret': 'fake-secret'})
    assert mismatch.status_code == 403
    assert all(not manager.calls for manager in managers.values())


def test_fresh_quote_option_reaches_only_verified_account_worker(isolated):
    client, managers, _ = isolated
    assert login(client).status_code == 200
    manager = next(iter(managers.values()))
    calls = []
    manager.get_ltp = lambda **args: calls.append(args) or {'ltp': 100, 'quoteTimestamp': 1791253800000}
    params = {'exchange': 'NFO', 'tradingsymbol': 'OPT-1', 'symboltoken': '1', 'requireFresh': 'true'}
    response = client.get('/market/ltp', headers=headers(), params=params)
    assert response.status_code == 200
    assert calls == [{'exchange': 'NFO', 'tradingsymbol': 'OPT-1', 'symboltoken': '1', 'require_fresh': True}]
    wrong = headers(USER_B, ACCOUNT_B, 'CLIENT-B')
    assert client.get('/market/ltp', headers=wrong, params=params).status_code == 403
    assert len(calls) == 1
    del params['requireFresh']
    assert client.get('/market/ltp', headers=headers(), params=params).status_code == 200
    assert 'require_fresh' not in calls[-1]


def test_single_account_contract_and_foreign_read_mutations_are_isolated(isolated):
    client, managers, _ = isolated
    result = login(client)
    assert result.status_code == 200
    assert result.json()['session_id'] == 'session-CLIENT-A-1'
    assert client.get('/angel/profile', headers=headers()).json()['data']['clientcode'] == 'CLIENT-A'
    foreign = headers(USER_B, ACCOUNT_B, 'CLIENT-B')
    for path, method in [('/angel/status', 'GET'), ('/angel/profile', 'GET'), ('/angel/orderbook', 'GET'),
                         ('/angel/positions', 'GET'), ('/market/ltp', 'GET'), ('/market/candles', 'GET'),
                         ('/angel/logout', 'POST'), ('/angel/orders/order-A/cancel', 'POST'), ('/angel/positions/exit', 'POST')]:
        assert client.request(method, path, headers=foreign).status_code == 403
    assert managers
    assert all(manager._active_user_id == USER_A for manager in managers.values())


def test_two_accounts_logout_expiry_reconnect_and_worker_failure_are_isolated(isolated):
    client, managers, gate = isolated
    login_a = login(client)
    login_b = login(client, headers(USER_B, ACCOUNT_B, 'CLIENT-B', session=''))
    assert login_a.status_code == login_b.status_code == 200
    assert client.get('/angel/profile', headers=headers()).json()['data']['clientcode'] == 'CLIENT-A'
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='session-CLIENT-B-1')).json()['data']['clientcode'] == 'CLIENT-B'
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='session-CLIENT-A-1')).status_code == 403
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-A', session='session-CLIENT-B-1')).status_code == 403
    worker_a = gate.snapshot()[ACCOUNT_A]
    worker_b = gate.snapshot()[ACCOUNT_B]
    manager_a, manager_b = worker_a.manager, worker_b.manager
    manager_a._state = 'SESSION_EXPIRED'
    assert client.get('/angel/profile', headers=headers()).status_code == 400
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='session-CLIENT-B-1')).status_code == 200
    manager_a._state = 'CONNECTED'
    original_profile = manager_a.get_profile
    manager_a.get_profile = lambda: (_ for _ in ()).throw(RuntimeError('worker failure'))
    assert client.get('/angel/profile', headers=headers()).status_code == 400
    manager_a.get_profile = original_profile
    reconnected = login(client, headers(generation=2, session=''))
    assert reconnected.status_code == 200
    assert client.get('/angel/profile', headers=headers(generation=1)).status_code == 403
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='session-CLIENT-B-1')).status_code == 200
    assert client.post('/angel/logout', headers=headers(generation=2, session='session-CLIENT-A-2')).status_code == 200
    assert manager_a._client is None
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='session-CLIENT-B-1')).status_code == 200
    assert manager_b._client is not None


def test_reconnect_generation_stale_sessions_and_wrong_context(isolated):
    client, managers, _ = isolated
    assert login(client).status_code == 200
    assert login(client, headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='')).status_code == 200
    assert login(client).status_code == 403  # generation replay
    assert login(client, headers(generation=2, session='')).status_code == 200
    assert client.get('/angel/status', headers=headers()).status_code == 403
    assert client.get('/angel/status', headers=headers(generation=2, session='session-CLIENT-A-2')).status_code == 200
    assert client.post('/angel/logout', headers=headers(generation=2, session='session-CLIENT-A-2')).status_code == 200
    assert all(manager._client is None for manager in managers.values() if manager._active_user_id is None)
    assert client.get('/angel/profile', headers=headers(generation=2)).status_code == 403
    assert login(client, headers(USER_B, ACCOUNT_B, 'CLIENT-B', generation=1, session='')).status_code == 403


def test_order_attempt_history_is_account_scoped(isolated):
    client, _, _ = isolated
    assert login(client).status_code == 200
    assert login(client, headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='')).status_code == 200
    assert client.get('/angel/orders', headers=headers()).status_code == 200
    assert client.delete('/angel/orders', headers=headers()).status_code == 200


def test_phase6_execution_fence_rejects_old_owner_without_affecting_other_account(isolated):
    client, managers, _ = isolated
    assert login(client).status_code == 200
    assert login(client, headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='')).status_code == 200
    owner = 'node-owner-new'
    installed = client.post('/internal/execution-fence', headers=headers(), json={'ownerId': owner, 'generation': 8})
    assert installed.status_code == 200
    current = headers(execution_owner=owner, execution_generation=8)
    assert client.post('/angel/orders/order-A/cancel', headers=current, json={'variety': 'NORMAL'}).status_code == 200
    stale = headers(execution_owner='node-owner-old', execution_generation=7)
    assert client.post('/angel/orders/order-A/cancel', headers=stale, json={'variety': 'NORMAL'}).status_code == 403
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='session-CLIENT-B-1')).status_code == 200
    assert any(('cancel', USER_A, 'order-A') in manager.calls for manager in managers.values())


def test_duplicate_login_abort_cannot_cancel_the_original_reservation(isolated):
    _, _, gate = isolated
    context = AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 1, 0, '')
    worker = gate.acquire(context, lifecycle=True, login=True, wait=False, request_id='login-one')
    with pytest.raises(PermissionError):
        gate.acquire(context, lifecycle=True, login=True, wait=False, request_id='login-two')
    assert gate.abort_login(context, 'login-two') is None
    assert worker.writer is True
    assert worker.pending_request_id == 'login-one'
    worker.manager.connect(api_key='fake', client_code='CLIENT-A', mpin='1111', totp_secret='fake', owner_user_id=USER_A)
    gate.complete_login(worker, context, worker.manager._session_id)
    gate.release(worker, True)
    live = AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 1, 0, worker.session_id)
    assert gate.acquire(live, lifecycle=False, login=False, wait=False) is worker
    gate.release(worker, False)


def test_exception_and_cancellation_cleanup_release_login_reservations(isolated):
    _, _, gate = isolated
    context = AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 1, 0, '')
    worker = gate.acquire(context, lifecycle=True, login=True, wait=False, request_id='failed-login')
    gate.finish_failed_login(worker, context, None, 'failed-login')
    gate.release(worker, True)
    assert worker.pending_generation is None
    assert worker.pending_request_id is None

    retry = AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 2, 0, '')
    next_worker = gate.acquire(retry, lifecycle=True, login=True, wait=False, request_id='retry-login')
    assert next_worker is not worker
    manager = gate.abort_login(retry, 'retry-login')
    assert manager is not None
    gate.release(next_worker, True)


@pytest.mark.parametrize('failure', [RuntimeError('handler failed'), asyncio.CancelledError()])
def test_http_login_exception_or_cancellation_clears_its_reservation(isolated, failure):
    _, _, gate = isolated
    request_headers = headers(session='')
    scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST',
             'scheme': 'http', 'path': '/angel/login', 'raw_path': b'/angel/login', 'query_string': b'',
             'headers': [(key.lower().encode(), value.encode()) for key, value in request_headers.items()],
             'client': ('test', 1), 'server': ('test', 80)}

    async def fail_handler(_request):
        raise failure

    async def exercise_middleware():
        with pytest.raises(type(failure)):
            # Exercise the actual request middleware around an unexpected endpoint outcome.
            await main.require_internal_service_key(Request(scope), fail_handler)

    asyncio.run(exercise_middleware())
    assert ACCOUNT_A not in gate.snapshot()
    retry = AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 2, 0, '')
    worker = gate.acquire(retry, lifecycle=True, login=True, wait=False, request_id='retry-after-handler-failure')
    assert worker.pending_generation == 2
    manager = gate.abort_login(retry, 'retry-after-handler-failure')
    gate.release(worker, True)
    if manager is not None:
        manager.shutdown()


def test_worker_termination_and_gateway_restart_fail_closed_per_account(isolated):
    client, _, gate = isolated
    assert login(client).status_code == 200
    assert login(client, headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='')).status_code == 200
    worker_a = gate.snapshot()[ACCOUNT_A]
    worker_b = gate.snapshot()[ACCOUNT_B]
    worker_a.manager.shutdown()
    assert client.get('/angel/profile', headers=headers()).status_code == 400
    assert client.get('/angel/profile', headers=headers(USER_B, ACCOUNT_B, 'CLIENT-B', session='session-CLIENT-B-1')).status_code == 200
    gate.shutdown()
    restarted = AccountDispatch(lambda: FakeManager())
    with pytest.raises(PermissionError):
        restarted.acquire(AccountContext(USER_B, ACCOUNT_B, 'CLIENT-B', 1, 0, worker_b.session_id), False, False, wait=False)
    client_b = restarted.acquire(AccountContext(USER_B, ACCOUNT_B, 'CLIENT-B', 2, 0, ''), True, True, wait=False, request_id='after-restart')
    assert client_b.user_id == USER_B
    restarted.release(client_b, True)
    restarted.shutdown()


def test_account_request_concurrency_is_bounded(isolated):
    client, _, gate = isolated
    assert login(client).status_code == 200
    context = AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 1, 0, 'session-CLIENT-A-1')
    worker = gate.snapshot()[ACCOUNT_A]
    leases = [gate.acquire(context, lifecycle=False, login=False, wait=False) for _ in range(worker.max_concurrent_requests)]
    with pytest.raises(BlockingIOError):
        gate.acquire(context, lifecycle=False, login=False, wait=False)
    for lease in leases:
        gate.release(lease, False)


def test_broker_worker_health_resources_have_a_process_limit():
    gate = AccountDispatch(FakeManager)
    try:
        for index in range(gate.max_account_workers):
            context = AccountContext(f'user-{index}', f'account-{index}', f'CLIENT-{index}', 1, 0, '')
            worker = gate.acquire(context, lifecycle=True, login=True, wait=False, request_id=f'login-{index}')
            gate.release(worker, True)
        next_context = AccountContext('user-over-limit', 'account-over-limit', 'CLIENT-OVER-LIMIT', 1, 0, '')
        with pytest.raises(AccountCapacityError, match='capacity is full'):
            gate.acquire(next_context, lifecycle=True, login=True, wait=False, request_id='over-limit')
    finally:
        gate.shutdown()


def test_lifecycle_waits_for_inflight_reader_then_rejects_foreign_owner():
    gate = AccountDispatch(FakeManager)
    context = AccountContext.from_headers({key.lower(): value for key, value in headers().items()})
    worker_state = gate.acquire(AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 1, 0, ''), True, True)
    worker_state.manager.connect(owner_user_id=USER_A, client_code='CLIENT-A')
    gate.complete_login(worker_state, context, worker_state.manager._session_id)
    gate.release(worker_state, True)
    gate.acquire(context, False, False)
    entered = Event()
    completed = Event()

    def reconnect():
        entered.set()
        next_context = AccountContext(USER_A, ACCOUNT_A, 'CLIENT-A', 2, 0, '')
        gate.acquire(next_context, True, True)
        completed.set()
        gate.release(worker_state, True)

    worker = Thread(target=reconnect)
    worker.start()
    assert entered.wait(1)
    assert not completed.wait(0.05)
    gate.release(worker_state, False)
    assert completed.wait(1)
    worker.join(1)
    assert not worker.is_alive()


def test_real_node_transport_to_python_dispatch_with_fake_broker(isolated):
    # Actual HTTP + actual Node transport/context verification, never Angel One.
    import uvicorn
    _, managers, _ = isolated
    server_socket = socket.socket()
    server_socket.bind(('127.0.0.1', 0))
    server_socket.listen(128)
    port = server_socket.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(main.app, log_level='error', lifespan='off', ws='none'))
    worker = Thread(target=server.run, kwargs={'sockets': [server_socket]}, daemon=True)
    worker.start()
    backend = Path(__file__).resolve().parents[2] / 'backend'
    script = r'''
const assert = require('node:assert/strict');
const BrokerAccount = require('./models/BrokerAccount');
const accounts = require('./services/accountContext');
const active = require('./services/activeAccountService');
const {requestPython, registerExecutionOwner} = require('./services/pythonApiClient');
const records = [
 {_id:'aaaaaaaaaaaaaaaaaaaaaaaa', userId:'111111111111111111111111', brokerClientId:'CLIENT-A', sessionGeneration:0, ownerGeneration:0, status:'CONNECTING'},
 {_id:'bbbbbbbbbbbbbbbbbbbbbbbb', userId:'222222222222222222222222', brokerClientId:'CLIENT-B', sessionGeneration:0, ownerGeneration:0, status:'CONNECTING'}
];
BrokerAccount.findOne = query => ({lean:async()=> records.find(record => String(query.userId) === record.userId && (!query._id || String(query._id) === record._id)) || null});
(async()=>{
 const connect = async record => {
  const context = accounts.mint({...record,sessionGeneration:1}, null, true);
  const login = await requestPython('/angel/login',{context,method:'POST',body:{apiKey:'fake',clientCode:record.brokerClientId,mpin:'1111',totpSecret:'fake'}});
  assert.equal(login.response.status,200);
  record.sessionGeneration=1; record.status='CONNECTED';
  active.setActiveAccount({userId:record.userId,brokerAccountId:record._id,sessionId:login.data.session_id,sessionGeneration:1,ownerGeneration:0});
  return accounts.resolve(record.userId, record._id);
 };
 const [ownedA, ownedB] = await Promise.all(records.map(connect));
 const [profileA, profileB] = await Promise.all([
  accounts.run(ownedA, () => requestPython('/angel/profile')),
  accounts.run(ownedB, () => requestPython('/angel/profile'))
 ]);
 assert.equal(profileA.data.data.clientcode,'CLIENT-A');
 assert.equal(profileB.data.data.clientcode,'CLIENT-B');
 const leaseA={ownerId:'phase6-node-a',generation:1};
 assert.equal((await registerExecutionOwner(ownedA,leaseA)).response.status,200);
 await accounts.run(ownedA,async()=> assert.equal((await requestPython('/angel/orders/order-A/cancel',{context:ownedA,executionOwner:leaseA,method:'POST',body:{variety:'NORMAL'}})).response.status,200));
 await accounts.run(ownedA, async () => { const out = await requestPython('/angel/logout',{method:'POST'}); assert.equal(out.response.status,200); });
 active.clearActiveAccount(ownedA.userId, ownedA.brokerAccountId);
 await assert.rejects(requestPython('/angel/profile',{context:ownedA}),{code:'BROKER_CONTEXT_REQUIRED'});
 assert.equal((await accounts.run(ownedB, () => requestPython('/angel/profile'))).data.data.clientcode,'CLIENT-B');
 console.log('NODE_PYTHON_ISOLATION_OK');
})().catch(error=>{console.error(error);process.exitCode=1});
'''
    try:
        result = subprocess.run(['node', '-e', script], cwd=backend,
                                env={**os.environ, 'ANGEL_ONE_API_BASE': f'http://127.0.0.1:{port}'},
                                capture_output=True, text=True, timeout=20)
        assert result.returncode == 0, result.stdout + result.stderr
        assert 'NODE_PYTHON_ISOLATION_OK' in result.stdout
        assert any(('cancel', USER_A, 'order-A') in manager.calls for manager in managers.values())
        assert any(any(call[0] == 'logout' and call[1] == USER_A for call in manager.calls) for manager in managers.values())
    finally:
        server.should_exit = True
        worker.join(5)
        server_socket.close()
        assert not worker.is_alive()
