"""Door-to-door directions, turn-by-turn steps, lanes and route choices (app/directions).

OSRM is never called for real: a fake answers from the request itself (straight lines through
the points it was given), and each test bends that answer to what it wants to check.
"""

import http.client
import json
import socket
import threading
import time
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from app.directions import geo
from app.directions.door import RETRY_MIN_S, VIA_SPACING_M, Corridor, DoorDirections, Endpoint, door_timing
from app.directions.limit import ClientLimiter
from app.directions.options import MAX_SHARED, SLOWER_FACTOR, SLOWER_S, route_id, route_labels, route_options, shared
from app.directions.osrm import OsrmClient, OsrmNoRoute, OsrmUnavailable
from app.directions.steps import build_steps, fmt_ref, instruction, lanes, road_name, toward
from app.main import create_app
from app.routing.avoid import Avoid, avoiding
from app.routing.router import Router

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731
GALLERIA_DOOR = {"lat": 29.7390, "lng": -95.4630}


# --- a fake OSRM ---------------------------------------------------------------------------------


def _parse(url: str) -> tuple[list[list[float]], dict]:
    u = urlsplit(url)
    coords = u.path.rsplit("/", 1)[-1]
    pts = [[float(lat), float(lng)] for lng, lat in (c.split(",") for c in coords.split(";"))]
    return pts, {k: v[0] for k, v in parse_qs(u.query).items()}


