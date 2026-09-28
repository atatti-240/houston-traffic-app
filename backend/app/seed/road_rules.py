"""Posted speed limits and toll roads per segment, from OpenStreetMap.

scripts/fetch_road_limits.py looks them up (Nominatim) and writes road_limits.json, with the votes
behind every value; the app only reads that file. A segment with no maxspeed in OpenStreetMap (or
missing from the file) has an unknown limit (None): we never guess one. Toll = most of the
segment's main-lane lookups said toll=yes.
"""

import json
from functools import cache
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import RoadSegment

ROAD_LIMITS = Path(__file__).with_name("road_limits.json")


@cache
def road_limits() -> dict[str, dict]:
    """{segment_id: {"speed_limit_mph": int | None, "toll": bool, ...votes}}; empty without the file."""
    if not ROAD_LIMITS.exists():
        return {}
    return json.loads(ROAD_LIMITS.read_text())["segments"]


def road_rules(segment_id: str) -> dict:
    """The RoadSegment columns for one segment: speed_limit_mph and toll."""
    r = road_limits().get(segment_id, {})
    return {"speed_limit_mph": r.get("speed_limit_mph"), "toll": bool(r.get("toll"))}


def refresh_road_rules(session: Session) -> int:
    """Bring an existing database's speed limits and toll roads up to date with road_limits.json
    (a database seeded before they existed has none). Returns segments changed."""
    changed = 0
    for seg in session.scalars(select(RoadSegment)):
        rules = road_rules(seg.id)
        if (seg.speed_limit_mph, seg.toll) != (rules["speed_limit_mph"], rules["toll"]):
            seg.speed_limit_mph, seg.toll = rules["speed_limit_mph"], rules["toll"]
            changed += 1
    session.commit()
    return changed
