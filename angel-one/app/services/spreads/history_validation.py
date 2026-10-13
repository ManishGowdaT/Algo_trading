"""Observational daily-history checks; never fill, drop or rewrite scanner bars."""
from collections import Counter
from dataclasses import dataclass
from datetime import date
from zoneinfo import ZoneInfo

from .provider import DataCapability

IST = ZoneInfo('Asia/Kolkata')


@dataclass(frozen=True)
class SessionCalendar:
    """Explicit completed NSE sessions from an authoritative, full-range source.

    No weekday/holiday inference is permitted. Coverage must include the entire
    requested range, including special sessions and the current session's close.
    """
    start: date
    end: date
    sessions: frozenset[date]
    source: str


def validate_history(bars, *, start, end, raw_count, skipped_count, calendar=None):
    days = [bar.timestamp.astimezone(IST).date() for bar in bars]
    duplicates = sorted(day.isoformat() for day, count in Counter(days).items() if count > 1)
    outside = sorted({day.isoformat() for day in days if not start <= day <= end})
    invalid = []
    for bar, day in zip(bars, days):
        values = (bar.open, bar.high, bar.low, bar.close, bar.volume)
        if (any(value is None for value in values) or
                min(values[:4]) <= 0 or bar.volume < 0 or
                bar.high < max(bar.open, bar.close, bar.low) or
                bar.low > min(bar.open, bar.close, bar.high)):
            invalid.append(day.isoformat())
    ascending = days == sorted(days)
    descending = days == sorted(days, reverse=True)
    covered = bool(calendar and calendar.source and calendar.start <= start and calendar.end >= end)
    expected = {day for day in calendar.sessions if start <= day <= end} if covered else None
    missing = sorted(day.isoformat() for day in expected - set(days)) if covered else None
    unexpected = sorted(day.isoformat() for day in set(days) - expected) if covered else None
    defects = bool(duplicates or outside or invalid or skipped_count or missing or unexpected)
    status = 'incomplete' if defects else 'verified' if covered else 'unverified'
    note = (f'Daily history {status}: {len(duplicates)} duplicate dates; '
            f'{skipped_count} skipped malformed rows; {len(invalid)} invalid OHLCV rows; '
            f'{len(outside)} out-of-range dates. ')
    note += (f'Calendar source: {calendar.source}; missing sessions: {missing}; unexpected sessions: {unexpected}.'
             if covered else 'No authoritative NSE completed-session calendar covers the requested range; missing-session dates cannot be certified.')
    return DataCapability(status == 'verified', status, note), {
        'requested_start': start.isoformat(), 'requested_end': end.isoformat(),
        'raw_count': raw_count, 'parsed_count': len(bars), 'skipped_count': skipped_count,
        'source_order': 'ascending' if ascending else 'descending' if descending else 'out_of_order',
        'normalized_order': 'ascending', 'duplicate_dates': duplicates,
        'invalid_ohlcv_dates': sorted(set(invalid)), 'out_of_range_dates': outside,
        'calendar_source': calendar.source if covered else None,
        'missing_sessions': missing, 'unexpected_sessions': unexpected,
        'status': status, 'explanation': note,
    }
