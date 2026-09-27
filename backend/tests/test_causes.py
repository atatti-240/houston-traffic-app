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


# --- review round: routine train risk, watches, history, alerts, cameras -------------------------

OST_ROAD = "OST:ost_cullen>tmc_288"  # rush hour plus a 13% chance of a train at 5 PM
KATY_CAM_ROAD = "I10W:downtown>i10_610w"  # the I-10 Katy camera's road: the scenario's busy camera


def _pct(detail: str) -> int:
    return int(detail.split("%")[0])


def test_a_train_that_is_only_a_chance_is_routine(evening):
    d = evening.get(f"/slowdowns/{OST_ROAD}").json()
    train = next(c for c in d["causes"] if c["kind"] == "train")
    assert train["title"] == "Chance of a train at the crossing" and _pct(train["detail"]) < 50
    assert d["kind"] == "rush" and d["routine"]  # stays in the breakdown, doesn't lead
    crash = evening.get(f"/slowdowns/{CRASH_ROAD}").json()
    assert crash["kind"] == "crash" and not crash["routine"]
    evening.post("/demo/advance-clock", json={"minutes": 15})  # the live train has cleared
    body = evening.get("/slowdowns").json()
    assert "train" not in body["counts_by_kind"]
    for s in body["items"]:
        for c in s["causes"]:
            if c["kind"] == "train":
                likely = c["title"] == "Train likely at the crossing"
                assert likely == (_pct(c["detail"]) >= 50), c
    # Routine: highlighted only as one of the 3 worst rush-hour roads.
    assert sum(s["highlight"] and s["kind"] == "rush" for s in body["items"]) <= 3
    assert all(s["routine"] == (s["kind"] == "rush") for s in body["items"] if s["kind"] != "train")


def test_watch_on_a_road_with_only_routine_causes_waits_until_it_is_not_slow(evening):
    evening.post(f"/slowdowns/{OST_ROAD}/watch")
    assert evening.post("/demo/tick").json()["notifications"] == []
    assert evening.get(f"/slowdowns/{OST_ROAD}").json()["watching"] is True


def test_feed_outage_is_not_cleared(evening):
    evening.post(f"/slowdowns/{CRASH_ROAD}/watch")
    for feed in ("incidents", "traffic", "trains"):
        r = evening.post("/demo/feed", json={"feed": feed, "up": False}).json()
        assert not [n for n in r["notifications"] if n["kind"] == "cleared"]
        evening.post("/demo/feed", json={"feed": feed, "up": True})
    d = evening.get(f"/slowdowns/{CRASH_ROAD}").json()
    assert d["kind"] == "crash" and d["watching"] is True


def test_speed_history_drops_after_the_marker_not_before(evening):
    def mph(sid):
        d = evening.get(f"/slowdowns/{sid}").json()
        return {p["t"][11:16]: p["mph"] for p in d["history"]["points"]}, [m["t"][11:16] for m in d["history"]["markers"]]

    crash, marks = mph(CRASH_ROAD)
    assert "16:52" in marks and crash["16:50"] > crash["17:00"] * 1.5  # the 4:52 crash isn't in 4:50
    busy, marks = mph(KATY_CAM_ROAD)
    assert "16:58" in marks and busy["16:50"] > busy["17:00"] * 1.3  # nor the 4:58 camera reading
    evening.post("/demo/incident", json={"segment_id": "SH288:midtown>tmc_288", "kind": "closure", "minutes": 30})
    closed, _ = mph("SH288:midtown>tmc_288")
    assert closed["17:00"] == 0 and closed["16:50"] > 0


def test_route_reasons_name_incidents_in_words(evening):
    reasons = [r for o, d in (("galleria", "midtown"), ("galleria", "downtown"))
               for r in evening.post("/route", json={"origin": o, "destination": d}).json()["best"]["reasons"]]
    assert any("lane closure" in r for r in reasons)
    assert not any("lane_closure" in r for r in reasons)


