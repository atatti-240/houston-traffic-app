"""Bridge to the team's computer-vision app (blindspot-cv): live video, vehicle boxes, incidents.

The CV app runs as its own process (on an Apple-silicon Mac for the incident check, or anywhere
without it) and streams what it sees as Server-Sent Events on GET <CV_URL>/live:

    {"updates": [{"cam": "007", "kind": "raw" | "yolo" | "incident", "jpeg": base64 | null, "info": {...}}]}

- raw: a video frame; info {status, fps, reconnects}
- yolo: vehicle boxes for a frame; info {stats, dets, rate, avg_60s, peak_60s, median_mph_60s}, where
  dets are [x1, y1, x2, y2 (fractions of the frame), class, confidence, mph or null]
- incident: the latest incident check; info {p, state: confirmed | possible | clear, text, at, recent}

CvBridge keeps one background thread on that stream (reconnecting with backoff) and, per CV camera,
the last few seconds of frames, recent detections, the stream status and the incident state. All
of it is bounded and read under one short lock with no I/O, so a slow or missing CV app never
holds up the API. A second thread tells the CV app which camera to process (CV_VIEW) and notices
when the set of confirmed incidents changes.

The Baton Rouge cameras stand in for Houston cameras (CV_CAMERAS maps them) until Houston live
video is available, and every response says so.
"""

import base64
import binascii
import json
import logging
import re
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

import httpx

log = logging.getLogger("houston.cv")

FRAME_KEEP_S = 8.0  # video kept per camera (the stream plays a few seconds behind, see video_delay_s)
MAX_FRAMES = 120
MAX_FRAME_BYTES = 2_000_000
DET_KEEP_S = 12.0
MAX_DETECTIONS = 40
MAX_BOXES = 300
MAX_CAMERAS = 32  # CV cameras we keep state for; only mapped ones keep video
MAX_EVENT_CHARS = 16_000_000
LIVE_WITHIN_S = 10.0  # a camera is live while frames keep arriving this often
INCIDENT_FRESH_S = 60.0  # an incident check older than this no longer describes the camera
INCIDENT_STALE_S = 600.0  # a confirmed incident we stop hearing about is dropped after this
# A detection reaches us about (inference time + 80 ms) after its frame (measured on the live
# stream); we pair it with the buffered frame closest to that, if one is this close.
DETECTION_LAG_S = 0.08
SNAP_S = 0.3
WATCH_S = 20.0  # a camera counts as watched for this long after its last request
VIEW_GAP_S = 2.0  # at most one view change this often
BACKOFF_S = (1, 2, 5, 10, 30)
READ_TIMEOUT_S = 30.0  # the CV app sends a keepalive every 15 s when nothing changes

STAND_IN = (
    "Baton Rouge (Louisiana DOTD) live video, standing in for this Houston camera until Houston live "
    "video is available"
)
# From the captions burned into the streams (the CV app's page names them too; this is the fallback)
LA_CAMERA_NAMES = {
    "001": "I-12 @ Drusilla Ln",
    "007": "I-10 @ College Dr",
    "009": "I-10 at Perkins",
    "011": "I-10/I-110",
    "015": "I-10 at LA1",
    "019": "I-10 at Essen EB",
    "021": "I-10 at Picardy",
    "025": "US 61 at Goodwood",
}
VIEW_MODES = ("follow", "all", "off")

# The CV app's page defines these as one-line JSON constants.
PAGE_CONST = re.compile(r"^\s*const (LIVE_CAMERAS|INCIDENTS|VIEW|SERVER) = (.+?);\s*(?://.*)?$", re.M)


def parse_page(html: str) -> dict:
    """LIVE_CAMERAS, INCIDENTS, VIEW (and SERVER, set by the fake CV server) from the CV app's page."""
    out = {}
    for m in PAGE_CONST.finditer(html):
        try:
            out[m.group(1)] = json.loads(m.group(2))
        except ValueError:
            continue
    return out


