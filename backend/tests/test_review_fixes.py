"""Regression tests for bugs found in review."""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.db import init_db
from app.main import create_app
from app.models import Trip
from app.recommender import recommend_departure

MON = lambda h, m=0: datetime(2026, 9, 28, h, m)  # noqa: E731


def _trip(services, **kw):
    with services.session_factory() as s:
        trip = Trip(
            name=kw.get("name", "Work"),
            origin=kw.get("origin", "eastend"),
            destination=kw.get("destination", "medcenter"),
            arrive_by=kw.get("arrive_by", "08:00"),
            days=kw.get("days", "0,1,2,3,4"),
            safe_path=kw.get("safe_path", False),
        )
        s.add(trip)
        s.commit()
        return trip.id


# --- recommender ----------------------------------------------------------------------------


def test_leaving_at_earliest_is_on_time_when_it_fits(services):
    # Grid departures 08:30..08:15 all miss by seconds; leaving at 08:14 makes it.
    rec = recommend_departure(services.router, "downtown", "galleria", MON(8, 30), earliest=MON(8, 14))
    assert rec.depart_at == MON(8, 14)
    assert rec.on_time == (rec.eta + timedelta(minutes=5) <= MON(8, 30))
    assert rec.on_time


def test_on_time_always_matches_the_route(services):
    for minute in range(0, 40, 3):
        rec = recommend_departure(services.router, "eastend", "medcenter", MON(8, 0), earliest=MON(7, minute))
        assert rec.on_time == (rec.eta + timedelta(minutes=rec.buffer_min) <= MON(8, 0))
        assert rec.depart_at >= MON(7, minute)


# --- scheduler ------------------------------------------------------------------------------


def test_late_leave_now_uses_real_eta_from_now(services):
    _trip(services)
    services.clock.set(MON(7, 5))
    [plan] = services.tick()
    assert "7:35" in plan.title
    services.clock.set(MON(7, 52))  # the user missed the ideal departure
    [leave] = services.tick()
    assert leave.kind == "leave_now"
    assert "running late" in leave.title
    real = services.router.best_route("eastend", "medcenter", MON(7, 52))
    assert real.arrive_at.strftime("%-I:%M %p") in leave.body
    assert "7:38 AM" not in leave.body  # no stale reasons about a train we already missed


def test_trip_arriving_after_midnight_gets_plan_the_night_before(services):
    _trip(services, origin="greenspoint", destination="hobby", arrive_by="00:15", days="0")
    services.clock.set(datetime(2026, 9, 27, 22, 0))  # Sunday night, Monday 00:15 arrival
    [plan] = services.tick()
    assert plan.kind == "plan"
    rec = recommend_departure(services.router, "greenspoint", "hobby", MON(0, 15))
    services.clock.set(rec.depart_at)
    [leave] = services.tick()
    assert leave.kind == "leave_now" and "running late" not in leave.title


def test_one_broken_trip_does_not_block_others(services):
    _trip(services, name="Broken", arrive_by="24:00")  # bypasses API validation
    _trip(services, name="Good")
    services.clock.set(MON(7, 5))
    sent = services.tick()
    assert [n.title for n in sent] == ["Good: leave at 7:35 AM"]


# --- API ------------------------------------------------------------------------------------


@pytest.fixture
def client(services):
    services.clock.set(MON(7, 15))
    with TestClient(create_app(services)) as c:
        yield c


@pytest.mark.parametrize(
    "body",
    [
        {"arrive_by": "24:00"},
        {"arrive_by": "08:60"},
        {"arrive_by": "8:30"},
        {"arrive_by": "08:30", "days": [7]},
        {"arrive_by": "08:30", "days": []},
    ],
)
def test_trip_validation_rejects_bad_times_and_days(client, body):
    r = client.post("/trips", json={"origin": "eastend", "destination": "downtown", **body})
    assert r.status_code == 422


def test_recommend_passed_clock_time_means_tomorrow(client, services):
    services.clock.set(MON(17, 3))
    body = client.post("/recommend", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:30"}).json()
    assert body["depart_at"].startswith("2026-09-29T") and body["on_time"]


def test_recommend_passed_iso_deadline_says_leave_now_late(client, services):
    services.clock.set(MON(9, 0))
    body = client.post(
        "/recommend", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "2026-09-28T08:30:00"}
    ).json()
    assert body["depart_at"].startswith("2026-09-28T09:00") and not body["on_time"]


def test_notification_ids_are_not_reused_after_reset(client):
    client.post("/trips", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:00"})
    first = client.post("/demo/advance-clock", json={"to": "2026-09-28T07:05:00"}).json()["notifications"]
    client.post("/demo/reset")
    client.post("/trips", json={"origin": "eastend", "destination": "medcenter", "arrive_by": "08:00"})
    second = client.post("/demo/advance-clock", json={"to": "2026-09-28T07:05:00"}).json()["notifications"]
    assert first and second and second[0]["id"] > first[0]["id"]


# --- services / db --------------------------------------------------------------------------


def test_replay_swaps_in_a_fresh_store(services):
    old_models, old_count = services.models, len(services.models.store)
    services.replay(7)
    assert services.models is not old_models
    assert len(old_models.store) == old_count  # anything still using the old store stays whole
    assert services.scheduler.router is services.router


def test_init_db_adds_columns_missing_from_older_databases():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE trip_states (id INTEGER PRIMARY KEY, trip_id INTEGER, day DATE, "
            "last_departure DATETIME, leave_now_sent BOOLEAN)"
        ))
    init_db(engine)
    assert "last_route" in {c["name"] for c in inspect(engine).get_columns("trip_states")}
    init_db(engine)  # idempotent


# --- reasons --------------------------------------------------------------------------------


def test_avoided_reason_names_the_stretch_when_route_still_uses_that_road(services):
    safe, _ = services.router.route("downtown", "hobby", MON(17, 10), safe_path=True)
    assert "I-45 Gulf Fwy" in {s.name for s in safe.segments}
    avoided = [r for r in safe.reasons if r.startswith("Avoided I-45 Gulf Fwy")]
    assert avoided and all(" from " in r and " to " in r for r in avoided)


def test_no_safe_path_brag_when_exposure_barely_changes(services):
    safe, _ = services.router.route("medcenter", "eastend", MON(17, 10), safe_path=True)
    assert not any(r.startswith("Safe Path:") for r in safe.reasons)
