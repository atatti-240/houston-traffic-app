# Website Style Guide (Role D)

Reference: https://www.nasaspaceappschallenge.org/ (Space Apps Houston site), inspected 2026-09-25.
We borrow the **look** (dark navy, bold uppercase headings, blue + neon-yellow accents, glassy cards). We do **not** copy NASA / Space Apps logos, names, images or text. Our app has its own name and logo.

## 1. Design tokens (measured from the reference)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#02060F` | page background |
| `--bg-header` | `rgba(5,10,28,0.9)` + `backdrop-blur` | sticky top bar, footer |
| `--card` | `rgba(7,23,63,0.55)` | cards / panels |
| `--card-border` | `1px solid rgba(46,150,245,0.25)` | card + footer borders |
| `--band` | `linear-gradient(transparent, rgba(0,66,166,0.22), transparent)` | alternating section backgrounds |
| `--primary` | `#2E96F5` (blue) | primary buttons, links, route line |
| `--accent` | `#EAFE07` (neon yellow) | active nav, highlight numbers ("Leave by 3:55 PM") |
| `--alert` | `#E43700` (red-orange) | blocked crossing, jammed camera, warnings |
| `--text` | `#FFFFFF` | headings |
| `--text-soft` | `rgba(255,255,255,0.8)` / `0.6` / `0.45` | body, secondary, captions |
| `--ice` | `#CFE4FF` | small labels, tags |
| Heading font | **Overpass 900, UPPERCASE** — h2 28px, h3 19px | section titles |
| Body font | **Fira Sans 300/400/600** — 16px body, 17px buttons (600) | text, buttons, nav |
| Radius | cards 24px · buttons 12px · nav pills 8px · dots 9999px | |
| Buttons | primary: bg `#2E96F5`, white text, `padding 12px 32px`, radius 12px · secondary: transparent, `1px solid rgba(255,255,255,0.4)` | |
| Nav item active | text `#EAFE07`, bg `rgba(234,254,7,0.12)`, radius 8px | |
| Section spacing | `padding-block: clamp(64px, 8vw, 120px)`, content `max-width: 1320px`, `padding-inline: 24px` | |

Fonts: `https://fonts.googleapis.com/css2?family=Overpass:wght@300;400;600;700;900&family=Fira+Sans:wght@300;400;500;600&display=swap` (or `next/font/google` with `Overpass` + `Fira_Sans`).

## 2. Drop-in for `frontend/app/globals.css` (Tailwind v4, already in the repo)

```css
@import "tailwindcss";

:root {
  --bg: #02060f;
  --bg-header: rgba(5, 10, 28, 0.9);
  --card: rgba(7, 23, 63, 0.55);
  --card-border: rgba(46, 150, 245, 0.25);
  --primary: #2e96f5;
  --accent: #eafe07;
  --alert: #e43700;
  --ice: #cfe4ff;
}

@theme inline {
  --color-bg: var(--bg);
  --color-card: var(--card);
  --color-primary: var(--primary);
  --color-accent: var(--accent);
  --color-alert: var(--alert);
  --color-ice: var(--ice);
  --font-display: "Overpass", sans-serif;
  --font-sans: "Fira Sans", sans-serif;
}

body {
  background: var(--bg);
  color: rgba(255, 255, 255, 0.87);
  font-family: var(--font-sans);
  font-weight: 300;
}

h1, h2, h3 { font-family: var(--font-display); font-weight: 900; text-transform: uppercase; color: #fff; }

.card { background: var(--card); border: 1px solid var(--card-border); border-radius: 24px; }
.band { background: linear-gradient(transparent, rgba(0, 66, 166, 0.22), transparent); }
.btn-primary { background: var(--primary); color: #fff; font-weight: 600; padding: 12px 32px; border-radius: 12px; }
.btn-ghost { border: 1px solid rgba(255, 255, 255, 0.4); color: #fff; font-weight: 600; padding: 12px 28px; border-radius: 12px; }
```

Map tiles to match the dark theme (free, no key): CARTO Dark Matter
`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png` (attribution: © OpenStreetMap contributors © CARTO).

## 3. How the reference layout maps to our pages

The reference is a long landing page. Our product is a **phone-first app**, so use the reference style on a short landing page and a compact version in the app screens.

| Reference section | Our version |
|---|---|
| Sticky blurred header (logo + name + year in yellow) | Sticky header: our logo + app name + "HOUSTON" in yellow; nav pills: Plan · Live · Alerts · About |
| Hero with big title + date card + Register / secondary buttons | Hero: "KNOW WHEN TO LEAVE." + card "Trains · Cameras · Crash data" + buttons **Plan my day** (primary) / **See live Houston** (ghost) |
| "What is…" text + image | "THE BLIND SPOT": 77 h/yr lost, 700+ crossings, what Google/Waze miss |
| Card grid ("Why join", "Challenges") on a blue band | 3 cards: Train-aware · Camera-verified · Safer routes (numbers from our tests: −54 min on a train-block day) |
| "Participant journey" steps | "HOW IT WORKS": 1 add stops → 2 get leave-by times → 3 we watch the road → 4 alert if it changes |
| Venue & location map | Live map preview (crossings + cameras near Ion District) |
| Supporting organizations logos | "DATA FROM": Houston TranStar, City of Houston Train Watch, Vision Zero (text credits, no official logos unless allowed) |
| Footer with blue top border | Footer: team names, Houston Hackathon 2026, GitHub link |

App screens (same tokens, tighter spacing — `padding: 16px`, cards radius 16px on phones):
1. **Plan** — trip form in a `.card`; result shows "LEAVE BY" in Overpass 900 + time in `--accent`, one card per leg, "Go" buttons (`.btn-primary` Waze, `.btn-ghost` Google).
2. **Live** — full-height dark map; crossings: `--alert` blocked / `#22c55e` clear / grey low-confidence; cameras: blue dots, tap → snapshot card with "updated x min ago".
3. **Alerts** — list of cards, newest first, reason line in `--ice`.
4. **Waze panel** — separate card with the Waze iFrame (never drawn over our map).

## 4. Accessibility checks
- Body text on `--bg` must stay ≥ `rgba(255,255,255,0.6)`; use 0.45 only for captions ≥ 14px.
- Never use `--accent` yellow for body text; only for short highlights.
- Don't signal crossing status by color only — add an icon or label (BLOCKED / CLEAR / ?).
- Tap targets ≥ 44px on the phone screens.