def parse_mapping(spec: str, cameras: dict[str, dict]) -> tuple[dict[str, str], list[str]]:
    """"007=cam_a,009=cam_b" -> ({CV camera: our camera id}, problems). Our ids must exist, and
    each camera is used once."""
    mapping: dict[str, str] = {}
    problems: list[str] = []
    for part in spec.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        cv, sep, ours = part.partition("=")
        cv, ours = cv.strip().removeprefix("br:"), ours.strip()
        if not sep or not cv or not ours:
            problems.append(f"can't read {part!r}: use <CV camera>=<our camera id>")
        elif ours not in cameras:
            problems.append(f"{part}: there's no camera {ours!r} (see GET /cameras)")
        elif cv in mapping or ours in mapping.values():
            problems.append(f"{part}: a camera can only be mapped once")
        else:
            mapping[cv] = ours
    return mapping, problems


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v else None


def _text(v, limit: int = 300) -> str | None:
    if not isinstance(v, str):
        return None
    v = " ".join(v.split())
    return v[:limit] or None


def _jpeg(b64) -> bytes | None:
    if not isinstance(b64, str) or len(b64) > MAX_FRAME_BYTES * 4 // 3 + 4:
        return None
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        return None
    return data if data[:2] == b"\xff\xd8" else None


def _box(d) -> list | None:
    """[x1, y1, x2, y2, class, confidence, mph or None] with coordinates clamped to the frame."""
    if not isinstance(d, (list, tuple)) or len(d) < 6:
        return None
    xy = [_num(v) for v in d[:4]]
    conf = _num(d[5])
    if None in xy or conf is None or not isinstance(d[4], str):
        return None
    x1, y1, x2, y2 = (min(1.0, max(0.0, v)) for v in xy)
    if x2 <= x1 or y2 <= y1:
        return None
    mph = _num(d[6]) if len(d) > 6 else None
    return [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4), d[4][:20], round(conf, 2),
            None if mph is None else round(mph, 1)]


def _stats(s: dict) -> dict:
    counts = s.get("counts") if isinstance(s.get("counts"), dict) else {}
    speed = s.get("speed") if isinstance(s.get("speed"), dict) else {}
    return {
        "vehicles": int(_num(s.get("vehicles")) or 0),
        "counts": {str(k)[:20]: int(_num(v) or 0) for k, v in list(counts.items())[:10]},
        "mean_conf": _num(s.get("mean_conf")),
        "inference_ms": _num(s.get("inference_ms")),
        "speed": {
            "median_mph": None if _num(speed.get("median_mph")) is None else round(_num(speed["median_mph"]), 1),
            **{k: int(_num(speed.get(k)) or 0) for k in ("moving", "stopped", "measured")},
        },
    }


def _rolling(info: dict) -> dict:
    """The CV app's rolling numbers over the last 60 s (detections/s, vehicles on average and at
    the peak, median speed of moving vehicles)."""
    out = {k: _num(info.get(k)) for k in ("rate", "avg_60s", "peak_60s", "median_mph_60s")}
    return {k: None if v is None else round(v, 2 if k == "rate" else 1) for k, v in out.items()}


def flow_of(stats: dict | None, rolling: dict) -> tuple[str | None, float | None]:
    """flowing / slow / stopped and the rough mph, from the rolling 60 s median speed of moving
    vehicles (the CV app's speeds are +-30% or worse, so only these three words are trusted)."""
    speed = (stats or {}).get("speed") or {}
    measured, stopped = speed.get("measured") or 0, speed.get("stopped") or 0
    if measured >= 3 and stopped / measured >= 0.6:
        return "stopped", None
    mph = rolling.get("median_mph_60s")
    if mph is None:
        mph = speed.get("median_mph")
    if mph is None:
        return None, None
    return ("stopped" if mph < 8 else "slow" if mph < 40 else "flowing"), round(mph)


@dataclass
class Frame:
    t: float  # when it reached us (epoch seconds)
    seq: int
    jpeg: bytes


@dataclass
class Detection:
    t: float  # the frame it was found on (same clock as Frame.t)
    boxes: list


