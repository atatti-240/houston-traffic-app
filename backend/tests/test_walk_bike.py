"""Walk and bike directions: the OpenStreetMap routing proxy, with the server faked (no network)."""

import io
import json
import urllib.error
import urllib.request
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.travel import osrm

DOWNTOWN = (29.7604, -95.3698)
MIDTOWN = (29.7420, -95.3780)


def osrm_body(distance=2400.0, duration=1900.0) -> dict:
    """What routing.openstreetmap.de answers (trimmed to the fields we read)."""
    step = lambda kind, mod, name, dist, loc, **kw: {  # noqa: E731
        "maneuver": {"type": kind, "modifier": mod, "location": loc, **kw},
        "name": name,
        "distance": dist,
        "duration": dist / 1.25,
        "mode": "walking",
    }
    return {
        "code": "Ok",
        "routes": [
            {
                "distance": distance,
                "duration": duration,
                "geometry": {"type": "LineString", "coordinates": [[-95.3698, 29.7604], [-95.3740, 29.7520], [-95.3780, 29.7420]]},
                "legs": [
                    {
                        "steps": [
                            step("depart", "", "Main Street", 400, [-95.3698, 29.7604], bearing_after=200),
                            step("new name", "straight", "Main Street", 300, [-95.3710, 29.7570]),
                            step("turn", "right", "Gray Street", 900, [-95.3740, 29.7520]),
                            step("turn", "slight left", "", 800, [-95.3760, 29.7470]),
                            step("arrive", "right", "", 0, [-95.3780, 29.7420]),
                        ]
                    }
                ],
            }
        ],
    }


class FakeServer:
    def __init__(self, body=None, error: Exception | None = None):
        self.body, self.error, self.urls = body or osrm_body(), error, []

    def __call__(self, url: str) -> dict:
        self.urls.append(url)
        if self.error:
            raise self.error
        return self.body


class FakeTime:
    def __init__(self):
        self.t = 1000.0
        self.slept: list[float] = []

    def clock(self) -> float:
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(s)
        self.t += s


def make_router(server: FakeServer, t: FakeTime | None = None) -> osrm.WalkBikeRouter:
    t = t or FakeTime()
    return osrm.WalkBikeRouter(fetch=server, clock=t.clock, sleep=t.sleep)


def test_walk_route_url_line_and_plain_steps():
    server = FakeServer()
    r = make_router(server).route("walk", DOWNTOWN, MIDTOWN)
    assert server.urls == [
        "https://routing.openstreetmap.de/routed-foot/route/v1/driving/-95.369800,29.760400;-95.378000,29.742000"
        "?overview=full&geometries=geojson&steps=true"
    ]
    assert r["distance_m"] == 2400 and r["duration_s"] == 1900
    assert r["geometry"][0] == [29.7604, -95.3698] and r["geometry"][-1] == [29.742, -95.378]  # lat, lng
    # "Continue on Main Street" folds into the step before it.
    assert [s["instruction"] for s in r["steps"]] == [
        "Head south on Main Street",
        "Turn right onto Gray Street",
        "Turn slightly left",
        "Arrive, on the right",
    ]
    assert r["steps"][0]["distance_m"] == 700 and r["steps"][0]["at"] == [29.7604, -95.3698]
    assert "OpenStreetMap" in r["source"]


def test_bike_uses_the_bike_router():
    server = FakeServer()
    make_router(server).route("bike", DOWNTOWN, MIDTOWN)
    assert "/routed-bike/route/v1/driving/" in server.urls[0]


def test_instructions_for_other_maneuvers():
    s = lambda kind, mod="", name="Elm St", **m: osrm.instruction({"maneuver": {"type": kind, "modifier": mod, **m}, "name": name})  # noqa: E731
    assert s("roundabout", "right", exit=2) == "At the roundabout, take the 2nd exit onto Elm St"
    assert s("fork", "slight right") == "Keep right at the fork onto Elm St"
    assert s("end of road", "left") == "Turn left at the end of the road onto Elm St"
    assert s("continue", "uturn") == "Turn around onto Elm St"
    assert s("continue", "straight", name="") == "Continue straight"
    assert s("arrive", "") == "Arrive"


