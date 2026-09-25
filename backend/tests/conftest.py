import os

os.environ.setdefault("DATABASE_URL", "sqlite:///:memory:")
os.environ.setdefault("SCHEDULER_INTERVAL_S", "0")

import pytest  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402

from app.db import init_db  # noqa: E402
from app.seed.network import seed_network  # noqa: E402


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    init_db(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as s:
        seed_network(s)
    return factory


@pytest.fixture
def session(session_factory):
    with session_factory() as s:
        yield s


@pytest.fixture(scope="session")
def trained():
    """Network + models after replaying 8 weeks of synthetic history (shared, read-only)."""
    from datetime import date

    from app.adapters import build_sources
    from app.graph import load_network
    from app.scoring import build_models, replay_history

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    init_db(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    with factory() as s:
        seed_network(s)
        network = load_network(s)
    models = build_models(network)
    sources = build_sources("mock", factory, 42)
    replay_history(models, sources, date(2026, 9, 28), 56)
    return network, models, sources, factory