@dataclass(frozen=True)
class CameraIncident:
    """A camera-confirmed incident that's still on (see IncidentWatch)."""

    cv_camera: str
    camera_id: str
    n: int  # episode number on this camera
    started: float  # first confirmed check (epoch seconds)
    checked: float  # latest check
    text: str | None  # the model's one-line description


class IncidentWatch:
    """One camera's confirmed-incident episode. It starts on a confirmed check (the CV app confirms
    when 2 of the camera's last 3 checks flag it) and ends once the camera has seen a clear road
    for `clear_after` seconds, or when its incident check has been silent for INCIDENT_STALE_S
    (the camera was switched off, or the CV app went away). A "possible" check keeps it going."""

    def __init__(self) -> None:
        self.n = 0
        self.started: float | None = None
        self.confirmed_at: float | None = None
        self.clear_since: float | None = None
        self.checked_at: float | None = None
        self.text: str | None = None

    def update(self, state: str, text: str | None, at: float) -> None:
        if self.checked_at is not None and at <= self.checked_at:
            return  # the same check again (sent once more after a reconnect)
        self.checked_at = at
        if state == "confirmed":
            if self.started is None:
                self.started, self.text = at, None
                self.n += 1
            self.confirmed_at, self.clear_since = at, None
            self.text = text or self.text
        elif self.started is not None:
            if state == "possible":
                self.clear_since = None
            elif self.clear_since is None:
                self.clear_since = at

    def active(self, now: float, clear_after: float) -> bool:
        if self.started is None or self.checked_at is None:
            return False
        cleared = self.clear_since is not None and now - self.clear_since >= clear_after
        if cleared or now - self.checked_at >= INCIDENT_STALE_S:
            self.started = self.confirmed_at = self.clear_since = self.text = None
            return False
        return True


class FeedCamera:
    """Everything we know about one of the CV app's cameras."""

    def __init__(self, cv_id: str, keep_video: bool) -> None:
        self.cv_id = cv_id
        self.keep_video = keep_video
        self.frames: deque[Frame] = deque(maxlen=MAX_FRAMES)
        self.seq = 0
        self.status = "unknown"  # the CV app's: live, connecting, reconnecting, paused
        self.fps: float | None = None
        self.reconnects = 0
        self.frame_at: float | None = None
        self.detections: deque[Detection] = deque(maxlen=MAX_DETECTIONS)
        self.stats: dict | None = None
        self.rolling: dict = {}
        self.model: str | None = None
        self.det_at: float | None = None
        self.det_error: str | None = None
        self.incident: dict | None = None
        self.incident_error: str | None = None
        self.watch = IncidentWatch()


