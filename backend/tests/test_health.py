from fastapi.testclient import TestClient

from app.main import create_app


def test_health(services):
    assert TestClient(create_app(services)).get("/health").json() == {"status": "ok"}
