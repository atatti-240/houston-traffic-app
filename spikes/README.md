# Spikes (throwaway)

Research scripts from 2026-09-25 that checked the real data sources. **Not product code** — copy the ideas into `backend/app/adapters/real/` (see `docs/plans/`).

| Script | What it proved |
|---|---|
| `ion_traffic_test.py` | Train Watch, TranStar cameras and feeds reachable near Ion District |
| `must_have_test.py` | All 5 must-haves work (crossings, YOLO, multi-stop planner, re-plan, replay) |
| `demo_trip.py` | UH Sugar Land -> UH -> Ion: leave by 3:55 PM (TranStar 2025 history) |
| `crash_hotspots.py` | Vision Zero High Injury Network 2025 ranking (writes `hin2025_segments.json`) |
| `refresh_probe.py` | Camera snapshot refresh rate (~2 min on freeways) |
| `logger.py` / `log_report.py` | Weekend logger for Train Watch, cameras + YOLO, TranStar RSS |

Setup (separate from the backend's uv env), from the repo root in Windows PowerShell:

    python -m venv spikes\.venv
    .\spikes\.venv\Scripts\python.exe -m pip install ultralytics requests
    .\spikes\.venv\Scripts\python.exe .\spikes\must_have_test.py

Run the weekend logger (leave the window open; Ctrl+C to stop):

    .\spikes\.venv\Scripts\python.exe .\spikes\logger.py
    .\spikes\.venv\Scripts\python.exe .\spikes\log_report.py    # in a second window

PowerShell 5.1 has no `&&` — run commands on separate lines or join with `;`.
On macOS/Linux use `spikes/.venv/bin/python`.

`snapshots/` holds a few TranStar camera frames for YOLO tests.
