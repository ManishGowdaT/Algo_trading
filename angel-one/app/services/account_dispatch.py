"""Verified Node dispatch boundary with an isolated broker worker per account."""
from dataclasses import dataclass
from threading import Condition
from threading import RLock
from time import monotonic
from contextvars import ContextVar
from uuid import uuid4


MAX_ACCOUNT_WORKERS = 32


class AccountCapacityError(RuntimeError):
    pass
from typing import Callable


@dataclass(frozen=True)
class AccountContext:
    user_id: str
    account_id: str
    client_id: str
    session_generation: int
    owner_generation: int
    session_id: str
    execution_owner_id: str = None
    execution_lease_generation: int = None

    @classmethod
    def from_headers(cls, headers):
        try:
            value = cls(headers['x-active-user-id'], headers['x-broker-account-id'],
                        headers['x-broker-client-id'], int(headers['x-session-generation']),
                        int(headers['x-owner-generation']), headers.get('x-broker-session-id', ''),
                        headers.get('x-execution-owner-id') or None,
                        int(headers['x-execution-lease-generation']) if headers.get('x-execution-lease-generation') else None)
            if not value.user_id or not value.account_id or not value.client_id or value.session_generation < 1 or value.owner_generation < 0:
                raise ValueError()
            return value
        except (KeyError, ValueError, TypeError):
            raise PermissionError('Verified broker account context required') from None


class _AccountWorker:
    def __init__(self, manager):
        self.manager = manager
        self.user_id = None
        self.client_id = None
        self.owner_generation = None
        self.generation = 0
        self.session_id = None
        self.pending_generation = None
        self.pending_request_id = None
        self.reserved_client_id = None
        self.condition = Condition()
        self.readers = 0
        self.writer = False
        self.waiting_writers = 0
        self.reserved_new = False
        self.max_concurrent_requests = 8
        self.execution_owner_id = None
        self.execution_lease_generation = 0


