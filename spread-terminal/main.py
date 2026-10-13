"""Local single-user Upstox spread terminal. Tokens stay in server memory."""
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from engine import rank_spreads

load_dotenv(Path(__file__).resolve().parent / '.env')

app = FastAPI(title='NIFTY Spread Terminal')
BASE = 'https://api.upstox.com/v2'
KEY = 'NSE_INDEX|Nifty 50'
REDIRECT = os.getenv('UPSTOX_REDIRECT_URI', 'http://127.0.0.1:8001/auth/callback')
sessions = {}
pending = {}


def token_error(payload, status):
    """Expose only recognized codes and our own text, never broker payloads."""
    hints = {
        'UDAPI100058': 'Upstox reports no active trading segments on this account. Reactivate the account/segments in the Upstox app or website, or contact Upstox support. After activation is confirmed, return to the home page and connect again. Changing .env will not activate your account.',
        'UDAPI100069': 'API key or API secret is incorrect. Copy both from the same Upstox app into .env and restart.',
        'UDAPI100070': 'Redirect URI mismatch. Register http://127.0.0.1:8001/auth/callback in the Upstox app and use the same value in .env.',
        'UDAPI100057': 'Login code is invalid or already used. Open the home page and click Connect Upstox for a fresh login.',
        'UDAPI100101': 'Upstox requires an individual app for this token exchange.',
        'UDAPI100099': 'Upstox rate limit reached. Wait briefly and start a fresh login.',
    }
    errors = payload.get('errors', []) if isinstance(payload, dict) else []
    if isinstance(errors, dict):
        errors = [errors]
    nodes = ([payload] if isinstance(payload, dict) else []) + (errors if isinstance(errors, list) else [])
    for error in nodes:
        code = error.get('errorCode', error.get('error_code')) if isinstance(error, dict) else None
        if code in hints:
            return f'{code}: {hints[code]}'
        if isinstance(error, dict) and error.get('error') == 'invalid_client':
            return 'invalid_client: '+hints['UDAPI100069']
        if isinstance(error, dict) and error.get('error') == 'invalid_grant':
            return 'invalid_grant: '+hints['UDAPI100057']
        if isinstance(code, str) and re.fullmatch(r'UDAPI\d{1,12}', code):
            message = str(error.get('message', 'Upstox rejected the token exchange.'))
            # Broker messages can echo submitted values. Redact before display.
            for name in ('UPSTOX_CLIENT_ID', 'UPSTOX_CLIENT_SECRET'):
                value = os.getenv(name)
                if value:
                    message = message.replace(value, '[redacted]')
            message = re.sub(r'https?://\S+', '[URL redacted]', message)
            message = re.sub(r'[A-Za-z0-9_\-]{24,}', '[redacted]', message)
            return f'{code}: {message[:300]} Start a fresh login from the home page.'
    return f'Upstox token endpoint returned HTTP {status}. Start a fresh login; verify the API key, secret and redirect URI in your developer app.'


