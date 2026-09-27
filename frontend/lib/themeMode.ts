"use client";

/**
 * The theme: System (follows the OS, the default), Light or Dark. The choice is kept in localStorage
 * (when it can be: private windows may refuse) and shown as <html data-theme>, which the colors in
 * globals.css follow. The inline script in app/layout.tsx applies it before the first paint; this
 * keeps it applied (the OS switching light / dark, another tab changing it) and lets components that
 * draw with real color values (the MapLibre street map) re-draw when it changes.
 */

import { useSyncExternalStore } from "react";

import { THEME_BAR, THEME_KEY } from "./themeScript";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const DARK = "(prefers-color-scheme: dark)";

function clean(v: unknown): ThemePref {
  return v === "light" || v === "dark" ? v : "system";
}

function stored(): ThemePref {
  try {
    return clean(window.localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

let pref: ThemePref | null = null;
const listeners = new Set<() => void>();

function current(): ThemePref {
  if (pref === null) pref = typeof window === "undefined" ? "system" : clean(document.documentElement.dataset.themePref ?? stored());
  return pref;
}

function systemDark(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.(DARK).matches;
}

function resolve(p: ThemePref): Theme {
  return p === "system" ? (systemDark() ? "dark" : "light") : p;
}

/** Puts the theme on <html> (again: React can clear the attribute on a dev remount) and tells subscribers. */
function apply() {
  const p = current();
  const t = resolve(p);
  const d = document.documentElement;
  if (d.dataset.theme !== t) d.dataset.theme = t;
  if (d.dataset.themePref !== p) d.dataset.themePref = p;
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = THEME_BAR[t];
  listeners.forEach((l) => l());
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try {
    if (p === "system") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, p);
  } catch {}
  apply();
}

let watching = false;
function watch() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.matchMedia?.(DARK).addEventListener?.("change", () => current() === "system" && apply());
  window.addEventListener("storage", (e) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    pref = stored();
    apply();
  });
  // React may reset <html>'s attributes (dev remounts): put the theme back.
  new MutationObserver(() => {
    const d = document.documentElement;
    if (d.dataset.theme !== resolve(current())) apply();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  apply();
}

function subscribe(l: () => void) {
  watch();
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The setting: "system", "light" or "dark". */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, current, () => "system");
}

/** The theme in effect: "light" or "dark". */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => resolve(current()), () => "light");
}

/** Keeps the theme applied; mounted once in the root layout. */
export function ThemeWatcher() {
  useSyncExternalStore(subscribe, current, () => "system");
  return null;
}
