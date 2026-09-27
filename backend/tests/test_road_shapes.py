"""Road segments are drawn along the real roads (app/seed/road_shapes.json, from OpenStreetMap)."""

import math

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed.network import (
    haversine_m,
    iter_directed,
    node_latlng,
    road_shapes,
    segment_geometry,
    segment_id,
)


@pytest.fixture
def client(services):
    with TestClient(create_app(services)) as c:
        yield c


def test_every_segment_has_a_traced_shape_pinned_to_its_nodes():
    shapes = road_shapes()["segments"]
    for link, frm, to in iter_directed():
        sid = segment_id(link, frm, to)
        assert len(shapes.get(sid, [])) >= 2, sid
        geom = segment_geometry(sid, frm, to)
        assert len(geom) > 2, sid  # a real road, not a straight line
        assert geom[0] == list(node_latlng(frm)) and geom[-1] == list(node_latlng(to)), sid
        # The traced road starts and ends near its interchanges (they're approximate points).
        assert haversine_m(tuple(shapes[sid][0]), node_latlng(frm)) < 2500, sid
        assert haversine_m(tuple(shapes[sid][-1]), node_latlng(to)) < 2500, sid


def _to_line_m(p, line) -> float:
    """Meters from a point to the nearest point on a polyline (flat-earth, fine at city scale)."""
    k = math.cos(math.radians(p[0]))
    xy = lambda q: (q[1] * 111_320 * k, q[0] * 111_320)  # noqa: E731
    px, py = xy(p)
    best = math.inf
    for a, b in zip(line, line[1:]):
        (ax, ay), (bx, by) = xy(a), xy(b)
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(px - (ax + t * dx), py - (ay + t * dy)))
    return best


def test_rail_crossings_sit_on_their_street(client):
    crossings = client.get("/crossings").json()["crossings"]
    segments = {s["id"]: s["geometry"] for s in client.get("/segments").json()}
    for c in crossings:
        off = _to_line_m((c["lat"], c["lng"]), segments[c["segment_ids"][0]])
        assert off < 30, (c["id"], off)


def test_route_follows_the_road_shapes(client):
    best = client.post("/route", json={"origin": "downtown", "destination": "hobby"}).json()["best"]
    assert len(best["geometry"]) > 20


def test_an_old_database_gets_the_traced_roads_on_startup(services):
    from sqlalchemy import select

    from app.models import RoadSegment
    from app.seed.network import refresh_shapes

    with services.session_factory() as s:
        for seg in s.scalars(select(RoadSegment)):
            seg.geometry = [seg.geometry[0], seg.geometry[-1]]  # how databases seeded before looked
        s.commit()
        assert refresh_shapes(s) >= 82
        assert min(len(seg.geometry) for seg in s.scalars(select(RoadSegment))) > 2
        assert refresh_shapes(s) == 0  # nothing left to change
