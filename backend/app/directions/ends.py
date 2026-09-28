"""Where a trip to or from an arbitrary point gets on and off our roads.

Each point used to snap to its own nearest node, so the corridor could start or end behind the
trip (Midtown -> EaDo snapped to Downtown: up north, then back down southeast). Now both ends are
picked together: a few nearby nodes for each point, and every pair is estimated as the way there
(straight line x ACCESS_DETOUR at CITY_MPH) + our router's time between them + the way from
there. The cheapest pair wins. Going door to door on city streets (no corridor: the empty route
at one node) is one of the options, so a short hop doesn't take a main road it doesn't need.

Our router only, never OSRM: cheap enough for every request. A place is fixed to its own node,
so trips between places are exactly what they were."""

import math
from datetime import datetime

from app.conditions.provider import ConditionsView
from app.directions import geo
from app.directions.door import FAR_M
from app.graph import Network
from app.routing.router import NoRouteError, Router

End = str | tuple[float, float]  # a node / place id, or a point (lat, lng)

CANDIDATES = 4  # nearby nodes tried for a point
CANDIDATE_EXTRA_M = 3000  # ... at most this much farther than its nearest one
ACCESS_DETOUR = 1.3  # streets vs. the straight line
CITY_MPH = 25  # the way on and off our roads (and door to door)
DIRECT_MAX_M = 10_000  # door to door without our roads only for trips shorter than this
MPH = 0.44704  # m/s


def street_s(meters: float) -> float:
    """Rough time on city streets for a straight-line distance."""
    return meters * ACCESS_DETOUR / (CITY_MPH * MPH)


def _nearest(network: Network, lat: float, lng: float) -> list[str]:
    # Same order as Network.nearest_node, so the first one is the node a point used to snap to.
    ranked = sorted(network.nodes.values(), key=lambda n: (n.lat - lat) ** 2 + (n.lng - lng) ** 2)
    return [n.id for n in ranked]


def candidates(network: Network, end: End) -> list[str]:
    """The nodes an end may join our roads at, nearest first. A place: its own node. A point far
    from our roads (another city, a typo) keeps its nearest node only, as before."""
    if isinstance(end, str):
        return [end]
    lat, lng = end
    ranked = _nearest(network, lat, lng)
    if not (math.isfinite(lat) and math.isfinite(lng)):
        return ranked[:1]
    node = network.nodes[ranked[0]]
    near = geo.dist_m([lat, lng], [node.lat, node.lng])
    if near > FAR_M:
        return ranked[:1]
    out = []
    for nid in ranked[:CANDIDATES]:
        n = network.nodes[nid]
        if geo.dist_m([lat, lng], [n.lat, n.lng]) <= near + CANDIDATE_EXTRA_M:
            out.append(nid)
    return out


def _spot(network: Network, end: End) -> list[float]:
    if isinstance(end, str):
        n = network.nodes[end]
        return [n.lat, n.lng]
    return [end[0], end[1]]


def choose_ends(
    network: Network,
    router: Router,
    origin: End,
    destination: End,
    depart_at: datetime,
    safety_weight: float,
    view: ConditionsView | None = None,
) -> tuple[str, str]:
    """The (origin node, destination node) our route should run between: the same node twice
    means door to door directly (the empty route)."""
    os_, ds = candidates(network, origin), candidates(network, destination)
    if len(os_) == 1 and len(ds) == 1:
        return os_[0], ds[0]
    o_at, d_at = _spot(network, origin), _spot(network, destination)
    best, best_s = (os_[0], ds[0]), math.inf
    straight = geo.dist_m(o_at, d_at)
    if straight <= DIRECT_MAX_M:
        # Door to door on city streets, no main roads: the empty route at a place's own node
        # (its door is there), else at the origin's nearest one.
        node = origin if isinstance(origin, str) else destination if isinstance(destination, str) else os_[0]
        best, best_s = (node, node), street_s(straight)
    for a in os_:
        on_s = street_s(geo.dist_m(o_at, _spot(network, a)))
        for b in ds:
            if a == b:
                continue
            try:
                r = router.best_route(a, b, depart_at, safety_weight=safety_weight, view=view)
            except NoRouteError:
                continue
            s = on_s + r.total_s + street_s(geo.dist_m(_spot(network, b), d_at))
            if s < best_s:
                best, best_s = (a, b), s
    return best
