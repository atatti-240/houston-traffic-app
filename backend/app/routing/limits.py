"""Speed limits and toll roads along a route, for the route card (and a driving mode later:
`speed_limits` says which limit applies from which mile of the route on)."""

from app.routing.router import Route


def speed_limit_runs(route: Route) -> list[dict]:
    """The route as stretches of one road at one posted limit, in driving order. A limit of None
    means OpenStreetMap doesn't have it: say so, never guess."""
    runs: list[dict] = []
    mile = 0.0
    for s in route.segments:
        last = runs[-1] if runs else None
        if last and last["road"] == s.name and last["speed_limit_mph"] == s.speed_limit_mph:
            last["miles"] += s.miles
            last["segment_ids"].append(s.id)
        else:
            runs.append(
                {"road": s.name, "speed_limit_mph": s.speed_limit_mph, "from_mile": mile, "miles": s.miles, "segment_ids": [s.id]}
            )
        mile += s.miles
    for r in runs:
        r["from_mile"], r["miles"] = round(r["from_mile"], 2), round(r["miles"], 2)
    return runs


def road_rules_json(route: Route) -> dict:
    """Route-level fields for route_json / plan legs."""
    tolls = [s for s in route.segments if s.toll]
    return {
        "uses_toll": bool(tolls),
        "toll_roads": list(dict.fromkeys(s.name for s in tolls)),
        "speed_limits": speed_limit_runs(route),
    }
