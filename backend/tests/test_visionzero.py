from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.seed.network import LINKS, node_latlng, segment_profiles
from app.seed.synthetic import SyntheticWorld
from app.seed.visionzero import MAX_FACTOR, crash_factor, hin_segments, match, street_keys


def _link(code):
    return next(link for link in LINKS if link.code == code)


def _match(code):
    link = _link(code)
    return match(link.name, node_latlng(link.a), node_latlng(link.b))


def test_street_keys_normalize_names():
    assert street_keys("WESTHEIMER RD") == street_keys("Westheimer Rd") == {"WESTHEIMER"}
    assert street_keys("Lawndale / Cullen Blvd") == {"LAWNDALE", "CULLEN"}
    assert street_keys("Hardy / Quitman St") == {"HARDY", "QUITMAN"}
    assert street_keys("N Main / Airline Dr") == {"MAIN", "AIRLINE"}
    assert street_keys("Wayside Dr / Clinton Dr") == {"WAYSIDE", "CLINTON"}
    assert street_keys("Telephone Rd South") == street_keys("TELEPHONE RD") == {"TELEPHONE"}
    assert street_keys("W HOLCOMBE BLVD") == {"HOLCOMBE"}
    assert street_keys("Old Spanish Trail") == street_keys("OLD SPANISH TRL") == {"OLD SPANISH"}


def test_hin_data_loads():
    segs = hin_segments()
    assert len(segs) == 1080
    assert sum(s.crashes for s in segs) == 4620 and sum(s.deaths for s in segs) == 762
    westheimer = [s for s in segs if s.name == "WESTHEIMER RD"]
    assert sum(s.crashes for s in westheimer) == 237 and sum(s.deaths for s in westheimer) == 61


@pytest.mark.parametrize("code,street", [("WHMR", "WESTHEIMER"), ("MAIN", "MAIN"), ("CULL", "CULLEN"), ("TELE", "TELEPHONE")])
def test_streets_match_hin_rows_by_name_and_place(code, street):
    hits = _match(code)
    assert hits and all(street in s.name for s in hits)
    # Only the stretch near our link, not the whole street across town.
    assert len(hits) < sum(1 for s in hin_segments() if street_keys(s.name) & {street})


def test_matched_streets_get_a_higher_crash_prior_than_unmatched():
    whmr, ost = _link("WHMR"), _link("OST")
    assert _match("OST") == []  # nearest Old Spanish Trail HIN row is ~1.2 km off our link
    assert crash_factor(ost.name, node_latlng(ost.a), node_latlng(ost.b)) == 1.0
    f = crash_factor(whmr.name, node_latlng(whmr.a), node_latlng(whmr.b))
    assert 1.0 < f <= MAX_FACTOR

    profiles = {p.segment_id: p for p in segment_profiles()}
    assert profiles["WHMR:galleria>i69_610sw"].crash_mult == pytest.approx(f)
    assert profiles["OST:ost_cullen>tmc_288"].crash_mult == 1.0


def test_matched_street_crashes_more_per_mile_in_the_synthetic_history():
    profiles = [p for p in segment_profiles() if p.segment_id.startswith(("WHMR:", "OST:"))]
    world = SyntheticWorld(profiles=profiles)
    counts = {"WHMR": 0, "OST": 0}
    for d in range(365):
        for c in world.crashes(date(2025, 1, 1) + timedelta(days=d)):
            counts[c.segment_id.split(":")[0]] += 1
    miles = {code: sum(p.length_m for p in profiles if p.segment_id.startswith(code)) / 1609.344 for code in counts}
    assert counts["WHMR"] / miles["WHMR"] > 1.5 * counts["OST"] / miles["OST"]


def test_freeways_keep_their_synthetic_crash_mult():
    by_code = {}
    for link in LINKS:
        by_code.setdefault(link.code, set()).add(link.crash_mult)
    for p in segment_profiles():
        if p.road_class == "freeway":
            assert p.crash_mult in by_code[p.segment_id.split(":")[0]]
    # No street outranks the worst freeway links.
    worst_freeway = max(link.crash_mult for link in LINKS if link.road_class == "freeway")
    assert all(p.crash_mult * 0.5 < worst_freeway for p in segment_profiles() if p.road_class == "arterial")


@pytest.fixture
def client(services):
    with TestClient(create_app(services)) as c:
        yield c


def test_high_injury_endpoint_lists_worst_segments_first(client):
    body = client.get("/hazards/high-injury").json()
    assert body["source"] == "City of Houston Vision Zero HIN 2025"
    segs = body["segments"]
    assert len(segs) == 20 and segs[0]["name"] == "Westheimer Rd"
    assert segs[0]["crashes"] == 21 and segs[0]["deaths"] == 6
    assert [s["crashes"] for s in segs] == sorted((s["crashes"] for s in segs), reverse=True)
    assert set(segs[0]) == {"name", "crashes", "deaths", "miles", "crash_rate", "lat", "lng"}


def test_high_injury_endpoint_filters_by_bbox(client):
    segs = client.get("/hazards/high-injury", params={"limit": 5, "bbox": "-95.45,29.70,-95.30,29.78"}).json()["segments"]
    assert len(segs) == 5
    assert all(-95.45 <= s["lng"] <= -95.30 and 29.70 <= s["lat"] <= 29.78 for s in segs)
    assert client.get("/hazards/high-injury", params={"bbox": "nope"}).status_code == 422


def test_live_points_at_the_high_injury_layer(client):
    assert client.get("/live").json()["high_injury_segments_url"] == "/hazards/high-injury"
