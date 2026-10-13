"""Opt-in market-data evidence only. Never supplies or modifies scanner inputs."""
from __future__ import annotations

import ast
import hashlib
import json
import math
import sys
import types
import uuid
import zipfile
from contextvars import ContextVar
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

CURRENT_AUDIT = ContextVar('spread_scan_audit', default=None)
ROOT = Path(__file__).resolve().parents[4]
SOURCE_HASH = '6ceb884e157e3918216ad70491eaf5daa7de490172a8ae778a137adfd9bd5caa'
STAGES = ('considered', 'cushion', 'friction', 'paired', 'ror', 'vrp', 'final')
CALC_NAMES = {'ScanParams', 'realized_vols', 'empirical_breach_prob',
              'apply_earnings_penalty', 'friction_detail', 'passes_friction', 'build_spreads'}


def json_safe(value):
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, np.generic):
        return json_safe(value.item())
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def oracle(zip_path):
    """Execute ONLY hash-verified calculation definitions, never ZIP I/O code."""
    with zipfile.ZipFile(zip_path) as archive:
        source = archive.read('spread-terminal/screener.py')
    if hashlib.sha256(source).hexdigest() != SOURCE_HASH:
        raise ValueError('Uploaded scanner source hash differs from the audited original')
    nodes = [n for n in ast.parse(source.decode('utf-8-sig')).body
             if isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in CALC_NAMES]
    module = types.ModuleType('spread_scan_audit_zip_oracle')
    sys.modules[module.__name__] = module
    module.__dict__.update(math=math, np=np, pd=pd, dataclass=dataclass,
                          TRADING_DAYS_PER_YEAR=252, CAL_TO_TRADING=252/365)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'uploaded-ZIP/screener.py', 'exec'), module.__dict__)
    return module


def first_failures(inputs, calculation):
    """Independent observational replay of the original ordered gates."""
    close = pd.Series(inputs['closes'], dtype=float)
    params = calculation.ScanParams(**inputs['parameters'])
    rv = calculation.realized_vols(close)
    counts = dict.fromkeys(STAGES, 0)
    records = []
    for label, side, direction, sign in [('BULL PUT','puts','down',-1), ('BEAR CALL','calls','up',1)]:
        df = pd.DataFrame(inputs[side])
        if df.empty or math.isnan(rv['rv21']) or rv['rv21'] <= 0:
            continue
        for column in ('strike','bid','ask','impliedVolatility','openInterest'):
            df[column] = pd.to_numeric(df[column], errors='coerce')
        spot = inputs['spot']
        otm = df[df.strike < spot if sign < 0 else df.strike > spot].copy()
        otm['dist'] = (otm.strike-spot).abs()
        otm = otm.sort_values('dist').head(params.max_strikes)
        for index, short in otm.iterrows():
            row = {'type':label, 'short_row_index':int(index), 'short_strike':float(short.strike),
                   'short_instrument_key':short.get('instrument_key'), 'first_failure':None}
            records.append(row)
            counts['considered'] += 1
            cushion = abs(float(short.strike)-spot)/spot*100
            row['cushion'] = cushion
            if cushion < params.min_cushion:
                row['first_failure']='cushion'; continue
            counts['cushion'] += 1
            fs = calculation.friction_detail(short)
            row['short_friction'] = fs
            if not fs['mid'] > 0:
                row['first_failure']='short midpoint'; continue
            if not fs['spread_pct'] <= params.max_spread_pct:
                row['first_failure']='short bid/ask fraction'; continue
            if not fs['oi'] >= params.min_oi:
                row['first_failure']='short OI'; continue
            target = float(short.strike)+sign*params.width
            mask = np.isclose(df.strike.values, target, atol=.011)
            if not mask.any():
                row['first_failure']='missing hedge strike'; continue
            long = df[mask].iloc[0]
            row.update(long_strike=float(long.strike), long_instrument_key=long.get('instrument_key'))
            fl = calculation.friction_detail(long)
            row['long_friction']=fl
            if not fl['mid'] > 0:
                row['first_failure']='long midpoint'; continue
            if not fl['spread_pct'] <= params.max_spread_pct:
                row['first_failure']='long bid/ask fraction'; continue
            if not fl['oi'] >= params.min_oi:
                row['first_failure']='long OI'; continue
            counts['friction'] += 1
            credit, width = fs['mid']-fl['mid'], abs(float(long.strike)-float(short.strike))
            row.update(credit=credit, width=width, max_loss=width-credit)
            if credit <= .01:
                row['first_failure']='credit <= 0.01'; continue
            if credit >= width:
                row['first_failure']='credit >= width'; continue
            counts['paired'] += 1
            ror = credit/(width-credit)*100
            row['ror_pct']=ror
            if ror < params.min_ror:
                row['first_failure']='RoR'; continue
            counts['ror'] += 1
            iv = float(short.impliedVolatility)
            row['iv']=iv
            if math.isnan(iv) or iv <= 0:
                row['first_failure']='missing/invalid IV'; continue
            vrp = iv/rv['rv21']
            row['vrp']=vrp
            if vrp < params.min_vrp:
                row['first_failure']='VRP'; continue
            counts['vrp'] += 1
            n = max(1,round(inputs['dte']*252/365))
            returns = (close.shift(-n)/close-1).dropna()*100
            breached = returns <= -cushion if direction=='down' else returns >= cushion
            raw = calculation.empirical_breach_prob(close,inputs['dte'],cushion,direction)
            row.update(horizon_td=n, observations=len(returns), breach_count=int(breached.sum()), p_raw=raw)
            if math.isnan(raw):
                row['first_failure']='historical probability'; continue
            adjusted = calculation.apply_earnings_penalty(raw,cushion,inputs['max_gap']) if inputs['earnings'] else raw
            row.update(p_adj=adjusted, ev_unrounded=(credit*(1-adjusted)-(width-credit)*adjusted)*100,
                       earnings_inside=inputs['earnings'], max_gap=inputs['max_gap'])
            counts['final'] += 1
    reasons = {}
    for row in records:
        if row['first_failure']:
            reasons[row['first_failure']] = reasons.get(row['first_failure'],0)+1
    return {'funnel':counts,'first_failure_counts':reasons,'candidate_attempts':records}