def _dense(a, b, step=40.0) -> list[list[float]]:
    n = max(1, int(geo.dist_m(a, b) // step))
    return [[a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n] for i in range(n)]


def _step(kind, a, b, name="", modifier="right", **extra) -> dict:
    line = _dense(a, b) + [list(b)]
    d = sum(geo.dist_m(p, q) for p, q in zip(line, line[1:]))
    return {
        "maneuver": {
            "type": kind,
            "modifier": modifier,
            "location": [a[1], a[0]],
            "bearing_before": 0,
            "bearing_after": 90,
        },
        "name": name,
        "distance": d,
        "duration": d / 20,
        "geometry": {"type": "LineString", "coordinates": [[p[1], p[0]] for p in line]},
        "intersections": [{"location": [a[1], a[0]]}],
        **extra,
    }


def fake_route(url: str) -> dict:
    """A route straight through the requested points: one leg through silent via points when
    `waypoints` is given, else one leg per pair of points."""
    pts, q = _parse(url)
    pairs = list(zip(pts, pts[1:]))
    if "waypoints" in q:
        legs_pairs = [pairs]
    else:
        legs_pairs = [[p] for p in pairs]
    legs, coords = [], []
    for lp in legs_pairs:
        line = [p for a, b in lp for p in _dense(a, b)] + [lp[-1][1]]
        dists = [geo.dist_m(p, q_) for p, q_ in zip(line, line[1:])]
        steps = [_step("depart" if i == 0 else "turn", a, b, name=f"Road {i}") for i, (a, b) in enumerate(lp)]
        steps.append(_step("arrive", lp[-1][1], lp[-1][1], modifier="left"))
        legs.append(
            {
                "distance": sum(dists),
                "duration": sum(dists) / 20,
                "steps": steps,
                "annotation": {"distance": dists, "duration": [x / 20 for x in dists]},
            }
        )
        coords.extend(line if not coords else line[1:])
    return {
        "code": "Ok",
        "routes": [
            {
                "distance": sum(leg["distance"] for leg in legs),
                "duration": sum(leg["duration"] for leg in legs),
                "geometry": {"type": "LineString", "coordinates": [[p[1], p[0]] for p in coords]},
                "legs": legs,
            }
        ],
        "waypoints": [{"location": [p[1], p[0]], "name": "", "distance": 0.0} for p in pts],
    }


class FakeOsrm:
    """Counts calls; `tweak(n, url, body)` can change the n-th answer (0-based) or raise."""

    def __init__(self, tweak=None):
        self.urls: list[str] = []
        self.tweak = tweak

    def __call__(self, url: str, timeout: float):
        self.urls.append(url)
        body = fake_route(url)
        if self.tweak:
            out = self.tweak(len(self.urls) - 1, url, body)
            if out is not None:
                return out
        return 200, body


def client_with(fetch, **kw) -> OsrmClient:
    return OsrmClient("http://osrm.test", fetch=fetch, sleep=lambda s: None, **kw)


def vias_in(url: str) -> int:
    return len(_parse(url)[0]) - 2


@pytest.fixture
def router(trained):
    network, models, _, _ = trained
    return Router(network, models)


def segments_of(network, route):
    return [network.segments[s] for s in route.segment_ids]


def place_end(network, node) -> Endpoint:
    n = network.nodes[node]
    return Endpoint(n.lat, n.lng, False)


# --- steps: instructions, names, lanes ------------------------------------------------------------


def osrm_step(kind, modifier=None, name="", ref=None, **extra) -> dict:
    return {
        "maneuver": {"type": kind, "modifier": modifier, "location": [-95.4, 29.7], "bearing_after": 270},
        "name": name,
        "ref": ref,
        **extra,
    }


@pytest.mark.parametrize(
    "step, text",
    [
        (osrm_step("depart", name="Bagby Street"), "Head west on Bagby St"),
        (osrm_step("turn", "left", "Westheimer Road", "FM 1093"), "Turn left onto Westheimer Rd"),
        (osrm_step("turn", "slight right", "Post Oak Boulevard"), "Bear right onto Post Oak Blvd"),
        (osrm_step("turn", "sharp left", "Main Street"), "Turn sharp left onto Main St"),
        (osrm_step("turn", "right"), "Turn right"),
        (osrm_step("merge", "slight left", "Gulf Freeway", "I 45"), "Merge onto I-45 Gulf Fwy"),
        (osrm_step("merge", "slight left", "Southwest Freeway", "I 69; US 59"), "Merge onto I-69/US-59 Southwest Fwy"),
        (
            osrm_step(
                "off ramp",
                "slight right",
                exits="43A;43B",
                destinations="St Joseph Parkway, Pease Street, Emancipation Avenue",
            ),
            "Take exit 43A toward St Joseph Pkwy, Pease St",
        ),
        (
            osrm_step("off ramp", "slight left", destinations="FM 1093: Westheimer Road"),
            "Take the exit on the left toward FM-1093, Westheimer Rd",
        ),
        (osrm_step("on ramp", "slight right", destinations="I 610 West"), "Take the ramp toward I-610 West"),
        (osrm_step("on ramp", "straight", "", "TX 35"), "Take the ramp onto TX-35"),
        (
            osrm_step("fork", "slight left", destinations="Saint Joseph Parkway"),
            "Keep left at the fork toward Saint Joseph Pkwy",
        ),
        (
            osrm_step("end of road", "left", "West Dallas Street"),
            "At the end of the road, turn left onto West Dallas St",
        ),
        (osrm_step("new name", "straight", "Holcombe Boulevard"), "Continue onto Holcombe Blvd"),
        (osrm_step("continue", "uturn", "Braeswood Boulevard"), "Make a U-turn onto Braeswood Blvd"),
        (osrm_step("continue", "slight left", "Katy Freeway", "I 10"), "Keep left to stay on I-10 Katy Fwy"),
        (
            {
                **osrm_step("roundabout", "right", "Main Street"),
                "maneuver": {"type": "roundabout", "modifier": "right", "exit": 2},
            },
            "At the roundabout, take the second exit onto Main St",
        ),
        (osrm_step("arrive", "right"), "Arrive at your destination, on the right"),
        (osrm_step("arrive"), "Arrive at your destination"),
    ],
)
def test_instructions_read_plainly(step, text):
    assert instruction(step) == text


def test_road_names_and_refs():
    assert fmt_ref("I 45") == "I-45" and fmt_ref("I 69; US 59") == "I-69/US-59" and fmt_ref(None) == ""
    assert road_name("Telephone Road", "TX 35") == "Telephone Rd"  # a street reads by its name
    assert road_name("South Loop East", "I 610") == "I-610 South Loop East"
    assert road_name("", "BW 8") == "BW-8"
    assert toward("I 45 North: Dallas; Downtown", limit=3) == "I-45 North, Dallas, Downtown"


def test_lanes_only_where_they_say_something():
    turn_lanes = [{"valid": False, "indications": ["left"]}, {"valid": True, "indications": ["straight", "right"]}]
    step = {"intersections": [{"lanes": turn_lanes}, {"lanes": [{"valid": True, "indications": ["none"]}]}]}
    assert lanes(step) == turn_lanes  # the maneuver's own intersection, left to right
    assert lanes({"intersections": [{"lanes": [{"valid": True, "indications": ["none"]}] * 3}]}) is None
    assert lanes({"intersections": [{}, {"lanes": turn_lanes}]}) is None  # lanes further down the road don't count
    assert lanes({"intersections": []}) is None


def test_steps_join_legs_without_stopping_at_each():
    leg = lambda: {
        "steps": [
            osrm_step("depart", name="A Street"),
            osrm_step("turn", "left", "B Street"),
            osrm_step("arrive", "left"),
        ]
    }  # noqa: E731
    steps = build_steps([leg(), leg()])
    assert [s["maneuver"]["type"] for s in steps] == ["depart", "turn", "turn", "arrive"]
    s = steps[1]
    assert s["road"] == "B St" and s["maneuver"]["location"] == [29.7, -95.4] and "lanes" not in s
    assert set(s) == {"instruction", "distance_m", "duration_s", "maneuver", "road"}


# --- the OSRM client -------------------------------------------------------------------------------


def test_client_builds_the_request_and_spaces_calls():
    now = [100.0]
    waits: list[float] = []
    fake = FakeOsrm()
    c = OsrmClient("http://osrm.test/", fetch=fake, clock=lambda: now[0], sleep=waits.append)
    pts = [[29.76, -95.37], [29.75, -95.40], [29.74, -95.46]]
    r = c.route(pts, bearings=[None, (270, 45), None], radiuses=[None, 30, None], via_only=True, annotations=True)
    assert len(r["legs"]) == 1 and len(r["waypoints"]) == 3
    q = _parse(fake.urls[0])[1]
    assert fake.urls[0].startswith("http://osrm.test/route/v1/driving/-95.370000,29.760000;")
    assert q["waypoints"] == "0;2" and q["bearings"] == ";270,45;" and q["radiuses"] == "unlimited;30;unlimited"
    assert q["steps"] == "true" and q["overview"] == "full" and q["geometries"] == "geojson"
    c.route(pts[:2])
    assert waits == [pytest.approx(1.0)]  # one request per second
    now[0] += 10
    c.route(pts[:2])
    assert waits == [pytest.approx(1.0)] and c.calls == 3


def test_client_gives_up_on_a_long_queue():
    c = OsrmClient("http://osrm.test", fetch=FakeOsrm(), clock=lambda: 0.0, sleep=lambda s: None, max_wait=2.0)
    for _ in range(3):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    with pytest.raises(OsrmUnavailable, match="busy"):
        c.route([[29.7, -95.3], [29.8, -95.4]])


def test_client_cools_down_after_a_failure_and_fails_fast():
    now = [0.0]

    def broken(url, timeout):
        raise TimeoutError("timed out")

    fake = FakeOsrm()
    c = OsrmClient("http://osrm.test", fetch=broken, clock=lambda: now[0], sleep=lambda s: None, cooldown=60)
    with pytest.raises(OsrmUnavailable):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    c.fetch = fake
    now[0] = 30
    with pytest.raises(OsrmUnavailable, match="cooling down"):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert fake.urls == [] and c.down
    now[0] = 61
    c.route([[29.7, -95.3], [29.8, -95.4]])
    assert len(fake.urls) == 1


def test_client_errors():
    no_route = lambda url, t: (400, {"code": "NoSegment", "message": "Could not find a matching segment"})  # noqa: E731
    c = client_with(no_route)
    with pytest.raises(OsrmNoRoute, match="NoSegment"):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert not c.down  # our request's fault, not the server's
    c = client_with(lambda url, t: (429, {}))
    with pytest.raises(OsrmUnavailable):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert c.down
    off = OsrmClient("", fetch=FakeOsrm())
    assert not off.enabled
    with pytest.raises(OsrmUnavailable, match="turned off"):
        off.route([[29.7, -95.3], [29.8, -95.4]])


def test_tests_never_reach_the_public_router():
    assert OsrmClient().base_url == ""  # conftest turns it off


def test_unreachable_server_fails_fast():
    with socket.socket() as s:  # a port nobody listens on
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    c = OsrmClient(f"http://127.0.0.1:{port}", timeout=2.0)
    t = time.monotonic()
    with pytest.raises(OsrmUnavailable):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert time.monotonic() - t < 2 and c.down


def test_slow_server_times_out():
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    held = []
    threading.Thread(target=lambda: held.append(srv.accept()), daemon=True).start()  # accepts, never answers
    try:
        c = OsrmClient(f"http://127.0.0.1:{srv.getsockname()[1]}", timeout=0.5)
        t = time.monotonic()
        with pytest.raises(OsrmUnavailable):
            c.route([[29.7, -95.3], [29.8, -95.4]])
        assert time.monotonic() - t < 2
    finally:
        srv.close()


def _serve_once(send) -> tuple[socket.socket, int]:
    """A local server for one request: reads it, then `send(conn)` writes whatever it likes."""
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)

    def run():
        conn, _ = srv.accept()
        with conn:
            conn.recv(65536)
            try:
                send(conn)
            except OSError:  # the client hung up
                pass

    threading.Thread(target=run, daemon=True).start()
    return srv, srv.getsockname()[1]


def test_a_server_trickling_its_answer_is_cut_off_at_the_timeout():
    def trickle(conn):
        conn.sendall(b'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{"code":"Ok","routes":[')
        for _ in range(40):  # a byte every 0.2 s: each read is quick, the whole answer never ends
            time.sleep(0.2)
            conn.sendall(b" ")

    srv, port = _serve_once(trickle)
    try:
        c = OsrmClient(f"http://127.0.0.1:{port}", timeout=0.6)
        t = time.monotonic()
        with pytest.raises(OsrmUnavailable, match="too long|timed out"):
            c.route([[29.7, -95.3], [29.8, -95.4]])
        assert time.monotonic() - t < 1.5 and c.down
    finally:
        srv.close()


def test_an_oversized_answer_is_refused(monkeypatch):
    monkeypatch.setattr("app.directions.osrm.MAX_BODY_BYTES", 1000)
    srv, port = _serve_once(
        lambda conn: conn.sendall(b"HTTP/1.1 200 OK\r\ncontent-length: 5000\r\n\r\n" + b'{"code":"Ok"' + b" " * 4988)
    )
    try:
        with pytest.raises(OsrmUnavailable):
            OsrmClient(f"http://127.0.0.1:{port}", timeout=2.0).route([[29.7, -95.3], [29.8, -95.4]])
    finally:
        srv.close()


@pytest.mark.parametrize("chunked", [False, True])
def test_real_answers_are_read_whole(chunked):
    ok = json.dumps(fake_route("http://x/route/v1/driving/-95.3,29.7;-95.4,29.8?steps=true")).encode()
    no = b'{"code": "NoSegment", "message": "Could not find a matching segment"}'

    def answer(status: bytes, body: bytes) -> bytes:
        if chunked:  # in two pieces, the second a moment later
            half = len(body) // 2
            parts = [body[:half], body[half:]]
            return b"HTTP/1.1 %s\r\ntransfer-encoding: chunked\r\n\r\n" % status + b"".join(
                b"%x\r\n%s\r\n" % (len(p), p) for p in parts
            ) + b"0\r\n\r\n"
        return b"HTTP/1.1 %s\r\ncontent-length: %d\r\n\r\n%s" % (status, len(body), body)

    srv, port = _serve_once(lambda conn: conn.sendall(answer(b"200 OK", ok)))
    try:
        route = OsrmClient(f"http://127.0.0.1:{port}", timeout=2.0).route([[29.7, -95.3], [29.8, -95.4]])
        assert route["legs"] and route["geometry"]["coordinates"]
    finally:
        srv.close()
    srv, port = _serve_once(lambda conn: conn.sendall(answer(b"400 Bad Request", no)))
    try:
        with pytest.raises(OsrmNoRoute, match="NoSegment"):
            OsrmClient(f"http://127.0.0.1:{port}", timeout=2.0).route([[29.7, -95.3], [29.8, -95.4]])
    finally:
        srv.close()


def test_an_answer_that_is_not_an_object_is_a_server_problem():
    c = client_with(lambda url, t: (200, []))
    with pytest.raises(OsrmUnavailable):
        c.route([[29.7, -95.3], [29.8, -95.4]])
    assert c.down


# --- door to door: vias, validation, fallbacks, cache ------------------------------------------------


def test_vias_follow_our_roads_and_keep_to_the_direction_of_travel(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    corr = Corridor(segments_of(network, best))
    vias = corr.vias(0, corr.length, 5000)
    assert len(vias) >= len(best.segment_ids)  # at least one per segment
    assert all(b.d - a.d > 100 for a, b in zip(vias, vias[1:]))
    for v in vias:
        at = geo.point_at(corr.line, corr.cum, v.d)
        assert geo.dist_m(at, v.point) < 1  # on the traced road
        ahead = geo.point_at(corr.line, corr.cum, v.d + 30)
        assert geo.angle_diff(v.bearing, geo.bearing(v.point, ahead)) < 30
        k = next(k for k, (s0, s1) in enumerate(corr.bounds) if s0 <= v.d <= s1)
        s0, s1 = corr.bounds[k]
        assert v.d - s0 >= 200 and s1 - v.d >= 200  # never at an interchange


def test_door_to_door_through_our_roads(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    fake = FakeOsrm()
    door = DoorDirections(client_with(fake))
    o, d = place_end(network, "downtown"), Endpoint(**GALLERIA_DOOR, is_point=True)
    path = door.build(segments_of(network, best), o, d)
    assert path.status == "ok" and path.tried[-1].startswith("vias")
    assert len(fake.urls) == 1 and _parse(fake.urls[0])[1]["waypoints"].startswith("0;")
    assert geo.dist_m(path.geometry[0], o.latlng) < 1 and geo.dist_m(path.geometry[-1], d.latlng) < 1
    assert path.steps[0]["maneuver"]["type"] == "depart" and path.steps[-1]["maneuver"]["type"] == "arrive"
    assert 0 < path.join_m < path.leave_m and path.access_start_s > 0 and path.access_end_s > 0
    # Cached by endpoints + path: no second call.
    assert door.build(segments_of(network, best), o, d) is path and len(fake.urls) == 1


def test_a_via_that_makes_a_u_turn_is_dropped(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))

    def uturn_at_second_via(n, url, body):
        if n == 0:
            st = body["routes"][0]["legs"][0]["steps"][2]  # starts at the 2nd via
            st["maneuver"]["modifier"] = "uturn"
            st["maneuver"]["type"] = "continue"

    fake = FakeOsrm(uturn_at_second_via)
    path = DoorDirections(client_with(fake)).build(
        segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    )
    assert path.status == "ok" and len(fake.urls) == 2
    assert vias_in(fake.urls[1]) == vias_in(fake.urls[0]) - 1
    assert "U-turn at a via point" in path.tried[0]


def test_a_route_that_wanders_falls_back_to_the_way_on_and_off_our_roads(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))

    def wander(n, url, body):
        if "waypoints" in url:  # both via attempts: 3x as long along our roads
            ann = body["routes"][0]["legs"][0]["annotation"]
            ann["distance"] = [x * 3 for x in ann["distance"]]

    fake = FakeOsrm(wander)
    corr = Corridor(segments_of(network, best))
    path = DoorDirections(client_with(fake)).build(
        corr.segments, place_end(network, "downtown"), Endpoint(**GALLERIA_DOOR, is_point=True)
    )
    assert path.status == "partial" and len(fake.urls) == 3
    assert vias_in(fake.urls[1]) < vias_in(fake.urls[0]) and vias_in(fake.urls[2]) == 2
    assert path.note and any(s["instruction"].startswith("Follow ") for s in path.steps)
    types = [s["maneuver"]["type"] for s in path.steps]
    assert types[0] == "depart" and types[-1] == "arrive" and types.count("arrive") == 1
    assert geo.dist_m(path.geometry[-1], [GALLERIA_DOOR["lat"], GALLERIA_DOOR["lng"]]) < 1


def test_nothing_usable_means_our_line_and_no_steps(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))

    def lost(n, url, body):
        for leg in body["routes"][0]["legs"]:
            leg["distance"] = 99_000
            leg.get("annotation", {})["distance"] = [99_000] * len(leg.get("annotation", {}).get("distance", []))

    fake = FakeOsrm(lost)
    door = DoorDirections(client_with(fake))
    segs = segments_of(network, best)
    path = door.build(segs, place_end(network, "downtown"), place_end(network, "galleria"))
    assert path.status == "unavailable" and path.geometry is None and path.steps == [] and len(fake.urls) == 3
    door.build(segs, place_end(network, "downtown"), place_end(network, "galleria"))
    assert len(fake.urls) == 3  # the same answer would come back: remembered


