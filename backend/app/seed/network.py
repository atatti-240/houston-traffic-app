"""A small but realistic Houston road graph.

Coordinates are approximate. Freeway links follow the real corridors (I-45, I-10, I-610,
I-69/US-59, Beltway 8, SH-288, US-290). Surface-street alternates in the East End and Near
Northside carry the at-grade rail crossings, so trains actually change route choices.

Each link below becomes two directed RoadSegments. Profile multipliers feed the synthetic
generator only (they are the "ground truth" the models should rediscover from history).
"""

import math
from dataclasses import dataclass, field

from sqlalchemy import delete
from sqlalchemy.orm import Session

from app.models import Camera, Node, RailCrossing, RoadSegment, ScoreEntry

DOWNTOWN = (29.7604, -95.3698)

# id: (name, lat, lng, is_place)
NODES: dict[str, tuple[str, float, float, bool]] = {
    # Named places (origin/destination picker)
    "downtown": ("Downtown", 29.7604, -95.3698, True),
    "midtown": ("Midtown", 29.7420, -95.3780, True),
    "galleria": ("Galleria / Uptown", 29.7390, -95.4637, True),
    "medcenter": ("Texas Medical Center", 29.7079, -95.4010, True),
    "energy": ("Energy Corridor", 29.7830, -95.6300, True),
    "greenspoint": ("Greenspoint", 29.9460, -95.4170, True),
    "eastend": ("East End", 29.7400, -95.3100, True),
    "heights": ("The Heights", 29.7980, -95.3980, True),
    "nns": ("Near Northside", 29.7920, -95.3530, True),
    "hobby": ("Hobby Airport", 29.6454, -95.2789, True),
    # Freeway interchanges
    "i10_610w": ("I-10 / 610 West", 29.7845, -95.4555, False),
    "i69_610sw": ("I-69 / 610 West", 29.7320, -95.4590, False),
    "288_610s": ("SH-288 / 610 South", 29.6835, -95.3850, False),
    "i45_610s": ("I-45 / 610 South", 29.6920, -95.2920, False),
    "i10_610e": ("I-10 / 610 East", 29.7785, -95.2660, False),
    "i45_610n": ("I-45 / 610 North", 29.8085, -95.3930, False),
    "290_610nw": ("US-290 / 610 NW", 29.8080, -95.4540, False),
    "i10_bw8w": ("I-10 / Beltway 8", 29.7840, -95.5590, False),
    "290_bw8": ("US-290 / Beltway 8", 29.8690, -95.5560, False),
    "i45_bw8n": ("I-45 / Beltway 8 North", 29.9380, -95.4120, False),
    "i69_bw8sw": ("I-69 / Beltway 8 SW", 29.6960, -95.5270, False),
    "tmc_288": ("SH-288 @ Medical Center", 29.7100, -95.3850, False),
    "gulf_ee": ("I-45 Gulf Fwy @ Telephone Rd", 29.7300, -95.3300, False),
    "ost_cullen": ("Old Spanish Trail @ Cullen", 29.7160, -95.3500, False),
}

FREEWAY_MPH = 65.0
ARTERIAL_MPH = 35.0


@dataclass(frozen=True)
class CrossingDef:
    id: str
    name: str
    lat: float
    lng: float
    rail_line: str


@dataclass(frozen=True)
class LinkDef:
    code: str  # short highway code used in segment ids
    highway: str
    name: str
    a: str
    b: str
    road_class: str = "freeway"
    # Synthetic ground truth: how congested / crash-prone this link is vs. a typical one.
    congestion_mult: float = 1.0
    crash_mult: float = 1.0
    crossings: tuple[CrossingDef, ...] = field(default_factory=tuple)


def _x(id_, name, lat, lng, line="UP"):
    return (CrossingDef(id_, name, lat, lng, line),)