class CvBridge:
    """Live state of the CV app's cameras, mapped onto our cameras. Thread-safe."""

    def __init__(
        self,
        url: str,
        cameras: dict[str, dict],
        mapping: str,
        view_mode: str = "follow",
        video_delay_s: float = 2.5,
        clear_after_s: float = 120.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        """cameras: our camera catalog, {id: {"name", "segment_id", ...}}."""
        self.url = url.rstrip("/")
        self.cameras = cameras
        self.mapping, self.problems = parse_mapping(mapping, cameras)  # CV camera -> our camera
        self.by_camera = {ours: cv for cv, ours in self.mapping.items()}
        if view_mode not in VIEW_MODES:
            self.problems.append(f"CV_VIEW={view_mode!r} isn't one of {', '.join(VIEW_MODES)}; using follow")
            view_mode = "follow"
        self.view_mode = view_mode
        self.video_delay_s = max(0.0, video_delay_s)
        self.clear_after_s = max(0.0, clear_after_s)
        self._transport = transport
        self._lock = threading.Lock()
        self._feeds: dict[str, FeedCamera] = {}
        self._page: dict = {}
        self.connected = False
        self.connected_at: float | None = None
        self.last_message_at: float | None = None
        self.error: str | None = None
        self._watched: dict[str, float] = {}
        self._view_set: tuple[str, str | None] | None = None
        self._view_dirty = True
        self._view_at = float("-inf")
        self.view_error: str | None = None
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._response: httpx.Response | None = None
        self.on_incidents_changed: Callable[[], None] | None = None
        self._incidents_key = ""

    # --- the stream ----------------------------------------------------------------------------

    def handle_message(self, msg, now: float | None = None) -> int:
        """Apply one /live message. Returns how many updates it used (bad ones are skipped)."""
        now = time.time() if now is None else now
        updates = msg.get("updates") if isinstance(msg, dict) else None
        if not isinstance(updates, list):
            return 0
        used = 0
        with self._lock:
            self.last_message_at = now
            for u in updates:
                used += self._apply(u, now)
        return used

    def _apply(self, u, now: float) -> bool:
        if not isinstance(u, dict):
            return False
        cam, kind, info = u.get("cam"), u.get("kind"), u.get("info")
        if not isinstance(cam, str) or not 0 < len(cam) <= 40 or not isinstance(info, dict):
            return False
        feed = self._feeds.get(cam)
        if feed is None:
            if len(self._feeds) >= MAX_CAMERAS and cam not in self.mapping:
                return False
            feed = self._feeds[cam] = FeedCamera(cam, keep_video=cam in self.mapping)
        if kind == "raw":
            self._raw(feed, u.get("jpeg"), info, now)
        elif kind == "yolo":
            self._detections(feed, info, now)
        elif kind == "incident":
            self._incident(feed, info, now)
        else:
            return False
        return True

    def _raw(self, feed: FeedCamera, b64, info: dict, now: float) -> None:
        if isinstance(info.get("status"), str):
            feed.status = info["status"][:20]
        if _num(info.get("fps")) is not None:
            feed.fps = round(_num(info.get("fps")), 1)
        if _num(info.get("reconnects")) is not None:
            feed.reconnects = int(_num(info.get("reconnects")))
        if feed.status != "live":
            return
        data = _jpeg(b64)
        if data is None:
            return
        feed.frame_at = now
        if feed.keep_video:
            feed.seq += 1
            feed.frames.append(Frame(now, feed.seq, data))
            while feed.frames and feed.frames[0].t < now - FRAME_KEEP_S:
                feed.frames.popleft()

    def _detections(self, feed: FeedCamera, info: dict, now: float) -> None:
        if info.get("error"):
            feed.det_error = _text(info["error"], 200)
            return
        stats, dets = info.get("stats"), info.get("dets")
        if not isinstance(stats, dict) or not isinstance(dets, list):
            return
        feed.stats = _stats(stats)
        feed.rolling = _rolling(info)
        feed.model = _text(info.get("model"), 60) or feed.model
        feed.det_at, feed.det_error = now, None
        boxes = [b for b in (_box(d) for d in dets[:MAX_BOXES]) if b]
        # Which frame these boxes belong to: the one shown about (inference time + lag) ago.
        t = now - min(feed.stats["inference_ms"] or 0.0, 5000.0) / 1000 - DETECTION_LAG_S
        near = min(feed.frames, key=lambda f: abs(f.t - t), default=None)
        if near is not None and abs(near.t - t) <= SNAP_S:
            t = near.t
        feed.detections.append(Detection(t, boxes))
        while feed.detections and feed.detections[0].t < now - DET_KEEP_S:
            feed.detections.popleft()

    def _incident(self, feed: FeedCamera, info: dict, now: float) -> None:
        if info.get("error"):
            feed.incident_error = _text(info["error"], 200)
            return
        p, state = _num(info.get("p")), info.get("state")
        if p is None or state not in ("confirmed", "possible", "clear"):
            return
        at = _num(info.get("at"))
        # The check's own time (a reconnect replays the last one, however old); clocks a day off: now.
        checked = now if at is None or abs(at - now) > 86400 else min(at, now)
        recent = info.get("recent") if isinstance(info.get("recent"), list) else []
        feed.incident = {
            "p": round(max(0.0, min(1.0, p)), 3),
            "state": state,
            "text": _text(info.get("text")),
            "checked": checked,
            "recent": [round(x, 2) for x in (_num(v) for v in recent[-5:]) if x is not None],
            "model": _text(info.get("model"), 60),
        }
        feed.incident_error = None
        feed.watch.update(state, feed.incident["text"], checked)

    # --- the page (camera names, whether the incident check is on) --------------------------------

    def handle_page(self, html: str) -> None:
        page = parse_page(html)
        if page:
            with self._lock:
                self._page = page

    def _available(self) -> set[str] | None:
        cams = self._page.get("LIVE_CAMERAS")
        if not isinstance(cams, list):
            return None
        return {str(c.get("id")) for c in cams if isinstance(c, dict) and c.get("id") is not None}

    def _page_camera(self, cv_id: str) -> dict:
        for c in self._page.get("LIVE_CAMERAS") or []:
            if isinstance(c, dict) and str(c.get("id")) == cv_id:
                return c
        return {}

    @property
    def test_server(self) -> bool:
        server = self._page.get("SERVER")
        return isinstance(server, dict) and bool(server.get("fake"))

    def _incident_model(self) -> str | None | bool:
        """The incident model's name, False when the CV app runs without it, None when unknown."""
        inc = self._page.get("INCIDENTS")
        if not isinstance(inc, dict):
            return None
        return _text(inc.get("model"), 60) or False

    # --- reading it (API side) -------------------------------------------------------------------

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def touch(self, camera_id: str, now: float | None = None) -> None:
        """Someone is watching this camera (CV_VIEW=follow switches the CV app to it)."""
        if camera_id in self.by_camera:
            with self._lock:
                self._watched[camera_id] = time.time() if now is None else now

    def _status(self, cv_id: str, feed: FeedCamera | None, now: float) -> str:
        """live / connecting / paused (the CV app is on another camera) / missing / offline."""
        if not self.connected:
            return "offline"
        available = self._available()
        if available is not None and cv_id not in available:
            return "missing"
        if feed is None:
            return "connecting"
        if feed.status == "live" and feed.frame_at is not None and now - feed.frame_at <= LIVE_WITHIN_S:
            return "live"
        # Paused, but it's what we asked for (or are about to): the CV app is starting it.
        watched = max(((t, cam) for cam, t in self._watched.items() if now - t <= WATCH_S), default=(0, None))[1]
        asked = (
            self.view_mode == "all"
            or (self._view_set is not None and self._view_set[1] == cv_id)
            or (self.view_mode == "follow" and watched is not None and self.by_camera[watched] == cv_id)
        )
        return "paused" if feed.status == "paused" and not asked else "connecting"

    def _incident_json(self, feed: FeedCamera | None, now: float) -> dict:
        model = self._incident_model()
        episode = feed is not None and feed.watch.active(now, self.clear_after_s)
        inc = feed.incident if feed else None
        if episode:
            w = feed.watch
            return {
                "state": "confirmed",
                "p": inc["p"] if inc else None,
                "text": w.text,
                "since_s": round(now - w.started),
                "checked_s": round(now - w.checked_at),
                # Confirmed earlier, but the latest checks see a clear road: it clears if that lasts.
                "clearing": inc is not None and inc["state"] == "clear",
                "affects_routing": True,
            }
        if feed is not None and feed.incident_error:
            return {"state": "error", "error": feed.incident_error, "affects_routing": False}
        if inc is None or now - inc["checked"] > INCIDENT_FRESH_S:
            return {"state": "off" if model is False else "waiting", "affects_routing": False}
        return {
            "state": inc["state"] if inc["state"] != "confirmed" else "possible",
            "p": inc["p"],
            "text": inc["text"],
            "checked_s": round(now - inc["checked"]),
            "affects_routing": False,
        }

    def _summary(self, camera_id: str, now: float) -> dict:
        cv_id = self.by_camera[camera_id]
        feed = self._feeds.get(cv_id)
        page_cam = self._page_camera(cv_id)
        status = self._status(cv_id, feed, now)
        flow, mph = flow_of(feed.stats if feed else None, feed.rolling if feed else {})
        fresh = feed is not None and feed.det_at is not None and now - feed.det_at <= LIVE_WITHIN_S
        replay = bool(page_cam.get("replay"))
        return {
            "status": status,
            "cv_camera": cv_id,
            "source_name": _text(page_cam.get("name"), 80) or LA_CAMERA_NAMES.get(cv_id) or f"Baton Rouge camera {cv_id}",
            "source_place": "Baton Rouge, LA",
            "provider": "Louisiana DOTD",
            "stand_in": True,
            "stand_in_note": STAND_IN,
            # A recording played on a loop (a CV test clip, or the fake CV server's frames), not live video
            "replay": replay or self.test_server,
            "test_server": self.test_server,
            "video_url": f"/cv/cameras/{camera_id}/video",
            "frame_url": f"/cv/cameras/{camera_id}/frame.jpg",
            "vehicles": feed.stats["vehicles"] if fresh and feed.stats else None,
            "flow": flow if fresh else None,
            "mph": mph if fresh else None,
            "incident": self._incident_json(feed, now),
            "age_s": round(now - feed.frame_at, 1) if feed and feed.frame_at else None,
        }

    def summary(self, camera_id: str, now: float | None = None) -> dict | None:
        """The camera's live_feed field (None when it has no live feed)."""
        if not self.enabled or camera_id not in self.by_camera:
            return None
        now = time.time() if now is None else now
        with self._lock:
            return self._summary(camera_id, now)

    def detail(self, camera_id: str, now: float | None = None, since_ms: float | None = None) -> dict | None:
        """Everything the camera card draws: the summary plus counts, rolling numbers and the
        recent vehicle boxes (each with the time of its frame, on the video's clock; only those
        after `since_ms` when given, so a card polling twice a second gets each set once)."""
        if not self.enabled or camera_id not in self.by_camera:
            return None
        now = time.time() if now is None else now
        oldest = max(now - DET_KEEP_S, (since_ms or 0) / 1000)
        with self._lock:
            out = self._summary(camera_id, now)
            feed = self._feeds.get(out["cv_camera"])
            inc = feed.incident if feed else None
            model = self._incident_model()
            out.update(
                camera_id=camera_id,
                camera_name=self.cameras[camera_id].get("name"),
                fps=feed.fps if feed else None,
                reconnects=feed.reconnects if feed else 0,
                stats=feed.stats if feed else None,
                rolling=feed.rolling if feed else {},
                model=feed.model if feed else None,
                detection_error=feed.det_error if feed else None,
                incident_model=model or None,
                incident_check="off" if model is False else "on" if model else "unknown",
                incident_recent=inc["recent"] if inc else [],
                detections=[
                    {"t": round(d.t * 1000), "boxes": d.boxes}
                    for d in (feed.detections if feed else ())
                    if d.t >= oldest and (since_ms is None or round(d.t * 1000) > since_ms)
                ],
                server_time=round(now * 1000),
                video_delay_ms=round(self.video_delay_s * 1000),
                clear_after_s=self.clear_after_s,
            )
            return out

    def frame(self, camera_id: str, at: float | None = None, before: bool = False) -> Frame | None:
        """The newest frame (at=None), the frame nearest `at`, or (before=True) the newest one
        taken at or before `at`."""
        cv_id = self.by_camera.get(camera_id)
        with self._lock:
            feed = self._feeds.get(cv_id) if cv_id else None
            if feed is None or not feed.frames:
                return None
            if at is None:
                return feed.frames[-1]
            if before:
                return next((f for f in reversed(feed.frames) if f.t <= at), None)
            return min(feed.frames, key=lambda f: abs(f.t - at))

    def is_live(self, camera_id: str, now: float | None = None) -> bool:
        cv_id = self.by_camera.get(camera_id)
        if cv_id is None:
            return False
        now = time.time() if now is None else now
        with self._lock:
            return self._status(cv_id, self._feeds.get(cv_id), now) == "live"

    def confirmed(self, now: float | None = None) -> list[CameraIncident]:
        """Camera-confirmed incidents that are still on, on mapped cameras."""
        now = time.time() if now is None else now
        out = []
        with self._lock:
            for cv_id, camera_id in self.mapping.items():
                feed = self._feeds.get(cv_id)
                if feed is not None and feed.watch.active(now, self.clear_after_s):
                    w = feed.watch
                    out.append(CameraIncident(cv_id, camera_id, w.n, w.started, w.checked_at, w.text))
        return out

    def incidents_key(self, now: float | None = None) -> str:
        """Changes whenever a camera-confirmed incident starts, clears or gets a new description."""
        return ";".join(f"{i.cv_camera}:{i.n}:{i.text or ''}" for i in self.confirmed(now))

    def status(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        confirmed = self.confirmed(now)
        with self._lock:
            model = self._incident_model()
            available = self._available()
            watching = max(
                ((t, cam) for cam, t in self._watched.items() if now - t <= WATCH_S), default=(None, None)
            )[1]
            seen = set(self._feeds) | (available or set())
            return {
                "enabled": self.enabled,
                "url": self.url or None,
                "connected": self.connected,
                "error": None if self.connected else self.error,
                "connected_s": round(now - self.connected_at) if self.connected and self.connected_at else None,
                "last_message_s": round(now - self.last_message_at, 1) if self.last_message_at else None,
                "test_server": self.test_server,
                "view": {
                    "mode": self.view_mode,
                    "camera": self._view_set[1] if self._view_set else None,
                    "watching": watching,
                    "error": self.view_error,
                },
                "incident_check": "off" if model is False else "on" if model else "unknown",
                "incident_model": model or None,
                "video_delay_ms": round(self.video_delay_s * 1000),
                "clear_after_s": self.clear_after_s,
                "problems": list(self.problems),
                "cameras": [
                    {
                        "cv_camera": cv_id,
                        "camera_id": camera_id,
                        "camera_name": self.cameras[camera_id].get("name"),
                        "source_name": _text(self._page_camera(cv_id).get("name"), 80) or LA_CAMERA_NAMES.get(cv_id),
                        "status": self._status(cv_id, self._feeds.get(cv_id), now),
                    }
                    for cv_id, camera_id in self.mapping.items()
                ],
                "unmapped": sorted(seen - set(self.mapping)),
                "incidents": [
                    {"cv_camera": i.cv_camera, "camera_id": i.camera_id, "text": i.text, "since_s": round(now - i.started)}
                    for i in confirmed
                ],
                "incidents_key": ";".join(f"{i.cv_camera}:{i.n}:{i.text or ''}" for i in confirmed),
            }

    # --- which camera the CV app processes ---------------------------------------------------------

    def desired_view(self, now: float | None = None) -> tuple[str, str | None] | None:
        """("one", CV camera) / ("all", None), or None to leave the CV app alone.
        follow: the mapped camera someone watched most recently, else the first mapped one (so
        incidents keep being checked on it while nobody's looking)."""
        if self.view_mode == "off" or not self.mapping:
            return None
        if self.view_mode == "all":
            return ("all", None)
        now = time.time() if now is None else now
        with self._lock:
            available = self._available()
            usable = [cv for cv in self.mapping if available is None or cv in available]
            watched = [
                (t, cam) for cam, t in self._watched.items() if now - t <= WATCH_S and self.by_camera[cam] in usable
            ]
        if not usable:
            return None
        return ("one", self.by_camera[max(watched)[1]] if watched else usable[0])

    def sync_view(self, client: httpx.Client, now: float | None = None) -> None:
        now = time.time() if now is None else now
        want = self.desired_view(now)
        if want is None or not self.connected:
            return
        if want == self._view_set and not self._view_dirty:
            return
        if now - self._view_at < VIEW_GAP_S:
            return
        self._view_at = now
        params = {"mode": want[0], **({"cam": f"br:{want[1]}"} if want[1] else {})}
        try:
            r = client.post(f"{self.url}/view", params=params, timeout=5.0)
            r.raise_for_status()
        except httpx.HTTPError as e:
            self.view_error = f"couldn't switch the CV app to {params}: {type(e).__name__}"
            log.warning("CV view change failed: %s", e)
            return
        self._view_set, self._view_dirty, self.view_error = want, False, None

    # --- background threads ---------------------------------------------------------------------

    def _client(self, **kw) -> httpx.Client:
        return httpx.Client(transport=self._transport, headers={"User-Agent": "BlindSpot/1.0 (Houston hackathon app)"}, **kw)

    def read_once(self, client: httpx.Client) -> None:
        """Fetch the page, then follow /live until it ends or fails (raises)."""
        try:
            page = client.get(f"{self.url}/", timeout=5.0)
            if page.status_code == 200:
                self.handle_page(page.text)
        except httpx.HTTPError:
            pass  # names and the incident model are nice to have
        timeout = httpx.Timeout(5.0, read=READ_TIMEOUT_S)
        with client.stream("GET", f"{self.url}/live", timeout=timeout) as r:
            r.raise_for_status()
            if "text/event-stream" not in r.headers.get("content-type", ""):
                raise httpx.HTTPError(f"{self.url}/live isn't an event stream (is CV_URL right?)")
            self._response = r
            with self._lock:
                self.connected, self.connected_at, self.error = True, time.time(), None
                self._view_dirty = True
            log.warning("Connected to the CV app at %s", self.url)
            data: list[str] = []
            size = 0
            for line in r.iter_lines():
                if self._stop.is_set():
                    return
                if line.startswith("data:"):
                    part = line[5:].removeprefix(" ")
                    size += len(part)
                    if size <= MAX_EVENT_CHARS:
                        data.append(part)
                elif not line:
                    if data and size <= MAX_EVENT_CHARS:
                        try:
                            self.handle_message(json.loads("\n".join(data)))
                        except ValueError:
                            log.warning("Skipped a CV message that isn't JSON")
                    data, size = [], 0
                elif line.startswith(":"):
                    with self._lock:
                        self.last_message_at = time.time()
        raise httpx.HTTPError("the CV app closed the stream")

    def _read_forever(self) -> None:
        failures = 0
        with self._client() as client:
            while not self._stop.is_set():
                started = time.time()
                try:
                    self.read_once(client)
                except Exception as e:  # never let the thread die: back off and try again
                    with self._lock:
                        was = self.connected
                        self.connected, self._response = False, None
                        self.error = f"can't reach the CV app at {self.url} ({type(e).__name__}: {e})"[:300]
                    if was:
                        log.warning("Lost the CV app: %s", e)
                if self._stop.is_set():
                    break
                failures = 0 if time.time() - started > 60 else failures + 1
                self._stop.wait(BACKOFF_S[min(failures, len(BACKOFF_S)) - 1] if failures else BACKOFF_S[0])

    def _control_forever(self) -> None:
        with self._client() as client:
            while not self._stop.is_set():
                try:
                    self.sync_view(client)
                    key = self.incidents_key()
                    if key != self._incidents_key:
                        self._incidents_key = key
                        if self.on_incidents_changed:
                            self.on_incidents_changed()
                except Exception:
                    log.exception("CV view / incident check failed")
                self._stop.wait(0.5)

    def start(self) -> None:
        if not self.enabled or self._threads:
            return
        for target in (self._read_forever, self._control_forever):
            t = threading.Thread(target=target, name=f"cv-{target.__name__.strip('_')}", daemon=True)
            t.start()
            self._threads.append(t)
        mapped = ", ".join(f"{cv} -> {cam}" for cv, cam in self.mapping.items()) or "nothing"
        log.warning("Live AI camera feeds from %s (view: %s; mapped: %s)", self.url, self.view_mode, mapped)
        for p in self.problems:
            log.warning("CV_CAMERAS / CV_VIEW: %s", p)

    def stop(self) -> None:
        self._stop.set()
        r = self._response
        if r is not None:
            try:
                r.close()
            except Exception:
                pass


def build_bridge(settings, session_factory) -> CvBridge | None:
    """The bridge for CV_URL, or None when it's not set."""
    if not settings.cv_url:
        return None
    from sqlalchemy import select

    from app.models import Camera

    with session_factory() as s:
        cameras = {
            c.id: {"name": c.name, "kind": c.kind, "segment_id": c.segment_id, "crossing_id": c.crossing_id}
            for c in s.scalars(select(Camera))
        }
    return CvBridge(
        settings.cv_url,
        cameras,
        settings.cv_cameras,
        settings.cv_view,
        settings.cv_video_delay_s,
        settings.cv_clear_after_s,
    )
