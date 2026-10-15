"""In-process rolling quotas for the existing read-only Upstox transport.

State is shared by transports using the same authenticated identity and API.
No account information or access tokens are stored here.
"""
from collections import deque
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math
import threading
import time


class MarketDataQuota:
    def __init__(self, *, clock=time.monotonic, windows=((1, 50), (60, 500), (1800, 2000))):
        self.clock = clock
        self.windows = windows
        self.lock = threading.Lock()
        self.entries = {}
        self.cooldowns = {}

    def acquire(self, key, *, sleep, remaining, on_wait=None):
        waited = 0.0
        while True:
            with self.lock:
                now = self.clock()
                # Retire only expired state; never evict an active quota.
                for old in list(self.entries):
                    if not self.entries[old] or self.entries[old][-1] <= now - 1800:
                        self.entries.pop(old, None)
                for old in list(self.cooldowns):
                    if self.cooldowns[old] <= now:
                        self.cooldowns.pop(old, None)
                calls = self.entries.setdefault(key, deque())
                while calls and calls[0] <= now - 1800:
                    calls.popleft()
                delay = max(0.0, self.cooldowns.get(key, now) - now)
                for seconds, limit in self.windows:
                    recent = [stamp for stamp in calls if stamp > now - seconds]
                    if len(recent) >= limit:
                        delay = max(delay, recent[-limit] + seconds - now)
                if delay <= 0:
                    calls.append(now)
                    return waited
            # Never hold the quota lock while waiting: other APIs/users can run.
            if delay >= remaining():
                from .transport import UpstoxProviderError
                raise UpstoxProviderError('Upstox quota wait exceeds spread deadline; retry later', status_code=504)
            if on_wait:
                on_wait(delay)
            duration = min(delay, 1.0)
            sleep(duration)
            waited += duration

    def cooldown(self, key, seconds):
        with self.lock:
            self.cooldowns[key] = max(self.cooldowns.get(key, 0), self.clock() + seconds)


def retry_after_seconds(value, *, now=None):
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        try:
            stamp = parsedate_to_datetime(value)
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=timezone.utc)
            seconds = (stamp - (now or datetime.now(timezone.utc))).total_seconds()
        except (TypeError, ValueError, OverflowError):
            return None
    return max(0.0, seconds) if math.isfinite(seconds) else None


market_data_quota = MarketDataQuota()