LINKS: list[LinkDef] = [
    # I-45 North Freeway
    LinkDef("I45N", "I-45", "North Fwy", "downtown", "i45_610n", congestion_mult=1.2, crash_mult=1.6),
    LinkDef("I45N", "I-45", "North Fwy", "i45_610n", "i45_bw8n", congestion_mult=1.15, crash_mult=1.3),
    LinkDef("I45N", "I-45", "North Fwy", "i45_bw8n", "greenspoint", congestion_mult=0.9),
    # I-45 Gulf Freeway
    LinkDef("I45S", "I-45", "Gulf Fwy", "downtown", "gulf_ee", congestion_mult=1.1, crash_mult=2.2),
    LinkDef("I45S", "I-45", "Gulf Fwy", "gulf_ee", "i45_610s", congestion_mult=1.1, crash_mult=1.8),
    LinkDef("I45S", "I-45", "Gulf Fwy", "i45_610s", "hobby", congestion_mult=0.9),
    # I-10 Katy / East
    LinkDef("I10W", "I-10", "Katy Fwy", "downtown", "i10_610w", congestion_mult=1.1),
    LinkDef("I10W", "I-10", "Katy Fwy", "i10_610w", "i10_bw8w", congestion_mult=1.15),
    LinkDef("I10W", "I-10", "Katy Fwy", "i10_bw8w", "energy", congestion_mult=1.05),
    LinkDef("I10E", "I-10", "East Fwy", "downtown", "i10_610e", congestion_mult=0.85),
    # I-69 / US-59 Southwest
    LinkDef("I69", "I-69", "Southwest Fwy", "downtown", "midtown", congestion_mult=1.1),
    LinkDef("I69", "I-69", "Southwest Fwy", "midtown", "i69_610sw", congestion_mult=1.25, crash_mult=1.4),
    LinkDef("I69", "I-69", "Southwest Fwy", "i69_610sw", "i69_bw8sw", congestion_mult=1.1),
    # 610 Loop
    LinkDef("L610W", "I-610", "West Loop", "i10_610w", "i69_610sw", congestion_mult=1.35, crash_mult=2.6),
    LinkDef("L610S", "I-610", "South Loop", "i69_610sw", "288_610s", congestion_mult=1.1, crash_mult=1.3),
    LinkDef("L610S", "I-610", "South Loop", "288_610s", "i45_610s", congestion_mult=1.0, crash_mult=2.4),
    LinkDef("L610E", "I-610", "East Loop", "i45_610s", "i10_610e", congestion_mult=0.8),
    LinkDef("L610N", "I-610", "North Loop", "i10_610e", "i45_610n", congestion_mult=0.9),
    LinkDef("L610N", "I-610", "North Loop", "i45_610n", "290_610nw", congestion_mult=1.1, crash_mult=1.2),
    LinkDef("L610W", "I-610", "West Loop", "290_610nw", "i10_610w", congestion_mult=1.2),
    # SH-288, US-290, Beltway 8
    LinkDef("SH288", "SH-288", "South Fwy", "midtown", "tmc_288", congestion_mult=1.05),
    LinkDef("SH288", "SH-288", "South Fwy", "tmc_288", "288_610s", congestion_mult=1.0),
    LinkDef("US290", "US-290", "Northwest Fwy", "290_610nw", "290_bw8", congestion_mult=1.1),
    LinkDef("BW8", "BW-8", "Sam Houston Tollway", "290_bw8", "i10_bw8w", congestion_mult=0.8),
    LinkDef("BW8", "BW-8", "Sam Houston Tollway", "i10_bw8w", "i69_bw8sw", congestion_mult=0.85),
    LinkDef("BW8", "BW-8", "Sam Houston Tollway", "290_bw8", "i45_bw8n", congestion_mult=0.8),
    # Surface streets near places
    LinkDef("WHMR", "Westheimer", "Westheimer Rd", "galleria", "i69_610sw", "arterial", congestion_mult=1.3),
    LinkDef("MAIN", "Main St", "Main St", "midtown", "medcenter", "arterial", congestion_mult=0.9),
    LinkDef("HOLC", "Holcombe", "Holcombe Blvd", "medcenter", "tmc_288", "arterial", congestion_mult=1.2),
    LinkDef("AIRL", "Airline", "N Main / Airline Dr", "heights", "i45_610n", "arterial", congestion_mult=0.7),
    # Surface streets with at-grade rail crossings
    LinkDef("HOUAV", "Houston Ave", "Houston Ave", "heights", "downtown", "arterial", congestion_mult=0.8,
            crossings=_x("x_houston_ave", "Houston Ave @ UP", 29.7780, -95.3720)),
    LinkDef("QUIT", "Quitman", "Hardy / Quitman St", "downtown", "nns", "arterial", congestion_mult=0.7,
            crossings=_x("x_quitman", "Quitman St @ Hardy Yard", 29.7850, -95.3580)),
    LinkDef("IRV", "Irvington", "Irvington Blvd", "nns", "i45_610n", "arterial", congestion_mult=0.6,
            crossings=_x("x_irvington", "Irvington Blvd @ UP", 29.8000, -95.3600)),
    LinkDef("NAV", "Navigation", "Navigation Blvd", "downtown", "eastend", "arterial", congestion_mult=0.8,
            crossings=_x("x_navigation", "Navigation Blvd @ N York St", 29.7540, -95.3350, "UP")),
    LinkDef("HARR", "Harrisburg", "Harrisburg Blvd", "downtown", "eastend", "arterial", congestion_mult=0.9,
            crossings=_x("x_harrisburg", "Harrisburg Blvd @ Hughes St", 29.7440, -95.3230, "BNSF")),
    LinkDef("TELE", "Telephone Rd", "Telephone Rd", "eastend", "gulf_ee", "arterial", congestion_mult=0.8,
            crossings=_x("x_telephone", "Telephone Rd @ BNSF", 29.7340, -95.3220, "BNSF")),
    LinkDef("WAYS", "Wayside", "Wayside Dr / Clinton Dr", "eastend", "i10_610e", "arterial", congestion_mult=0.7,
            crossings=_x("x_wayside", "Wayside Dr @ Port Terminal RR", 29.7600, -95.2900, "PTRA")),
    LinkDef("CULL", "Cullen", "Lawndale / Cullen Blvd", "eastend", "ost_cullen", "arterial", congestion_mult=0.5,
            crossings=_x("x_cullen", "Cullen Blvd @ UP", 29.7250, -95.3400)),
    LinkDef("OST", "Old Spanish Trail", "Old Spanish Trail", "ost_cullen", "tmc_288", "arterial",
            congestion_mult=0.9, crossings=_x("x_ost", "Old Spanish Trail @ Almeda", 29.7120, -95.3700)),
    LinkDef("TELS", "Telephone Rd", "Telephone Rd South", "eastend", "i45_610s", "arterial",
            congestion_mult=0.7, crossings=_x("x_telephone_s", "Telephone Rd @ Bellfort UP", 29.7100, -95.3000)),
    LinkDef("SCOT", "Scott St", "Scott St", "gulf_ee", "ost_cullen", "arterial", congestion_mult=0.8),
]

