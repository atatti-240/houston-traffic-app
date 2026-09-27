"""Driver reports: snapping, limits, expiry, votes, what they do to roads, routes, causes and
alerts, the demo's canned reports, and old databases."""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import Base
from app.main import create_app
from app.reports import (
    REPORTS_PER_WINDOW,
    DriverReport,
    DriverReportVote,
    RateLimiter,
    ReportStore,
    offset_line,
    point_along,
)

FLOOD_ROAD = "WHMR:i69_610sw>galleria"  # the only way into the Galleria
I69_OUT = "I69:midtown>i69_610sw"  # downtown -> Galleria goes this way unless something's on it
POLICE_ROAD = "SH288:midtown>tmc_288"
FAR = (29.5, -95.8)  # in the Houston box, nowhere near our roads


@pytest.fixture
def app(services):
    services.clock.set(services.clock.now().replace(hour=8, minute=0))
    return create_app(services)


def client_at(app, ip: str) -> TestClient:
    return TestClient(app, client=(ip, 5000))


@pytest.fixture
def c(app):
    with client_at(app, "10.0.0.1") as cl:
        yield cl


def on_line(services, sid: str, along: float = 0.5) -> dict:
    lat, lng = point_along(services.network.segments[sid], along)
    return {"lat": lat, "lng": lng}


def report(cl, services, kind: str, sid: str, **extra):
    r = cl.post("/reports", json={"kind": kind, **on_line(services, sid), **extra})
    assert r.status_code in (200, 201), r.text
    return r.json()["report"]


def active_ids(cl) -> set[int]:
    return {r["id"] for r in cl.get("/reports").json()["items"]}


def advance(cl, minutes: float) -> None:
    cl.post("/demo/advance-clock", json={"minutes": minutes})


# --- reporting and snapping ------------------------------------------------------------------------


def test_report_snaps_to_the_direction_whose_line_you_tap(c, services):
    for sid in (FLOOD_ROAD, services.network.segments[FLOOD_ROAD].reverse_id):
        r = c.post("/reports", json={"kind": "flooding", **on_line(services, sid)})
        assert r.status_code == 201
        rep = r.json()["report"]
        assert rep["segment_id"] == sid and rep["road"].startswith("Westheimer Rd")
        assert rep["affects_routing"] and rep["mine"] == "reported"
    items = c.get("/reports").json()["items"]
    assert len(items) == 2 and items[0]["provenance"] == "Reported by a driver, just now"
    assert items[0]["created_at"].endswith("T08:00:00") and items[0]["expires_at"].endswith("T10:00:00")


def test_every_drawn_line_snaps_back_to_its_own_direction(services):
    for seg in services.network.segments.values():
        for along in (0.3, 0.7):
            assert services.reports.snap(*point_along(seg, along)).segment_id == seg.id


def test_far_from_our_roads_it_is_a_pin_only(c):
    rep = c.post("/reports", json={"kind": "pothole", "lat": FAR[0], "lng": FAR[1], "note": "Deep one"}).json()["report"]
    assert rep["segment_id"] is None and rep["road"] is None and rep["place"].startswith("Near ")
    assert not rep["affects_routing"] and (rep["lat"], rep["lng"]) == FAR
    alert = next(a for a in c.get("/traffic-alerts").json()["items"] if a["id"] == f"incident:report-{rep['id']}")
    assert alert["slowdown_id"] is None and alert["place"].startswith("Near ")
    assert alert["impact"] == "Reported by a driver"
    live = next(i for i in c.get("/live").json()["incidents"] if i["id"] == f"report-{rep['id']}")
    assert live["affects_routing"] is False


