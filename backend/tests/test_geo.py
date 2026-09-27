"""Place search and details (OpenStreetMap via Nominatim) and opening hours. Nothing here touches
the network: the geocoder gets a fake `fetch`."""

import io
import json
import urllib.parse
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.geo import nominatim
from app.geo.hours import hours_json, parse, status
from app.geo.nominatim import Cache, GeoUnavailable, Geocoder, RateLimiter, clean_phone, clean_url
from app.main import create_app

MON = datetime(2026, 9, 28)  # a Monday


def at(day: int, hh: int, mm: int = 0) -> datetime:
    """`day` days after Monday 2026-09-28 at hh:mm."""
    return MON + timedelta(days=day, hours=hh, minutes=mm)


# ---- opening hours ----------------------------------------------------------------------------


def test_parse_common_forms():
    assert parse("24/7") == [[(0, 1440)]] * 7
    week = parse("Mo-Fr 09:00-18:00; Sa 10:00-14:00; Su off")
    assert week[0] == week[4] == [(540, 1080)] and week[5] == [(600, 840)] and week[6] == []
    # several spans a day, and closing after midnight
    assert parse("Mo-Su 11:00-14:00,17:00-22:00")[2] == [(660, 840), (1020, 1320)]
    assert parse("Fr-Sa 18:00-02:00")[4] == [(1080, 1560)]
    # a later rule replaces an earlier one for its days; no weekday means every day
    week = parse("07:00-23:00; Su 08:00-20:00")
    assert week[0] == [(420, 1380)] and week[6] == [(480, 1200)]
    # wrapping day ranges, day lists, holidays skipped, en dashes, English day names
    week = parse("Fr-Mo 10:00–16:00; We,Th 12:00-13:00; PH off")
    assert [bool(d) for d in week] == [True, False, True, True, True, True, True]
    assert parse("Mon-Fri 8:00-17:00")[0] == [(480, 1020)]
    # commas between rules, as some mappers write them
    week = parse("Mo-Fr 08:00-17:00, Sa 09:00-12:00")
    assert week[0] == [(480, 1020)] and week[5] == [(540, 720)] and week[6] == []
    assert parse("Mo-Fr 00:00-24:00")[1] == [(0, 1440)]
    # 24/7 as one rule among others
    assert parse("24/7; PH off") == [[(0, 1440)]] * 7
    assert parse("Mo-Sa 24/7; Su 08:00-20:00")[6] == [(480, 1200)] and parse("Mo-Sa 24/7; Su 08:00-20:00")[0] == [(0, 1440)]


@pytest.mark.parametrize(
    "raw",
    ["", None, "sunrise-sunset", "Jan-Mar Mo-Fr 09:00-17:00", "Mo-Fr 09:00+", "Mo-Fr 9am-5pm",
     'Mo-Fr 09:00-17:00 "by appointment"', "Mo[1] 10:00-12:00", "PH off", "Mo-Fr", "week 1-20 Mo 10:00-12:00"],
)
def test_parse_gives_up_on_what_it_cant_read(raw):
    assert parse(raw) is None


def test_status_lines():
    week = parse("Mo-Fr 09:00-21:00; Sa 10:00-14:00; Su off")
    assert status(week, at(0, 12))["text"] == "Open now, closes 9 PM"
    assert status(week, at(0, 12))["open"] is True
    assert status(week, at(0, 20, 15))["text"] == "Closing soon, at 9 PM"
    assert status(week, at(0, 7))["text"] == "Closed, opens 9 AM"
    assert status(week, at(0, 8, 30))["text"] == "Opens soon, at 9 AM"
    assert status(week, at(0, 22))["text"] == "Closed, opens 9 AM tomorrow"
    closed_sat = status(week, at(5, 15))
    assert closed_sat == {"open": False, "text": "Closed, opens Mon 9 AM", "closes_at": None, "opens_at": "2026-10-05T09:00:00"}
    assert status(parse("24/7"), at(2, 3))["text"] == "Open 24 hours"
    assert status(parse("Mo-Sa 00:00-24:00"), at(1, 10))["text"] == "Open 24 hours today"
    assert status(parse("Mo off"), at(0, 10))["text"] == "Closed"
    assert status(parse("Mo-Fr 09:30-17:00"), at(0, 7))["text"] == "Closed, opens 9:30 AM"


