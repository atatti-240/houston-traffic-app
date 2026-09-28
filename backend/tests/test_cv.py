"""Live AI camera feeds: the bridge to the CV app, its endpoints, and camera-confirmed incidents
driving slowdowns, alerts and routing. No network: messages are fed in directly, and the stream
reader and view control run against httpx.MockTransport."""

import base64
import importlib.util
import json
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.cv import bridge as cvb
from app.cv.bridge import CvBridge, IncidentWatch, flow_of, parse_mapping, parse_page
from app.cv.incidents import CameraAiIncidents, incident_kind
from app.main import create_app

FIXTURE = Path(__file__).resolve().parent.parent / "scripts" / "fake_cv_frames"
META = json.loads((FIXTURE / "frames.json").read_text())
FRAMES = [(FIXTURE / f["file"]).read_bytes() for f in META["frames"]]
GULF = "cam_I45S_downtown_gulf_ee"  # 007 stands in for it by default
KATY = "cam_I10W_downtown_i10_610w"  # 009
GULF_ROAD = "I45S:downtown>gulf_ee"
MAPPING = f"007={GULF},009={KATY}"
CRASH_TEXT = "Two cars have collided and are stopped in the right lane."
PAGE = """<script>
const VIEW = {"mode": "one", "active": "tt:624"};                // {mode: "one" | "all", active: ...}
const LIVE_CAMERAS = [{"id": "007", "key": "br:007", "name": "I-10 @ College Dr", "replay": false, "expect": null}, {"id": "009", "key": "br:009", "name": "I-10 at Perkins", "replay": false, "expect": null}];
const INCIDENTS = {"model": "Qwen3-VL 2B", "alert": 0.7, "confirm": [2, 3], "every": 4, "accuracy": "..."};      // {model: ...}
</script>"""


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def raw(cam="007", i=0, status="live"):
    return {"cam": cam, "kind": "raw", "jpeg": b64(FRAMES[i % len(FRAMES)]), "info": {"status": status, "fps": 8.0, "reconnects": 0}}


def yolo(cam="007", i=0, inference_ms=220.0):
    f = META["frames"][i % len(FRAMES)]
    return {
        "cam": cam,
        "kind": "yolo",
        "jpeg": None,
        "info": {"stats": {**f["stats"], "inference_ms": inference_ms}, "dets": f["dets"], "model": "YOLO11s HD",
                 "rate": 1.0, "avg_60s": 24.5, "peak_60s": 31, "median_mph_60s": 13.2},
    }


def incident(cam="007", p=0.05, state="clear", text=None, at=None):
    return {"cam": cam, "kind": "incident", "jpeg": None,
            "info": {"p": p, "state": state, "text": text, "at": at if at is not None else time.time(), "ms": 900,
                     "model": "Qwen3-VL 2B", "frames": 4, "recent": [p]}}


def cameras_of(services) -> dict:
    from sqlalchemy import select

    from app.models import Camera

    with services.session_factory() as s:
        return {c.id: {"name": c.name, "kind": c.kind, "segment_id": c.segment_id, "crossing_id": c.crossing_id}
                for c in s.scalars(select(Camera))}


def make_bridge(cameras, mapping=MAPPING, view="follow", transport=None, connected=True, **kw) -> CvBridge:
    b = CvBridge("http://cv.test", cameras, mapping, view, transport=transport, **kw)
    b.handle_page(PAGE)
    b.connected = connected
    return b


@pytest.fixture
def cams(services):
    return cameras_of(services)


@pytest.fixture
def cv_services(services, cams):
    """The services fixture with a CV bridge (connected, fed by hand)."""
    from app.services import Services

    bridge = make_bridge(cams)
    svc = Services(services.session_factory, clock=services.clock, sources=services.sources, cv=bridge)
    return svc


@pytest.fixture
def client(cv_services):
    with TestClient(create_app(cv_services)) as c:
        yield c


def feed_video(bridge, cam="007", seconds=3.0, fps=8.0, end=None):
    """Frames and boxes as the CV app sends them: boxes arrive (inference + 80 ms) after their frame."""
    end = time.time() if end is None else end
    n = int(seconds * fps)
    t0 = end - seconds
    for k in range(n):
        t = t0 + k / fps
        bridge.handle_message({"updates": [raw(cam, k)]}, now=t)
        if k % 4 == 0 and k + 3 < n:
            bridge.handle_message({"updates": [yolo(cam, k)]}, now=t + 0.3)


