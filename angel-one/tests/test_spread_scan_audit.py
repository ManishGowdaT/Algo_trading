import json
import math
import zipfile
from dataclasses import asdict
from pathlib import Path

import numpy as np

from app.services.spreads import api, engine, scan_audit
from app.services.spreads.fixture_adapter import FixtureMarketDataProvider
from app.services.spreads.nifty_fixtures import spread_fixture_payloads


def test_diagnostic_capture_never_changes_existing_scan_or_formula_parameters(monkeypatch,tmp_path):
    monkeypatch.setenv('SPREADS_DATA_MODE','fixtures')
    monkeypatch.setattr(scan_audit,'ROOT',tmp_path)
    plain=api._scan_underlying('NIFTY',api.NiftyScanRequest(width=50),None,'')
    captured=api._scan_underlying('NIFTY',api.NiftyScanRequest(width=50,audit_snapshot=True),None,'')
    assert {k:v for k,v in captured.items() if k!='scan_audit'}==plain
    assert 'audit_snapshot' not in api.NiftyScanRequest(audit_snapshot=True).model_dump()
    snapshot=json.loads(Path(captured['scan_audit']['file']).read_text())
    assert snapshot['normalized']['parameters']==asdict(engine.ScanParams(dte=captured['dte'],width=50))
    assert snapshot['history']['bars'] and snapshot['normalized']['closes']
    assert snapshot['replay']['candidates_identical']
    assert snapshot['replay']['rejection_funnel_identical']


def test_transport_capture_returns_identical_data_and_only_market_fields():
    payload=[{'strike_price':100,'expiry':'2026-11-23','secret':'secret-token',
              'call_options':{'instrument_key':'NSE_FO|123','authorization':'secret-token',
                 'market_data':{'oi':100,'bid_price':2,'ask_price':2.1,'token':'secret-token'},
                 'option_greeks':{'iv':30,'secret':'secret-token'}}}]
    class Transport:
        _authorization='secret-token'
        def get(self,*args): return payload
    capture=scan_audit.ScanAudit('TEST')
    wrapped=scan_audit.RecordingTransport(Transport(),capture)
    assert wrapped.get('/v2/option/chain',{'instrument_key':'NSE_EQ|123','token':'secret-token'}) is payload
    assert 'secret-token' not in json.dumps(capture.raw)
    assert capture.raw[0]['data'][0]['call_options']['market_data']['oi']==100


def test_independent_first_rejections_reconcile_to_original_zip_for_100_inputs(tmp_path):
    source=(Path(__file__).parent/'fixtures/spreads/original_screener.txt').read_bytes()
    zip_path=tmp_path/'original.zip'
    with zipfile.ZipFile(zip_path,'w') as archive: archive.writestr('spread-terminal/screener.py',source)
    rng=np.random.default_rng(912)
    for case in range(100):
        closes=100*np.exp(np.cumsum(rng.normal(0,.012,400)))
        spot=float(closes[-1])
        strikes=np.arange(math.floor(spot/5)*5-45,math.floor(spot/5)*5+50,5)
        puts,calls=[],[]
        for index,strike in enumerate(strikes):
            for rows,mid in [(puts,.2+index*.6),(calls,.2+(len(strikes)-index)*.6)]:
                rows.append(dict(strike=float(strike),bid=mid*.98,ask=mid*1.02,
                    impliedVolatility=.45 if index%7 else float('nan'),openInterest=250 if index%5 else 10))
        params=engine.ScanParams(dte=[5,14,30,90,180][case%5],width=[5.,10.,15.][case%3],
            min_vrp=[.5,1.15,2.][case%3],min_cushion=[0.,2.,5.][case%3],min_ror=[5.,15.,50.][case%3])
        inputs=dict(ticker='TEST',spot=spot,closes=closes.tolist(),puts=puts,calls=calls,
            expiration='2026-12-31',dte=params.dte,parameters=asdict(params),earnings=case%2==0,max_gap=8.)
        result=scan_audit.replay(inputs,zip_path)
        assert all(result[key] for key in ('definitions_identical','rv_identical','candidates_identical',
                                           'funnels_identical','rejection_funnel_identical'))
        assert sum(result['first_failure_counts'].values())+result['funnel']['final']==result['funnel']['considered']


def test_malformed_payload_capture_cannot_change_transport_result():
    payload = [{'call_options': 'invalid-provider-value'}]
    class Transport:
        def get(self, *args): return payload
    capture = scan_audit.ScanAudit('TEST')
    assert scan_audit.RecordingTransport(Transport(), capture).get('/v2/option/chain') is payload
    assert capture.raw[0]['capture_error_type'] == 'AttributeError'