def test_snap_preview_offers_both_directions(c, services):
    s = c.get("/reports/snap", params=on_line(services, I69_OUT)).json()
    rev = services.network.segments[I69_OUT].reverse_id
    assert s["on_road"] and s["segment_id"] == I69_OUT and s["road"] == "I-69 Southwest Fwy westbound"
    assert s["other"]["segment_id"] == rev and s["other"]["road"] == "I-69 Southwest Fwy eastbound"
    # Picking the other direction puts the pin on that direction's line.
    rep = report(c, services, "hazard", I69_OUT, segment_id=rev)
    assert rep["segment_id"] == rev
    assert (rep["lat"], rep["lng"]) == pytest.approx((s["other"]["lat"], s["other"]["lng"]))
    # Westheimer's two directions are a block apart there: no other direction to offer.
    w = c.get("/reports/snap", params=on_line(services, FLOOD_ROAD)).json()
    assert w["segment_id"] == FLOOD_ROAD and w["road"] == "Westheimer Rd northbound" and w["other"] is None
    far = c.get("/reports/snap", params={"lat": FAR[0], "lng": FAR[1]}).json()
    assert far["on_road"] is False and far["segment_id"] is None and far["place"].startswith("Near ")
    assert c.get("/reports/snap", params={"lat": 40.7, "lng": -74.0}).status_code == 422


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "ufo", "lat": 29.76, "lng": -95.37},
        {"kind": "crash", "lat": 40.71, "lng": -74.0},  # New York
        {"kind": "crash", "lat": 29.76, "lng": -95.37, "note": "x" * 141},
        {"kind": "crash", "lat": 29.76, "lng": -95.37, "segment_id": "nope"},
        {"kind": "crash", "lat": FAR[0], "lng": FAR[1], "segment_id": FLOOD_ROAD},  # that road isn't there
    ],
)
def test_bad_reports_are_422(c, body):
    assert c.post("/reports", json=body).status_code == 422
    assert c.get("/reports").json()["items"] == []


def test_note_is_one_short_line(c, services):
    rep = report(c, services, "hazard", POLICE_ROAD, note="  Ladder\n in the\tleft lane  ")
    assert rep["note"] == "Ladder in the left lane"


def test_rate_limit_per_client(app, services):
    a, b = client_at(app, "10.0.0.7"), client_at(app, "10.0.0.8")
    spots = list(services.network.segments)[:REPORTS_PER_WINDOW + 1]
    for sid in spots[:REPORTS_PER_WINDOW]:
        assert a.post("/reports", json={"kind": "crash", **on_line(services, sid)}).status_code == 201
    r = a.post("/reports", json={"kind": "crash", **on_line(services, spots[-1])})
    assert r.status_code == 429 and "Too many reports" in r.json()["detail"] and int(r.headers["retry-after"]) > 0
    assert b.post("/reports", json={"kind": "crash", **on_line(services, spots[-1])}).status_code == 201


def test_rate_limiter_windows_and_stays_bounded():
    rl = RateLimiter(2, 60, max_keys=3)
    assert rl.hit("a", 0) is None and rl.hit("a", 10) is None
    assert rl.hit("a", 20) == pytest.approx(40)  # the first hit leaves the window at 60
    assert rl.hit("a", 61) is None
    for k in "bcde":
        rl.hit(k, 100)
    assert len(rl._hits) == 3 and "a" not in rl._hits


# --- expiry and votes --------------------------------------------------------------------------------


def test_reports_expire_on_the_simulated_clock(c, services):
    crash = report(c, services, "crash", I69_OUT)
    flood = report(c, services, "flooding", FLOOD_ROAD)
    advance(c, 44)
    assert active_ids(c) == {crash["id"], flood["id"]}
    advance(c, 2)  # 46 min: a crash lasts 45
    assert active_ids(c) == {flood["id"]}
    advance(c, 74)  # 2 h: so does flooding
    assert active_ids(c) == set()
    # Back before they were made (the demo clock can go back): not up either.
    c.post("/demo/advance-clock", json={"to": "2026-09-28T07:00:00"})
    assert active_ids(c) == set()


def test_still_there_keeps_it_up_and_one_vote_per_client(app, c, services):
    rep = report(c, services, "crash", I69_OUT)
    other = client_at(app, "10.0.0.2")
    advance(c, 30)
    r = other.post(f"/reports/{rep['id']}/vote", json={"still_there": True}).json()["report"]
    assert r["still_there"] == 1 and r["mine"] == "still_there" and r["expires_at"].endswith("T09:15:00")
    assert r["provenance"] == "Reported by drivers, 30 min ago, 1 still there"
    # Voting again changes nothing; the reporter can't confirm their own report.
    assert other.post(f"/reports/{rep['id']}/vote", json={"still_there": True}).json()["report"]["still_there"] == 1
    assert c.post(f"/reports/{rep['id']}/vote", json={"still_there": True}).json()["report"]["still_there"] == 1
    advance(c, 40)  # 70 min: past its first 45, inside the new 75
    assert rep["id"] in active_ids(c)