def confirm(bridge, cam="007", text=CRASH_TEXT, now=None):
    now = time.time() if now is None else now
    for k, (p, state) in enumerate([(0.86, "possible"), (0.91, "confirmed")]):
        t = now - 4 + 4 * k
        bridge.handle_message({"updates": [incident(cam, p, state, text, at=t)]}, now=t)


# --- parsing -------------------------------------------------------------------------------------


def test_mapping_reads_pairs_and_reports_mistakes(cams):
    mapping, problems = parse_mapping(f" br:007={GULF}; 009 = {KATY} ,", cams)
    assert mapping == {"007": GULF, "009": KATY} and problems == []
    mapping, problems = parse_mapping(f"007={GULF},011=nope,009={GULF},junk", cams)
    assert mapping == {"007": GULF}
    assert len(problems) == 3 and any("nope" in p for p in problems) and any("once" in p for p in problems)


def test_page_constants_are_read_from_the_cv_apps_page():
    page = parse_page(PAGE)
    assert [c["id"] for c in page["LIVE_CAMERAS"]] == ["007", "009"]
    assert page["INCIDENTS"]["model"] == "Qwen3-VL 2B" and page["VIEW"]["mode"] == "one"
    assert parse_page("<html>nothing here</html>") == {}


def test_the_fake_cv_servers_page_reads_the_same_way():
    spec = importlib.util.spec_from_file_location("fake_cv", FIXTURE.parent / "fake_cv.py")
    fake = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fake)
    cams = [fake.FakeCamera("007", [{}], 0)]
    page = parse_page(fake.page(cams, {"mode": "one", "active": "br:007"}, True, META).decode())
    assert page["SERVER"]["fake"] is True and page["LIVE_CAMERAS"][0]["replay"] is True
    assert page["INCIDENTS"]["model"]
    # Same confirmation rule as the CV app: 2 of the last 3 checks at 70%+
    assert [fake.incident_state(r) for r in ([0.1, 0.8], [0.8, 0.9], [0.9, 0.95, 0.1], [0.95, 0.1, 0.2])] == [
        "possible", "confirmed", "confirmed", "clear"]


def test_fixture_is_small_real_frames_with_boxes():
    total = sum(p.stat().st_size for p in FIXTURE.iterdir())
    assert total < 1.5 * 1024 * 1024
    assert len(FRAMES) >= 20 and all(f[:2] == b"\xff\xd8" for f in FRAMES)
    assert all(f["dets"] and f["stats"]["vehicles"] == len(f["dets"]) for f in META["frames"])


def test_incident_kind_from_the_models_description():
    assert incident_kind("Two cars collided in the left lane.") == "crash"
    assert incident_kind("A truck is stopped on the right shoulder with hazard lights on.") == "stall"
    assert incident_kind("Debris is scattered across the middle lanes.") == "hazard"
    assert incident_kind("A person is walking along the freeway.") == "hazard"
    assert incident_kind("Something unusual near the ramp.") == "other"
    assert incident_kind(None) == "other"


def test_flow_words_from_rough_speeds():
    assert flow_of({"speed": {"median_mph": 55, "measured": 8, "stopped": 0}}, {}) == ("flowing", 55)
    assert flow_of({"speed": {"median_mph": 30, "measured": 8, "stopped": 1}}, {"median_mph_60s": 22.4}) == ("slow", 22)
    assert flow_of({"speed": {"median_mph": 20, "measured": 10, "stopped": 7}}, {}) == ("stopped", None)
    assert flow_of({"speed": {"median_mph": None, "measured": 0, "stopped": 0}}, {}) == (None, None)


# --- the bridge's state ------------------------------------------------------------------------------


def test_frames_are_kept_for_mapped_cameras_only_and_bounded(cams):
    b = make_bridge(cams)
    now = 1_000_000.0
    for k in range(300):
        b.handle_message({"updates": [raw("007", k), raw("001", k)]}, now=now + k * 0.05)
    frames = b._feeds["007"].frames
    assert len(frames) <= cvb.MAX_FRAMES and frames[-1].t - frames[0].t <= cvb.FRAME_KEEP_S
    assert not b._feeds["001"].frames  # not mapped: status only
    assert b.frame(GULF).jpeg == FRAMES[299 % len(FRAMES)]
    assert b.summary(GULF, now=now + 15)["status"] == "live"
    assert b.summary(GULF, now=now + 40)["status"] == "connecting"  # frames stopped coming


