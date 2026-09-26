# Frontend

Next.js PWA with a Leaflet map. See the [root README](../README.md) for how to run the whole app.

```bash
npm install
npm run dev   # http://localhost:3000, expects the API at NEXT_PUBLIC_API_URL (default http://localhost:8000)
```

- `components/HomeClient.tsx`: page state, polling, demo actions
- `components/MapView.tsx`: congestion heatmap, crash-risk halos, crossings, cameras, routes
- `components/TripPanel.tsx`: planner + recommendation card
- `components/DemoRunner.tsx`: the scripted judge demo
- `lib/api.ts`: typed API client