def test_status_past_midnight():
    week = parse("Mo-Th 11:00-22:00; Fr-Sa 11:00-02:00; Su 12:00-21:00")
    # Friday night's hours run into Saturday 1 AM
    assert status(week, at(5, 1))["text"] == "Closing soon, at 2 AM"
    assert status(week, at(4, 20))["text"] == "Open now, closes 2 AM"
    assert status(week, at(5, 3))["text"] == "Closed, opens 11 AM"
    # open until midnight
    assert status(parse("Mo-Su 06:00-24:00"), at(0, 12))["text"] == "Open now, closes 12 AM"


def test_hours_json():
    h = hours_json("Mo-Fr 09:00-18:00; Sa 10:00-14:00,15:00-17:30", at(0, 10))
    assert h["open"] is True and h["text"] == "Open now, closes 6 PM" and h["today"] == "Mon"
    assert h["week"][0] == {"day": "Mon", "hours": "9 AM–6 PM"}
    assert h["week"][5] == {"day": "Sat", "hours": "10 AM–2 PM, 3 PM–5:30 PM"}
    assert h["week"][6] == {"day": "Sun", "hours": "Closed"}
    assert hours_json("24/7", at(0, 10))["week"][3]["hours"] == "Open 24 hours"
    raw = hours_json("Mo-Fr 09:00-17:00; Sa 10:00-12:00 \"call first\"", at(0, 10))
    assert raw == {"raw": 'Mo-Fr 09:00-17:00; Sa 10:00-12:00 "call first"', "open": None, "text": None,
                   "closes_at": None, "opens_at": None, "week": None, "today": None}
    assert hours_json(None, at(0, 10)) is None


# ---- cleaning tags -----------------------------------------------------------------------------


def test_clean_url():
    assert clean_url("https://www.heb.com/") == "https://www.heb.com/"
    assert clean_url("www.example.com/menu") == "https://www.example.com/menu"
    assert clean_url("http://a.example.org;https://b.example.org") == "http://a.example.org"
    for bad in ("javascript:alert(1)", "ftp://files.example.com", "http://localhost", "https://u:p@x.example.com",
                "not a url", "", None, "https://exa mple.com"):
        assert clean_url(bad) is None, bad


def test_clean_phone():
    assert clean_phone("+1 713-522-3029") == {"display": "(713) 522-3029", "tel": "+17135223029"}
    assert clean_phone("713.522.3029") == {"display": "(713) 522-3029", "tel": "+17135223029"}
    assert clean_phone("+1-281-212-8800;+1-281-212-8801") == {"display": "(281) 212-8800", "tel": "+12812128800"}
    assert clean_phone("+44 20 7946 0958") == {"display": "+44 20 7946 0958", "tel": "+442079460958"}
    assert clean_phone("call us") is None and clean_phone(None) is None


# ---- the geocoder ------------------------------------------------------------------------------


def nominatim_row(osm_id: int, name: str, lat: float, lng: float, *, typ="cafe", category="amenity", importance=0.0001,
                  tags=None, **address):
    return {
        "osm_type": "way", "osm_id": osm_id, "lat": str(lat), "lon": str(lng), "category": category, "type": typ,
        "name": name, "importance": importance, "display_name": f"{name}, Houston, Texas",
        "address": {"city": "Houston", **address}, "extratags": tags,
    }


STARBUCKS = [
    nominatim_row(1, "Starbucks", 29.76, -95.37, house_number="1600", road="Lamar Street", suburb="Downtown",
                  tags={"opening_hours": "Mo-Su 06:00-20:00", "phone": "+1 713-555-0101", "website": "https://www.starbucks.com/x"}),
    nominatim_row(2, "Starbucks", 29.7422, -95.3905, house_number="3407", road="Montrose Boulevard", suburb="Montrose"),
    nominatim_row(3, "Starbucks", 29.7533, -95.4103, road="West Gray Street", suburb="Montrose"),
]