# Links that get a highway camera placeholder (TranStar has cameras on all of these).
CAMERA_LINKS = ["I45N", "I45S", "I10W", "I69", "L610W", "L610S", "SH288", "US290"]


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def compass(a: tuple[float, float], b: tuple[float, float]) -> str:
    dy = b[0] - a[0]
    dx = (b[1] - a[1]) * math.cos(math.radians(a[0]))
    angle = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][int((angle + 22.5) // 45) % 8]


def segment_id(link: LinkDef, frm: str, to: str) -> str:
    return f"{link.code}:{frm}>{to}"


@dataclass(frozen=True)
class SegmentProfile:
    """Synthetic ground truth for one directed segment."""

    segment_id: str
    road_class: str
    length_m: float
    free_flow_mph: float
    inbound: bool  # heading toward downtown
    congestion_mult: float
    crash_mult: float


def node_latlng(node_id: str) -> tuple[float, float]:
    _, lat, lng, _ = NODES[node_id]
    return (lat, lng)


def iter_directed():
    """Yield (link, from_node, to_node) for both directions of every link."""
    for link in LINKS:
        yield link, link.a, link.b
        yield link, link.b, link.a


def segment_profiles() -> list[SegmentProfile]:
    profiles = []
    for link, frm, to in iter_directed():
        a, b = node_latlng(frm), node_latlng(to)
        detour = 1.1 if link.road_class == "freeway" else 1.25
        profiles.append(
            SegmentProfile(
                segment_id=segment_id(link, frm, to),
                road_class=link.road_class,
                length_m=haversine_m(a, b) * detour,
                free_flow_mph=FREEWAY_MPH if link.road_class == "freeway" else ARTERIAL_MPH,
                inbound=haversine_m(b, DOWNTOWN) < haversine_m(a, DOWNTOWN),
                congestion_mult=link.congestion_mult,
                crash_mult=link.crash_mult,
            )
        )
    return profiles


def crossing_defs() -> list[CrossingDef]:
    return [c for link in LINKS for c in link.crossings]


def seed_network(session: Session) -> dict[str, int]:
    """Replace the road network tables with the Houston graph. Also clears scores."""
    for model in (Camera, RailCrossing, ScoreEntry, RoadSegment, Node):
        session.execute(delete(model))

    for node_id, (name, lat, lng, is_place) in NODES.items():
        session.add(Node(id=node_id, name=name, lat=lat, lng=lng, is_place=is_place))

    profiles = {p.segment_id: p for p in segment_profiles()}
    for link, frm, to in iter_directed():
        sid = segment_id(link, frm, to)
        a, b = node_latlng(frm), node_latlng(to)
        session.add(
            RoadSegment(
                id=sid,
                name=f"{link.highway} {link.name}" if link.road_class == "freeway" else link.name,
                highway=link.highway,
                road_class=link.road_class,
                direction=compass(a, b),
                from_node=frm,
                to_node=to,
                length_m=round(profiles[sid].length_m, 1),
                free_flow_mph=profiles[sid].free_flow_mph,
                geometry=[list(a), list(b)],
            )
        )
    session.flush()

    for link in LINKS:
        for c in link.crossings:
            session.add(
                RailCrossing(
                    id=c.id,
                    name=c.name,
                    lat=c.lat,
                    lng=c.lng,
                    rail_line=c.rail_line,
                    segment_id=segment_id(link, link.a, link.b),
                    reverse_segment_id=segment_id(link, link.b, link.a),
                )
            )
            session.add(
                Camera(
                    id=f"cam_{c.id}",
                    kind="train",
                    name=f"{c.name} crossing cam",
                    lat=c.lat,
                    lng=c.lng,
                    url=f"https://cameras.example/houston/train/{c.id}",
                    crossing_id=c.id,
                )
            )

    seen: set[str] = set()
    for link in LINKS:
        if link.code in CAMERA_LINKS and link.code not in seen or link.crash_mult >= 2:
            seen.add(link.code)
            a, b = node_latlng(link.a), node_latlng(link.b)
            sid = segment_id(link, link.a, link.b)
            session.add(
                Camera(
                    id=f"cam_{link.code}_{link.a}_{link.b}",
                    kind="highway",
                    name=f"{link.highway} {link.name} @ {NODES[link.b][0]}",
                    lat=(a[0] + b[0]) / 2,
                    lng=(a[1] + b[1]) / 2,
                    url=f"https://cameras.example/houston/transtar/{link.code.lower()}-{link.a}-{link.b}",
                    segment_id=sid,
                )
            )
    session.commit()
    return {
        "nodes": len(NODES),
        "segments": len(profiles),
        "crossings": len(crossing_defs()),
    }