def test_osrm_down_is_not_remembered_and_is_not_retried_during_the_cool_down(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    now = [0.0]
    calls = []

    def down(url, timeout):
        calls.append(url)
        raise ConnectionRefusedError("refused")

    door = DoorDirections(OsrmClient("http://osrm.test", fetch=down, clock=lambda: now[0], sleep=lambda s: None))
    segs, o, d = segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    path = door.build(segs, o, d)
    assert path.status == "unavailable" and len(calls) == 1
    assert door.build(segs, o, d).status == "unavailable" and len(calls) == 1  # cooling down: no call
    now[0] = 120
    door.client.fetch = FakeOsrm()
    assert door.build(segs, o, d).status == "ok"  # not cached while it was down


def test_a_failure_that_may_pass_says_when_to_ask_again(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    segs, o, d = segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    now = [0.0]

    def down(url, timeout):
        raise ConnectionResetError("reset")

    door = DoorDirections(OsrmClient("http://osrm.test", fetch=down, clock=lambda: now[0], sleep=lambda s: None))
    assert door.build(segs, o, d).retry_after_s == 60  # the cool-down
    now[0] = 58.5
    assert door.build(segs, o, d).retry_after_s == RETRY_MIN_S  # nearly over: not in a burst right away

    busy = OsrmClient("http://osrm.test", fetch=FakeOsrm(), clock=lambda: 0.0, sleep=lambda s: None, max_wait=2.0)
    for _ in range(3):  # the queue is full
        busy.route([[29.7, -95.3], [29.8, -95.4]])
    door = DoorDirections(busy)
    path = door.build(segs, o, d)
    assert path.status == "unavailable" and path.retry_after_s == RETRY_MIN_S and door.cached(segs, o, d) is None


def test_a_failure_that_would_happen_again_is_not_asked_again(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    segs, o, d = segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    no_route = lambda url, t: (400, {"code": "NoSegment", "message": "Could not find a matching segment"})  # noqa: E731
    for door in (DoorDirections(client_with(no_route)), DoorDirections(OsrmClient(""))):
        path = door.build(segs, o, d)
        assert path.status == "unavailable" and path.retry_after_s is None
    assert DoorDirections.too_far(Corridor(segs)).retry_after_s is None


def test_waiting_on_a_build_that_failed_for_now_says_to_ask_again(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    started, release = threading.Event(), threading.Event()

    def slow_then_down(url, timeout):
        started.set()
        release.wait(5)
        raise TimeoutError("timed out")

    door = DoorDirections(client_with(slow_then_down))
    segs, o, d = segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    results = []
    first = threading.Thread(target=lambda: results.append(door.build(segs, o, d)))
    first.start()
    started.wait(5)
    second = threading.Thread(target=lambda: results.append(door.build(segs, o, d)))
    second.start()
    time.sleep(0.1)
    release.set()
    first.join(5)
    second.join(5)
    assert [p.status for p in results] == ["unavailable", "unavailable"]
    assert all(p.retry_after_s and p.retry_after_s >= RETRY_MIN_S for p in results)


def test_doubling_back_is_caught_but_crossing_over_is_fine():
    east = [[29.75, -95.40 + i * 0.001] for i in range(12)]
    spur = east + [[29.75 + 0.001 * i, east[-1][1]] for i in range(1, 4)] + list(reversed(east[-8:]))
    assert geo.doubles_back(spur) is not None
    # East, north, west, then south straight across the first road (through one of its points).
    loop = [[29.75, -95.40 + i * 0.001] for i in range(6)] + [[29.75 + i * 0.001, -95.395] for i in range(1, 6)]
    loop += [[29.755, -95.395 - i * 0.001] for i in range(1, 3)] + [[29.755 - i * 0.001, -95.397] for i in range(1, 11)]
    assert [29.75, -95.397] in [[round(a, 6), round(b, 6)] for a, b in loop[:6]] + [
        [round(a, 6), round(b, 6)] for a, b in loop[13:]
    ]
    assert geo.doubles_back(loop) is None
    back_along = (
        loop[:13]
        + [[29.755 - i * 0.001, -95.397] for i in range(1, 5)]
        + [[29.75, -95.397 - i * 0.001] for i in range(1, 4)]
    )
    assert geo.doubles_back(back_along) is not None  # ... but turning back onto it is caught


def test_door_timing_counts_the_part_of_our_roads_it_drives_plus_the_way_on_and_off(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    corr = Corridor(segments_of(network, best))
    path = DoorDirections(client_with(FakeOsrm())).build(
        corr.segments, place_end(network, "downtown"), Endpoint(**GALLERIA_DOOR, is_point=True)
    )
    t = door_timing(best, corr, path)
    assert t.access_s == pytest.approx(path.access_start_s + path.access_end_s)
    driven = (path.leave_m - path.join_m) / corr.length
    assert best.base_travel_s * driven * 0.5 < t.travel_s - t.access_s <= best.base_travel_s
    assert t.total_s == pytest.approx(t.travel_s + t.train_delay_s + t.closure_wait_s)
    assert t.arrive_at == best.depart_at + timedelta(seconds=t.total_s)


def test_our_roads_driven_before_the_first_via_and_after_the_last_are_timed_by_us(router, trained):
    """OSRM's line follows our road from the start and to near the end (as it does for a trip from
    one of our places): only the bit off our roads is OSRM's time, the rest is our traffic model."""
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(8))
    corr = Corridor(segments_of(network, best))
    o = Endpoint(*corr.line[0], is_point=True)
    end = corr.line[-1]
    heading = geo.bearing(corr.line[-2], end) % 180
    # ~130 m off to the side of where our road ends (east of a north-south road, else north)
    off_end = [end[0], end[1] + 0.00135] if heading < 45 or heading > 135 else [end[0] + 0.0012, end[1]]
    d = Endpoint(*off_end, is_point=True)

    def along_our_road(url, timeout):
        pts, _ = _parse(url)
        line = [p for a, b in zip(corr.line, corr.line[1:]) for p in _dense(a, b, 20.0)] + [corr.line[-1]]
        line += _dense(corr.line[-1], off_end, 20.0)[1:] + [off_end]
        dists = [geo.dist_m(a, b) for a, b in zip(line, line[1:])]
        leg = {
            "distance": sum(dists),
            "duration": sum(dists) / 20,
            "steps": [_step("depart", line[0], line[1]), _step("arrive", off_end, off_end, modifier="left")],
            "annotation": {"distance": dists, "duration": [x / 20 for x in dists]},
        }
        route = {
            "distance": leg["distance"],
            "duration": leg["duration"],
            "geometry": {"type": "LineString", "coordinates": [[p[1], p[0]] for p in line]},
            "legs": [leg],
        }
        return 200, {"code": "Ok", "routes": [route], "waypoints": [{"location": [p[1], p[0]]} for p in pts]}

    path = DoorDirections(client_with(along_our_road)).build(corr.segments, o, d)
    assert path.status == "ok"
    vias = corr.vias(0.0, corr.length, VIA_SPACING_M)
    assert path.join_m < 50 < vias[0].d and path.access_start_s < 5
    assert path.leave_m > corr.length - 50 > vias[-1].d and 0 < path.access_end_s < 15  # ~130 m at 20 m/s
    t = door_timing(best, corr, path)
    assert t.total_s == pytest.approx(best.total_s + path.access_start_s + path.access_end_s, abs=30)


# --- route choices ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "o, d, h",
    [("downtown", "galleria", 7), ("eastend", "medcenter", 7), ("hobby", "galleria", 17), ("energy", "downtown", 8)],
)
def test_up_to_three_different_routes(router, trained, o, d, h):
    network = trained[0]
    t = MON(h, 30)
    view = router.view(t)
    best, alt = router.route(o, d, t, view=view)
    routes = route_options(router, best, alt, view, lambda: router.traffic_only_route(o, d, t, view))
    assert 1 <= len(routes) <= 3 and routes[0] is best
    assert len({tuple(r.segment_ids) for r in routes}) == len(routes)
    for r in routes[1:]:
        assert r.total_s <= max(best.total_s * SLOWER_FACTOR, best.total_s + SLOWER_S)
        assert all(shared(network, r, k) <= MAX_SHARED for k in routes if k is not r)
        assert network.segments[r.segment_ids[0]].from_node == o and network.segments[r.segment_ids[-1]].to_node == d
    labels = [label for label, _ in route_labels(network, routes)]
    assert len(set(labels)) == len(labels) and all(x.startswith("via ") for x in labels)


def test_there_is_a_third_route_downtown_to_the_galleria(router):
    view = router.view(MON(7, 30))
    best, alt = router.route("downtown", "galleria", MON(7, 30), view=view)
    assert len(route_options(router, best, alt, view)) == 3


# --- the API ------------------------------------------------------------------------------------------


@pytest.fixture
def client(services):
    services.clock.set(MON(7, 15))
    with TestClient(create_app(services)) as c:
        yield c


def test_route_keeps_best_and_alternative_and_adds_routes(client):
    body = client.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()
    routes = body["routes"]
    assert body["best"] == routes[0] and 1 <= len(routes) <= 3
    assert body["alternative"]["id"] and body["alternative"]["segments"]
    for r in routes:
        assert r["id"] and r["label"].startswith("via ") and r["main_road"] and isinstance(r["delay_causes"], list)
        assert "directions" not in r  # only when asked for
        for c in r["delay_causes"]:
            assert (
                c["kind"] in {"rush", "volume", "crash", "construction", "closure", "event", "weather", "train"}
                and c["minutes"] >= 1
            )


def test_route_with_directions_to_a_point_reaches_the_door(client, services):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    plain = client.post("/route", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()["best"]
    body = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()
    best = body["best"]
    d = best["directions"]
    assert d["status"] == "ok" and d["steps"][-1]["instruction"].startswith("Arrive") and d["access_min"]["end"] > 0
    assert best["geometry"][-1] == pytest.approx([GALLERIA_DOOR["lat"], GALLERIA_DOOR["lng"]], abs=1e-5)
    assert best["total_min"] != plain["total_min"] and best["breakdown"]["access_min"] > 0
    arrive = datetime.fromisoformat(best["depart_at"]) + timedelta(minutes=best["total_min"])
    assert abs((datetime.fromisoformat(best["arrive_at"]) - arrive).total_seconds()) < 4
    # Only the first route asks OSRM; the others wait to be asked for.
    assert len(fake.urls) == 1 and all(r["directions"]["status"] == "pending" for r in body["routes"][1:])

    alt = body["routes"][1]
    patch = client.post(
        "/directions",
        json={
            "origin": "downtown",
            "destination": GALLERIA_DOOR,
            "segment_ids": [s["id"] for s in alt["segments"]],
            "depart_at": alt["depart_at"],
        },
    ).json()
    assert patch["id"] == alt["id"] and patch["directions"]["status"] == "ok" and len(fake.urls) == 2
    again = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()
    assert again["routes"][1]["directions"]["status"] == "ok" and len(fake.urls) == 2  # from the cache now
    assert again["routes"][1]["total_min"] == patch["total_min"]


def test_between_places_directions_keep_our_times(client, services):
    services.directions = DoorDirections(client_with(FakeOsrm()))
    plain = client.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    best = client.post("/route?directions=true", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    assert best["directions"]["status"] == "ok" and best["directions"]["access_min"] is None
    assert best["total_min"] == plain["total_min"] and best["arrive_at"] == plain["arrive_at"]
    assert best["geometry"] != plain["geometry"]


def test_directions_rejects_a_broken_path(client):
    ok = {"origin": "downtown", "destination": "galleria"}
    assert client.post("/directions", json={**ok, "segment_ids": ["I45N:downtown>i45_610n"]}).status_code == 422
    assert client.post("/directions", json={**ok, "segment_ids": ["nope"]}).status_code == 404


def test_with_osrm_unreachable_the_trip_still_comes_back_quickly(client, services):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    services.directions = DoorDirections(OsrmClient(f"http://127.0.0.1:{port}", timeout=1.0))
    t = time.monotonic()
    r = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR})
    assert r.status_code == 200 and time.monotonic() - t < 3
    best = r.json()["best"]
    assert (
        best["directions"]["status"] == "unavailable"
        and best["directions"]["steps"] == []
        and best["directions"]["note"]
    )
    assert best["geometry"] and best["total_min"] > 0
    assert best["directions"]["retry_after_s"] == 60  # ask again once the cool-down is over


def test_recommend_door_to_door_leaves_early_enough_on_the_usual_marks(client, services):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    body = client.post(
        "/recommend?directions=true", json={"origin": "eastend", "destination": GALLERIA_DOOR, "arrive_by": "08:30"}
    ).json()
    depart, eta = datetime.fromisoformat(body["depart_at"]), datetime.fromisoformat(body["eta"])
    assert depart.minute % 5 == 0 and depart.second == 0
    assert body["buffer_min"] == 5 and body["eta"] == body["route"]["arrive_at"]
    assert body["on_time"] == (eta + timedelta(minutes=5) <= MON(8, 30))
    assert body["route"]["directions"]["status"] == "ok" and body["routes"][0] == body["route"]
    assert len(fake.urls) <= 2  # the chosen route (and the re-picked one), never the recommender's loop


def test_plans_and_saved_trips_never_ask_osrm(client, services):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    r = client.post(
        "/plan", json={"start": {"place": "downtown"}, "stops": [{"place": "galleria"}, {"place": "medcenter"}]}
    )
    assert r.status_code == 201
    client.post("/trips", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30"})
    client.post("/demo/advance-clock", json={"minutes": 30})
    client.post("/recommend", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30"})
    assert fake.urls == []


def test_route_ids_are_stable(router):
    a, _ = router.route("downtown", "galleria", MON(12))
    b, _ = router.route("downtown", "galleria", MON(12, 5))
    assert a.segment_ids == b.segment_ids and route_id(a) == route_id(b) and len(route_id(a)) == 10


def test_the_same_trip_asked_twice_at_once_calls_osrm_once(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    started, release = threading.Event(), threading.Event()
    fake = FakeOsrm()

    def slow(url, timeout):
        started.set()
        release.wait(5)
        return fake(url, timeout)

    door = DoorDirections(client_with(slow))
    segs, o, d = segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    results = []
    first = threading.Thread(target=lambda: results.append(door.build(segs, o, d)))
    first.start()
    started.wait(5)
    second = threading.Thread(target=lambda: results.append(door.build(segs, o, d)))
    second.start()
    time.sleep(0.1)
    release.set()
    first.join(5)
    second.join(5)
    assert len(fake.urls) == 1 and [p.status for p in results] == ["ok", "ok"] and results[0] is results[1]


def test_both_ends_by_the_same_node_go_door_to_door_directly(client, services):
    # A shop a few blocks from downtown snaps to the downtown node: our route is empty.
    near = {"lat": 29.7573, "lng": -95.3555}
    assert client.post("/route", json={"origin": "downtown", "destination": "downtown"}).status_code == 200
    plain = client.post("/route", json={"origin": "downtown", "destination": near}).json()
    assert plain["best"]["segments"] == [] and plain["best"]["label"] == "via local streets"
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    best = client.post("/route?directions=true", json={"origin": "downtown", "destination": near}).json()["best"]
    assert best["directions"]["status"] == "ok" and len(fake.urls) == 1 and vias_in(fake.urls[0]) == 0
    assert best["total_min"] > 0 and best["geometry"][-1] == pytest.approx([near["lat"], near["lng"]], abs=1e-5)


def test_a_slow_server_gets_no_third_try(router, trained):
    network = trained[0]
    best, _ = router.route("downtown", "galleria", MON(12))
    now = [0.0]
    fake = FakeOsrm()

    def slow_and_wandering(url, timeout):
        now[0] += 3.5  # each answer takes 3.5 s ...
        status, body = fake(url, timeout)
        for leg in body["routes"][0]["legs"]:  # ... and is no good
            leg["distance"] = 99_000
            leg.get("annotation", {})["distance"] = [99_000] * len(leg.get("annotation", {}).get("distance", []))
        return status, body

    door = DoorDirections(
        OsrmClient("http://osrm.test", fetch=slow_and_wandering, clock=lambda: now[0], sleep=lambda s: None)
    )
    segs, o, d = segments_of(network, best), place_end(network, "downtown"), place_end(network, "galleria")
    path = door.build(segs, o, d)
    assert path.status == "unavailable" and len(fake.urls) == 2 and "out of time" in path.tried[-1]
    assert door.cached(segs, o, d) is None  # a slow moment isn't remembered


def _cut_off(url, timeout):
    raise http.client.IncompleteRead(b"")  # the connection dropped mid-answer


def _string_steps(url, timeout):
    status, body = FakeOsrm()(url, timeout)
    for leg in body["routes"][0]["legs"]:
        leg["steps"] = ["turn left"] * len(leg["steps"])
    return status, body


@pytest.mark.parametrize(
    "answer",
    [
        _cut_off,
        lambda url, t: (200, {"code": "Ok", "routes": [{"legs": []}]}),
        lambda url, t: (200, []),
        _string_steps,
    ],
)
def test_odd_answers_fall_back_instead_of_failing(client, services, answer):
    services.directions = DoorDirections(client_with(answer))
    r = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR})
    assert r.status_code == 200 and r.json()["best"]["directions"]["status"] == "unavailable"


@pytest.mark.parametrize(
    "far",
    [
        {"lat": 40.7128, "lng": -74.0060},  # New York: snaps to one of our places, 2,000+ km away
        {"lat": 1000, "lng": -95.4},  # not a coordinate
        {"lat": float("nan"), "lng": -95.4},
    ],
)
def test_points_far_from_houston_get_our_line_without_asking_osrm(client, services, far):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))

    def post(path: str, body: dict) -> dict:  # json.dumps: NaN too, as a sloppy client might send it
        r = client.post(path, content=json.dumps(body), headers={"content-type": "application/json"})
        assert r.status_code == 200
        return r.json()

    plain = post("/route", {"origin": "downtown", "destination": far})["best"]
    body = post("/route?directions=true", {"origin": "downtown", "destination": far})
    best = body["best"]
    assert best["directions"]["status"] == "unavailable" and "around Houston" in best["directions"]["note"]
    assert best["directions"]["retry_after_s"] is None  # it would be the same later
    assert best["total_min"] == plain["total_min"] and best["geometry"] == plain["geometry"]
    for r in body["routes"][1:]:
        ids = [s["id"] for s in r["segments"]]
        patch = post("/directions", {"origin": "downtown", "destination": far, "segment_ids": ids})
        assert patch["directions"]["status"] == "unavailable"
    rec = post("/recommend?directions=true", {"origin": far, "destination": "galleria", "arrive_by": "09:00"})
    assert rec["route"]["directions"]["status"] == "unavailable"
    assert fake.urls == []


def test_a_point_out_of_town_but_near_houston_still_goes_door_to_door(client, services):
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    katy = {"lat": 29.7858, "lng": -95.8245}  # ~20 km past the Energy Corridor
    best = client.post("/route?directions=true", json={"origin": "downtown", "destination": katy}).json()["best"]
    assert best["directions"]["status"] == "ok" and len(fake.urls) == 1


def _directions_body(route: dict, destination) -> dict:
    return {
        "origin": "downtown",
        "destination": destination,
        "segment_ids": [s["id"] for s in route["segments"]],
        "depart_at": route["depart_at"],
    }


def test_directions_that_failed_for_now_come_through_when_asked_again(client, services):
    now = [0.0]
    fake = FakeOsrm()
    answers = iter([TimeoutError("timed out")])

    def flaky(url, timeout):  # times out once, then answers
        e = next(answers, None)
        if e:
            raise e
        return fake(url, timeout)

    services.directions = DoorDirections(
        OsrmClient("http://osrm.test", fetch=flaky, clock=lambda: now[0], sleep=lambda s: None)
    )
    body = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()
    best = body["best"]
    assert best["directions"]["status"] == "unavailable" and best["directions"]["retry_after_s"] == 60
    assert "main roads only" in best["directions"]["note"]
    assert all(r["directions"]["retry_after_s"] is None for r in body["routes"][1:])  # pending: asked anyway

    now[0] = 30  # still cooling down: fails fast, says how long is left, OSRM isn't asked
    early = client.post("/directions", json=_directions_body(best, GALLERIA_DOOR)).json()
    assert early["directions"]["status"] == "unavailable" and early["directions"]["retry_after_s"] == 30
    assert fake.urls == []

    now[0] = 61
    patch = client.post("/directions", json=_directions_body(best, GALLERIA_DOOR)).json()
    d = patch["directions"]
    assert patch["id"] == best["id"] and d["status"] == "ok" and d["retry_after_s"] is None and d["steps"]
    assert patch["total_min"] != best["total_min"] and patch["breakdown"]["access_min"] > 0
    assert patch["geometry"][-1] == pytest.approx([GALLERIA_DOOR["lat"], GALLERIA_DOOR["lng"]], abs=1e-5)
    again = client.post("/route?directions=true", json={"origin": "downtown", "destination": GALLERIA_DOOR}).json()
    assert again["best"]["directions"]["status"] == "ok" and len(fake.urls) == 1  # remembered now


def test_client_limiter_refills_and_forgets_idle_clients():
    now = [0.0]
    lim = ClientLimiter(burst=3, per_min=10, max_clients=2, clock=lambda: now[0])
    assert [lim.take("a") for _ in range(3)] == [0, 0, 0]
    assert lim.take("a") == pytest.approx(6.0)  # 10 a minute: one every 6 s
    assert lim.take("b") == 0  # everyone has their own
    now[0] = 3
    assert lim.take("a") == pytest.approx(3.0)  # a refused ask doesn't count
    now[0] = 6
    assert lim.take("a") == 0 and lim.take("a") > 0
    lim.take("c")
    assert list(lim._clients) == ["a", "c"]  # b was idle the longest
    now[0] = 1000
    takes = [lim.take("a") for _ in range(4)]
    assert takes[:3] == [0, 0, 0] and takes[3] > 0  # a full bucket again, not more


def test_directions_are_limited_per_client(client, services):
    fake = FakeOsrm()
    now = [0.0]
    services.directions = DoorDirections(client_with(fake))
    services.directions.limiter = ClientLimiter(burst=2, per_min=10, clock=lambda: now[0])
    alt = client.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["routes"][1]
    doors = [{"lat": GALLERIA_DOOR["lat"] + 0.001 * i, "lng": GALLERIA_DOOR["lng"]} for i in range(3)]

    assert [client.post("/directions", json=_directions_body(alt, x)).status_code for x in doors[:2]] == [200, 200]
    r = client.post("/directions", json=_directions_body(alt, doors[2]))
    assert r.status_code == 429 and r.headers["retry-after"] == "6"
    assert r.json()["retry_after_s"] == 6 and "Try again" in r.json()["detail"]
    calls = len(fake.urls)
    # What's known already costs OSRM nothing, so it isn't limited ...
    assert client.post("/directions", json=_directions_body(alt, doors[0])).status_code == 200
    far = {"lat": 40.7128, "lng": -74.0060}  # too far for OSRM: our own line
    to_far = client.post("/route", json={"origin": "downtown", "destination": far}).json()["best"]
    assert client.post("/directions", json=_directions_body(to_far, far)).status_code == 200
    assert len(fake.urls) == calls
    # ... and another device isn't held up by this one
    with TestClient(create_app(services), client=("10.0.0.2", 50000)) as other:
        assert other.post("/directions", json=_directions_body(alt, doors[2])).status_code == 200
    now[0] = 6
    assert client.post("/directions", json=_directions_body(alt, doors[1] | {"lng": -95.47})).status_code == 200


def test_directions_are_not_limited_with_osrm_off(client):
    alt = client.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["routes"][1]
    for i in range(12):
        door = {"lat": GALLERIA_DOOR["lat"] + 0.001 * i, "lng": GALLERIA_DOOR["lng"]}
        assert client.post("/directions", json=_directions_body(alt, door)).status_code == 200


def test_a_replan_while_driving_starts_the_way_you_are_heading(client, services):
    """POST /route with `heading` (driving): OSRM snaps the start to the side of the road going that
    way, so the new directions don't begin with a U-turn. Without it, the start is free as before."""
    fake = FakeOsrm()
    services.directions = DoorDirections(client_with(fake))
    here = {"lat": 29.7560, "lng": -95.3700}
    body = {"origin": here, "destination": GALLERIA_DOOR}
    assert client.post("/route?directions=true", json={**body, "heading": 271.6}).status_code == 200
    assert _parse(fake.urls[-1])[1]["bearings"].startswith("272,90;")
    # A different heading is a different answer (not the cached one)
    client.post("/route?directions=true", json={**body, "heading": 90})
    assert len(fake.urls) == 2 and _parse(fake.urls[-1])[1]["bearings"].startswith("90,90;")
    client.post("/route?directions=true", json=body)
    assert _parse(fake.urls[-1])[1]["bearings"].startswith(";")
    assert client.post("/route", json={**body, "heading": 400}).status_code == 422


def test_heading_reaches_a_short_door_to_door_hop_too():
    fake = FakeOsrm()
    door = DoorDirections(client_with(fake))
    o = Endpoint(29.7560, -95.3700, True, 180)
    door._direct(Corridor([]), o, Endpoint(29.7540, -95.3700, True), 0.0)
    assert _parse(fake.urls[-1])[1]["bearings"] == "180,90;"
    door._direct(Corridor([]), Endpoint(29.7560, -95.3700, True), Endpoint(29.7540, -95.3700, True), 0.0)
    assert "bearings" not in _parse(fake.urls[-1])[1]


# --- route choices and avoid tolls / highways ----------------------------------------------------------


def _uses_toll(network, route) -> bool:
    return any(network.segments[sid].toll for sid in route.segment_ids)


def test_extra_routes_stay_off_toll_roads_when_asked(services):
    """Energy Corridor -> Downtown: the best route takes I-10, and the extra routes found by making
    the chosen ones dearer go round by the Sam Houston Tollway. With avoid tolls, the router that
    found the best route (app.routing.avoid.avoiding) finds the extra ones too, so they stay off it."""
    t = MON(7, 30)
    view = services.router.view(t)
    network = services.network
    best, alt = services.router.route("energy", "downtown", t, view=view)
    plain = route_options(services.router, best, alt, view)
    assert any(_uses_toll(network, r) for r in plain[1:])

    tollfree = avoiding(services.router, Avoid(tolls=True))
    best, alt = tollfree.route("energy", "downtown", t, view=view)
    routes = route_options(tollfree, best, alt, view)
    assert len(routes) >= 2 and not any(_uses_toll(network, r) for r in routes)
    # The same extra searches on the plain router would go back to the tollway.
    assert any(_uses_toll(network, r) for r in route_options(services.router, best, alt, view)[1:])


def test_route_and_recommend_list_only_toll_free_routes_when_avoiding_tolls(client):
    trip = {"origin": "energy", "destination": "downtown", "depart_at": MON(7, 30).isoformat()}
    plain = client.post("/route", json=trip).json()
    assert any(r["uses_toll"] for r in plain["routes"])

    body = client.post("/route", json={**trip, "avoid_tolls": True}).json()
    assert len(body["routes"]) >= 2 and not any(r["uses_toll"] for r in body["routes"])
    assert not any(s["id"].startswith("BW8:") for r in body["routes"] for s in r["segments"])

    rec = client.post(
        "/recommend", json={"origin": "energy", "destination": "downtown", "arrive_by": "08:30", "avoid_tolls": True}
    ).json()
    assert len(rec["routes"]) >= 2 and not any(r["uses_toll"] for r in rec["routes"])