class FakeNominatim:
    """Answers like Nominatim from canned rows; records every URL asked for."""

    def __init__(self, search=None, lookup=None):
        self.search, self.lookup = search or {}, lookup or {}
        self.urls: list[str] = []
        self.down = False

    def __call__(self, url: str):
        self.urls.append(url)
        if self.down:
            raise TimeoutError("timed out")
        u = urllib.parse.urlsplit(url)
        q = dict(urllib.parse.parse_qsl(u.query))
        assert q["format"] == "jsonv2" and q["extratags"] == "1"
        if u.path.endswith("/lookup"):
            return self.lookup.get(q["osm_ids"], [])
        assert q["bounded"] == "1" and len(q["viewbox"].split(",")) == 4
        wide = float(q["viewbox"].split(",")[0]) < -96
        return self.search.get((q["q"].lower(), "houston" if wide else "near"), [])

    def params(self, i: int) -> dict:
        return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.urls[i]).query))


class Clock:
    def __init__(self):
        self.t = datetime(2026, 9, 27, 12, 0)

    def __call__(self):
        return self.t


def make_geo(fake, session_factory=None, clock=None) -> Geocoder:
    return Geocoder(session_factory, fetch=fake, base_url="https://nominatim.test", limiter=RateLimiter(0),
                    now=clock or Clock())


def test_search_near_you_sorts_closest_first_and_caches():
    fake = FakeNominatim(search={("starbucks", "near"): STARBUCKS})
    geo = make_geo(fake)
    near = (29.7432, -95.3808)  # Midtown
    results, stale = geo.search("  Starbucks ", near)
    assert not stale and [r["id"] for r in results] == ["W2", "W1", "W3"]
    assert results[0]["address"] == "3407 Montrose Boulevard, Montrose" and results[0]["kind"] == "Cafe"
    p = fake.params(0)
    left, top, right, bottom = map(float, p["viewbox"].split(","))
    assert left < near[1] < right and bottom < near[0] < top and right - left < 0.2
    assert len(fake.urls) == 1  # 3 results near you: the whole area wasn't asked
    # asked again: from the cache, no request; and each result's details are cached too
    assert geo.search("starbucks", near)[0] == results and len(fake.urls) == 1
    details, _ = geo.place("W1")
    assert details["phone"]["tel"] == "+17135550101" and details["opening_hours"] == "Mo-Su 06:00-20:00"
    assert len(fake.urls) == 1


def test_search_falls_back_to_all_of_houston_and_keeps_landmarks_on_top():
    rice = nominatim_row(45185995, "Rice University", 29.717, -95.402, typ="university", importance=0.59)
    rice_cafe = nominatim_row(7, "Rice University Cafe", 29.745, -95.381)
    fake = FakeNominatim(search={("rice university", "near"): [], ("rice university", "houston"): [rice_cafe, rice]})
    results, _ = make_geo(fake).search("rice university", (29.7432, -95.3808))
    assert [r["name"] for r in results] == ["Rice University", "Rice University Cafe"]
    assert len(fake.urls) == 2 and float(fake.params(1)["viewbox"].split(",")[0]) < -96


def test_search_without_a_point_asks_all_of_houston():
    fake = FakeNominatim(search={("1600 smith st", "houston"): [nominatim_row(9, "", 29.75, -95.37, typ="house", category="place",
                                                                               house_number="1600", road="Smith Street", suburb="Downtown")]})
    results, _ = make_geo(fake).search("1600 smith st")
    assert results == [{"id": "W9", "name": "1600 Smith Street", "address": "Downtown", "lat": 29.75, "lng": -95.37,
                        "kind": "Address", "importance": 0.0001, "phone": None, "website": None, "opening_hours": None,
                        "brand": None, "cuisine": None}]


def test_kinds_and_address_lines():
    def one(**kw):
        row = nominatim_row(1, kw.pop("name", "X"), 29.75, -95.37, **kw)
        return nominatim.place_json(row)

    assert one(typ="residential", category="highway")["kind"] == "Street"
    assert one(typ="motorway", category="highway")["kind"] == "Freeway"
    assert one(typ="residential", category="building")["kind"] == "Apartments"
    assert one(typ="yes", category="building")["kind"] == "Building"
    assert one(typ="fuel")["kind"] == "Gas station"
    assert one(typ="fast_food")["kind"] == "Fast food"
    assert one(typ="ice_cream")["kind"] == "Ice cream"
    # a house number without its street isn't an address line; other cities are named
    assert one(house_number="3363", suburb="Uptown")["address"] == "Uptown"
    assert one(road="Main Street", city="Katy")["address"] == "Main Street, Katy"


