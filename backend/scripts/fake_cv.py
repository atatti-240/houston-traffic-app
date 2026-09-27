#!/usr/bin/env python3
"""A stand-in for the team's CV app (blindspot-cv), for tests and for demos without it or without a Mac.

It serves what BlindSpot's bridge reads from the real app: GET / (a page naming the cameras),
GET /live (Server-Sent Events with video frames, vehicle boxes and incident checks, same format)
and POST /view (which camera runs). The video is a short loop of real frames recorded from the
Baton Rouge I-10 @ College Dr stream through the CV app, each with the boxes and rough speeds its
detector found (scripts/fake_cv_frames/). The incident is scripted: nothing in those frames is an
incident, and the page says it's a test server, so BlindSpot labels it that way.

    uv run python scripts/fake_cv.py                          # on :8500, no incident
    uv run python scripts/fake_cv.py --incident-after 20      # possible at 20 s, confirmed 4 s later,
                                                              # the camera sees a clear road again 90 s after that
    curl -X POST localhost:8500/incident                      # start the scripted incident now
    curl -X POST 'localhost:8500/incident?clear=1'            # ... or end it now

Standard library only.
"""

import argparse
import base64
import json
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from statistics import median
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
INCIDENT_ALERT = 0.7  # same rule as the CV app: one check over the line is possible,
CONFIRM = (2, 3)  # 2 of the last 3 is confirmed
DETECTION_LAG_S = 0.3  # boxes arrive this long after their frame, like a real detector
TEXT = "Two cars have collided and are stopped in the right lane, near the bottom right of the picture."


def incident_state(recent: list[float]) -> str:
    need, of = CONFIRM
    if sum(p >= INCIDENT_ALERT for p in recent[-of:]) >= need:
        return "confirmed"
    return "possible" if recent and recent[-1] >= INCIDENT_ALERT else "clear"


