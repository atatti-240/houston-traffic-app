"""Deterministic synthetic Houston traffic history.

Stands in for TranStar speeds, incident feeds and train crossing data until the real feeds
are wired up. Everything is generated per-day from (seed, date), so any day can be
regenerated on demand and nothing has to be stored.

Ground truth baked in (the models should rediscover this from the data):
- Weekday AM rush peaks ~7:45 inbound (toward downtown), PM rush ~17:30 outbound.
- Some links (West Loop, I-45 Gulf, South Loop east of 288) crash far more often, and each
  crash causes a local slowdown.
- A few crossings have trains at nearly the same time every weekday (see RECURRING_TRAINS).
"""

import math
import random
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from app.seed.network import CrossingDef, SegmentProfile, crossing_defs, segment_profiles
from app.timebuckets import SLOT_MINUTES, SLOTS_PER_DAY


@dataclass(frozen=True)
class SpeedObservation:
    segment_id: str
    slot: int
    speed_mph: float


@dataclass(frozen=True)
class CrashRecord:
    segment_id: str
    at: datetime


@dataclass(frozen=True)
class TrainEvent:
    crossing_id: str
    start: datetime
    end: datetime

    @property
    def minutes(self) -> float:
        return (self.end - self.start).total_seconds() / 60


WEEKDAYS = frozenset(range(5))
ALL_DAYS = frozenset(range(7))

# crossing_id -> [(days, start minute of day, duration minutes, probability)]
RECURRING_TRAINS: dict[str, list[tuple[frozenset[int], int, int, float]]] = {
    "x_cullen": [(WEEKDAYS, 7 * 60 + 35, 20, 0.85), (WEEKDAYS, 17 * 60 + 10, 15, 0.7)],
    "x_navigation": [(WEEKDAYS, 7 * 60 + 50, 12, 0.75)],
    "x_harrisburg": [(WEEKDAYS, 8 * 60 + 5, 10, 0.6), (WEEKDAYS, 16 * 60 + 45, 12, 0.6)],
    "x_houston_ave": [(WEEKDAYS, 7 * 60 + 20, 10, 0.5)],
    "x_quitman": [(ALL_DAYS, 17 * 60 + 30, 15, 0.6)],
    "x_ost": [(WEEKDAYS, 7 * 60 + 55, 10, 0.55)],
}
RANDOM_TRAINS_PER_DAY = 1.2

CRASHES_PER_MILE_HOUR = 0.0025


def _bump(h: float, mu: float, sigma: float) -> float:
    return math.exp(-0.5 * ((h - mu) / sigma) ** 2)


def base_congestion(slot: int, weekend: bool, inbound: bool, road_class: str) -> float:
    """Typical congestion ratio (0 = free flow, 1 = stopped) before multipliers and noise."""
    h = (slot + 0.5) * SLOT_MINUTES / 60
    if weekend:
        r = 0.04 + 0.18 * _bump(h, 13.5, 2.5)
    else:
        am, pm, mid = _bump(h, 7.75, 1.0), _bump(h, 17.5, 1.2), _bump(h, 12.5, 2.0)
        heavy, light = (am, pm) if inbound else (pm, am)
        r = 0.04 + 0.62 * heavy + 0.26 * light + 0.12 * mid
    if road_class == "arterial":
        r *= 0.65
    return r


def _crash_time_mult(dow: int, hour: int) -> float:
    if dow < 5 and (7 <= hour < 9 or 16 <= hour < 19):
        return 2.5
    if (dow in (4, 5) and hour >= 22) or (dow in (5, 6) and hour < 2):
        return 2.0
    if 2 <= hour < 5:
        return 0.4
    return 1.0


def _poisson(rng: random.Random, lam: float) -> int:
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


class SyntheticWorld:
    def __init__(
        self,
        seed: int = 42,
        profiles: list[SegmentProfile] | None = None,
        crossings: list[CrossingDef] | None = None,
    ) -> None:
        self.seed = seed
        self.profiles = profiles if profiles is not None else segment_profiles()
        self.crossings = crossings if crossings is not None else crossing_defs()

    def _rng(self, day: date, salt: str) -> random.Random:
        return random.Random(f"{self.seed}|{day.isoformat()}|{salt}")

    def crashes(self, day: date) -> list[CrashRecord]:
        rng = self._rng(day, "crash")
        out = []
        dow = day.weekday()
        for p in self.profiles:
            miles = p.length_m / 1609.344
            for hour in range(24):
                lam = CRASHES_PER_MILE_HOUR * miles * p.crash_mult * _crash_time_mult(dow, hour)
                for _ in range(_poisson(rng, lam)):
                    at = datetime.combine(day, time(hour, rng.randrange(60)))
                    out.append(CrashRecord(p.segment_id, at))
        return out

    def speed_observations(self, day: date) -> list[SpeedObservation]:
        rng = self._rng(day, "speed")
        weekend = day.weekday() >= 5
        day_intensity = max(0.7, rng.gauss(1.0, 0.08))

        # Each crash slows its segment for 45-90 minutes, fading out.
        incident: dict[tuple[str, int], float] = {}
        for c in self.crashes(day):
            start = (c.at.hour * 60 + c.at.minute) // SLOT_MINUTES
            length = rng.randint(3, 6)
            for k in range(length):
                key = (c.segment_id, start + k)
                incident[key] = incident.get(key, 0.0) + 0.4 * (1 - k / length)

        out = []
        for p in self.profiles:
            for slot in range(SLOTS_PER_DAY):
                r = base_congestion(slot, weekend, p.inbound, p.road_class)
                r = r * p.congestion_mult * day_intensity + rng.gauss(0, 0.03)
                r += incident.get((p.segment_id, slot), 0.0)
                r = min(0.95, max(0.0, r))
                out.append(SpeedObservation(p.segment_id, slot, round(p.free_flow_mph * (1 - r), 2)))
        return out

    def train_events(self, day: date) -> list[TrainEvent]:
        rng = self._rng(day, "train")
        dow = day.weekday()
        midnight = datetime.combine(day, time())
        out = []
        for c in self.crossings:
            for days, start_min, duration, prob in RECURRING_TRAINS.get(c.id, []):
                if dow in days and rng.random() < prob:
                    start = start_min + rng.uniform(-6, 6)
                    dur = duration * rng.uniform(0.75, 1.25)
                    out.append(
                        TrainEvent(
                            c.id,
                            midnight + timedelta(minutes=start),
                            midnight + timedelta(minutes=start + dur),
                        )
                    )
            for _ in range(_poisson(rng, RANDOM_TRAINS_PER_DAY)):
                start = rng.uniform(0, 24 * 60 - 15)
                dur = rng.uniform(4, 14)
                out.append(
                    TrainEvent(c.id, midnight + timedelta(minutes=start), midnight + timedelta(minutes=start + dur))
                )
        return sorted(out, key=lambda e: e.start)