def test_bad_updates_are_skipped(cams):
    b = make_bridge(cams)
    bad = [None, "x", {"cam": 7, "kind": "raw", "info": {}}, {"cam": "007", "kind": "raw", "jpeg": "!!notb64", "info": {"status": "live"}},
           {"cam": "007", "kind": "raw", "jpeg": b64(b"GIF89a..."), "info": {"status": "live"}},
           {"cam": "007", "kind": "weird", "info": {}}, {"cam": "007", "kind": "yolo", "info": {"stats": "no"}}]
    assert b.handle_message({"updates": bad}) == 3  # the raw ones update the status but add no frame
    assert b.handle_message({"nope": 1}) == 0 and b.handle_message([1, 2]) == 0
    assert b.frame(GULF) is None


def test_numbers_that_arent_finite_are_ignored(cams):
    # Python's json writes (and reads) NaN and Infinity; a huge integer doesn't fit a float
    b = make_bridge(cams)
    frame = b64(FRAMES[0])
    msg = json.loads(
        '{"updates": ['
        f'{{"cam": "007", "kind": "raw", "jpeg": "{frame}", "info": {{"status": "live", "fps": NaN, "reconnects": Infinity}}}},'
        '{"cam": "007", "kind": "yolo", "jpeg": null, "info": {"stats": {"vehicles": Infinity, "counts": {"car": NaN},'
        ' "inference_ms": 1' + "0" * 400 + ', "speed": {"median_mph": Infinity, "moving": 4, "stopped": 0, "measured": 4}},'
        ' "dets": [[0.1, 0.1, Infinity, 0.3, "car", 0.9, 12], [0.1, 0.1, 0.2, 0.3, "car", 0.9, -Infinity]],'
        ' "rate": Infinity, "median_mph_60s": -Infinity}},'
        '{"cam": "007", "kind": "incident", "jpeg": null, "info": {"p": 0.2, "state": "clear", "at": NaN, "recent": [Infinity, 0.2]}}'
        "]}"
    )
    assert b.handle_message(msg) == 3
    d = b.detail(GULF)
    json.dumps(d, allow_nan=False)  # the API can send it
    assert d["status"] == "live" and d["reconnects"] == 0 and d["vehicles"] == 0 and d["flow"] is None
    assert d["detections"][0]["boxes"] == [[0.1, 0.1, 0.2, 0.3, "car", 0.9, None]]
    assert d["incident"]["state"] == "clear" and d["incident_recent"] == [0.2]


def test_one_update_that_fails_doesnt_cost_the_others(cams, monkeypatch):
    b = make_bridge(cams)

    def broken(*a):
        raise RuntimeError("boom")

    monkeypatch.setattr(b, "_detections", broken)
    assert b.handle_message({"updates": [yolo("007", 0), raw("007", 1)]}) == 1
    assert b.frame(GULF).jpeg == FRAMES[1]


def test_paused_cameras_have_no_live_video(cams):
    b = make_bridge(cams)
    b.handle_message({"updates": [raw("009", 0, status="paused")]})
    s = b.summary(KATY)
    assert s["status"] == "paused" and b.frame(KATY) is None
    b.touch(KATY)  # someone opens it: with CV_VIEW=follow the CV app is about to switch to it
    assert b.summary(KATY)["status"] == "connecting"
    off = make_bridge(cams, view="off")
    off.handle_message({"updates": [raw("009", 0, status="paused")]})
    off.touch(KATY)
    assert off.summary(KATY)["status"] == "paused"  # we never switch it: it stays on the other camera
    b.handle_message({"updates": [raw("009", 1, status="connecting")]})
    assert b.summary(KATY)["status"] == "connecting"


def test_boxes_are_paired_with_the_frame_they_were_found_on(cams):
    b = make_bridge(cams)
    now = time.time()
    feed_video(b, end=now)
    d = b.detail(GULF, now=now)
    assert d["detections"]
    for det in d["detections"]:
        frame = b.frame(GULF, det["t"] / 1000)
        i = FRAMES.index(frame.jpeg)
        assert det["boxes"] == META["frames"][i]["dets"]
    assert d["stats"]["vehicles"] > 0 and d["flow"] == "slow" and d["mph"] == 13
    assert d["video_delay_ms"] == 2500 and abs(d["server_time"] - now * 1000) < 2