def test_short_jogs_fold_into_the_next_turn():
    """Crossing a street a few meters to the side (right 12 m, left 14 m) isn't a step of its own; the
    next step turns by the net change of direction. Two rights round a block read as a sharp right."""
    s = lambda kind, mod, before, after, dist, name="": {  # noqa: E731
        "maneuver": {"type": kind, "modifier": mod, "bearing_before": before, "bearing_after": after, "location": [0, 0]},
        "name": name,
        "distance": dist,
        "duration": dist,
    }
    steps = osrm.simple_steps(
        [
            {
                "steps": [
                    s("depart", "", 0, 180, 60),
                    s("turn", "left", 180, 90, 70),
                    s("turn", "right", 90, 180, 12),
                    s("turn", "left", 180, 90, 14),
                    s("turn", "right", 90, 175, 200, "Post Oak Boulevard"),
                    s("turn", "right", 175, 265, 20),
                    s("turn", "right", 265, 355, 300, "Richmond Avenue"),
                    s("arrive", "", 355, 0, 0),
                ]
            }
        ]
    )
    assert [(x["instruction"], x["distance_m"]) for x in steps] == [
        ("Head south", 60),
        ("Turn left", 70),
        ("Turn right onto Post Oak Boulevard", 226),
        ("Turn sharp right onto Richmond Avenue", 320),
        ("Arrive", 0),
    ]


def test_answers_are_cached():
    server = FakeServer()
    router = make_router(server)
    first = router.route("walk", DOWNTOWN, MIDTOWN)
    assert router.route("walk", DOWNTOWN, MIDTOWN) == first
    assert len(server.urls) == 1
    router.route("bike", DOWNTOWN, MIDTOWN)
    assert len(server.urls) == 2


def test_the_same_question_asked_twice_at_once_is_asked_once():
    import threading

    started, release = threading.Event(), threading.Event()
    calls = []

    def slow_server(url):
        calls.append(url)
        started.set()
        release.wait(5)
        return osrm_body()

    router = osrm.WalkBikeRouter(fetch=slow_server, sleep=lambda s: None)
    answers = []
    threads = [threading.Thread(target=lambda: answers.append(router.route("walk", DOWNTOWN, MIDTOWN))) for _ in range(3)]
    for t in threads:
        t.start()
    assert started.wait(5)
    release.set()
    for t in threads:
        t.join(5)
    assert len(calls) == 1 and len(answers) == 3 and answers[0] == answers[1] == answers[2]


def test_a_failure_reaches_everyone_waiting_for_it():
    import threading

    release = threading.Event()

    def failing(url):
        release.wait(5)
        raise urllib.error.URLError("down")

    router = osrm.WalkBikeRouter(fetch=failing, sleep=lambda s: None)
    errors = []

    def ask():
        try:
            router.route("bike", DOWNTOWN, MIDTOWN)
        except osrm.RoutingUnavailable as e:
            errors.append(e)

    threads = [threading.Thread(target=ask) for _ in range(2)]
    for t in threads:
        t.start()
    release.set()
    for t in threads:
        t.join(5)
    assert len(errors) == 2


def test_requests_are_spaced_out_and_a_long_queue_is_refused():
    server, t = FakeServer(), FakeTime()
    router = make_router(server, t)
    # Three different trips asked at the same moment: each waits for its one-second slot.
    router._next_slot = t.t + 3.0  # three requests already queued ahead
    router.route("walk", DOWNTOWN, MIDTOWN)
    assert t.slept == [3.0]
    router._next_slot = t.t + 10
    with pytest.raises(osrm.RoutingUnavailable):
        router.route("walk", DOWNTOWN, (29.75, -95.37))
    assert len(server.urls) == 1


def test_checks_points_before_asking():
    server = FakeServer()
    router = make_router(server)
    with pytest.raises(osrm.BadRequest, match="outside the Houston area"):
        router.route("walk", (40.7, -74.0), MIDTOWN)
    with pytest.raises(osrm.BadRequest, match="too far for a walk"):
        router.route("walk", DOWNTOWN, (29.95, -95.60))  # ~30 km
    router.route("bike", DOWNTOWN, (29.95, -95.60))  # fine by bike
    assert len(server.urls) == 1


def test_no_route_and_bad_answers():
    with pytest.raises(osrm.NoRoute):
        make_router(FakeServer({"code": "NoRoute", "message": "Impossible route"})).route("walk", DOWNTOWN, MIDTOWN)
    with pytest.raises(osrm.RoutingUnavailable):
        make_router(FakeServer({"code": "Ok", "routes": []})).route("walk", DOWNTOWN, MIDTOWN)


