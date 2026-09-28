"""Weekday alerts for any place: a searched address, a business, a dropped pin (a point, not a place id)."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text

from app.db import init_db
from app.main import create_app
from app.models import parse_point, point_key

EADO = {"lat": 29.7482, "lng": -95.3505}


@pytest.fixture
def client(services):
    services.clock.set(services.clock.now().replace(hour=7, minute=15))
    with TestClient(create_app(services)) as c:
        yield c


def test_point_keys():
    assert parse_point(point_key(29.7482, -95.3505)) == (29.7482, -95.3505)
    assert parse_point("downtown") is None and parse_point("a,b") is None


def test_a_trip_to_a_point_saves_with_its_name(client):
    body = {"name": "Midtown → EaDo", "origin": "midtown", "destination": EADO,
            "destination_name": "EaDo", "arrive_by": "08:00"}
    r = client.post("/trips", json=body)
    assert r.status_code == 201
    trip = r.json()
    assert trip["origin"] == "midtown" and trip["destination"] == EADO
    assert trip["destination_name"] == "EaDo" and trip["origin_name"] is None
    assert client.get("/trips").json() == [trip]
    # The same trip again is the one already saved, not a second alert.
    again = client.post("/trips", json=body)
    assert again.status_code == 200 and again.json()["id"] == trip["id"]
    # A point as the start too.
    both = client.post("/trips", json={**body, "origin": {"lat": 29.7400, "lng": -95.3800}, "origin_name": "Home"})
    assert both.status_code == 201 and both.json()["origin"] == {"lat": 29.74, "lng": -95.38}


def test_the_scheduler_alerts_for_a_point_trip_by_its_name(client):
    client.post("/trips", json={"name": "Midtown → EaDo", "origin": "midtown", "destination": EADO,
                                "destination_name": "EaDo", "arrive_by": "08:00"})
    r = client.post("/demo/advance-clock", json={"to": "2026-09-28T07:05:00"}).json()
    assert [n["kind"] for n in r["notifications"]] == ["plan"]
    assert "EaDo" in r["notifications"][0]["title"]
    assert "Dropped pin" not in r["notifications"][0]["title"]


def test_an_old_database_gets_the_point_name_columns(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    init_db(engine)
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE trips DROP COLUMN origin_name"))
        conn.execute(text("ALTER TABLE trips DROP COLUMN destination_name"))
    init_db(engine)
    assert {"origin_name", "destination_name"} <= {c["name"] for c in inspect(engine).get_columns("trips")}