def test_offline_bridge_says_so(cams):
    b = make_bridge(cams, connected=False)
    s = b.summary(GULF)
    assert s["status"] == "offline" and s["stand_in"] and "Baton Rouge" in s["stand_in_note"]
    assert s["incident"]["state"] == "waiting" and b.status()["connected"] is False
    assert b.summary("cam_x_cullen") is None  # no live feed for unmapped cameras


def test_incident_check_off_on_machines_without_it(cams):
    b = make_bridge(cams)
    b.handle_page(PAGE.replace('"model": "Qwen3-VL 2B"', '"model": null'))
    assert b.summary(GULF)["incident"]["state"] == "off"
    assert b.status()["incident_check"] == "off"


# --- incidents ---------------------------------------------------------------------------------------


def test_possible_incidents_stay_on_the_card(cams):
    b = make_bridge(cams)
    b.handle_message({"updates": [incident("007", 0.82, "possible", "A car may be stopped.")]})
    card = b.summary(GULF)["incident"]
    assert card["state"] == "possible" and card["text"] == "A car may be stopped." and card["affects_routing"] is False
    assert b.confirmed() == []


def test_confirmed_incident_lasts_until_the_camera_stays_clear(cams):
    b = make_bridge(cams, clear_after_s=120)
    t = 2_000_000.0
    confirm(b, now=t)
    (ci,) = b.confirmed(now=t)
    assert ci.camera_id == GULF and ci.text == CRASH_TEXT and ci.n == 1
    # A clear check starts the countdown; a possible one in between restarts it.
    b.handle_message({"updates": [incident("007", 0.1, "clear", at=t + 4)]}, now=t + 4)
    assert b.summary(GULF, now=t + 5)["incident"]["clearing"] is True
    b.handle_message({"updates": [incident("007", 0.8, "possible", "still there", at=t + 60)]}, now=t + 60)
    b.handle_message({"updates": [incident("007", 0.1, "clear", at=t + 64)]}, now=t + 64)
    assert b.confirmed(now=t + 150)  # 86 s of clear road so far
    assert b.confirmed(now=t + 190) == []
    assert b.summary(GULF, now=t + 190)["incident"]["state"] == "waiting"  # latest check is old by now
    # A new one later is a new incident
    confirm(b, now=t + 400)
    assert b.confirmed(now=t + 400)[0].n == 2


def test_a_confirmed_incident_keeps_its_first_description(cams):
    # The model words every check afresh: a new wording mustn't re-plan trips or turn a crash into a stall
    b = make_bridge(cams)
    t = 2_500_000.0
    b.handle_message({"updates": [incident("007", 0.9, "possible", None, at=t - 4)]}, now=t - 4)
    b.handle_message({"updates": [incident("007", 0.6, "confirmed", None, at=t)]}, now=t)  # 2 of 3, latest low
    assert b.confirmed(now=t)[0].text is None
    b.handle_message({"updates": [incident("007", 0.9, "confirmed", CRASH_TEXT, at=t + 4)]}, now=t + 4)
    key = b.incidents_key(now=t + 4)
    assert b.confirmed(now=t + 4)[0].text == CRASH_TEXT and key.endswith(CRASH_TEXT)
    b.handle_message({"updates": [incident("007", 0.9, "confirmed", "A car is stopped on the shoulder.", at=t + 8)]}, now=t + 8)
    (ci,) = b.confirmed(now=t + 8)
    assert ci.text == CRASH_TEXT and b.incidents_key(now=t + 8) == key
    assert b.summary(GULF, now=t + 8)["incident"]["text"] == CRASH_TEXT


def test_confirmed_incident_is_dropped_when_the_camera_goes_quiet(cams):
    b = make_bridge(cams)
    t = 3_000_000.0
    confirm(b, now=t)
    assert b.confirmed(now=t + cvb.INCIDENT_STALE_S - 1)
    assert b.confirmed(now=t + cvb.INCIDENT_STALE_S + 1) == []