@app.middleware('http')
async def local_only(request, call_next):
    if request.headers.get('host') not in ('127.0.0.1:8001', 'localhost:8001', 'testserver'):
        from fastapi.responses import JSONResponse
        return JSONResponse({'detail': 'Local access only'}, status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


def token(request):
    sid = request.cookies.get('spread_session', '')
    item = sessions.get(sid)
    if not item or item[1] < time.time():
        sessions.pop(sid, None)
        raise HTTPException(401, 'Connect Upstox to continue.')
    return item[0]


async def broker(path, access, params=None):
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            response = await client.get(BASE+path, params=params, headers={'Authorization': 'Bearer '+access, 'Accept': 'application/json'})
        if response.status_code in (401, 403):
            raise HTTPException(401, 'Upstox authorization expired or access denied. Reconnect.')
        if response.status_code == 429:
            raise HTTPException(429, 'Upstox rate limit reached. Retry shortly.')
        if response.status_code != 200:
            raise HTTPException(502, 'Upstox could not return market data.')
        payload = response.json()
        if payload.get('status') != 'success':
            raise ValueError()
        return payload['data']
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(502, 'Upstox is unavailable or returned invalid data.')


@app.get('/')
async def index():
    return FileResponse(Path(__file__).parent/'templates/index.html')


@app.get('/auth/connect')
async def connect():
    if not os.getenv('UPSTOX_CLIENT_ID') or not os.getenv('UPSTOX_CLIENT_SECRET'):
        raise HTTPException(503, 'Set UPSTOX_CLIENT_ID and UPSTOX_CLIENT_SECRET, then restart.')
    state = secrets.token_urlsafe(32)
    pending[state] = time.time()+600
    response = RedirectResponse(BASE+'/login/authorization/dialog?'+urlencode(dict(response_type='code', client_id=os.environ['UPSTOX_CLIENT_ID'], redirect_uri=REDIRECT, state=state)))
    response.set_cookie('spread_oauth', state, httponly=True, samesite='lax', max_age=600)
    return response


@app.get('/auth/callback')
async def callback(request: Request, state: str = '', code: str = ''):
    expected = request.cookies.get('spread_oauth', '')
    if not state or not secrets.compare_digest(state, expected) or pending.pop(state, 0) < time.time() or not code:
        raise HTTPException(400, 'Login failed or expired. Connect again.')
    try:
        async with httpx.AsyncClient(timeout=25) as client:
            res = await client.post(BASE+'/login/authorization/token', headers={'Accept': 'application/json'}, data=dict(code=code, client_id=os.environ['UPSTOX_CLIENT_ID'], client_secret=os.environ['UPSTOX_CLIENT_SECRET'], redirect_uri=REDIRECT, grant_type='authorization_code'))
        payload = res.json()
        access = payload.get('access_token') if res.status_code == 200 and isinstance(payload, dict) else None
    except httpx.HTTPError:
        raise HTTPException(502, 'Could not reach Upstox token endpoint. Check internet/proxy connectivity, then start a fresh login from the home page.')
    except ValueError:
        raise HTTPException(502, 'Upstox returned a non-JSON token response. Start a fresh login from the home page.')
    if not access:
        raise HTTPException(401, token_error(payload, res.status_code))
    sid = secrets.token_urlsafe(32)
    sessions[sid] = (access, time.time()+12*3600)
    response = RedirectResponse('/')
    response.delete_cookie('spread_oauth')
    response.set_cookie('spread_session', sid, httponly=True, samesite='strict', max_age=43200)
    return response


@app.get('/api/expiries')
async def expiries(request: Request):
    data = await broker('/option/contract', token(request), {'instrument_key': KEY})
    today = datetime.now(timezone(timedelta(hours=5, minutes=30))).date().isoformat()
    return {'expiries': sorted({c['expiry'] for c in data if c.get('expiry', '') >= today})}


class Scan(BaseModel):
    symbol: str = 'NIFTY'
    expiry: str
    width: int = Field(100, ge=50, le=2000, multiple_of=50)
    min_oi: int = Field(100, ge=0, le=100000000)
    min_ror: float = Field(5, ge=0, le=1000)


@app.post('/api/scan')
async def scan(req: Scan, request: Request):
    if req.symbol != 'NIFTY':
        raise HTTPException(422, 'Select NIFTY.')
    access = token(request)
    contracts = await broker('/option/contract', access, {'instrument_key': KEY})
    if req.expiry not in {c.get('expiry') for c in contracts}:
        raise HTTPException(422, 'Select an available expiry.')
    chain = await broker('/option/chain', access, {'instrument_key': KEY, 'expiry_date': req.expiry})
    return dict(candidates=rank_spreads(chain, [c for c in contracts if c.get('expiry') == req.expiry], req.width, req.min_oi, req.min_ror),
        chain=chain, fetched_at=datetime.now(timezone.utc).isoformat(), expiry=req.expiry,
        ranking='Return on maximum loss, descending; cushion breaks ties. Before fees.',
        data_note='Upstox snapshot; retrieval time is not exchange quote time. Quotes may be stale when markets are closed.')
