"""Real hazard data: the city's Vision Zero High Injury Network (the most dangerous streets)."""

from string import capwords

from fastapi import APIRouter, HTTPException, Query

from app.seed.visionzero import SOURCE, hin_segments

router = APIRouter(prefix="/hazards", tags=["map"])


@router.get("/high-injury")
def high_injury(
    limit: int = Query(20, ge=1, le=2000),
    bbox: str | None = Query(None, description="minLng,minLat,maxLng,maxLat", examples=["-95.45,29.70,-95.30,29.78"]),
):
    """City street segments (~0.5 mi each) with the most crashes, worst first. City streets
    only: the High Injury Network has no freeways."""
    segs = hin_segments()
    if bbox:
        try:
            w, s, e, n = map(float, bbox.split(","))
        except ValueError as err:
            raise HTTPException(422, f"Bad bbox {bbox!r}: use minLng,minLat,maxLng,maxLat") from err
        segs = [x for x in segs if w <= x.lng <= e and s <= x.lat <= n]
    top = sorted(segs, key=lambda x: (-x.crashes, -x.deaths))[:limit]
    return {
        "source": SOURCE,
        "segments": [
            {
                "name": capwords(x.name),
                "crashes": x.crashes,
                "deaths": x.deaths,
                "miles": x.miles,
                "crash_rate": x.crash_rate,
                "lat": x.lat,
                "lng": x.lng,
            }
            for x in top
        ],
    }