def test_a_replayed_old_check_after_reconnecting_changes_nothing():
    w = IncidentWatch()
    w.update("confirmed", "x", 100.0)
    w.update("clear", None, 104.0)
    w.update("confirmed", "x", 100.0)  # the CV app sends its last slot again on reconnect
    assert w.clear_since == 104.0


def test_camera_incident_becomes_a_live_incident_on_the_cameras_road(cams, services):
    b = make_bridge(cams)
    confirm(b)
    (inc,) = CameraAiIncidents(b).active(services.clock.now())
    assert inc.segment_id == GULF_ROAD and inc.kind == "crash" and inc.source == "camera_ai"
    assert inc.title == "Crash spotted by camera AI" and CRASH_TEXT.rstrip(".") in inc.detail
    assert "Baton Rouge" in inc.detail and inc.clears_at is None
    assert inc.started_at <= services.clock.now()


def test_camera_incident_drives_slowdowns_alerts_and_routing(client, cv_services):
    before = client.post("/route", json={"origin": "midtown", "destination": "hobby"}).json()["best"]
    assert GULF_ROAD in [s["id"] for s in before["segments"]]
    confirm(cv_services.cv)

    why = client.get(f"/slowdowns/{GULF_ROAD}").json()
    crash = next(c for c in why["causes"] if c["kind"] == "crash")
    assert crash["source"] == "camera_ai" and crash["title"] == "Crash spotted by camera AI"
    assert CRASH_TEXT.rstrip(".") in crash["detail"]
    assert any(s["id"] == GULF_ROAD and s["kind"] == "crash" for s in client.get("/slowdowns").json()["items"])

    alert = next(a for a in client.get("/traffic-alerts").json()["items"] if a["source"] == "camera_ai")
    assert alert["group"] == "incident" and alert["slowdown_id"] == GULF_ROAD and alert["delay_min"] >= 1

    live = client.get("/live").json()
    assert any(i["source"] == "camera_ai" and i["affects_routing"] for i in live["incidents"])
    cam = next(c for c in live["cameras"] if c["id"] == GULF)
    assert cam["live_feed"]["incident"]["state"] == "confirmed" and "camera AI" in cam["note"]

    after = client.post("/route", json={"origin": "midtown", "destination": "hobby"}).json()["best"]
    assert GULF_ROAD not in [s["id"] for s in after["segments"]]
    assert any("Rerouted around I-45 Gulf Fwy" in r and "camera AI" in r for r in after["reasons"])


def test_possible_incident_never_reaches_routing(client, cv_services):
    cv_services.cv.handle_message({"updates": [incident("007", 0.83, "possible", CRASH_TEXT)]})
    assert not any(a["source"] == "camera_ai" for a in client.get("/traffic-alerts").json()["items"])
    assert not client.get("/live").json()["incidents"]
    why = client.get(f"/slowdowns/{GULF_ROAD}").json()
    assert all(c["source"] != "camera_ai" for c in why["causes"])


def test_the_demo_reset_leaves_camera_incidents_alone(client, cv_services):
    confirm(cv_services.cv)
    client.post("/demo/clear-live")
    assert any(a["source"] == "camera_ai" for a in client.get("/traffic-alerts").json()["items"])


# --- endpoints ---------------------------------------------------------------------------------------


def test_status_endpoint(client, cv_services):
    confirm(cv_services.cv)
    st = client.get("/cv/status").json()
    assert st["enabled"] and st["connected"] and st["incident_check"] == "on"
    assert {c["cv_camera"]: c["camera_id"] for c in st["cameras"]} == {"007": GULF, "009": KATY}
    assert st["incidents"][0]["camera_id"] == GULF and st["incidents_key"].startswith("007:1:")


