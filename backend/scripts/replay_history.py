"""Replay synthetic history day by day through all three models and save the scores."""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.adapters import build_sources  # noqa: E402
from app.config import settings  # noqa: E402
from app.db import SessionLocal, init_db  # noqa: E402
from app.graph import load_network  # noqa: E402
from app.scoring import build_models, replay_history  # noqa: E402


def main() -> None:
    init_db()
    t0 = time.time()
    with SessionLocal() as session:
        network = load_network(session)
        if not network.segments:
            sys.exit("No road network found. Run scripts/seed.py first.")
        models = build_models(network)
        sources = build_sources(settings.data_source, SessionLocal, settings.synthetic_seed)
        days = settings.history_weeks * 7
        replay_history(models, sources, settings.sim_start.date(), days)
        models.store.save(session)
    print(f"Replayed {days} days into {len(models.store)} scores in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
