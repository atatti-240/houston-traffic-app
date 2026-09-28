# Frontend

Next.js PWA with a Leaflet map. See the [root README](../README.md) for how to run the whole app.

## Look and theme

Google Maps' look: flat colors (no gradients or glows), light elevation shadows, the Figtree font (tabular digits for times and counts via `font-num`).

- Colors come from `C` in `lib/theme.ts` (and Tailwind: `bg-card`, `text-muted`, `border-line`...). Each is a CSS variable with a light and a dark value in `app/globals.css`, so anything drawn with them follows the theme on its own. Use `C.heavyText` / `C.moderateText` / `C.lightText` for colored text, `LEVEL[x].bg` + `.fg` for a filled pill, `tint(color, pct)` for a see-through background, `SHADOW[1]` / `SHADOW[2]` for elevation. A part that is always dark (camera video) gets `data-theme="dark"`.
- The theme (System / Light / Dark, in the map's layers menu) is `lib/themeMode.ts`; a script in `app/layout.tsx` applies it before the first paint. Canvas and MapLibre can't read CSS variables: the street map's palettes are in `components/map/basemapStyle.ts` (repainted when `useTheme()` changes), and `cssColor(C.x)` gives a variable's current value.

```bash
npm install
npm run dev   # app at http://localhost:3000/home (the landing page is at /), expects the API at NEXT_PUBLIC_API_URL (default http://localhost:8000)
```

- `components/HomeClient.tsx`: page state, polling, demo actions
- `components/MapView.tsx`: congestion heatmap, crash-risk halos, crossings, cameras, routes
- `components/TripPanel.tsx`: planner + recommendation card
- `components/DemoRunner.tsx`: the scripted judge demo
- `lib/api.ts`: typed API client