class Hub:
    """Latest (version, base64 JPEG, info) per (camera, kind); each client gets what changed."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._slots: dict[tuple[str, str], tuple[int, str | None, dict]] = {}

    def put(self, cam: str, kind: str, jpeg: bytes | None = None, **info) -> None:
        with self._lock:
            version, old, _ = self._slots.get((cam, kind), (0, None, None))
            b64 = base64.b64encode(jpeg).decode() if jpeg is not None else old
            self._slots[(cam, kind)] = (version + 1, b64, info)

    def changed_since(self, seen: dict) -> dict:
        with self._lock:
            return {k: v for k, v in self._slots.items() if seen.get(k) != v[0]}


class Script:
    """The scripted incident: p(incident) per check, by how long it has been going."""

    def __init__(self, cam: str, after: float | None, lasts: float, text: str) -> None:
        self.cam = cam
        self.start = None if after is None else time.time() + after
        self.lasts, self.text = lasts, text
        self._lock = threading.Lock()

    def trigger(self, clear: bool = False) -> None:
        with self._lock:
            self.start = (time.time() - self.lasts - 1) if clear else time.time()

    def p(self, cam: str, now: float, k: int) -> float:
        with self._lock:
            start = self.start
        if cam != self.cam or start is None or now < start or now >= start + self.lasts:
            return (0.02, 0.05, 0.03, 0.08)[k % 4]  # a normal road
        return (0.84, 0.91, 0.88, 0.93)[k % 4]


class FakeCamera:
    def __init__(self, cam: str, frames: list[dict], offset: int) -> None:
        self.id, self.frames, self.i = cam, frames, offset % len(frames)
        self.on_since: float | None = None
        self.recent: deque[float] = deque(maxlen=5)
        self.window: deque[tuple[float, int, list[float]]] = deque()  # last 60 s: (t, vehicles, moving mph)
        self.checks = 0


def run_cameras(cams: list[FakeCamera], hub: Hub, view: dict, script: Script, fps: float, det_fps: float,
                every: float, incidents: bool) -> None:
    last_raw = last_det = last_check = 0.0
    pending: list[tuple[float, FakeCamera, dict]] = []  # boxes waiting for their DETECTION_LAG_S
    while True:
        now = time.time()
        for cam in cams:
            on = view["mode"] == "all" or view["active"] == f"br:{cam.id}"
            if not on:
                if cam.on_since is not None:
                    cam.on_since = None
                    cam.recent.clear()
                    hub.put(cam.id, "raw", status="paused", fps=0, reconnects=0)
                continue
            if cam.on_since is None:
                cam.on_since = now
                hub.put(cam.id, "raw", status="connecting", fps=0, reconnects=0)
        live = [c for c in cams if c.on_since is not None and now - c.on_since >= 1.0]  # a second to "connect"
        if now - last_raw >= 1 / fps:
            last_raw = now
            for cam in live:
                cam.i = (cam.i + 1) % len(cam.frames)
                f = cam.frames[cam.i]
                hub.put(cam.id, "raw", f["jpeg"], status="live", fps=round(fps, 1), reconnects=0)
                if now - last_det >= 1 / det_fps - 0.02:
                    pending.append((now + DETECTION_LAG_S, cam, f))
            if live and now - last_det >= 1 / det_fps - 0.02:
                last_det = now
        for due, cam, f in [p for p in pending if p[0] <= now]:
            pending.remove((due, cam, f))
            moving = [d[6] for d in f["dets"] if (d[6] or 0) >= 3]
            cam.window.append((now, f["stats"]["vehicles"], moving))
            while cam.window and cam.window[0][0] < now - 60:
                cam.window.popleft()
            counts = [v for _, v, _ in cam.window]
            speeds = [s for _, _, m in cam.window for s in m]
            # inference_ms tells the bridge how long ago the frame was (it pairs the boxes with it)
            stats = {**f["stats"], "inference_ms": round((DETECTION_LAG_S - 0.08) * 1000)}
            hub.put(cam.id, "yolo", stats=stats, dets=f["dets"], model="YOLO11s HD (recorded)", avg_ms=stats["inference_ms"],
                    rate=det_fps, avg_60s=sum(counts) / len(counts), peak_60s=max(counts),
                    median_mph_60s=median(speeds) if speeds else None, speed_samples_60s=len(speeds))
        if incidents and now - last_check >= every:
            last_check = now
            for cam in live:
                p = script.p(cam.id, now, cam.checks)
                cam.checks += 1
                cam.recent.append(p)
                recent = list(cam.recent)
                hub.put(cam.id, "incident", p=p, state=incident_state(recent),
                        text=script.text if p >= INCIDENT_ALERT else None, at=now, ms=900.0,
                        model="scripted test incident", frames=4, recent=recent)
        time.sleep(0.01)


def page(cams: list[FakeCamera], view: dict, incidents: bool, meta: dict) -> bytes:
    # Every camera plays the same recording, so each is named after the camera it was recorded from.
    live = [{"id": c.id, "key": f"br:{c.id}", "name": meta.get("name") or "Baton Rouge recording", "replay": True,
             "expect": None} for c in cams]
    inc = {"model": "scripted test incident" if incidents else None, "alert": INCIDENT_ALERT, "confirm": list(CONFIRM)}
    server = {"fake": True, "recorded": meta.get("name"), "note": meta.get("note")}
    return (
        "<!doctype html><title>Fake CV server</title>\n<script>\n"
        f"const VIEW = {json.dumps(view)};\n"
        f"const LIVE_CAMERAS = {json.dumps(live)};\n"
        f"const INCIDENTS = {json.dumps(inc)};\n"
        f"const SERVER = {json.dumps(server)};\n"
        "</script>\n<p>Fake CV server for BlindSpot: recorded Baton Rouge frames and a scripted incident. "
        "Streams on <a href=/live>/live</a>.</p>\n"
    ).encode()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8500)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--cameras", nargs="+", default=["007", "009"], help="camera ids to serve (all play the recording)")
    ap.add_argument("--frames", type=Path, default=HERE / "fake_cv_frames")
    ap.add_argument("--view", choices=["one", "all"], default="one", help="like the CV app: one camera runs at a time")
    ap.add_argument("--fps", type=float, default=None, help="video frames per second (default: as recorded)")
    ap.add_argument("--det-fps", type=float, default=2.0, help="detections per second")
    ap.add_argument("--every", type=float, default=4.0, help="seconds between incident checks")
    ap.add_argument("--no-incidents", action="store_true", help="act like the CV app without its incident check")
    ap.add_argument("--incident-after", type=float, default=None, metavar="S",
                    help="start the scripted incident S seconds after startup (default: only on POST /incident)")
    ap.add_argument("--incident-for", type=float, default=90.0, metavar="S", help="how long it stays (default 90)")
    ap.add_argument("--incident-text", default=TEXT, help="the model's description while it's flagged")
    ap.add_argument("--incident-cam", default=None, help="which camera sees it (default: the first one)")
    args = ap.parse_args()

    meta = json.loads((args.frames / "frames.json").read_text())
    frames = [{**f, "jpeg": (args.frames / f["file"]).read_bytes()} for f in meta["frames"]]
    cams = [FakeCamera(c, frames, k * len(frames) // 2) for k, c in enumerate(args.cameras)]
    view = {"mode": args.view, "active": f"br:{cams[0].id}"}
    script = Script(args.incident_cam or cams[0].id, args.incident_after, args.incident_for, args.incident_text)
    hub = Hub()
    for cam in cams:
        hub.put(cam.id, "raw", status="paused", fps=0, reconnects=0)  # until it's viewed, like the CV app
    incidents = not args.no_incidents
    threading.Thread(
        target=run_cameras,
        args=(cams, hub, view, script, args.fps or meta.get("fps") or 7.5, args.det_fps, args.every, incidents),
        daemon=True,
    ).start()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/":
                return self._send(200, "text/html; charset=utf-8", page(cams, view, incidents, meta))
            if path != "/live":
                return self._send(404, "text/plain", b"not found")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            seen, last = {}, time.time()
            try:
                while True:
                    changed = hub.changed_since(seen)
                    if changed:
                        updates = [{"cam": c, "kind": k, "jpeg": b64, "info": info} for (c, k), (_, b64, info) in changed.items()]
                        seen.update({key: slot[0] for key, slot in changed.items()})
                        self.wfile.write(f"data: {json.dumps({'updates': updates})}\n\n".encode())
                        self.wfile.flush()
                        last = time.time()
                    elif time.time() - last > 15:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        last = time.time()
                    time.sleep(1 / 25)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self):
            url = urlparse(self.path)
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if url.path == "/view":
                keys = {f"br:{c.id}" for c in cams}
                if q.get("mode") not in (None, "one", "all") or (q.get("cam") and q["cam"] not in keys):
                    return self._send(400, "text/plain", b"unknown view mode or camera")
                view["mode"] = q.get("mode") or view["mode"]
                view["active"] = q.get("cam") or view["active"]
                return self._send(200, "application/json", json.dumps(view).encode())
            if url.path == "/incident":
                script.trigger(clear=q.get("clear") in ("1", "true", "yes"))
                return self._send(200, "application/json", b'{"ok": true}')
            self._send(404, "text/plain", b"not found")

        def _send(self, code, ctype, body):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, fmt, *a):
            pass

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    when = f"in {args.incident_after:g} s" if args.incident_after is not None else "on POST /incident"
    when += f" on camera {script.cam}"
    print(f"Fake CV server on http://{args.host}:{args.port}: cameras {', '.join(c.id for c in cams)} "
          f"replaying {len(frames)} recorded frames; scripted incident {when if incidents else 'off'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