def replay(inputs, zip_path):
    from . import engine, original_calculations
    reference = oracle(zip_path)
    current_tree = ast.parse(Path(original_calculations.__file__).read_text())
    with zipfile.ZipFile(zip_path) as archive:
        source_tree = ast.parse(archive.read('spread-terminal/screener.py').decode('utf-8-sig'))
    definitions = lambda tree: {n.name:ast.dump(n,include_attributes=False) for n in tree.body
                               if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and n.name in CALC_NAMES}
    close = pd.Series(inputs['closes'],dtype=float)
    frames = []
    for side in ('puts','calls'):
        frame = pd.DataFrame(inputs[side],columns=['strike','bid','ask','impliedVolatility','openInterest'])
        for column in frame.columns:
            frame[column]=pd.to_numeric(frame[column],errors='coerce')
        frames.append(frame)
    rv = reference.realized_vols(close)
    args = (inputs['ticker'],inputs['spot'],*frames,inputs['expiration'],inputs['dte'],close,rv,
            inputs['earnings'],inputs['max_gap'],reference.ScanParams(**inputs['parameters']))
    expected = reference.build_spreads(*args)
    actual = engine.build_spreads(inputs['ticker'],inputs['spot'],frames[0].to_dict('records'),frames[1].to_dict('records'),
        inputs['expiration'],inputs['dte'],inputs['closes'],engine.realized_vols(inputs['closes']),
        inputs['earnings'],inputs['max_gap'],engine.ScanParams(**inputs['parameters']))
    explanation = first_failures(inputs,reference)
    return {'source_hash':SOURCE_HASH, 'definitions_identical':definitions(current_tree)==definitions(source_tree),
            'rv_identical':json_safe(rv)==json_safe(engine.realized_vols(inputs['closes'])),
            'candidates_identical':json_safe(actual[0])==json_safe(expected[0]),
            'funnels_identical':actual[1]==expected[1],
            'rejection_funnel_identical':explanation['funnel']==expected[1],
            'original_candidates':json_safe(expected[0]),'integrated_candidates':json_safe(actual[0]),
            **json_safe(explanation)}


