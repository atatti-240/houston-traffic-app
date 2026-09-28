"""Crash risk is shown to people as a 1% to 5% chance per trip; the router keeps its 0..1 score."""

import re

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.routing.router import crash_chance


@pytest.fixture
def client(services):
    with TestClient(create_app(services)) as c:
        yield c


def test_the_shown_chance_stays_between_1_and_5_percent():
    assert crash_chance(0.0) == 0.01
    assert crash_chance(1.0) == 0.05
    assert abs(crash_chance(0.5) - 0.03) < 1e-9
    assert crash_chance(-3) == 0.01 and crash_chance(7) == 0.05


def test_route_reasons_show_crash_risk_between_1_and_5_percent(client):
    shown = []
    for dest in ("hobby", "greenspoint", "energy", "galleria"):
        body = client.post("/route", json={"origin": "downtown", "destination": dest, "safety_weight": 1.0}).json()
        for r in [body["best"], *(body.get("routes") or [])]:
            for reason in r.get("reasons", []):
                shown += [float(p) for p in re.findall(r"crash risk[^%]*?(\d+(?:\.\d+)?)%", reason)]
    assert all(1.0 <= p <= 5.0 for p in shown), shown
