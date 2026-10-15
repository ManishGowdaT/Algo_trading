from datetime import date, datetime
from zoneinfo import ZoneInfo
import pytest

from app.services.spreads.history_validation import SessionCalendar, validate_history
from app.services.spreads.provider import PriceBar
from app.services.spreads.upstox_adapter import UpstoxMarketDataProvider

IST = ZoneInfo('Asia/Kolkata')


def bar(day, **kwargs):
    return PriceBar(datetime.combine(day, datetime.min.time(), IST),
                    kwargs.get('open', 10), 12, 9, 11, 100)


def check(bars, calendar=None, skipped=0):
    return validate_history(bars, start=date(2026, 10, 9), end=date(2026, 10, 12),
                            raw_count=len(bars) + skipped, skipped_count=skipped, calendar=calendar)


def calendar():
    # Test-only declared sessions include a special Saturday; never used live.
    return SessionCalendar(date(2026, 10, 9), date(2026, 10, 12),
                           frozenset([date(2026, 10, 9), date(2026, 10, 10), date(2026, 10, 12)]),
                           'test-only authoritative-calendar stand-in')


def test_missing_calendar_never_certifies_weekdays_or_holidays():
    capability, report = check([bar(date(2026, 10, 9)), bar(date(2026, 10, 12))])
    assert capability.status == 'unverified'
    assert report['missing_sessions'] is None


def test_special_session_missing_is_reported_without_filling():
    bars = [bar(date(2026, 10, 9)), bar(date(2026, 10, 12))]
    capability, report = check(bars, calendar())
    assert capability.status == 'incomplete'
    assert report['missing_sessions'] == ['2026-10-10']
    assert len(bars) == 2


def test_full_calendar_and_valid_ohlcv_can_verify_descending_response():
    bars = [bar(day) for day in sorted(calendar().sessions, reverse=True)]
    capability, report = check(bars, calendar())
    assert capability.status == 'verified'
    assert report['source_order'] == 'descending'
    assert report['missing_sessions'] == []


def test_duplicates_malformed_invalid_and_out_of_range_are_not_hidden():
    capability, report = check([bar(date(2026, 10, 12)), bar(date(2026, 10, 9), open=None),
                                bar(date(2026, 10, 12)), bar(date(2026, 10, 13))], skipped=1)
    assert capability.status == 'incomplete'
    assert report['duplicate_dates'] == ['2026-10-12']
    assert report['invalid_ohlcv_dates'] == ['2026-10-09']
    assert report['out_of_range_dates'] == ['2026-10-13']
    assert report['skipped_count'] == 1
    assert report['source_order'] == 'out_of_order'


def test_partial_calendar_cannot_certify_requested_range():
    partial = SessionCalendar(date(2026, 10, 12), date(2026, 10, 12),
                              frozenset([date(2026, 10, 12)]), 'partial test calendar')
    assert check([bar(date(2026, 10, 12))], partial)[0].status == 'unverified'


@pytest.mark.parametrize('value', [float('nan'), float('inf'), True])
def test_nonfinite_or_boolean_prices_never_certify(value):
    capability, report = check([bar(date(2026,10,12), open=value)], calendar())
    assert capability.status == 'incomplete'
    assert report['invalid_ohlcv_dates'] == ['2026-10-12']


def test_discovery_reports_duplicates_and_malformed_rows_without_claiming_completeness():
    from app.services.spreads.discovery_adapter import DiscoveryDataAdapter
    class Transport:
        def get(self, path):
            return {'candles': [
                ['2026-10-12T00:00:00+05:30',10,12,9,11,123],
                ['2026-10-12T00:00:00+05:30',10,12,9,11,123],
                ['bad-date',10,12,9,11,123]]}
    history = DiscoveryDataAdapter(None, transport=Transport()).get_history('NSE_EQ|TEST', as_of=date(2026,10,12))
    assert history.completeness.status == 'incomplete'
    assert history.validation['duplicate_dates'] == ['2026-10-12']
    assert history.validation['skipped_count'] == 1
    assert history.validation['missing_sessions'] is None
    assert len(history.bars) == 2


def test_adapter_mapping_sorting_and_diagnostics_preserve_returned_values():
    class Transport:
        def get(self, path):
            return {'candles': [
                ['2026-10-12T00:00:00+05:30', 10, 12, 9, 11, 123, 500],
                ['bad-date', 10, 12, 9, 11, 123],
                ['2026-10-09T00:00:00+05:30', 8, 10, 7, 9, 456, 600],
            ]}
    history = UpstoxMarketDataProvider(transport=Transport()).get_history('NSE_EQ|TEST')
    assert [(b.open, b.high, b.low, b.close, b.volume, b.open_interest) for b in history.bars] == [
        (8, 10, 7, 9, 456, 600), (10, 12, 9, 11, 123, 500)]
    assert history.validation['skipped_count'] == 1
    assert history.completeness.status == 'incomplete'
    assert history.adjustment.status == 'unverified'
