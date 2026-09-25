"""Time bucket helpers shared by all scoring models.

Congestion and train models: (day_of_week, 15-min slot) -> "d{dow}s{slot}" (672 buckets).
Crash model: (weekday|weekend, hour) -> "wd-h07" / "we-h22" (48 buckets), coarser because
crashes are sparse.
"""

from datetime import datetime

SLOT_MINUTES = 15
SLOTS_PER_DAY = 24 * 60 // SLOT_MINUTES


def slot_of(dt: datetime) -> int:
    return (dt.hour * 60 + dt.minute) // SLOT_MINUTES


def fine_bucket(dt: datetime) -> str:
    return fine_bucket_key(dt.weekday(), slot_of(dt))


def fine_bucket_key(dow: int, slot: int) -> str:
    return f"d{dow}s{slot}"


def crash_bucket(dt: datetime) -> str:
    return crash_bucket_key(dt.weekday() >= 5, dt.hour)


def crash_bucket_key(weekend: bool, hour: int) -> str:
    return f"{'we' if weekend else 'wd'}-h{hour:02d}"