def test_still_there_never_keeps_it_up_past_four_lives(app, c, services):
    rep = report(c, services, "crash", I69_OUT)
    for i in range(4):
        advance(c, 40)
        client_at(app, f"10.0.1.{i}").post(f"/reports/{rep['id']}/vote", json={"still_there": True})
    assert c.get("/reports").json()["items"][0]["expires_at"].endswith("T11:00:00")  # 8:00 + 4 x 45 min


def test_two_more_not_there_than_still_there_take_it_down(app, c, services):
    rep = report(c, services, "crash", I69_OUT)
    yes, no1, no2, no3 = (client_at(app, f"10.0.2.{i}") for i in range(4))
    yes.post(f"/reports/{rep['id']}/vote", json={"still_there": True})
    for cl in (no1, no1, no2):  # no1 twice: counts once
        body = cl.post(f"/reports/{rep['id']}/vote", json={"still_there": False}).json()
        assert body["removed"] is False
    assert body["report"]["not_there"] == 2 and body["report"]["still_there"] == 1
    body = no3.post(f"/reports/{rep['id']}/vote", json={"still_there": False}).json()
    assert body == {"removed": True, "report": None}
    assert rep["id"] not in active_ids(c)
    assert no3.post(f"/reports/{rep['id']}/vote", json={"still_there": True}).status_code == 404


def test_changing_your_vote_moves_it(app, c, services):
    rep = report(c, services, "crash", I69_OUT)
    other = client_at(app, "10.0.0.3")
    other.post(f"/reports/{rep['id']}/vote", json={"still_there": False})
    r = other.post(f"/reports/{rep['id']}/vote", json={"still_there": True}).json()["report"]
    assert (r["still_there"], r["not_there"], r["mine"]) == (1, 0, "still_there")


def test_reporter_not_there_withdraws_it(c, services):
    rep = report(c, services, "police", POLICE_ROAD)
    assert c.post(f"/reports/{rep['id']}/vote", json={"still_there": False}).json()["removed"] is True
    assert active_ids(c) == set()


def test_vote_on_a_missing_report_is_404(c):
    assert c.post("/reports/999/vote", json={"still_there": True}).status_code == 404


def test_vote_rate_limit(app, c, services):
    rep = report(c, services, "crash", I69_OUT)
    other = client_at(app, "10.0.0.4")
    codes = [other.post(f"/reports/{rep['id']}/vote", json={"still_there": i % 2 == 0}).status_code for i in range(31)]
    assert codes[:30] == [200] * 30 and codes[30] == 429


def test_same_thing_reported_again_nearby_is_a_still_there(app, c, services):
    rep = report(c, services, "crash", I69_OUT)
    other = client_at(app, "10.0.0.5")
    r = other.post("/reports", json={"kind": "crash", **on_line(services, I69_OUT, 0.52)})
    assert r.status_code == 200 and r.json()["merged"] is True
    assert r.json()["report"]["id"] == rep["id"] and r.json()["report"]["still_there"] == 1
    # Another kind, or the other direction, is its own report.
    assert other.post("/reports", json={"kind": "stalled", **on_line(services, I69_OUT)}).status_code == 201
    rev = services.network.segments[I69_OUT].reverse_id
    assert other.post("/reports", json={"kind": "crash", **on_line(services, rev)}).status_code == 201
    assert len(active_ids(c)) == 3


# --- what reports do to roads, routes, causes and alerts -----------------------------------------------


