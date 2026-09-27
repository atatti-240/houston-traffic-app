"""Transit: the GTFS index and the trip search, on a tiny hand-made feed (tests/fixtures/gtfs_tiny).

Two bus lines (Main: A1 -> A4, Pease: B1 -> B3, B1 a short walk from A3) and a late rail trip that
runs past midnight. Weekday and weekend service, with Labor Day on the weekend timetable.
"""

import shutil
import sqlite3
import zipfile
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.travel import transit
from app.travel.gtfs import build_index, parse_time
from app.travel.transit import Route, TransitIndex, clean_headsign, nice_name, slice_line, tidy_stop_name

FEED = Path(__file__).parent / "fixtures" / "gtfs_tiny"

HOME = (29.7398, -95.3803)  # ~40 m from A1 (Main St @ Elgin)
NEAR_A4 = (29.7553, -95.3743)  # ~40 m from A4 (Main St @ Dallas)
NEAR_B3 = (29.7543, -95.3553)  # ~40 m from B3 (Pease St @ Hamilton)
FAR_AWAY = (29.95, -95.60)


@pytest.fixture(scope="module")
def index_path(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("transit") / "transit.db"
    build_index(FEED, out, source_label="fixture")
    return out


@pytest.fixture(scope="module")
def index(index_path) -> TransitIndex:
    return TransitIndex(index_path)


def rides(option: dict) -> list[str]:
    return [leg["route"]["name"] for leg in option["legs"] if leg["kind"] == "ride"]


# ---- the index ------------------------------------------------------------------------------------


def test_parse_time_keeps_hours_past_midnight():
    assert parse_time(" 7:30:00") == 27000
    assert parse_time("24:30:00") == 88200
    assert parse_time("") is None


def test_index_keeps_what_the_search_needs(index_path):
    db = sqlite3.connect(index_path)
    meta = dict(db.execute("SELECT key, value FROM meta"))
    assert meta["service_start"] == "2026-08-01" and meta["service_end"] == "2026-12-31"
    assert meta["version"] == "tiny-1" and meta["timezone"] == "America/Chicago"
    assert meta["stops"] == "7"  # the station (location_type 1) isn't a stop
    assert meta["trips"] == "6" and meta["max_time"] == str(24 * 3600 + 45 * 60)
    # A stop between timepoints gets a time spread evenly between its neighbours.
    (a2,) = db.execute(
        "SELECT st.arr FROM stop_times st JOIN trips t ON t.id = st.trip JOIN stops s ON s.id = st.stop "
        "WHERE t.gtfs_id = 'T1' AND s.gtfs_id = 'A2'"
    ).fetchone()
    assert a2 == 7 * 3600 + 34 * 60
    # Pickup / drop-off restrictions are kept as flags.
    flags = dict(
        db.execute(
            "SELECT s.gtfs_id, st.flags FROM stop_times st JOIN trips t ON t.id = st.trip JOIN stops s ON s.id = st.stop "
            "WHERE t.gtfs_id = 'P1'"
        )
    )
    assert flags == {"B1": 2, "B2": 0, "B3": 1}


def test_index_builds_from_a_zip_with_a_folder_inside(tmp_path):
    z = tmp_path / "feed.zip"
    with zipfile.ZipFile(z, "w") as f:
        for p in FEED.glob("*.txt"):
            f.write(p, f"google_transit/{p.name}")
    meta = build_index(z, tmp_path / "t.db")
    assert meta["routes"] == "3" and not (tmp_path / "t.tmp.db").exists()


def test_names_read_well():
    assert nice_name("DOWNTOWN TC") == "Downtown TC"
    assert nice_name("MLK & PARK VILLAGE") == "MLK & Park Village"
    assert nice_name("W BELLFORT ST") == "W Bellfort St"
    assert nice_name("Westheimer Rd @ Post Oak Blvd") == "Westheimer Rd @ Post Oak Blvd"
    assert clean_headsign("METRORail - FANNIN SOUTH") == "Fannin South"
    assert tidy_stop_name("MSG Joe E. Ramirez 67Th St Wb") == "MSG Joe E. Ramirez 67th St WB"
    assert tidy_stop_name("Coffee Plant /  2Nd Ward EB") == "Coffee Plant / 2nd Ward EB"
    assert tidy_stop_name("Dryden/Tmc Stn SB") == "Dryden/TMC Stn SB"
    assert Route(1, "082", "082", "Westheimer", 3, "", "").label == "82 Westheimer"
    assert Route(2, "700", "700", "METRORAIL RED LINE", 0, "", "").label == "Red Line"


def test_service_calendar_honours_added_and_removed_dates(index):
    names = lambda day: {index.services[s][0] for s in index.active_services(datetime.fromisoformat(day).date())}  # noqa: E731
    wk, we = 0b0011111, 0b1100000
    assert names("2026-09-28") == {wk}  # a Monday
    assert names("2026-09-26") == {we}  # a Saturday
    assert names("2026-09-07") == {we}  # Labor Day: weekday service removed, weekend added
    assert index.active_services(datetime(2027, 1, 4).date()) == set()  # past the end date


# ---- trips ----------------------------------------------------------------------------------------


def test_direct_bus_with_walks_and_later_departures(index):
    r = index.plan(HOME, NEAR_A4, datetime(2026, 9, 28, 7, 20))
    assert r["status"] == "ok"
    best = r["options"][0]
    walk1, ride, walk2 = best["legs"]
    assert walk1["kind"] == walk2["kind"] == "walk" and walk1["to"]["name"] == "Main St @ Elgin St"
    assert ride["route"]["name"] == "10 Main" and ride["route"]["mode"] == "bus"
    assert ride["headsign"] == "Downtown TC"
    assert ride["depart_at"] == datetime(2026, 9, 28, 7, 30) and ride["arrive_at"] == datetime(2026, 9, 28, 7, 42)
    assert ride["stops"] == 3 and ride["minutes"] == 12
    # Leave in time to walk to the stop; arrive after the last walk (whole minutes).
    assert best["leave_at"] == datetime(2026, 9, 28, 7, 29) and best["arrive_at"] == datetime(2026, 9, 28, 7, 43)
    assert best["changes"] == 0 and best["later"] == [datetime(2026, 9, 28, 7, 50)]
    # The ride follows the route's shape between the two stops.
    assert len(ride["geometry"]) >= 4
    assert ride["geometry"][0] == pytest.approx([29.74, -95.38], abs=1e-4)
    assert ride["geometry"][-1] == pytest.approx([29.755, -95.374], abs=1e-4)


def test_one_change_with_a_short_walk_between_stops(index):
    r = index.plan(HOME, NEAR_B3, datetime(2026, 9, 28, 7, 20))
    assert r["status"] == "ok"
    best = r["options"][0]
    assert rides(best) == ["10 Main", "20 Pease"] and best["changes"] == 1
    kinds = [leg["kind"] for leg in best["legs"]]
    assert kinds == ["walk", "ride", "walk", "ride", "walk"]
    change = best["legs"][2]
    assert change["from"]["name"] == "Main St @ Pease St" and change["to"]["name"] == "Pease St @ Travis St"
    second = best["legs"][3]
    assert second["depart_at"] == datetime(2026, 9, 28, 7, 45) and second["arrive_at"] == datetime(2026, 9, 28, 7, 55)
    # The first bus that still makes the change: T1 at 7:30 (T2 gets to Pease St at 7:58, too late).
    assert best["legs"][1]["depart_at"] == datetime(2026, 9, 28, 7, 30)


def test_missed_connection_waits_for_the_next_one(index):
    r = index.plan(HOME, NEAR_B3, datetime(2026, 9, 28, 7, 35))
    best = r["options"][0]
    # T1 is gone: T2 reaches Pease St at 7:58, then the 8:15 Pease bus.
    assert best["legs"][1]["depart_at"] == datetime(2026, 9, 28, 7, 50)
    assert best["legs"][3]["depart_at"] == datetime(2026, 9, 28, 8, 15)


def test_holiday_runs_the_weekend_timetable(index):
    r = index.plan(HOME, NEAR_A4, datetime(2026, 9, 7, 7, 20))
    assert r["options"][0]["legs"][1]["depart_at"] == datetime(2026, 9, 7, 8, 0)


def test_after_midnight_uses_the_previous_days_late_trips(index):
    r = index.plan(HOME, NEAR_A4, datetime(2026, 9, 29, 0, 20))
    assert r["status"] == "ok"
    ride = r["options"][0]["legs"][1]
    assert ride["route"]["name"] == "Red Line" and ride["route"]["mode"] == "rail"
    assert ride["headsign"] == "Fannin South"
    assert ride["depart_at"] == datetime(2026, 9, 29, 0, 30)


def test_late_trips_from_yesterday_compete_with_todays_first_ones(tmp_path):
    """At 0:20 both timetables run: yesterday's 24:30 train (in at 0:46) beats today's 0:50 bus."""
    feed = tmp_path / "feed"
    shutil.copytree(FEED, feed)
    with open(feed / "trips.txt", "a") as f:
        f.write("010,WK,E1,DOWNTOWN TC,0,SMAIN\n")
    with open(feed / "stop_times.txt", "a") as f:
        f.write("E1, 0:50:00, 0:50:00,A1,1,0,0\nE1, 1:05:00, 1:05:00,A4,2,0,0\n")
    build_index(feed, tmp_path / "t.db")
    r = TransitIndex(tmp_path / "t.db").plan(HOME, NEAR_A4, datetime(2026, 9, 29, 0, 20))
    assert [rides(o) for o in r["options"]] == [["Red Line"], ["10 Main"]]
    assert [o["arrive_at"] for o in r["options"]] == [datetime(2026, 9, 29, 0, 46), datetime(2026, 9, 29, 1, 6)]


def test_next_departures_near_the_start(index):
    r = index.plan(HOME, NEAR_A4, datetime(2026, 9, 28, 7, 20))
    first = r["nearby"][0]
    assert first["stop"]["name"] == "Main St @ Elgin St" and first["walk_min"] == 1
    # One line per route and direction: the next one.
    assert [(d["route"]["name"], d["at"]) for d in first["departures"]] == [("10 Main", datetime(2026, 9, 28, 7, 30))]
    # Only departures you can still walk to (1 min away): at 7:30 the 7:30 bus is gone.
    later = index.plan(HOME, NEAR_A4, datetime(2026, 9, 28, 7, 30))["nearby"][0]
    assert [d["at"] for d in later["departures"]] == [datetime(2026, 9, 28, 7, 50)]


def test_honest_answers_when_there_is_nothing(index):
    outside = index.plan(HOME, NEAR_A4, datetime(2027, 3, 1, 8, 0))
    assert outside["status"] == "outside_dates" and "Aug 1, 2026 to Dec 31, 2026" in outside["message"]
    none = index.plan(HOME, NEAR_A4, datetime(2026, 9, 28, 12, 0))
    assert none["status"] == "no_trips" and none["options"] == [] and none["nearby"] == []
    far = index.plan(FAR_AWAY, NEAR_A4, datetime(2026, 9, 28, 7, 20))
    assert far["status"] == "no_stops_start"
    far_end = index.plan(HOME, FAR_AWAY, datetime(2026, 9, 28, 7, 20))
    assert far_end["status"] == "no_stops_end"


def test_slice_line_cuts_between_the_nearest_points():
    line = [[0.0, 0.0], [0.0, 0.001], [0.0, 0.002], [0.0, 0.003]]
    cut = slice_line(line, [0.00001, 0.0005], [0.0, 0.0025])
    assert cut[0] == [0.0, 0.0005] and cut[-1] == [0.0, 0.0025] and cut[1:-1] == [[0.0, 0.001], [0.0, 0.002]]
    assert slice_line(line, [0.01, 0.0], [0.0, 0.002]) is None  # a stop far off the shape


# ---- API ------------------------------------------------------------------------------------------


@pytest.fixture
def client(services):
    services.clock.set(datetime(2026, 9, 28, 7, 20))
    with TestClient(create_app(services)) as c:
        yield c


def point(p):
    return {"lat": p[0], "lng": p[1]}


def test_api_trip_and_status(client, index):
    client.app.state.transit = index
    body = client.post("/transit/trip", json={"origin": point(HOME), "destination": point(NEAR_B3)}).json()
    assert body["status"] == "ok" and body["depart_at"] == "2026-09-28T07:20:00"
    assert body["legend"] == "Route and arrival data provided by permission of METRO"
    assert body["options"][0]["arrive_at"] == "2026-09-28T07:56:00"
    assert body["feed"]["start_date"] == "2026-08-01"
    later = client.post("/transit/trip", json={"origin": point(HOME), "destination": point(NEAR_A4), "depart_at": "07:45"}).json()
    assert later["options"][0]["legs"][1]["depart_at"] == "2026-09-28T07:50:00"
    status = client.get("/transit/status").json()
    assert status["loaded"] and status["covers_today"] and status["feed"]["routes"] == 3


def test_api_says_when_transit_isnt_loaded(client):
    client.app.state.transit = None
    body = client.post("/transit/trip", json={"origin": point(HOME), "destination": point(NEAR_A4)}).json()
    assert body["status"] == "not_loaded" and body["message"] == "Bus and rail times aren't loaded yet."
    assert client.get("/transit/status").json()["loaded"] is False


def test_api_rejects_points_outside_houston(client, index):
    client.app.state.transit = index
    r = client.post("/transit/trip", json={"origin": {"lat": 40.7, "lng": -74.0}, "destination": point(NEAR_A4)})
    assert r.status_code == 422 and "Houston" in r.json()["detail"]


def test_default_index_reopens_a_rebuilt_file_and_skips_a_broken_one(tmp_path):
    path = tmp_path / "transit.db"
    assert transit.default_index(path) is None  # not built yet
    build_index(FEED, path)
    first = transit.default_index(path)
    assert first is not None and transit.default_index(path) is first
    path.write_bytes(b"not a database")
    assert transit.default_index(path) is None