def test_incident_masked_by_another_on_the_same_road_is_not_no_delay(evening):
    evening.post("/demo/incident", json={"segment_id": "I45N:downtown>i45_610n", "kind": "weather", "title": "Heavy rain", "minutes": 60})
    items = evening.get("/traffic-alerts").json()["items"]
    works = next(a for a in items if a["title"] == "Freeway construction")
    assert works["kind"] == "construction" and "no delay yet" not in works["impact"]


def test_busy_camera_reading_is_on_a_road_with_a_camera(evening):
    cam = next(c for c in evening.get("/live").json()["cameras"] if c["segment_id"] == KATY_CAM_ROAD)
    assert cam["congestion"] != "unknown" and cam["note"].startswith("Heavier than usual")
    road = next(s for s in evening.get("/slowdowns").json()["items"] if s["id"] == KATY_CAM_ROAD)
    assert road["kind"] == "volume" and road["highlight"]
    assert any(a["group"] == "volume" and a["slowdown_id"] == KATY_CAM_ROAD for a in evening.get("/traffic-alerts").json()["items"])


def test_crossing_cameras_report_the_worse_direction_and_live_blockage(evening):
    live = evening.get("/live").json()
    status = {c["nearest_camera_id"]: c["status"] for c in live["crossings"]}
    segments = {c["id"]: c["segment_ids"] for c in evening.get("/crossings").json()["crossings"]}
    levels = {"light": 0, "moderate": 1, "heavy": 2}
    for cam in live["cameras"]:
        if not cam["crossing_id"]:
            assert cam["crossing_blocked"] is None
            continue
        assert cam["crossing_blocked"] == (status[cam["id"]] == "blocked")
        both = [evening.get(f"/slowdowns/{sid}").json()["level"] for sid in segments[cam["crossing_id"]]]
        assert levels[cam["level"]] == max(levels[x] for x in both)
    assert [c["id"] for c in live["cameras"] if c["crossing_blocked"]] == ["cam_x_navigation"]


def test_crossing_camera_note_follows_the_train_it_shows(evening):
    # 5:10 PM: the Navigation crossing is still blocked (until 5:14), but the train clears before a
    # driver on the worse direction would reach it. The camera draws the train; its note says so.
    evening.post("/demo/advance-clock", json={"minutes": 10})
    cam = next(c for c in evening.get("/live").json()["cameras"] if c["id"] == "cam_x_navigation")
    assert cam["crossing_blocked"] is True and cam["note"].startswith("Freight train blocking crossing")
    road = evening.get(f"/slowdowns/{cam['slowdown_id']}").json()
    assert cam["slowdown_id"].startswith("NAV:") and road["id"] == cam["slowdown_id"]


def test_train_alert_delay_matches_the_road_it_opens(evening):
    train = next(a for a in evening.get("/traffic-alerts").json()["items"] if a["group"] == "train")
    road = evening.get(f"/slowdowns/{train['slowdown_id']}").json()
    cause = next(c for c in road["causes"] if c["kind"] == "train")
    assert abs(train["delay_min"] - cause["minutes"]) <= 0.55 and train["impact"].endswith(f"+{train['delay_min']} min")


def test_highway_camera_area_is_the_place_it_is_named_after(evening):
    cam = next(c for c in evening.get("/live").json()["cameras"] if c["id"] == "cam_SH288_midtown_tmc_288")
    assert cam["name"].endswith("@ Medical Center") and cam["area"] == "Texas Medical Center"


def test_off_peak_usual_traffic_says_when_it_eases(client):
    client.post("/demo/advance-clock", json={"to": "2026-09-27T14:00:00"})
    details = {s["detail"] for s in client.get("/slowdowns").json()["items"] if s["kind"] == "rush"}
    assert details and all("eases by about" in d or "stays that way" in d for d in details)
    assert not any("eases until" in d or "eases for" in d for d in details)
