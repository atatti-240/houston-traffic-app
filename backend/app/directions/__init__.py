"""Directions: door-to-door routes on real roads (OSRM), turn-by-turn steps with lane arrows,
and up to three different routes to pick from.

    osrm.py     the public OSRM client (rate limit, timeout, cool-down)
    steps.py    OSRM steps -> plain instructions, road names, lanes
    door.py     our corridor + OSRM -> the door-to-door line, steps and times (validated, cached)
    options.py  up to 3 routes, their labels, main roads and delay causes
    trips.py    the routes list in /route and /recommend
"""
