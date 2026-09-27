"""Speed limits and toll roads (app/seed/road_limits.json, from OpenStreetMap) and the avoid
tolls / avoid highways routing options."""

import importlib.util
import json
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import init_db
from app.graph import Network
from app.main import create_app
from app.models import RoadSegment
from app.routing.avoid import Avoid, avoiding
from app.routing.router import Router
from app.seed.network import LINKS, iter_directed, segment_id, seed_network
from app.seed.road_rules import refresh_road_rules, road_limits

MORNING = datetime(2026, 9, 28, 8, 0)


@pytest.fixture
def client(services):
    services.clock.set(MORNING.replace(hour=7, minute=15))
    with TestClient(create_app(services)) as c:
        yield c


def _codes(route: dict) -> list[str]:
    return [s["id"].split(":")[0] for s in route["segments"]]


# --- the data -------------------------------------------------------------------------------


def test_limits_load_for_every_segment_and_are_real_values_or_unknown():
    limits = road_limits()
    ids = {segment_id(link, frm, to) for link, frm, to in iter_directed()}
    assert set(limits) == ids
    for sid, r in limits.items():
        mph = r["speed_limit_mph"]
        assert mph is None or (mph % 5 == 0 and 20 <= mph <= 85), sid
        # Every value is backed by lookups that hit the segment's own road, and auditable.
        if mph is not None:
            assert r["speed_votes"][str(mph)] >= 1 and r["own_road"] >= 1, sid
        if r["toll"]:
            assert r["toll_votes"]["yes"] * 2 > r["own_road"], sid
    known = [r for r in limits.values() if r["speed_limit_mph"] is not None]
    assert len(known) >= 40  # most freeways are tagged in OpenStreetMap


def test_only_the_sam_houston_tollway_is_a_toll_road():
    tolls = {sid.split(":")[0] for sid, r in road_limits().items() if r["toll"]}
    assert tolls == {"BW8"}
    # Every Beltway segment in both directions, confirmed by most of its main-lane lookups.
    bw8 = [segment_id(lk, f, t) for lk, f, t in iter_directed() if lk.code == "BW8"]
    assert all(road_limits()[sid]["toll"] for sid in bw8) and len(bw8) == 6


def test_seeded_segments_carry_limit_and_toll(session):
    segs = {s.id: s for s in session.scalars(select(RoadSegment))}
    for sid, r in road_limits().items():
        assert segs[sid].speed_limit_mph == r["speed_limit_mph"]
        assert bool(segs[sid].toll) == r["toll"]


