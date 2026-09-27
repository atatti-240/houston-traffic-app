.PHONY: setup seed roads limits dev backend frontend test cv-fake dev-cv

setup:
	cd backend && uv sync
	cd frontend && npm install

# Rebuild the database from scratch: Houston road network + synthetic history replay.
seed:
	cd backend && rm -f data/app.db && uv run python scripts/seed.py && uv run python scripts/replay_history.py

# Re-trace every road segment along the real streets (OpenStreetMap via the public OSRM router).
roads:
	cd backend && uv run python scripts/fetch_road_shapes.py

# Look up each segment's speed limit and toll status in OpenStreetMap (Nominatim, ~6 min).
limits:
	cd backend && uv run python scripts/fetch_road_limits.py

backend:
	cd backend && uv run uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# Run backend (:8000) and frontend (:3000) together; Ctrl-C stops both.
# With the team's CV app running: CV_URL=http://localhost:8500 make dev
dev:
	$(MAKE) -j2 backend frontend

# A stand-in for the CV app on :8500: recorded Baton Rouge frames with their vehicle boxes, and a
# scripted incident (curl -X POST localhost:8500/incident). Options: make cv-fake CV_FAKE_ARGS="--incident-after 20"
cv-fake:
	cd backend && uv run python scripts/fake_cv.py $(CV_FAKE_ARGS)

# Everything with live AI camera feeds from the fake CV server; Ctrl-C stops all three.
dev-cv:
	CV_URL=http://localhost:8500 $(MAKE) -j3 cv-fake backend frontend

test:
	cd backend && uv run pytest -q
	cd frontend && npx next typegen && npx tsc --noEmit
