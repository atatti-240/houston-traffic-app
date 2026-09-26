"""All app times are naive Houston wall-clock times (the simulated clock has no timezone)."""

from datetime import datetime
from zoneinfo import ZoneInfo

HOUSTON = ZoneInfo("America/Chicago")


def to_local_naive(dt: datetime) -> datetime:
    """Aware datetimes (e.g. "...-05:00" or "...Z" from clients) -> naive Houston time."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(HOUSTON).replace(tzinfo=None)


def iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.replace(microsecond=0).isoformat()


def minutes_between(later: datetime, earlier: datetime) -> float:
    return (later - earlier).total_seconds() / 60