def test_crash_report_slows_its_road_and_says_who_reported_it(c, services):
    before = c.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    assert I69_OUT in [s["id"] for s in before["segments"]]
    rep = report(c, services, "crash", I69_OUT, note="Two cars on the shoulder")
    d = c.get(f"/slowdowns/{I69_OUT}").json()
    crash = next(x for x in d["causes"] if x["kind"] == "crash")
    assert crash["title"] == "Crash reported" and crash["source"] == "drivers"
    assert crash["detail"] == "Reported by a driver, just now. “Two cars on the shoulder”"
    assert rep["delay_min"] > 0 and abs(rep["delay_min"] - crash["minutes"]) <= 0.5
    # Routing goes around it and says why.
    after = c.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    assert I69_OUT not in [s["id"] for s in after["segments"]]
    assert "Rerouted around I-69 Southwest Fwy: crash reported (drivers, just now)" in after["reasons"]
    alert = next(a for a in c.get("/traffic-alerts").json()["items"] if a["id"] == f"incident:report-{rep['id']}")
    assert alert["group"] == "incident" and alert["slowdown_id"] == I69_OUT
    assert alert["impact"] == f"Reported by a driver · +{alert['delay_min']} min"


def test_flooding_warns_trips_that_cross_it(c, services):
    rep = report(c, services, "flooding", FLOOD_ROAD)
    d = c.get(f"/slowdowns/{FLOOD_ROAD}").json()
    assert d["kind"] == "weather" and d["label"] == "Flooding" and d["title"] == "Flooding reported"
    best = c.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    assert best["segments"][-1]["id"] == FLOOD_ROAD  # no other way in
    assert best["segments"][-1]["incident"]["kind"] == "flooding"
    assert any(r.startswith("Heads up: flooding on Westheimer Rd (drivers, just now)") for r in best["reasons"])
    assert {"type": "incident", "kind": "flooding"}.items() <= next(h for h in best["hazards"] if h["type"] == "incident").items()
    alert = next(a for a in c.get("/traffic-alerts").json()["items"] if a["id"] == f"incident:report-{rep['id']}")
    assert alert["group"] == "weather" and alert["kind"] == "weather"


def test_police_and_potholes_are_heads_up_only(c, services):
    before = c.get(f"/slowdowns/{POLICE_ROAD}").json()
    police = report(c, services, "police", POLICE_ROAD)
    pothole = report(c, services, "pothole", POLICE_ROAD, segment_id=POLICE_ROAD)
    after = c.get(f"/slowdowns/{POLICE_ROAD}").json()
    assert after["delay_min"] == before["delay_min"] and after["causes"] == before["causes"]
    assert not police["affects_routing"] and police["delay_min"] is None
    alerts = {a["id"]: a for a in c.get("/traffic-alerts").json()["items"]}
    for rep in (police, pothole):
        a = alerts[f"incident:report-{rep['id']}"]
        assert a["group"] == "incident" and a["impact"] == "Reported by a driver" and a["slowdown_id"] == POLICE_ROAD
    route = c.post("/route", json={"origin": "downtown", "destination": "medcenter"}).json()["best"]
    assert POLICE_ROAD in [s["id"] for s in route["segments"]]
    assert not any("police" in r or "pothole" in r for r in route["reasons"])


def test_a_report_outweighed_by_a_worse_incident_says_so(c, services):
    # A road counts its worst incident: a crash report under a two-lane closure adds nothing.
    c.post("/demo/incident", json={"segment_id": I69_OUT, "kind": "lane_closure", "lanes_blocked": 2, "minutes": 120})
    rep = report(c, services, "crash", I69_OUT)
    assert rep["outweighed"] is True and rep["delay_min"] is None
    alert = next(a for a in c.get("/traffic-alerts").json()["items"] if a["id"] == f"incident:report-{rep['id']}")
    assert alert["impact"] == "Reported by a driver" and alert["delay_min"] is None
    c.post("/demo/clear-live")
    assert c.get("/reports").json()["items"][0]["outweighed"] is False


def test_reports_count_while_the_incidents_feed_is_down(c, services):
    c.post("/demo/feed", json={"feed": "incidents", "up": False})
    report(c, services, "crash", I69_OUT)
    d = c.get(f"/slowdowns/{I69_OUT}").json()
    assert "crash" in {x["kind"] for x in d["causes"]}
    route = c.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    assert "incidents" in route["feeds_down"] and I69_OUT not in [s["id"] for s in route["segments"]]


