import unittest
import asyncio
from fastapi import HTTPException
from starlette.requests import Request
from unittest.mock import AsyncMock, patch, Mock
from engine import rank_spreads
from main import app, expiries, callback, scan, Scan, local_only, token_error, pending, sessions


def request(host='testserver'):
    return Request({'type':'http', 'headers':[(b'host', host.encode())]})


def run(coroutine):
    # These handlers only await immediate mocks, so no OS event loop is needed.
    try:
        coroutine.send(None)
    except StopIteration as done:
        return done.value
    raise AssertionError('Unexpected asynchronous IO in isolated handler test')


def fixtures():
    chain, contracts = [], []
    for strike in (19800, 19900, 20100, 20200):
        row = dict(strike_price=strike, underlying_spot_price=20000)
        for side in ('put_options', 'call_options'):
            key = f'{side}-{strike}'
            premium = 30 if strike in (19900, 20100) else 10
            row[side] = dict(instrument_key=key, market_data=dict(bid_price=premium, ask_price=premium+2, oi=1000, bid_qty=100, ask_qty=100))
            contracts.append(dict(instrument_key=key, lot_size=50, expiry='2099-01-01'))
        chain.append(row)
    return chain, contracts


class TerminalTests(unittest.TestCase):
    def test_token_errors_do_not_expose_payload(self):
        inactive = token_error({'errors':[{'errorCode':'UDAPI100058'}]}, 401)
        self.assertIn('no active trading segments', inactive)
        self.assertIn('After activation is confirmed', inactive)
        message = token_error({'errors':[{'errorCode':'UDAPI100069', 'message':'sensitive-value'}]}, 401)
        self.assertIn('API key or API secret', message)
        self.assertNotIn('sensitive-value', message)
        self.assertIn('HTTP 500', token_error({'errors':None}, 500))
        self.assertIn('invalid_client', token_error({'error':'invalid_client'}, 401))
        with patch.dict('os.environ', {'UPSTOX_CLIENT_SECRET':'secret-for-test'}):
            message = token_error({'errors':[{'errorCode':'UDAPI199999','message':'Rejected secret-for-test'}]}, 401)
        self.assertIn('UDAPI199999', message)
        self.assertNotIn('secret-for-test', message)

    def test_callback_token_exchange_success_and_failure(self):
        for status, payload in [(200, {'access_token':'mock-token'}), (401, {'errors':[{'errorCode':'UDAPI100069'}]})]:
            state = 'test-state'
            pending[state] = 10**12
            req = Request({'type':'http','headers':[(b'cookie',b'spread_oauth=test-state')]})
            client = AsyncMock()
            client.post.return_value = Mock(status_code=status, json=Mock(return_value=payload))
            context = AsyncMock()
            context.__aenter__.return_value = client
            with patch('main.httpx.AsyncClient', return_value=context), patch.dict('os.environ', {'UPSTOX_CLIENT_ID':'mock-key','UPSTOX_CLIENT_SECRET':'mock-secret'}):
                if status == 200:
                    response = run(callback(req,state=state,code='fresh-mock-code'))
                    self.assertEqual(response.status_code,307)
                    self.assertTrue(any('spread_session=' in c and 'HttpOnly' in c for c in response.headers.getlist('set-cookie')))
                else:
                    with self.assertRaises(HTTPException) as exc:
                        run(callback(req,state=state,code='fresh-mock-code'))
                    self.assertIn('UDAPI100069',exc.exception.detail)
            sent = client.post.call_args.kwargs['data']
            self.assertEqual(sent['client_secret'],'mock-secret')
            self.assertEqual(sent['grant_type'],'authorization_code')
            self.assertNotIn(state,pending)
        sessions.clear()

    def test_both_directions_and_payoffs(self):
        results = rank_spreads(*fixtures())
        self.assertEqual({r['type'] for r in results}, {'BULL PUT', 'BEAR CALL'})
        for r in results:
            self.assertEqual(r['credit'], 18)
            self.assertEqual(r['max_profit'], 900)
            self.assertEqual(r['max_loss'], 4100)
        self.assertEqual(results[0]['breakeven'], 20118)

    def test_reject_bad_quotes_and_missing_lots(self):
        chain, contracts = fixtures()
        for row in chain:
            for side in ('put_options', 'call_options'):
                row[side]['market_data']['ask_price'] = float('nan')
        self.assertEqual(rank_spreads(chain, contracts), [])
        self.assertEqual(rank_spreads(*fixtures(), width=150), [])
        self.assertEqual(rank_spreads(fixtures()[0], []), [])

    def test_quantity_and_filters(self):
        chain, contracts = fixtures()
        for row in chain:
            for side in ('put_options', 'call_options'):
                row[side]['market_data']['bid_qty'] = 1
        self.assertEqual(rank_spreads(chain, contracts), [])
        self.assertEqual(rank_spreads(*fixtures(), min_ror=50), [])

    def test_auth_and_local_guards(self):
        with self.assertRaises(HTTPException) as exc:
            run(expiries(request()))
        self.assertEqual(exc.exception.status_code, 401)
        with self.assertRaises(HTTPException) as exc:
            run(callback(request(), state='fake', code='fake'))
        self.assertEqual(exc.exception.status_code, 400)
        response = run(local_only(request('evil.example'), AsyncMock()))
        self.assertEqual(response.status_code, 403)

    def test_scan_with_broker_fixture(self):
        chain, contracts = fixtures()
        with patch('main.token', return_value='test'), patch('main.broker', new=AsyncMock(side_effect=[contracts, chain])):
            response = run(scan(Scan(expiry='2099-01-01'), request()))
            self.assertEqual(len(response['candidates']), 2)


if __name__ == '__main__':
    unittest.main()