def test_down_without_cache_raises_and_with_cache_serves_stale(session_factory):
    fake = FakeNominatim(search={("starbucks", "near"): STARBUCKS})
    clock = Clock()
    geo = make_geo(fake, session_factory, clock)
    near = (29.7432, -95.3808)
    fresh, _ = geo.search("starbucks", near)
    fake.down = True
    with pytest.raises(GeoUnavailable, match="down"):
        geo.search("walmart", near)
    clock.t += timedelta(days=2)  # expired, and the geocoder is down: the old answer, marked stale
    results, stale = geo.search("starbucks", near)
    assert stale and results == fresh
    # a restart (new geocoder, empty memory) still has it in SQLite
    again = make_geo(FakeNominatim(), session_factory, clock)
    again.fetch.down = True
    assert again.search("starbucks", near) == (fresh, True)


def test_search_stays_in_houston_for_a_point_outside_it():
    fake = FakeNominatim(search={("starbucks", "houston"): STARBUCKS})
    results, _ = make_geo(fake).search("starbucks", (40.7128, -74.0060))  # New York
    assert len(fake.urls) == 1 and float(fake.params(0)["viewbox"].split(",")[0]) < -96
    assert {r["id"] for r in results} == {"W1", "W2", "W3"}


def test_down_near_a_new_spot_serves_the_saved_answer_for_all_of_houston(session_factory):
    rice = nominatim_row(45185995, "Rice University", 29.717, -95.402, typ="university", importance=0.59)
    fake = FakeNominatim(search={("rice university", "near"): [], ("rice university", "houston"): [rice]})
    clock = Clock()
    geo = make_geo(fake, session_factory, clock)
    geo.search("rice university", (29.7432, -95.3808))  # near Midtown: nothing close, so all of Houston too
    fake.down = True
    fake.urls.clear()
    # From somewhere else (no saved answer for that spot): the saved one for the whole area, marked
    # stale, after a single failed request (not a second wait for the same outage).
    results, stale = geo.search("rice university", (29.7604, -95.4600))
    assert stale and [r["name"] for r in results] == ["Rice University"] and len(fake.urls) == 1
    clock.t += timedelta(days=3)
    assert geo.search("rice university", (29.7000, -95.3000))[1] is True
    with pytest.raises(GeoUnavailable, match="down"):
        geo.search("walmart", (29.7604, -95.4600))


def test_nothing_near_you_and_the_area_down_says_down_not_nothing_found():
    fake = FakeNominatim(search={("heb", "near"): []})

    def fetch(url):
        if float(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))["viewbox"].split(",")[0]) < -96:
            raise TimeoutError("timed out")
        return fake(url)

    with pytest.raises(GeoUnavailable, match="down"):
        make_geo(fetch).search("heb", (29.7432, -95.3808))


def test_nothing_found_is_cached_for_a_short_while():
    fake = FakeNominatim()
    clock = Clock()
    geo = make_geo(fake, clock=clock)
    assert geo.place("N42") == (None, False)
    assert geo.place("N42") == (None, False) and len(fake.urls) == 1
    clock.t += timedelta(hours=2)
    geo.place("N42")
    assert len(fake.urls) == 2


def test_find_by_name_near_a_point():
    shell = nominatim_row(5, "Shell", 29.7348, -95.3909, typ="fuel", tags={"opening_hours": "24/7"})
    far = nominatim_row(6, "Shell", 29.7400, -95.3909, typ="fuel")  # ~580 m away: another station
    fake = FakeNominatim(search={("shell", "near"): [far, shell]})
    d, _ = make_geo(fake).find("Shell", 29.7349, -95.3910)
    assert d["id"] == "W5" and d["kind"] == "Gas station" and d["opening_hours"] == "24/7"
    d, _ = make_geo(fake).find("Shell", 29.7500, -95.3910)
    assert d is None


def test_rate_limiter_spaces_calls_and_refuses_long_waits():
    t = [100.0]
    slept: list[float] = []

    def sleep(s):
        slept.append(s)
        t[0] += s

    lim = RateLimiter(interval=1.0, max_wait=2.5, clock=lambda: t[0], sleep=sleep)
    lim.wait()
    lim.wait()
    assert slept == [1.0]
    # three callers at once: the third would wait 2 s (fine), a fourth 3 s (refused)
    lim2 = RateLimiter(interval=1.0, max_wait=2.5, clock=lambda: 0.0, sleep=lambda s: None)
    lim2.wait(), lim2.wait(), lim2.wait()
    with pytest.raises(GeoUnavailable, match="busy"):
        lim2.wait()