def test_watch_on_a_reported_crash_clears_when_it_is_voted_away(app, c, services):
    rep = report(c, services, "crash", I69_OUT)
    c.post(f"/slowdowns/{I69_OUT}/watch")
    for i in range(2):
        client_at(app, f"10.0.3.{i}").post(f"/reports/{rep['id']}/vote", json={"still_there": False})
    # The vote re-checks watches right away (in the background, after the response).
    assert [n["kind"] for n in c.get("/notifications").json()] == ["cleared"]
    assert c.get(f"/slowdowns/{I69_OUT}").json()["watching"] is False


def test_a_new_report_rechecks_saved_trips(c, services):
    services.clock.set(datetime(2026, 9, 28, 8, 0))
    trip = {"name": "To the Galleria", "origin": "downtown", "destination": "galleria", "arrive_by": "08:25"}
    c.post("/trips", json=trip)
    c.post("/demo/tick")
    report(c, services, "crash", I69_OUT)  # re-checks in the background after the response
    kinds = [n["kind"] for n in c.get("/notifications").json()]
    assert kinds == ["reroute", "plan"]


# --- demo --------------------------------------------------------------------------------------------


def test_evening_demo_reports_are_labeled_demo_and_reset_clears_them(app, c, services):
    user = report(c, services, "hazard", POLICE_ROAD)
    c.post("/demo/scenario/evening")
    items = c.get("/reports").json()["items"]
    demo = [r for r in items if r["demo"]]
    assert {r["kind"] for r in demo} == {"flooding", "stalled", "police", "pothole"}
    assert all(r["provenance"].startswith("Demo report, ") for r in demo)
    flood = next(r for r in demo if r["kind"] == "flooding")
    assert flood["provenance"] == "Demo report, 16 min ago, 3 still there" and flood["segment_id"] == FLOOD_ROAD
    best = c.post("/route", json={"origin": "downtown", "destination": "galleria"}).json()["best"]
    assert any("flooding on Westheimer Rd (demo drivers, 16 min ago)" in r for r in best["reasons"])
    # One more "not there" takes down the pothole.
    pothole = next(r for r in demo if r["kind"] == "pothole")
    assert c.post(f"/reports/{pothole['id']}/vote", json={"still_there": False}).json()["removed"] is True
    # Running it again replaces the demo's reports (the 8 AM one isn't up at 5 PM anyway).
    c.post("/demo/scenario/evening")
    assert len([r for r in c.get("/reports").json()["items"] if r["demo"]]) == 4
    c.post("/demo/clear-live")
    assert c.get("/reports").json()["items"] == []
    c.post("/demo/reset")
    assert services.reports.get(user["id"]) is None


# --- old databases -------------------------------------------------------------------------------------


def test_database_without_the_reports_tables_gets_them(services):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    old = [t for t in Base.metadata.sorted_tables if t.name not in {"driver_reports", "driver_report_votes"}]
    Base.metadata.create_all(engine, tables=old)
    assert not inspect(engine).has_table("driver_reports")
    store = ReportStore(sessionmaker(bind=engine, expire_on_commit=False), lambda: services.network)
    assert inspect(engine).has_table("driver_reports") and inspect(engine).has_table("driver_report_votes")
    now = datetime(2026, 9, 28, 8, 0)
    r, merged = store.create("crash", *point_along(services.network.segments[I69_OUT], 0.5), "", "k", now)
    assert not merged and [i.id for i in store.incidents(now + timedelta(minutes=1))] == [f"report-{r.id}"]
    assert {DriverReport.__tablename__, DriverReportVote.__tablename__} <= set(inspect(engine).get_table_names())


def test_offset_line_matches_the_map(services):
    # Same numbers as the frontend's offsetLine: 55 m to the right of travel (east when heading north).
    line = offset_line([(29.70, -95.40), (29.71, -95.40)])
    assert line[0][0] == pytest.approx(29.70) and line[0][1] > -95.40
    assert (line[0][1] + 95.40) * 111_320 * 0.8686 == pytest.approx(55, abs=0.5)
