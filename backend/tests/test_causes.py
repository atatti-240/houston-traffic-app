"""Why traffic is slow: slowdowns, causes, road detail, traffic alerts, cameras, watches."""

import pytest
from fastapi.testclient import TestClient

from app.main import create_app

CRASH_ROAD = "I45S:gulf_ee>i45_610s"
KINDS = {"rush", "event", "crash", "train", "closure", "weather", "construction", "volume"}


@pytest.fixture
def client(services):
    with TestClient(create_app(services)) as c:
        yield c


@pytest.fixture
def evening(client):
    r = client.post("/demo/scenario/evening").json()
    assert r["now"].endswith("T17:00:00")
    return client


def test_evening_has_every_kind_of_cause_on_the_map(evening):
    body = evening.get("/slowdowns").json()
    assert body["count"] == len(body["items"]) > 0
    highlighted = {s["kind"] for s in body["items"] if s["highlight"]}
    assert KINDS <= highlighted
    delays = [s["delay_min"] for s in body["items"]]
    assert delays == sorted(delays, reverse=True)
    for s in body["items"]:
        assert sum(c["pct"] for c in s["causes"]) == 100
        assert s["level"] in {"heavy", "moderate", "light"} and s["speed_mph"] <= s["free_flow_mph"]
        assert s["title"] and s["detail"] and s["geometry"]


def test_crash_road_detail_has_share_of_delay_and_speed_history(evening):
    d = evening.get(f"/slowdowns/{CRASH_ROAD}").json()
    assert d["road"] == "I-45 Gulf Fwy southbound" and d["level"] == "heavy" and d["is_slowdown"]
    assert d["kind"] == "crash" and d["title"] == "Multi-vehicle crash"
    assert {c["kind"] for c in d["causes"]} == {"crash", "rush"}
    points = d["history"]["points"]
    assert len(points) == 13 and points[-1]["t"].endswith("T17:00:00")
    assert points[0]["mph"] > points[-1]["mph"] * 2  # the crash knocked the speed down
    assert any(m["label"].endswith("crash") and m["t"].endswith("T16:52:00") for m in d["history"]["markers"])
    assert d["watching"] is False


def test_unknown_road_is_404(client):
    assert client.get("/slowdowns/nope").status_code == 404
    assert client.post("/slowdowns/nope/watch").status_code == 404


def test_notify_me_when_the_crash_clears(evening):
    assert evening.post(f"/slowdowns/{CRASH_ROAD}/watch").status_code == 201
    assert evening.post(f"/slowdowns/{CRASH_ROAD}/watch").json()["watching"] is True  # idempotent
    assert evening.get(f"/slowdowns/{CRASH_ROAD}").json()["watching"] is True
    # Still rush hour after the crash is gone: that's "cleared" for a crash watch.
    r = evening.post("/demo/advance-clock", json={"minutes": 90}).json()
    cleared = [n for n in r["notifications"] if n["kind"] == "cleared"]
    assert len(cleared) == 1 and cleared[0]["title"] == "I-45 Gulf Fwy southbound has cleared"
    assert evening.get(f"/slowdowns/{CRASH_ROAD}").json()["watching"] is False
    assert evening.post("/demo/advance-clock", json={"minutes": 10}).json()["notifications"] == []


def test_unwatch(evening):
    evening.post(f"/slowdowns/{CRASH_ROAD}/watch")
    assert evening.delete(f"/slowdowns/{CRASH_ROAD}/watch").status_code == 204
    assert evening.get(f"/slowdowns/{CRASH_ROAD}").json()["watching"] is False


def test_traffic_alerts_cover_every_group_newest_first(evening):
    items = evening.get("/traffic-alerts").json()["items"]
    assert {"incident", "roadwork", "event", "weather", "train", "volume"} <= {a["group"] for a in items}
    times = [a["time"] for a in items]
    assert times == sorted(times, reverse=True)
    crash = next(a for a in items if a["title"] == "Multi-vehicle crash")
    assert crash["impact"].startswith("2 lanes blocked · +") and crash["slowdown_id"] == CRASH_ROAD
    train = next(a for a in items if a["group"] == "train")
    assert train["time"].endswith("T16:56:00") and "Clears about" in train["impact"]


def test_cameras_say_where_they_look_and_what_they_see(evening):
    cams = evening.get("/live").json()["cameras"]
    for c in cams:
        assert c["area"] and c["looking"] and c["level"] in {"heavy", "moderate", "light"} and c["note"]
    rain = [c for c in cams if c["weather"]]
    assert rain and all(c["area"] == "Galleria / Uptown" for c in rain)
    assert any(c["note"].startswith("Freight train blocking crossing") for c in cams)


def test_places_have_addresses(client):
    assert all(p["address"] for p in client.get("/places").json())


def test_new_incident_kinds_slow_roads(client):
    for kind in ("event", "weather", "lane_closure"):
        r = client.post("/demo/incident", json={"segment_id": CRASH_ROAD, "kind": kind, "detail": "Test"})
        assert r.status_code == 200, r.text
    d = client.get(f"/slowdowns/{CRASH_ROAD}").json()
    assert d["kind"] in {"event", "weather", "closure"}


def test_unknown_scenario_is_404(client):
    assert client.post("/demo/scenario/nope").status_code == 404


def test_a_train_counts_from_when_it_blocked_the_crossing(evening):
    # The evening train on Navigation Blvd started at 4:56: the chart only drops after that.
    d = evening.get("/slowdowns/NAV:downtown>eastend").json()
    assert "train" in {c["kind"] for c in d["causes"]}
    assert any(m["label"].endswith("train") and m["t"].endswith("T16:56:00") for m in d["history"]["markers"])
    mph = {p["t"][11:16]: p["mph"] for p in d["history"]["points"]}
    assert mph["16:50"] > mph["17:00"] * 1.5


def test_alerts_never_say_plus_zero_minutes(evening):
    items = evening.get("/traffic-alerts").json()["items"]
    assert not any("+0 min" in a["impact"] for a in items)
    assert not any("+0 min" in c["note"] for c in evening.get("/live").json()["cameras"])