def test_http_json_sends_our_user_agent_with_a_timeout(monkeypatch):
    seen = {}

    def urlopen(req, timeout):
        seen["ua"], seen["timeout"], seen["url"] = req.get_header("User-agent"), timeout, req.full_url
        return io.BytesIO(json.dumps([]).encode())

    monkeypatch.setattr(nominatim.urllib.request, "urlopen", urlopen)
    assert nominatim.http_json("https://nominatim.test/search?q=x") == []
    assert seen["ua"].startswith("BlindSpot/") and 0 < seen["timeout"] <= 10


def test_cache_memory_is_bounded():
    c = Cache(size=2)
    now = datetime(2026, 9, 27)
    for k in "abc":
        c.put(k, [k], now)
    assert c.get("a") is None and c.get("c") == (["c"], now)


# ---- API ---------------------------------------------------------------------------------------


@pytest.fixture
def geo_client(services):
    fake = FakeNominatim(
        search={("starbucks", "near"): STARBUCKS},
        lookup={
            "W425632238": [nominatim_row(425632238, "Shell", 29.7348, -95.3909, typ="fuel",
                                         tags={"opening_hours": "Mo-Fr 06:00-22:00; Sa-Su 08:00-20:00",
                                               "contact:phone": "713-555-0123", "website": "javascript:alert(1)"})],
        },
    )
    app = create_app(services)
    app.state.geocoder = make_geo(fake, services.session_factory)
    with TestClient(app) as c:
        c.fake = fake
        yield c


def test_geocode_endpoint(geo_client):
    r = geo_client.get("/geocode", params={"q": "starbucks", "lat": 29.7432, "lng": -95.3808, "limit": 2})
    assert r.status_code == 200
    body = r.json()
    assert [x["id"] for x in body["results"]] == ["W2", "W1"] and not body["stale"]
    assert body["results"][0]["distance_km"] == pytest.approx(0.94, abs=0.03)
    assert set(body["results"][0]) == {"id", "name", "address", "lat", "lng", "kind", "distance_km"}
    assert "OpenStreetMap" in body["attribution"]
    assert geo_client.get("/geocode", params={"q": "st"}).status_code == 422
    assert geo_client.get("/geocode", params={"q": "   "}).status_code == 422
    geo_client.fake.down = True
    down = geo_client.get("/geocode", params={"q": "walmart"})
    assert down.status_code == 503 and "down" in down.json()["detail"]


def test_details_endpoint_hours_at_the_app_clock(geo_client, services):
    services.clock.set(datetime(2026, 9, 28, 21, 30))  # Monday 9:30 PM, Houston time
    d = geo_client.get("/geocode/details", params={"osm": "W425632238"}).json()
    assert d["name"] == "Shell" and d["kind"] == "Gas station"
    assert d["hours"]["text"] == "Closing soon, at 10 PM" and d["hours"]["open"] is True
    assert d["phone"] == {"display": "(713) 555-0123", "tel": "+17135550123"}
    assert d["website"] is None  # not an http(s) link: never shown
    later = geo_client.get("/geocode/details", params={"osm": "W425632238", "at": "2026-10-03T07:00:00"}).json()
    assert later["hours"]["text"] == "Opens soon, at 8 AM"
    # from a search result: details were cached with it, no new request
    geo_client.get("/geocode", params={"q": "starbucks", "lat": 29.7432, "lng": -95.3808})
    n = len(geo_client.fake.urls)
    s = geo_client.get("/geocode/details", params={"osm": "W1"}).json()
    assert s["website"] == "https://www.starbucks.com/x" and len(geo_client.fake.urls) == n


def test_details_endpoint_errors(geo_client):
    assert geo_client.get("/geocode/details", params={"osm": "W999"}).status_code == 404
    assert geo_client.get("/geocode/details", params={"osm": "X12"}).status_code == 422
    assert geo_client.get("/geocode/details").status_code == 422
    assert geo_client.get("/geocode/details", params={"name": "Shell"}).status_code == 422
    geo_client.fake.down = True
    assert geo_client.get("/geocode/details", params={"osm": "N777"}).status_code == 503
