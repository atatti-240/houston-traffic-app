"""Create tables and load the Houston road network (nodes, segments, crossings, cameras)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import SessionLocal, init_db  # noqa: E402
from app.seed.network import seed_network  # noqa: E402


def main() -> None:
    init_db()
    with SessionLocal() as session:
        counts = seed_network(session)
    print(f"Seeded Houston network: {counts}")


if __name__ == "__main__":
    main()