class RecordingTransport:
    """Capture approved market fields from the SAME response used by the adapter."""
    def __init__(self, transport, capture):
        self.transport,self.capture=transport,capture

    def get(self,path,params=None):
        try:
            data=self.transport.get(path,params)
        except Exception as error:
            self.capture.raw.append({'path':path,'status':getattr(error,'status_code',None),
                                     'error_type':type(error).__name__})
            raise
        try:
            self._record(path, params, data)
        except Exception as error:
            # Observing malformed data must never alter the transport's result.
            self.capture.raw.append({'path':path,'capture_error_type':type(error).__name__})
        return data

    def _record(self, path, params, data):
        def keep(row,fields):
            return {k:row[k] for k in fields if k in row} if isinstance(row,dict) else {}
        if '/historical-candle/' in path:
            raw={'candles':[list(row[:7]) if isinstance(row,(list,tuple)) else None
                            for row in data.get('candles',[])]} if isinstance(data,dict) else None
        elif path=='/v2/option/contract':
            raw=[keep(row,('instrument_key','trading_symbol','underlying_key','underlying_symbol','expiry',
                           'strike_price','instrument_type','lot_size','tick_size')) for row in data] if isinstance(data,list) else None
        elif path=='/v2/option/chain':
            raw=[]
            for row in data if isinstance(data,list) else []:
                entry=keep(row,('expiry','underlying_key','underlying_spot_price','strike_price'))
                for side in ('call_options','put_options'):
                    option=row.get(side,{}) if isinstance(row,dict) else {}
                    entry[side]={'instrument_key':option.get('instrument_key'),
                        'market_data':keep(option.get('market_data'),('bid_price','ask_price','oi','volume','bid_qty','ask_qty')),
                        'option_greeks':keep(option.get('option_greeks'),('iv',))}
                raw.append(entry)
        elif path=='/v3/market-quote/option-greek':
            raw={k:keep(v,('instrument_token','iv','oi')) for k,v in data.items()} if isinstance(data,dict) else None
        else:
            raw=None
        if raw is not None:
            self.capture.raw.append({'path':path,'parameters':keep(params,('instrument_key','expiry_date')),
                'observed_at':datetime.now().astimezone().isoformat(),'data':raw,
                'note':'Same transport response as scanner; existing transport cache may apply; quote timestamp is not certified.'})

    def request_metrics(self):
        return self.transport.request_metrics()


class ScanAudit:
    def __init__(self,ticker):
        self.id=str(uuid.uuid4())
        self.ticker=ticker
        self.raw=[]
        self.earnings_dates={}
        self.finished=False
        self.snapshot={'audit_id':self.id,'ticker':ticker,'raw_upstox':self.raw}

    def record_dates(self,events,today,expiration,history):
        closes=[(bar.timestamp.astimezone(ZoneInfo('Asia/Kolkata')).date(),bar.close) for bar in history.bars if bar.close is not None]
        pct=pd.Series([value for _,value in closes],dtype=float).pct_change()
        positions={day:index for index,(day,_) in enumerate(closes)}
        gaps=[]
        historical=[day for day in events if today-timedelta(days=3*365)<=day<=today]
        for event in historical:
            for candidate in (event,event+timedelta(days=1),event+timedelta(days=2),event+timedelta(days=3)):
                position=positions.get(candidate)
                if position is not None:
                    gaps.append({'event_date':event,'close_date':candidate,'position':position,
                        'absolute_gap_pct':abs(float(pct.iloc[position]))*100 if position>0 and not math.isnan(pct.iloc[position]) else None})
                    break
        self.earnings_dates={'upcoming_dates':[d for d in events if d>today],
                            'historical_dates_used':historical,'event_gaps':gaps,
                            'as_of':today,'expiration':expiration}

    def inputs(self,underlying,contracts,history,chain,earnings,expiration,dte,params):
        from . import engine
        closes=[bar.close for bar in history.bars if bar.close is not None]
        inputs={'ticker':underlying['symbol'],'spot':closes[-1] if closes else None,
                'closes':closes,'puts':engine.option_chain_rows(chain,'puts'),
                'calls':engine.option_chain_rows(chain,'calls'),'expiration':expiration.isoformat(),
                'dte':dte,'parameters':asdict(params),'earnings':earnings.earnings_inside,
                'max_gap':earnings.max_historical_gap_pct}
        for side in ('puts','calls'):
            for row in inputs[side]:
                row['midpoint']=(row['bid']+row['ask'])/2
                key=row.get('instrument_key')
                chain_iv,greek_iv=None,None
                for response in self.raw:
                    if response.get('path')=='/v2/option/chain':
                        for strike in response['data']:
                            for option_side in ('put_options','call_options'):
                                option=strike.get(option_side,{})
                                if option.get('instrument_key')==key:
                                    chain_iv=option.get('option_greeks',{}).get('iv')
                    if response.get('path')=='/v3/market-quote/option-greek':
                        for option in (response.get('data') or {}).values():
                            if option.get('instrument_token')==key:
                                greek_iv=option.get('iv')
                def positive(value):
                    try:
                        return not isinstance(value,bool) and math.isfinite(float(value)) and float(value)>0
                    except (ValueError,TypeError,OverflowError):
                        return False
                matching=[contract for contract in contracts if contract.instrument_key==key and contract.expiry==expiration]
                row.update(raw_chain_iv=chain_iv,raw_v3_iv=greek_iv,
                    iv_source='Option Chain' if positive(chain_iv) else 'V3' if positive(greek_iv) else 'Unavailable',
                    option_type='PE' if side=='puts' else 'CE',expiry=expiration,
                    lot_sizes=[contract.lot_size for contract in matching])
        self.snapshot.update(underlying=underlying,contracts=[asdict(c) for c in contracts],
            history=asdict(history),chain=asdict(chain),earnings={**asdict(earnings),**self.earnings_dates},
            normalized=inputs,rv=engine.realized_vols(closes) if closes else {},
            latest_historical_candle=next((asdict(bar) for bar in reversed(history.bars) if bar.close is not None),None))

    def finish(self,result):
        self.snapshot['api_result']=result
        if result.get('ok') and result.get('strategy_profile') == 'NSE_RESEARCH_V1':
            self.snapshot['strategy_profile'] = 'NSE_RESEARCH_V1'
            self.snapshot['replay'] = {'status':'PROFILE_ADAPTATION',
                'reason':'Listed hedge steps and tick-derived credit gate intentionally differ from ZIP baseline; do not claim ZIP candidate parity.'}
        elif result.get('ok'):
            uploaded=Path.home()/'Downloads'/'spread-terminal.zip'
            if uploaded.exists():
                try:
                    self.snapshot['replay']=replay(self.snapshot['normalized'],uploaded)
                    self.snapshot['replay']['api_original_fields_identical']=all(
                        all(actual.get(k)==v for k,v in expected.items())
                        for actual,expected in zip(result['candidates'],self.snapshot['replay']['original_candidates'])
                    ) and len(result['candidates'])==len(self.snapshot['replay']['original_candidates'])
                except Exception as exc:
                    self.snapshot['replay']={'status':'UNVERIFIED','error_type':type(exc).__name__}
            else:
                self.snapshot['replay']={'status':'UNVERIFIED','reason':'Original uploaded ZIP is not available on this host'}
        else:
            self.snapshot['replay']={'status':'NOT_RUN','reason':'Underlying unavailable before original build_spreads; no earnings values assumed'}
        target=ROOT/'tmp'/'spread-audit'/f'{self.id}.json'
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(json_safe(self.snapshot),indent=2,allow_nan=False),encoding='utf-8')
        self.finished=True
        return {'audit_id':self.id,'status':'captured','file':str(target)}


