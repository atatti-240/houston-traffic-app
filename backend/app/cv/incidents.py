"""Camera-confirmed incidents as live incidents on our roads.

When the CV app's incident check confirms something on a camera (2 of its last 3 checks), the
mapped Houston camera's road gets a live incident, like one from TranStar: it slows the road
(and routes go around it), shows up as a cause in "Why it's slow", on the map and in Alerts, with
the camera AI as its source and the model's one-line description. It clears once the camera has
seen a clear road for CV_CLEAR_AFTER_S. Possible (unconfirmed) incidents never get here.

The incident happened in real time, so its times are "that long ago" on the simulated clock too.
"""

import time
from collections.abc import Callable
from datetime import datetime, timedelta

from app.conditions.live import Incident, IncidentKind
from app.cv.bridge import CameraIncident, CvBridge

SOURCE = "camera_ai"

# The model describes crashes, stalled or stopped vehicles, people on foot, wrong-way drivers and
# debris. First match wins, so "a car stopped after a collision" is a crash.
KIND_WORDS: list[tuple[IncidentKind, tuple[str, ...]]] = [
    ("crash", ("crash", "collision", "collided", "wreck", "overturned", "rolled over", "flipped", "accident",
               "damaged", "smoke", "fire")),
    ("stall", ("stalled", "stopped", "stuck", "disabled", "broken down", "broke down", "hazard lights", "stranded",
               "parked")),
    ("hazard", ("debris", "cargo", "spill", "object", "tire", "pedestrian", "person", "people", "walking", "on foot",
                "wrong way", "wrong-way", "animal", "ladder")),
]
TITLES: dict[str, str] = {
    "crash": "Crash spotted by camera AI",
    "stall": "Stalled vehicle spotted by camera AI",
    "hazard": "Hazard spotted by camera AI",
    "other": "Incident spotted by camera AI",
}


def incident_kind(text: str | None) -> IncidentKind:
    words = (text or "").lower()
    return next((kind for kind, keys in KIND_WORDS if any(k in words for k in keys)), "other")


def incident_detail(text: str | None, camera_name: str | None) -> str:
    seen = f"“{text.rstrip('.')}.”" if text else "flagged in 2 of its last 3 checks."
    on = f"On the {camera_name} camera" if camera_name else "On camera"
    return f"{on}: {seen} (Baton Rouge live video standing in for it.)"


class CameraAiIncidents:
    """An IncidentSource-like view of the bridge: active(now) -> Incident list."""

    def __init__(self, bridge: CvBridge, wall: Callable[[], float] = time.time) -> None:
        self.bridge = bridge
        self.wall = wall

    def _segment(self, camera_id: str, network=None) -> str | None:
        cam = self.bridge.cameras.get(camera_id, {})
        if cam.get("segment_id"):
            return cam["segment_id"]
        # A crossing camera: the crossing's road
        if network is not None and cam.get("crossing_id") in network.crossings:
            ids = network.crossings[cam["crossing_id"]].segment_ids
            return ids[0] if ids else None
        return None

    def to_incident(self, ci: CameraIncident, now: datetime, real: float, network=None) -> Incident:
        kind = incident_kind(ci.text)
        name = self.bridge.cameras.get(ci.camera_id, {}).get("name")
        return Incident(
            id=f"cv-{ci.cv_camera}-{ci.n}",
            title=TITLES[kind],
            kind=kind,
            segment_id=self._segment(ci.camera_id, network),
            started_at=now - timedelta(seconds=max(0.0, real - ci.started)),
            source=SOURCE,
            updated_at=now - timedelta(seconds=max(0.0, real - ci.checked)),
            clears_at=None,  # until the camera sees a clear road
            lanes_blocked=1,
            detail=incident_detail(ci.text, name),
        )

    def active(self, now: datetime, network=None) -> list[Incident]:
        real = self.wall()
        return [self.to_incident(ci, now, real, network) for ci in self.bridge.confirmed(real)]
