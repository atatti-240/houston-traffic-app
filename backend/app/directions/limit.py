"""A per-client limit on asking for directions (POST /directions).

The public OSRM server allows about one request a second for the whole app, so one busy client
(a script, a stuck retry loop) could leave nothing for everyone else. Each client (by address)
gets BURST asks that refill at PER_MIN a minute. At most MAX_CLIENTS are remembered (the one
idle the longest is forgotten first), so it stays small whoever calls.
"""

import threading
import time
from collections import OrderedDict
from collections.abc import Callable

BURST = 6
PER_MIN = 10
MAX_CLIENTS = 1024


class ClientLimiter:
    def __init__(
        self,
        burst: int = BURST,
        per_min: float = PER_MIN,
        max_clients: int = MAX_CLIENTS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.burst = burst
        self.rate = per_min / 60  # asks per second
        self.max_clients = max_clients
        self.clock = clock
        self._lock = threading.Lock()
        self._clients: OrderedDict[str, tuple[float, float]] = OrderedDict()  # client -> (asks left, when)

    def take(self, client: str) -> float:
        """One ask for `client`: 0 when it can go ahead, else how many seconds until it can."""
        with self._lock:
            now = self.clock()
            left, at = self._clients.pop(client, (float(self.burst), now))
            left = min(float(self.burst), left + (now - at) * self.rate)
            wait = 0.0 if left >= 1 else (1 - left) / self.rate
            self._clients[client] = (left - 1 if wait == 0 else left, now)  # the most recent last
            while len(self._clients) > self.max_clients:
                self._clients.popitem(last=False)
            return wait