def batch_snapshot(result,request):
    if result.get('strategy_profile') == 'NSE_RESEARCH_V1':
        audit_id = str(uuid.uuid4())
        target = ROOT/'tmp'/'spread-audit'/f'batch-{audit_id}.json'
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(json_safe({'audit_id':audit_id,'request':request,'result':result,
            'status':'PROFILE_ADAPTATION','note':'No original-ZIP candidate parity claim for NSE market-structure adaptations.'}),indent=2,allow_nan=False),encoding='utf-8')
        return {'audit_id':audit_id,'status':'captured','file':str(target),'strategy_profile':'NSE_RESEARCH_V1'}
    expected=[]
    issues=[]
    totals=dict.fromkeys(STAGES,0)
    reasons={}
    for scan in result['underlyings']:
        evidence=scan.get('scan_audit',{})
        if evidence.get('status')!='captured':
            issues.append({'ticker':scan['symbol'],'status':'UNVERIFIED','reason':'No complete per-underlying capture'})
            continue
        snapshot=json.loads(Path(evidence['file']).read_text(encoding='utf-8'))
        if scan.get('ok'):
            replay_result=snapshot.get('replay',{})
            expected.extend(replay_result.get('original_candidates',[]))
            for key,value in replay_result.get('funnel',{}).items():
                totals[key]+=value
            for key,value in replay_result.get('first_failure_counts',{}).items():
                reasons[key]=reasons.get(key,0)+value
            for key in ('definitions_identical','rv_identical','candidates_identical','funnels_identical',
                        'rejection_funnel_identical','api_original_fields_identical'):
                if replay_result.get(key) is not True:
                    issues.append({'ticker':scan['symbol'],'check':key,'status':'FAIL' if key in replay_result else 'UNVERIFIED'})
    expected.sort(key=lambda row:row['ev'],reverse=True)
    actual=[{key:row.get(key) for key in original} for row,original in zip(result['candidates'],expected)]
    ranking_pass=len(result['candidates'])==len(expected) and actual==expected
    identifier=str(uuid.uuid4())
    target=ROOT/'tmp'/'spread-audit'/f'batch-{identifier}.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(json_safe({'audit_id':identifier,'request':request,'result':result,
        'original_combined_candidates':expected,'combined_ranking_identical':ranking_pass,
        'original_aggregate_funnel':totals,'aggregate_funnel_identical':totals==(result.get('funnel') or dict.fromkeys(STAGES,0)),
        'first_failure_counts':reasons,
        'issues':issues}),indent=2,allow_nan=False),encoding='utf-8')
    return {'audit_id':identifier,'status':'captured','file':str(target),
            'combined_ranking_identical':ranking_pass,'issues':issues}