class AccountDispatch:
    """Per-account broker workers and request-generation admission."""
    max_account_workers = MAX_ACCOUNT_WORKERS

    def __init__(self, worker_factory: Callable[[], object]):
        self.worker_factory = worker_factory
        self._workers = {}
        self._client_owners = {}
        self._reserved_clients = {}
        self._registry_lock = RLock()
        self._current = ContextVar('angel_account_worker', default=None)

    @staticmethod
    def _key(context):
        return context.account_id

    def _get_or_create(self, context):
        with self._registry_lock:
            worker = self._workers.get(self._key(context))
            if worker is None:
                worker = _AccountWorker(self.worker_factory())
                self._workers[self._key(context)] = worker
            return worker

    def _identity_matches(self, worker, context):
        return (worker.user_id, worker.client_id, worker.owner_generation) == (
            context.user_id, context.client_id, context.owner_generation)

    def acquire(self, context, lifecycle, login, manager=None, wait=True, request_id=None):
        if login:
            request_id = request_id or str(uuid4())
            with self._registry_lock:
                worker = self._workers.get(self._key(context))
                if worker is not None and not self._identity_matches(worker, context):
                    raise PermissionError('Broker account ownership identity mismatch')
                owner = self._client_owners.get(context.client_id)
                if owner is not None and owner != context.account_id:
                    raise PermissionError('Broker client identity is already assigned to another account')
                reservation_owner = self._reserved_clients.get(context.client_id)
                if reservation_owner is not None and reservation_owner != context.account_id:
                    raise PermissionError('Broker client identity is already connecting for another account')
                if worker is None:
                    active_workers = sum(1 for item in self._workers.values() if item.manager is not None)
                    if active_workers >= MAX_ACCOUNT_WORKERS:
                        raise AccountCapacityError('Broker gateway account capacity is full')
                    worker = _AccountWorker(self.worker_factory())
                    worker.user_id = context.user_id
                    worker.client_id = context.client_id
                    worker.owner_generation = context.owner_generation
                    worker.reserved_new = True
                    self._workers[context.account_id] = worker
                elif worker.manager is None:
                    active_workers = sum(1 for item in self._workers.values() if item.manager is not None)
                    if active_workers >= MAX_ACCOUNT_WORKERS:
                        raise AccountCapacityError('Broker gateway account capacity is full')
                    worker.manager = self.worker_factory()
                with worker.condition:
                    already_reserved = (worker.pending_generation == context.session_generation
                        and worker.reserved_client_id == context.client_id
                        and worker.pending_request_id == request_id)
                    if worker.pending_generation is not None and not already_reserved:
                        raise PermissionError('Broker account login is already in progress')
                    if context.session_generation <= worker.generation:
                        raise PermissionError('Stale broker session generation')
                    if not already_reserved:
                        worker.pending_generation = context.session_generation
                        worker.pending_request_id = request_id
                        worker.reserved_client_id = context.client_id
                        self._reserved_clients[context.client_id] = context.account_id
                        worker.waiting_writers += 1
                self._acquire_worker(worker, context, lifecycle=True, login=True, wait=wait)
                worker.waiting_writers = max(0, worker.waiting_writers - 1)
                return worker

        with self._registry_lock:
            worker = self._workers.get(self._key(context))
        if worker is None:
            raise PermissionError('Broker account worker is unavailable')
        self._acquire_worker(worker, context, lifecycle=lifecycle, login=False, wait=wait)
        return worker

    @staticmethod
    def _acquire_worker(worker, context, lifecycle, login, wait):
        deadline = monotonic() + 30
        with worker.condition:
            while (worker.writer or (lifecycle and worker.readers)
                   or (not lifecycle and (worker.waiting_writers or worker.readers >= worker.max_concurrent_requests))):
                if not wait:
                    raise BlockingIOError('Broker account is busy')
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise TimeoutError('Broker account is busy')
                worker.condition.wait(remaining)
            if login:
                if context.session_id:
                    raise PermissionError('Login cannot select an existing session')
            elif (not worker.session_id or context.user_id != worker.user_id
                  or context.client_id != worker.client_id
                  or context.owner_generation != worker.owner_generation
                  or context.session_generation != worker.generation
                  or context.session_id != worker.session_id):
                raise PermissionError('Broker account or session context mismatch')
            if context.execution_owner_id is not None and (
                    context.execution_owner_id != worker.execution_owner_id
                    or context.execution_lease_generation != worker.execution_lease_generation):
                raise PermissionError('Stale execution owner generation')
            if lifecycle:
                worker.writer = True
            else:
                worker.readers += 1

    @staticmethod
    def release(worker, lifecycle):
        with worker.condition:
            if lifecycle:
                worker.writer = False
            else:
                worker.readers -= 1
            worker.condition.notify_all()

    def complete_login(self, worker, context, session_id):
        if (worker.pending_generation != context.session_generation
                or worker.reserved_client_id != context.client_id
                or worker.user_id != context.user_id
                or worker.client_id != context.client_id
                or worker.owner_generation != context.owner_generation
                or not session_id
                or worker.manager._session_id != session_id
                or not worker.manager.is_logged_in
                or str(worker.manager._client_code or '').upper() != context.client_id):
            raise PermissionError('Broker login session identity could not be verified')
        with self._registry_lock:
            owner = self._client_owners.get(context.client_id)
            if owner is not None and owner != context.account_id:
                raise PermissionError('Broker client identity is already assigned to another account')
            self._client_owners[context.client_id] = context.account_id
        worker.user_id = context.user_id
        worker.client_id = context.client_id
        worker.owner_generation = context.owner_generation
        worker.generation = context.session_generation
        worker.session_id = session_id
        worker.pending_generation = None
        worker.pending_request_id = None
        worker.reserved_client_id = None
        if self._reserved_clients.get(context.client_id) == context.account_id:
            self._reserved_clients.pop(context.client_id, None)
        worker.reserved_new = False

    def finish_failed_login(self, worker, context, status_code, request_id=None):
        # HTTP errors are definitive broker rejections. Transport loss can be
        # ambiguous; retain the generation and worker so a late login cannot
        # be mistaken for a later session. The Node client advances its CAS.
        if request_id is not None and worker.pending_request_id != request_id:
            return
        if status_code is None:
            worker.generation = max(worker.generation, context.session_generation)
        worker.pending_generation = None
        worker.pending_request_id = None
        worker.reserved_client_id = None
        with self._registry_lock:
            if self._reserved_clients.get(context.client_id) == context.account_id:
                self._reserved_clients.pop(context.client_id, None)
        manager = None
        if worker.reserved_new and not worker.session_id:
            with self._registry_lock:
                if self._workers.get(context.account_id) is worker:
                    self._workers.pop(context.account_id, None)
                if self._reserved_clients.get(context.client_id) == context.account_id:
                    self._reserved_clients.pop(context.client_id, None)
            manager, worker.manager = worker.manager, None
        worker.reserved_new = False
        return manager

    def abort_login(self, context, request_id=None):
        with self._registry_lock:
            worker = self._workers.get(context.account_id)
            if (worker is None or worker.pending_generation != context.session_generation
                    or (request_id is not None and worker.pending_request_id != request_id)):
                return
            worker.pending_generation = None
            worker.pending_request_id = None
            worker.reserved_client_id = None
            worker.waiting_writers = max(0, worker.waiting_writers - 1)
            if self._reserved_clients.get(context.client_id) == context.account_id:
                self._reserved_clients.pop(context.client_id, None)
            retire = worker.reserved_new and not worker.session_id
            worker.reserved_new = False
            if retire and self._workers.get(context.account_id) is worker:
                self._workers.pop(context.account_id, None)
            manager = worker.manager if retire else None
            if retire:
                worker.manager = None
        return manager

    def _retire(self, account_id, worker):
        with self._registry_lock:
            if self._workers.get(account_id) is worker and not worker.session_id:
                self._workers.pop(account_id, None)
                if self._client_owners.get(worker.client_id) == account_id:
                    self._client_owners.pop(worker.client_id, None)
        if worker.manager is not None:
            worker.manager.shutdown()

    def account_shutdown_manager(self, worker, context):
        if worker.user_id != context.user_id or worker.session_id != context.session_id or worker.generation != context.session_generation:
            raise PermissionError('Stale logout completion')
        manager = worker.manager
        worker.session_id = None
        worker.manager = None
        return manager

    def finish_logout(self, worker, context):
        manager = self.account_shutdown_manager(worker, context)
        return manager

    def bind_current(self, worker):
        return self._current.set(worker)

    def reset_current(self, token):
        self._current.reset(token)

    def current_manager(self):
        worker = self._current.get()
        if worker is None:
            raise RuntimeError('Verified broker account context is required')
        return worker.manager

    def shutdown(self):
        with self._registry_lock:
            workers = list(self._workers.values())
            self._workers.clear()
            self._client_owners.clear()
            self._reserved_clients.clear()
        for worker in workers:
            if worker.manager is not None:
                worker.manager.shutdown()

    def snapshot(self):
        with self._registry_lock:
            return {key: worker for key, worker in self._workers.items()}

    def install_execution_owner(self, context, owner_id, generation):
        if not owner_id or not isinstance(generation, int) or generation < 1:
            raise PermissionError('Valid execution owner generation required')
        worker = self.acquire(context, lifecycle=True, login=False, wait=True)
        try:
            if generation < worker.execution_lease_generation:
                raise PermissionError('Stale execution owner generation')
            if generation == worker.execution_lease_generation and worker.execution_owner_id not in (None, owner_id):
                raise PermissionError('Execution owner generation is already assigned')
            worker.execution_owner_id = owner_id
            worker.execution_lease_generation = generation
        finally:
            self.release(worker, lifecycle=True)
