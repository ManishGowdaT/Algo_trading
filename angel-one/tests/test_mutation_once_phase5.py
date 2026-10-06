from types import SimpleNamespace
import pytest
from app.services.angel_client import AngelClient, AngelSession


def client(smart):
    instance = AngelClient.__new__(AngelClient)
    instance._smart = smart
    instance._session = AngelSession('jwt', 'refresh', 'feed', 'CLIENT-A')
    return instance


@pytest.mark.parametrize('failure', [TimeoutError, TypeError])
def test_accepted_placement_exception_never_retries(failure):
    calls = []
    def post(path, payload):
        calls.append(path)
        raise failure('after possible acceptance')
    with pytest.raises(failure):
        client(SimpleNamespace(_postRequest=post)).place_order({'quantity': 10})
    assert calls == ['api.order.placefullresponse']


def test_empty_placement_remains_unknown_without_retry():
    calls = []
    def post(path, payload):
        calls.append(path)
        return None
    result = client(SimpleNamespace(_postRequest=post)).place_order({'quantity': 10})
    assert result['outcome'] == 'UNKNOWN'
    assert calls == ['api.order.placefullresponse']


def test_cancel_type_error_after_mutation_never_retries():
    calls = []
    def cancel(order_id, variety):
        calls.append(order_id)
        raise TypeError('after possible acceptance')
    with pytest.raises(TypeError):
        client(SimpleNamespace(cancelOrder=cancel)).cancel_order(order_id='A-1')
    assert calls == ['A-1']


def test_positional_sdk_cancel_is_selected_before_mutation():
    calls = []
    def cancel(oid, kind):
        calls.append((oid, kind))
        return {'status': True}
    assert client(SimpleNamespace(cancelOrder=cancel)).cancel_order(order_id='A-1')['status']
    assert calls == [('A-1', 'NORMAL')]
