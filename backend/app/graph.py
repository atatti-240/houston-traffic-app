"""In-memory view of the road network, loaded once from the DB and shared by models + router."""

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Node, RailCrossing, RoadSegment


@dataclass(frozen=True)
class NodeInfo:
    id: str
    name: str
    lat: float
    lng: float
    is_place: bool


@dataclass(frozen=True)
class SegmentInfo:
    id: str
    name: str
    highway: str
    road_class: str
    direction: str
    from_node: str
    to_node: str
    length_m: float
    free_flow_mph: float
    geometry: tuple[tuple[float, float], ...]

    @property
    def length_miles(self) -> float:
        return self.length_m / 1609.344

    @property
    def free_flow_seconds(self) -> float:
        return self.length_miles / self.free_flow_mph * 3600

    @property
    def reverse_id(self) -> str:
        code = self.id.split(":", 1)[0]
        return f"{code}:{self.to_node}>{self.from_node}"


@dataclass(frozen=True)
class CrossingInfo:
    id: str
    name: str
    lat: float
    lng: float
    rail_line: str
    segment_ids: tuple[str, str]


@dataclass
class Network:
    nodes: dict[str, NodeInfo]
    segments: dict[str, SegmentInfo]
    crossings: dict[str, CrossingInfo]
    out_edges: dict[str, list[SegmentInfo]] = field(default_factory=lambda: defaultdict(list))
    crossings_on: dict[str, list[CrossingInfo]] = field(default_factory=lambda: defaultdict(list))

    def __post_init__(self) -> None:
        for seg in self.segments.values():
            self.out_edges[seg.from_node].append(seg)
        for c in self.crossings.values():
            for sid in c.segment_ids:
                self.crossings_on[sid].append(c)

    def places(self) -> list[NodeInfo]:
        return [n for n in self.nodes.values() if n.is_place]

    def nearest_node(self, lat: float, lng: float) -> NodeInfo:
        return min(self.nodes.values(), key=lambda n: (n.lat - lat) ** 2 + (n.lng - lng) ** 2)


def load_network(session: Session) -> Network:
    nodes = {
        n.id: NodeInfo(n.id, n.name, n.lat, n.lng, n.is_place) for n in session.scalars(select(Node))
    }
    segments = {
        s.id: SegmentInfo(
            s.id,
            s.name,
            s.highway,
            s.road_class,
            s.direction,
            s.from_node,
            s.to_node,
            s.length_m,
            s.free_flow_mph,
            tuple(tuple(p) for p in s.geometry),
        )
        for s in session.scalars(select(RoadSegment))
    }
    crossings = {
        c.id: CrossingInfo(c.id, c.name, c.lat, c.lng, c.rail_line, (c.segment_id, c.reverse_segment_id))
        for c in session.scalars(select(RailCrossing))
    }
    return Network(nodes, segments, crossings)