def test_camera_endpoints(client, cv_services, monkeypatch):
    feed_video(cv_services.cv)
    d = client.get(f"/cv/cameras/{GULF}").json()
    assert d["status"] == "live" and d["source_name"] == "I-10 @ College Dr" and d["stand_in"]
    assert d["detections"] and d["stats"]["counts"] and d["video_url"].endswith("/video")
    ts = [x["t"] for x in d["detections"]]
    newer = client.get(f"/cv/cameras/{GULF}", params={"since": ts[-2]}).json()["detections"]
    assert [x["t"] for x in newer] == ts[-1:]  # only box sets the card doesn't have yet
    client.get(f"/cv/cameras/{KATY}")
    assert cv_services.cv.desired_view() == ("one", "009")  # watching a camera switches the CV app to it

    r = client.get(f"/cv/cameras/{GULF}/frame.jpg")
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg" and r.content[:2] == b"\xff\xd8"
    t = d["detections"][0]["t"]
    assert client.get(f"/cv/cameras/{GULF}/frame.jpg", params={"at": t}).content in FRAMES

    # MJPEG: frames from a few seconds back; the stream ends by itself here (short limit)
    monkeypatch.setattr("app.api.cv.MAX_STREAM_S", 0.5)
    cv_services.cv.video_delay_s = 1.0
    r = client.get(f"/cv/cameras/{GULF}/video")
    assert r.status_code == 200 and r.headers["content-type"].startswith("multipart/x-mixed-replace; boundary=frame")
    assert r.content.startswith(b"--frame\r\nContent-Type: image/jpeg\r\n") and r.content.count(b"--frame\r\n") >= 1

    # Told to stop: open streams end right away (uvicorn waits for them before shutting down)
    monkeypatch.setattr("app.api.cv.MAX_STREAM_S", 60)
    monkeypatch.setattr("app.api.cv.CLOSING", type("Set", (), {"is_set": lambda self: True})())
    assert client.get(f"/cv/cameras/{GULF}/video").content == b""

    assert client.get(f"/cv/cameras/{KATY}/video").status_code == 503  # not live
    assert client.get(f"/cv/cameras/{KATY}/frame.jpg").status_code == 503
    assert client.get("/cv/cameras/cam_x_cullen").status_code == 404  # no feed mapped
    assert client.get("/cv/cameras/nope").status_code == 404


def test_open_videos_are_capped(client, cv_services, monkeypatch):
    from app.api import cv as cv_api

    feed_video(cv_services.cv)
    monkeypatch.setitem(cv_api.OPEN, "streams", cv_api.MAX_STREAMS)
    assert client.get(f"/cv/cameras/{GULF}/video").status_code == 503
    monkeypatch.setitem(cv_api.OPEN, "streams", 0)
    monkeypatch.setattr(cv_api, "MAX_STREAM_S", 0.3)
    assert client.get(f"/cv/cameras/{GULF}/video").status_code == 200
    assert cv_api.OPEN["streams"] == 0  # counted while open only


def test_camera_lists_carry_live_feed(client, cv_services):
    feed_video(cv_services.cv)
    by_id = {c["id"]: c for c in client.get("/cameras").json()}
    assert by_id[GULF]["live_feed"]["status"] == "live" and by_id["cam_x_cullen"]["live_feed"] is None
    live = {c["id"]: c for c in client.get("/live").json()["cameras"]}
    assert live[GULF]["live_feed"]["vehicles"] > 0 and live[KATY]["live_feed"]["status"] == "connecting"
    assert live[GULF]["vehicles"] is None  # Houston counts stay Houston-only


def test_without_cv_url_everything_says_off(services):
    with TestClient(create_app(services)) as c:
        st = c.get("/cv/status").json()
        assert st["enabled"] is False and "CV_URL" in st["error"]
        assert c.get(f"/cv/cameras/{GULF}").status_code == 404
        assert all(cam["live_feed"] is None for cam in c.get("/cameras").json())
        assert all(cam["live_feed"] is None for cam in c.get("/live").json()["cameras"])


# --- the stream reader and view control (mock transport) ----------------------------------------


def sse(*messages) -> bytes:
    return b"".join(b": keepalive\n\n" + f"data: {json.dumps(m)}\n\n".encode() for m in messages)


def test_reader_follows_the_stream_until_it_ends(cams):
    body = sse({"updates": [raw("007", 0), yolo("007", 0)]}, {"updates": [incident("007", 0.9, "possible", "hm")]})

    def handler(request: httpx.Request):
        if request.url.path == "/":
            return httpx.Response(200, text=PAGE)
        if request.url.path == "/live":
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=body)
        return httpx.Response(404)

    b = CvBridge("http://cv.test", cams, MAPPING, transport=httpx.MockTransport(handler))
    with b._client() as client, pytest.raises(httpx.HTTPError, match="closed the stream"):
        b.read_once(client)
    assert b.frame(GULF) is not None and b.summary(GULF)["incident"]["state"] == "possible"
    assert b.status()["incident_model"] == "Qwen3-VL 2B"


