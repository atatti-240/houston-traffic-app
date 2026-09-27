.PHONY: setup seed roads transit dev backend frontend test

setup:
	cd backend && uv sync
	cd frontend && npm install

# Rebuild the database from scratch: Houston road network + synthetic history replay.
seed:
	cd backend && rm -f data/app.db && uv run python scripts/seed.py && uv run python scripts/replay_history.py

# Re-trace every road segment along the real streets (OpenStreetMap via the public OSRM router).
roads:
	cd backend && uv run python scripts/fetch_road_shapes.py

# Download METRO's bus and rail timetable (GTFS) and build the transit index (backend/data/transit.db, not committed).
transit:
	cd backend && uv run python scripts/build_transit.py

backend:
	cd backend && uv run uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# Run backend (:8000) and frontend (:3000) together; Ctrl-C stops both.
dev:
	$(MAKE) -j2 backend frontend

test:
	cd backend && uv run pytest -q
	cd frontend && npx next typegen && npx tsc --noEmit