@pytest.mark.parametrize(
    "body",
    [
        ["Ok"],  # not an object
        {"code": "Ok", "routes": [{"geometry": {"coordinates": [[-95.37, 29.76], [-95.38, 29.74]]}}]},  # no distance
        {"code": "Ok", "routes": [{"distance": 1, "duration": 1, "geometry": {"coordinates": [[1], [2]]}}]},
    ],
)
def test_answers_we_cant_read_count_as_unavailable(body):
    with pytest.raises(osrm.RoutingUnavailable):
        make_router(FakeServer(body)).route("walk", DOWNTOWN, MIDTOWN)


def test_a_server_that_trickles_bytes_runs_out_of_time(monkeypatch):
    t = FakeTime()
    monkeypatch.setattr(osrm.time, "monotonic", t.clock)

    class Trickle(io.RawIOBase):
        def read(self, n=-1):
            t.t += 3  # a byte every 3 seconds, never done
            return b" "

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: Trickle())
    with pytest.raises(TimeoutError):
        osrm.http_json("https://routing.openstreetmap.de/x")


def test_a_huge_answer_is_refused(monkeypatch):
    monkeypatch.setattr(osrm, "MAX_BYTES", 1000)
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=None: io.BytesIO(b" " * 200_000))
    with pytest.raises(ValueError, match="too large"):
        osrm.http_json("https://routing.openstreetmap.de/x")


def test_http_calls_have_a_timeout_and_a_user_agent(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=None):
        seen["timeout"], seen["ua"], seen["url"] = timeout, req.get_header("User-agent"), req.full_url
        return io.BytesIO(json.dumps(osrm_body()).encode())

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    assert osrm.http_json("https://routing.openstreetmap.de/x")["code"] == "Ok"
    assert seen["timeout"] == osrm.TIMEOUT_S and "BlindSpot" in seen["ua"]


def test_osrm_400_answers_are_read_as_json(monkeypatch):
    def fake_urlopen(req, timeout=None):
        body = io.BytesIO(json.dumps({"code": "NoSegment", "message": "Could not find a matching segment"}).encode())
        raise urllib.error.HTTPError(req.full_url, 400, "Bad Request", {}, body)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    router = osrm.WalkBikeRouter(sleep=lambda s: None)
    with pytest.raises(osrm.NoRoute):
        router.route("walk", DOWNTOWN, MIDTOWN)


# ---- API ------------------------------------------------------------------------------------------


@pytest.fixture
def client(services):
    services.clock.set(datetime(2026, 9, 28, 7, 20))
    with TestClient(create_app(services)) as c:
        yield c


def ask(client, mode="walk", a=DOWNTOWN, b=MIDTOWN):
    return client.post(
        "/travel/route",
        json={"mode": mode, "origin": {"lat": a[0], "lng": a[1]}, "destination": {"lat": b[0], "lng": b[1]}},
    )


def test_api_walk_route_times_from_the_simulated_clock(client):
    client.app.state.walk_bike = make_router(FakeServer())
    r = ask(client)
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "walk" and body["depart_at"] == "2026-09-28T07:20:00"
    assert body["arrive_at"] == "2026-09-28T07:51:40"  # + 1900 s
    assert body["steps"][1]["instruction"] == "Turn right onto Gray Street"


@pytest.mark.parametrize(
    "error",
    [urllib.error.URLError("connection refused"), TimeoutError("timed out"), urllib.error.HTTPError("u", 502, "Bad Gateway", {}, None)],
)
def test_api_says_so_when_the_routing_service_is_down(client, error):
    client.app.state.walk_bike = make_router(FakeServer(error=error))
    r = ask(client, "bike")
    assert r.status_code == 503
    assert r.json()["detail"].startswith("Cycling directions aren't available right now")


def test_api_turns_an_unreadable_answer_into_a_503(client):
    unreadable = {"code": "Ok", "routes": [{"geometry": {"coordinates": [[-95.37, 29.76], [-95.38, 29.74]]}}]}
    client.app.state.walk_bike = make_router(FakeServer(unreadable))
    r = ask(client)
    assert r.status_code == 503 and r.json()["detail"].startswith("Walking directions aren't available right now")


def test_api_errors_in_plain_words(client):
    client.app.state.walk_bike = make_router(FakeServer({"code": "NoRoute"}))
    assert ask(client).status_code == 404
    too_far = ask(client, "walk", DOWNTOWN, (29.95, -95.60))
    assert too_far.status_code == 422 and "too far for a walk" in too_far.json()["detail"]
    outside = ask(client, "walk", DOWNTOWN, (40.7, -74.0))
    assert outside.status_code == 422 and "Houston" in outside.json()["detail"]
    assert ask(client, "drive").status_code == 422  # only walk and bike here