def test_reader_rejects_something_that_isnt_the_cv_app(cams):
    transport = httpx.MockTransport(lambda r: httpx.Response(200, text="<html>hi</html>"))
    b = CvBridge("http://cv.test", cams, MAPPING, transport=transport)
    with b._client() as client, pytest.raises(httpx.HTTPError, match="event stream"):
        b.read_once(client)
    down = CvBridge("http://cv.test", cams, MAPPING, transport=httpx.MockTransport(lambda r: httpx.Response(503)))
    with down._client() as client, pytest.raises(httpx.HTTPStatusError):
        down.read_once(client)


def view_calls(cams, mode):
    calls = []

    def handler(request: httpx.Request):
        calls.append(dict(request.url.params))
        return httpx.Response(200, json={})

    return make_bridge(cams, view=mode, transport=httpx.MockTransport(handler)), calls


def test_follow_view_processes_the_watched_camera_else_the_first(cams):
    b, calls = view_calls(cams, "follow")
    with b._client() as client:
        t = 5_000_000.0
        b.sync_view(client, now=t)
        assert calls[-1] == {"mode": "one", "cam": "br:007"}
        b.sync_view(client, now=t + 10)
        assert len(calls) == 1  # nothing changed
        b.touch(KATY, now=t + 11)
        b.sync_view(client, now=t + 11)
        assert calls[-1] == {"mode": "one", "cam": "br:009"}
        b.touch(GULF, now=t + 11.5)
        b.sync_view(client, now=t + 12)
        assert len(calls) == 2  # at most one change every VIEW_GAP_S
        b.sync_view(client, now=t + 13.5)
        assert len(calls) == 2  # the I-10 card may still be open (see the next test)
        b.sync_view(client, now=t + 14.5)  # it stopped asking: back to the Gulf Freeway camera
        assert calls[-1] == {"mode": "one", "cam": "br:007"}
        b.sync_view(client, now=t + 11.5 + cvb.WATCH_S + 5)  # nobody watching: back to the first
        assert len(calls) == 3


def test_two_cameras_watched_at_once_take_turns(cams):
    # Two cards open on different cameras, both polling: switching every VIEW_GAP_S would never let
    # either video start, so each keeps the CV app for VIEW_TURN_S.
    b, calls = view_calls(cams, "follow")
    t = 6_000_000.0
    b.handle_message({"updates": [raw("009", 0, status="paused")]}, now=t)
    switches = []
    with b._client() as client:
        b.touch(GULF, now=t)
        b.sync_view(client, now=t)
        for k in range(1, 140):  # 70 s, both cards asking twice a second
            now = t + k / 2
            b.touch(GULF, now=now)
            b.touch(KATY, now=now + 0.1)
            n = len(calls)
            b.sync_view(client, now=now + 0.2)
            if len(calls) > n:
                switches.append((round(now + 0.2 - t), calls[-1]["cam"]))
            if k == 20:
                assert b.summary(KATY, now=now + 0.2)["status"] == "paused"  # waiting its turn
    assert calls[0] == {"mode": "one", "cam": "br:007"}
    assert switches == [(30, "br:009"), (60, "br:007")]
    # Once its turn is over, someone who moved on to another camera gets it at once
    b.touch(KATY, now=t + 100)
    with b._client() as client:
        b.sync_view(client, now=t + 100)
    assert calls[-1] == {"mode": "one", "cam": "br:009"}


def test_view_modes_all_and_off(cams):
    b, calls = view_calls(cams, "all")
    with b._client() as client:
        b.sync_view(client, now=1.0)
    assert calls == [{"mode": "all"}]
    b, calls = view_calls(cams, "off")
    with b._client() as client:
        b.sync_view(client, now=1.0)
    assert calls == []
    b, calls = view_calls(cams, "follow")
    b.connected = False
    with b._client() as client:
        b.sync_view(client, now=1.0)
    assert calls == []  # not while the CV app is away


def test_a_mapped_camera_the_cv_app_doesnt_run_is_missing(cams):
    b = make_bridge(cams, mapping=f"025={GULF}")
    assert b.summary(GULF)["status"] == "missing" and b.desired_view() is None
