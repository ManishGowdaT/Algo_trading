"""Synthetic unit inputs only; not broker evidence."""
import unittest
from datetime import datetime, timedelta
from validate_index_ohlcv import validate, IST, INSTRUMENTS


def sample(underlying='NIFTY'):
    exchange,token=INSTRUMENTS[underlying]
    start=datetime(2026,10,16,9,15,tzinfo=IST)
    return {'underlying':underlying,'exchange':exchange,'symboltoken':token,'date':'2026-10-16',
            'source':'ANGEL_ONE_RAW_HISTORICAL','interval':'ONE_MINUTE',
            'data':[[(start+timedelta(minutes=i)).isoformat(),100,102,99,101,10] for i in range(135)]}


class ValidationTests(unittest.TestCase):
    def test_each_index_and_internal_weighted_vwap(self):
        for index in INSTRUMENTS:
            s=sample(index);s['data'][1][2:6]=[105,99,102,30]
            r=validate(s)
            self.assertTrue(r['valid']);self.assertEqual(r['barsValidated'],135)
            self.assertAlmostEqual(r['sessionVwapAt1130'],(134*10*(302/3)+30*102)/1370)
    def test_missing_and_zero_volume_are_different(self):
        s=sample();s['data'][0][5]=None
        self.assertFalse(validate(s)['valid'])
        s=sample();s['data'][0][5]=0
        self.assertTrue(validate(s)['valid'])
        for row in s['data']:row[5]=0
        self.assertIn('ZERO_CUMULATIVE_VOLUME',validate(s)['errors'])
    def test_gaps_duplicates_and_ambiguous_time_fail(self):
        s=sample();s['data'].pop(4);self.assertFalse(validate(s)['valid'])
        s=sample();s['data'][1]=s['data'][0];self.assertFalse(validate(s)['valid'])
        s=sample();s['data'][0][0]='2026-10-16T09:15:00';self.assertFalse(validate(s)['valid'])
    def test_identity_mismatch_cannot_pass(self):
        s=sample();s['exchange']='BSE';self.assertFalse(validate(s)['valid'])


if __name__=='__main__':unittest.main()
