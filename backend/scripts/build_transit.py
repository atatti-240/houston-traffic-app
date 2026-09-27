"""Download METRO's bus and rail timetable (GTFS) and build the transit index the app searches.

    cd backend && uv run python scripts/build_transit.py            # download, then build
    cd backend && uv run python scripts/build_transit.py --zip PATH # build from a GTFS zip you have

Writes backend/data/transit.db (or $TRANSIT_DB), about 55 MB, not committed. A running backend
picks it up on the next request. The zip (about 13 MB) is only kept in a temp folder.

The feed is METRO's official static GTFS, linked from ridemetro.org > About > Business to Business
> Developer Portal (api-portal.ridemetro.org, "Static GTFS"). If METRO moves the file, download it
from there and use --zip. METRO's terms allow using and redistributing the data with the legend
"Route and arrival data provided by permission of METRO", which the app shows under transit results.
"""

import argparse
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.travel.gtfs import build_index  # noqa: E402
from app.travel.osrm import USER_AGENT  # noqa: E402
from app.travel.transit import DEFAULT_PATH  # noqa: E402

METRO_GTFS_URL = "https://metro.resourcespace.com/pages/download.php?ref=4835&ext=zip"


def download(url: str, to: Path) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, open(to, "wb") as f:
            shutil.copyfileobj(r, f)
    except OSError as e:  # URLError, HTTPError and timeouts are all OSErrors
        raise SystemExit(
            f"Couldn't download {url}: {e}. Try again later, or download the GTFS zip from METRO's Developer Portal and use --zip."
        ) from e
    if not zipfile.is_zipfile(to):
        raise SystemExit(f"{url} didn't send a zip file. Download the GTFS zip from METRO's Developer Portal and use --zip.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", type=Path, help="build from this GTFS zip (or folder) instead of downloading")
    ap.add_argument("--url", default=METRO_GTFS_URL, help="where to download the GTFS zip from")
    ap.add_argument("--out", type=Path, default=DEFAULT_PATH, help=f"index to write (default {DEFAULT_PATH})")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        src = args.zip
        if src is None:
            src = Path(tmp) / "metro-gtfs.zip"
            print(f"Downloading {args.url} ...")
            download(args.url, src)
            print(f"  {src.stat().st_size / 1e6:.1f} MB")
        print(f"Building {args.out} ...")
        meta = build_index(src, args.out, source_label=str(args.zip or args.url))
    size = args.out.stat().st_size / 1e6
    print(
        f"Done: {meta['agency'] or 'feed'} {meta['version']}, service {meta['service_start']} to {meta['service_end']}, "
        f"{meta['stops']} stops, {meta['routes']} routes, {meta['trips']} trips ({size:.0f} MB)."
    )


if __name__ == "__main__":
    main()