def test_an_old_database_gets_limits_and_tolls_on_startup(tmp_path):
    """A database made before these columns existed: init_db adds them, refresh fills them."""
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    init_db(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE road_segments DROP COLUMN speed_limit_mph"))
        conn.execute(text("ALTER TABLE road_segments DROP COLUMN toll"))
        conn.execute(text("ALTER TABLE trips DROP COLUMN avoid_tolls"))
        conn.execute(text("ALTER TABLE trips DROP COLUMN avoid_highways"))
    init_db(engine)
    cols = {c["name"] for c in inspect(engine).get_columns("road_segments")}
    assert {"speed_limit_mph", "toll"} <= cols
    assert {"avoid_tolls", "avoid_highways"} <= {c["name"] for c in inspect(engine).get_columns("trips")}
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as s:
        seed_network(s)
        for seg in s.scalars(select(RoadSegment)):
            seg.speed_limit_mph, seg.toll = None, None  # how a database seeded before looks
        s.commit()
        assert refresh_road_rules(s) == 82
        seg = s.get(RoadSegment, "BW8:290_bw8>i10_bw8w")
        assert seg.toll is True and seg.speed_limit_mph == 65
        assert refresh_road_rules(s) == 0  # nothing left to change


# --- the API --------------------------------------------------------------------------------


def test_segments_and_why_slow_expose_the_limit(client):
    segs = {s["id"]: s for s in client.get("/segments").json()}
    assert segs["BW8:290_bw8>i10_bw8w"]["toll"] is True and segs["BW8:290_bw8>i10_bw8w"]["speed_limit_mph"] == 65
    assert segs["I10W:downtown>i10_610w"]["toll"] is False
    for sid, r in road_limits().items():
        assert segs[sid]["speed_limit_mph"] == r["speed_limit_mph"]
    why = client.get("/slowdowns/I10W:downtown>i10_610w").json()
    assert why["speed_limit_mph"] == road_limits()["I10W:downtown>i10_610w"]["speed_limit_mph"]
    unknown = next(sid for sid, r in road_limits().items() if r["speed_limit_mph"] is None)
    assert client.get(f"/slowdowns/{unknown}").json()["speed_limit_mph"] is None


def test_route_lists_limits_along_the_way_and_the_toll_road(client):
    best = client.post("/route", json={"origin": "greenspoint", "destination": "energy", "depart_at": "2026-09-28T08:00:00"}).json()["best"]
    assert "BW8" in _codes(best)
    assert best["uses_toll"] is True and best["toll_roads"] == ["BW-8 Sam Houston Tollway"]
    for s in best["segments"]:
        assert s["speed_limit_mph"] == road_limits()[s["id"]]["speed_limit_mph"]
        assert s["toll"] == road_limits()[s["id"]]["toll"]
    runs = best["speed_limits"]
    # Stretches in driving order that add up to the whole route, each one road at one limit.
    assert [sid for r in runs for sid in r["segment_ids"]] == [s["id"] for s in best["segments"]]
    assert runs[0]["from_mile"] == 0
    assert sum(r["miles"] for r in runs) == pytest.approx(sum(s["miles"] for s in best["segments"]), abs=0.05)
    assert {"road": "BW-8 Sam Houston Tollway", "speed_limit_mph": 65} in [{k: r[k] for k in ("road", "speed_limit_mph")} for r in runs]
    free = client.post("/route", json={"origin": "eastend", "destination": "medcenter"}).json()["best"]
    assert free["uses_toll"] is False and free["toll_roads"] == []


# --- avoid tolls / highways -----------------------------------------------------------------


def test_router_avoids_tolls_when_there_is_another_way(services):
    router = services.router
    usual = router.best_route("greenspoint", "energy", MORNING)
    assert any(s.toll for s in usual.segments)
    best, alt = avoiding(router, Avoid(tolls=True)).route("greenspoint", "energy", MORNING)
    assert not any(s.toll for s in best.segments)
    assert alt is None or not any(s.toll for s in alt.segments)
    assert not any(r.startswith("No toll-free route") for r in best.reasons)
    assert best.arrive_at >= usual.arrive_at  # the tollway was the quick way
    # The option lives on a copy: the shared router still takes the tollway.
    assert router.avoid_ids == frozenset() and any(s.toll for s in router.best_route("greenspoint", "energy", MORNING).segments)


def test_router_avoids_highways_on_surface_streets_when_it_can(services):
    usual = services.router.best_route("downtown", "medcenter", MORNING)
    assert any(s.road_class == "freeway" for s in usual.segments)
    best, _ = avoiding(services.router, Avoid(highways=True)).route("downtown", "medcenter", MORNING)
    assert all(s.road_class == "arterial" for s in best.segments)
    assert not any(r.startswith("No highway-free route") for r in best.reasons)


def test_no_way_around_uses_as_little_as_it_can_and_says_so(services):
    # The Galleria is only reached through the I-69 / 610 interchange on our map.
    usual = services.router.best_route("heights", "galleria", MORNING)
    best, _ = avoiding(services.router, Avoid(highways=True)).route("heights", "galleria", MORNING)
    fwy = [s for s in best.segments if s.road_class == "freeway"]
    assert fwy and best.reasons[0].startswith("No highway-free route: this one uses ")
    assert f"({sum(s.miles for s in fwy):.1f} mi)" in best.reasons[0]
    assert sum(s.miles for s in fwy) <= sum(s.miles for s in usual.segments if s.road_class == "freeway")


def test_no_toll_free_route_note(services):
    # A map without US-290: the Beltway is the only way out of the US-290 / Beltway 8 interchange.
    net = services.network
    segs = {sid: s for sid, s in net.segments.items() if not sid.startswith("US290:")}
    router = avoiding(Router(Network(net.nodes, segs, net.crossings), services.models), Avoid(tolls=True))
    best, _ = router.route("290_bw8", "i10_bw8w", MORNING)
    assert [s.id for s in best.segments] == ["BW8:290_bw8>i10_bw8w"]
    assert best.reasons[0] == f"No toll-free route: this one uses BW-8 Sam Houston Tollway ({best.segments[0].miles:.1f} mi)"


def test_avoiding_both_still_stays_off_the_tollway_when_there_is_a_toll_free_way(services):
    # No highway-free way from Greenspoint, but a toll-free one (I-45, 610, I-10): take that one,
    # never the tollway with a false "No toll-free route".
    both = avoiding(services.router, Avoid(tolls=True, highways=True))
    best, alt = both.route("greenspoint", "energy", MORNING)
    assert not any(s.toll for r in (best, alt) if r for s in r.segments)
    assert best.reasons[0].startswith("No highway-free route: this one uses ")
    assert not any(r.startswith("No toll-free route") for rt in (best, alt) if rt for r in rt.reasons)
    for find in (both.best_route, both.traffic_only_route):
        assert not any(s.toll for s in find("greenspoint", "energy", MORNING).segments)

    # With truly no toll-free way (a map without US-290), both notes, and still as little as it can.
    net = services.network
    segs = {sid: s for sid, s in net.segments.items() if not sid.startswith("US290:")}
    router = Router(Network(net.nodes, segs, net.crossings), services.models)
    best, _ = avoiding(router, Avoid(tolls=True, highways=True)).route("290_bw8", "i10_bw8w", MORNING)
    assert [s.id for s in best.segments] == ["BW8:290_bw8>i10_bw8w"]
    assert [r.split(":")[0] for r in best.reasons[:2]] == ["No toll-free route", "No highway-free route"]


def test_route_recommend_and_plan_take_the_options(client):
    body = {"origin": "greenspoint", "destination": "energy"}
    assert client.post("/route", json=body).json()["best"]["uses_toll"] is True
    r = client.post("/route", json={**body, "avoid_tolls": True}).json()
    assert r["best"]["uses_toll"] is False and "BW8" not in _codes(r["best"])
    assert r["alternative"] is None or r["alternative"]["uses_toll"] is False

    rec = client.post("/recommend", json={**body, "arrive_by": "09:30", "avoid_tolls": True}).json()
    assert rec["route"]["uses_toll"] is False

    hwy = client.post("/route", json={"origin": "downtown", "destination": "medcenter", "avoid_highways": True}).json()["best"]
    assert {s["road_class"] for s in hwy["segments"]} == {"arterial"}

    both = client.post("/route", json={**body, "avoid_tolls": True, "avoid_highways": True}).json()["best"]
    assert both["uses_toll"] is False and not any(r.startswith("No toll-free") for r in both["reasons"])

    plan = client.post(
        "/plan",
        json={"start": {"place": "greenspoint"}, "stops": [{"place": "energy"}], "avoid_tolls": True},
    )
    assert plan.status_code == 201
    p = plan.json()
    assert p["avoid_tolls"] is True and p["avoid_highways"] is False
    assert all(not leg["uses_toll"] and leg["speed_limits"] for leg in p["legs"])
    assert client.get(f"/plan/{p['plan_id']}").json()["avoid_tolls"] is True


def test_watched_plan_keeps_avoiding_on_replan(client, services):
    p = client.post(
        "/plan",
        json={"start": {"place": "greenspoint"}, "stops": [{"place": "energy"}], "avoid_tolls": True, "watch": True},
    ).json()
    services.tick(replan_now=True)
    again = client.get(f"/plan/{p['plan_id']}").json()
    assert again["avoid_tolls"] is True and not again["legs"][0]["uses_toll"]


def test_saved_trips_remember_the_options_and_alerts_follow_them(client):
    base = {"origin": "greenspoint", "destination": "energy", "arrive_by": "09:00"}
    plain = client.post("/trips", json={**base, "name": "Plain"}).json()
    tollfree = client.post("/trips", json={**base, "name": "Toll-free", "avoid_tolls": True})
    assert tollfree.status_code == 201  # not the same trip as the plain one
    assert tollfree.json()["avoid_tolls"] is True and plain["avoid_tolls"] is False
    again = client.post("/trips", json={**base, "name": "Toll-free", "avoid_tolls": True})
    assert again.status_code == 200 and again.json()["id"] == tollfree.json()["id"]

    notes = client.post("/demo/advance-clock", json={"to": "2026-09-28T07:05:00"}).json()["notifications"]
    by_trip = {n["trip_id"]: n for n in notes}
    assert "Tollway" in by_trip[plain["id"]]["body"]
    assert "Tollway" not in by_trip[tollfree.json()["id"]]["body"]


# --- the lookup script (never touches the network in tests) ---------------------------------


@pytest.fixture(scope="module")
def fetch():
    path = Path(__file__).resolve().parents[1] / "scripts" / "fetch_road_limits.py"
    spec = importlib.util.spec_from_file_location("fetch_road_limits", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _hit(kind="motorway", name="Katy Freeway", ref="I 10;US 90", osm_id=1, **tags):
    return {"category": "highway", "type": kind, "name": name, "osm_id": osm_id,
            "namedetails": {"name": name, **({"ref": ref} if ref else {})}, "extratags": tags}


def _link(code):
    return next(lk for lk in LINKS if lk.code == code)


def test_parse_mph(fetch):
    assert fetch.parse_mph("65 mph") == 65 and fetch.parse_mph(" 35 mph") == 35
    assert fetch.parse_mph("100") is None  # km/h: not a Houston posting
    assert fetch.parse_mph("signals") is None and fetch.parse_mph(None) is None and fetch.parse_mph("60 mph;50 mph") is None


def test_only_the_segments_own_main_lanes_count(fetch):
    i10 = _link("I10W")
    assert fetch.is_own_road(_hit(maxspeed="60 mph"), i10)[0]
    managed = _hit(ref="I 10", toll="yes", oneway="reversible", **{"hov:minimum": "2"})
    assert not fetch.is_own_road(managed, i10)[0]
    assert not fetch.is_own_road(_hit(kind="secondary", name="Katy Freeway Frontage Road", ref=None), i10)[0]
    assert not fetch.is_own_road(_hit(kind="motorway_link", name=None, ref=None), i10)[0]
    assert not fetch.is_own_road(_hit(kind="motorway", name="Westpark Tollway", ref="WPT"), i10)[0]
    # Main lanes with an HOV lane among them are still the main lanes.
    assert fetch.is_own_road(_hit(**{"hov:lanes": "yes|no|no"}), i10)[0]
    # The Beltway's tolled main lanes: ref SHT, "Sam Houston Tollway" in the name.
    bw8 = _link("BW8")
    assert fetch.is_own_road(_hit(name="West Sam Houston Tollway North", ref="SHT", toll="yes"), bw8)[0]
    assert fetch.is_own_road(_hit(name="North Sam Houston Parkway West", ref="BW 8", toll="no"), bw8)[0]
    # Surface streets: any street named like the link, not a cross street.
    whmr = _link("WHMR")
    assert fetch.is_own_road(_hit(kind="primary", name="Westheimer Road", ref=None), whmr)[0]
    assert not fetch.is_own_road(_hit(kind="secondary", name="Post Oak Boulevard", ref=None), whmr)[0]
    assert not fetch.is_own_road(None, whmr)[0]


def test_decide_takes_the_main_lane_majority(fetch):
    i10 = _link("I10W")
    managed = _hit(ref="I 10", toll="yes", maxspeed="55 mph", oneway="reversible")
    hits = [_hit(maxspeed="60 mph", osm_id=i) for i in range(3)] + [managed, None]
    r = fetch.decide(hits, i10)
    # One sample on a tolled managed lane doesn't make I-10 a toll road or change its limit.
    assert r["speed_limit_mph"] == 60 and r["toll"] is False
    assert r["lookups"] == 5 and r["own_road"] == 3 and r["speed_votes"] == {"60": 3}
    assert r["toll_votes"] == {"yes": 0, "no": 3} and len(r["skipped"]) == 2
    # Tie: the lower limit. No maxspeed anywhere: unknown, never a guess.
    tie = fetch.decide([_hit(maxspeed="60 mph"), _hit(maxspeed="65 mph")], i10)
    assert tie["speed_limit_mph"] == 60
    none = fetch.decide([_hit(), _hit()], i10)
    assert none["speed_limit_mph"] is None and none["speed_votes"] == {"none": 2}
    # Toll only with a majority of the main-lane lookups.
    bw8 = _link("BW8")
    sht = _hit(name="West Sam Houston Tollway North", ref="SHT", toll="yes", maxspeed="65 mph")
    assert fetch.decide([sht, sht, _hit(name="North Sam Houston Parkway West", ref="BW 8", toll="no")], bw8)["toll"] is True
    assert fetch.decide([sht, _hit(name="North Sam Houston Parkway West", ref="BW 8", toll="no")], bw8)["toll"] is False


def test_lookups_are_cached_and_a_refusal_stops_the_run(fetch, tmp_path, monkeypatch):
    cache = tmp_path / "cache.json"
    cache.write_text(json.dumps({"29.700000,-95.400000": _hit(maxspeed="60 mph")}))
    calls = []

    def fake_urlopen(req, timeout):
        calls.append((req.full_url, req.headers, timeout))
        raise fetch.urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)

    monkeypatch.setattr(fetch.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(fetch.time, "sleep", lambda s: None)
    api = fetch.Nominatim(cache)
    assert api.reverse(29.7, -95.4)["name"] == "Katy Freeway" and calls == []  # from the cache
    with pytest.raises(SystemExit, match="429"):
        api.reverse(29.71, -95.41)
    url, headers, timeout = calls[0]
    assert "zoom=17" in url and "extratags=1" in url and timeout == 20
    assert "blindspot" in headers["User-agent"]
    assert json.loads(cache.read_text())  # what it had is still saved

    # Down or timing out: three tries, then a clear stop (never a hang).
    def down(req, timeout):
        calls.append(timeout)
        raise TimeoutError("timed out")

    monkeypatch.setattr(fetch.urllib.request, "urlopen", down)
    with pytest.raises(SystemExit, match="isn't answering"):
        api.reverse(29.72, -95.42)
    assert calls[1:] == [20, 20, 20]


def test_sample_points_stay_away_from_the_ends(fetch):
    line = [[29.70, -95.40], [29.70, -95.30]]
    pts = fetch.sample_points(line, 4)
    assert len(pts) == 4 and all(-95.39 < lng < -95.31 for _, lng in pts)
    assert [round(lng, 4) for _, lng in pts] == [-95.3875, -95.3625, -95.3375, -95.3125]
