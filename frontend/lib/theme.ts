/** Design tokens and the shared vocabulary of causes, levels and alert groups (from the design). */

export const C = {
  bg: "#111318",
  map: "#171A21",
  nav: "#15181E",
  card: "#1E222B",
  cardHi: "#232A3A",
  pop: "#232833",
  popLine: "#353B48",
  line: "#2A2F3B",
  edge: "#2E3340",
  edgeStrong: "#3A404D",
  ink: "#ECEDEF",
  soft: "#C4C8D2",
  muted: "#9AA0AE",
  accent: "#8FB0FF",
  accentHi: "#B5CCFF",
  onAccent: "#0E1015",
  heavy: "#FF4D4D",
  heavyText: "#FF7A70",
  moderate: "#F5C518",
  light: "#2FBF6B",
  marker: "#F2F3F5",
} as const;

export type Level = "heavy" | "moderate" | "light";

export const LEVEL: Record<Level, { label: string; color: string; fg: string }> = {
  heavy: { label: "Heavy", color: C.heavy, fg: "#11141A" },
  moderate: { label: "Moderate", color: C.moderate, fg: "#11141A" },
  light: { label: "Light", color: C.light, fg: "#11141A" },
};

/** What's causing a slowdown. `icon` is a 24x24 stroke path (draw with <Icon d=...>). */
export type CauseKind = "rush" | "event" | "crash" | "train" | "closure" | "weather" | "construction" | "volume";

export const CAUSE: Record<CauseKind, { label: string; icon: string; color: string }> = {
  rush: { label: "Rush hour", icon: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 8v4l3 2", color: C.accent },
  event: {
    label: "Event",
    icon: "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0zM19 16a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z",
    color: "#B07CE8",
  },
  crash: {
    label: "Crash",
    icon: "M10.3 3.9L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 16.5v.5",
    color: C.heavy,
  },
  train: {
    label: "Train",
    icon: "M7 3h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM5 10h14M8 20l-1.5 2M16 20l1.5 2M9 13v.01M15 13v.01",
    color: "#E0A04A",
  },
  closure: { label: "Road closure", icon: "M3 8h18v6H3zM8 8l-3 6M14 8l-3 6M20 8l-3 6M6 14v6M18 14v6", color: "#FF8A3D" },
  weather: {
    label: "Weather",
    icon: "M7 15a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 8a3.5 3.5 0 0 1 0 7zM8 18l-1 3M12 18l-1 3M16 18l-1 3",
    color: "#6FA8C4",
  },
  construction: { label: "Construction", icon: "M4 20h16M9 20l3-15 3 15M10.2 12h3.6M9.4 16h5.2", color: C.moderate },
  volume: { label: "Heavier than usual", icon: "M4 17l5-5 4 4 7-8", color: "#E5963A" },
};

/** Order of the cause chips on the map sheet (as in the design). */
export const CAUSE_ORDER: CauseKind[] = ["rush", "event", "crash", "train", "closure", "weather", "construction", "volume"];

/** Alert groups (the Alerts screen's filters) and their icon dot colors. */
export type AlertGroup = "incident" | "roadwork" | "event" | "weather" | "train" | "volume";

export const ALERT_GROUP: Record<AlertGroup, { label: string; filter: string; icon: string; color: string }> = {
  incident: {
    label: "Incident",
    filter: "Incidents",
    icon: "M12 8v5M12 16.5v.5M10.3 3.9L2.8 17a2 2 0 001.7 3h15a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
    color: "#D93D3D",
  },
  roadwork: { label: "Roadwork", filter: "Roadwork", icon: "M4 20h16M7 20l4-14h2l4 14M8.5 14h7", color: "#3E63DD" },
  event: { label: "Event", filter: "Events", icon: "M8 3v4M16 3v4M4 9h16M5 5h14v15H5z", color: "#8E4EC6" },
  weather: { label: "Weather", filter: "Weather", icon: CAUSE.weather.icon, color: "#2B7BA8" },
  train: { label: "Train", filter: "Trains", icon: CAUSE.train.icon, color: "#9A6A1E" },
  volume: { label: "Heavier than usual", filter: "Busier", icon: "M4 17l5-5 4 4 7-8", color: "#B86E0B" },
};

/** Common UI icons (24x24 stroke paths from the design). */
export const ICON = {
  back: "M15 18l-6-6 6-6",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-3.5-3.5",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5",
  camera: "M3 7h12v10H3zM15 10l6-3v10l-6-3",
  map: "M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
  causes: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  bell: "M6 16V11a6 6 0 0112 0v5l2 2H4l2-2zM10 21h4",
  clock: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 8v4l3 2",
  locate: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3",
  close: "M6 6l12 12M18 6L6 18",
  pause: "M8 5v14M16 5v14",
  play: "M7 5l12 7-12 7z",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  filters: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  car: "M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13M4 13h16v4H4zM7 17v2M17 17v2",
  shield: "M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z",
  pin: "M12 21s-6-5.3-6-11a6 6 0 1 1 12 0c0 5.7-6 11-6 11zM12 7.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z",
  check: "M5 12l5 5 9-10",
  chevron: "M9 6l6 6-6 6",
  video: "M3 7h12v10H3zM15 10l6-3v10l-6-3",
} as const;

/** Congestion score (0..1) -> level, matching the backend's speed thresholds
 * (travel = free flow / (1 - 0.85 score); heavy < 50% of free-flow speed, moderate < 75%). */
export function levelForScore(score: number): Level {
  if (score >= 0.59) return "heavy";
  if (score >= 0.29) return "moderate";
  return "light";
}
