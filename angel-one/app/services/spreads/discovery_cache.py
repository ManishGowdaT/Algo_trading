"""Bounded per-owner in-memory discovery cache and single-flight refresh."""
import asyncio
import hashlib
import time
from collections import OrderedDict
from copy import deepcopy

TTL = 900


class DiscoveryCache:
    def __init__(self, *, clock=time.time, limit=64):
        self.clock, self.limit = clock, limit
        self.entries = OrderedDict()
        self.tasks = {}
        self.progress = {}

    def key(self, owner, mode, token):
        return (owner, mode, hashlib.sha256(token.encode()).hexdigest())

    async def get(self, key, loader, *, force=False, timeout=180, wait=True):
        entry = self.entries.get(key)
        # Retry age is distinct from the original successful-ranking timestamp.
        checked_at = entry.get('last_refresh_at', entry['updated']) if entry else 0
        fresh = entry is not None and checked_at > 0 and self.clock()-checked_at <= TTL
        if force or (not fresh and (wait or entry is None or entry['updated'] > 0)):
            if key not in self.tasks:
                if len(self.tasks) >= 4:
                    raise RuntimeError('Discovery is busy; retry shortly.')
                self.tasks[key] = asyncio.create_task(self._refresh(key, loader))
                self.progress[key] = {'stage':'universe', 'completed':0, 'total':0}
            task = self.tasks[key]
            # Serve stale cached ranking during GET refresh, as in the original.
            if wait and (force or entry is None):
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout)
                except asyncio.TimeoutError:
                    raise TimeoutError('Discovery is still refreshing; retry shortly.') from None
        entry = self.entries.get(key, {'updated':0.,'all':[],'universe':{},'errors':[],'capabilities':{}})
        if key in self.entries:
            self.entries.move_to_end(key)
        return deepcopy({**entry, 'top':entry['all'][:5], 'refreshing':key in self.tasks,
                         'progress':self.progress.get(key)})

    async def _refresh(self, key, loader):
        try:
            payload = await loader()
            old = self.entries.get(key)
            # Original empty refresh retains previous ranking/timestamp.
            entry = {'updated':self.clock() if payload['all'] else (old['updated'] if old else 0.),
                     **payload}
            if not payload['all'] and old:
                entry = {**old, 'errors': payload.get('errors', []), 'refresh_empty': True}
            entry['last_refresh_at'] = self.clock()
            self.entries[key] = entry
            self.entries.move_to_end(key)
            while len(self.entries) > self.limit:
                self.entries.popitem(last=False)
        except Exception:
            # Consume background failures; no raw provider exception text.
            old = self.entries.get(key, {'updated':0.,'all':[],'universe':{},'capabilities':{}})
            self.entries[key] = {**old,'last_refresh_at':self.clock(),'errors':[{'ticker':None,'stage':'universe','error':'Discovery inputs could not be loaded. Retry shortly.'}]}
            while len(self.entries) > self.limit:
                self.entries.popitem(last=False)
        finally:
            self.tasks.pop(key, None)
            self.progress.pop(key, None)


discovery_cache = DiscoveryCache()
