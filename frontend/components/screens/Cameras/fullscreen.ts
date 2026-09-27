"use client";

/** Full screen for a camera card: the real Fullscreen API where there is one, else the card covers
 * the window (Escape leaves). */

import { useCallback, useEffect, useState, type RefObject } from "react";

type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };

export const EXIT_FULL = "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5";

export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [nativeFull, setNativeFull] = useState(false);
  const [pseudoFull, setPseudoFull] = useState(false);

  useEffect(() => {
    const on = () => {
      const d = document as FsDoc;
      setNativeFull(!!ref.current && (d.fullscreenElement ?? d.webkitFullscreenElement) === ref.current);
    };
    document.addEventListener("fullscreenchange", on);
    document.addEventListener("webkitfullscreenchange", on);
    return () => {
      document.removeEventListener("fullscreenchange", on);
      document.removeEventListener("webkitfullscreenchange", on);
    };
  }, [ref]);
  useEffect(() => {
    if (!pseudoFull) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPseudoFull(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [pseudoFull]);

  const toggle = useCallback(() => {
    const d = document as FsDoc;
    if (d.fullscreenElement ?? d.webkitFullscreenElement) {
      if (d.exitFullscreen) d.exitFullscreen().catch(() => {});
      else d.webkitExitFullscreen?.();
      return;
    }
    if (pseudoFull) return setPseudoFull(false);
    const el = ref.current as FsEl | null;
    if (!el) return;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setPseudoFull(true));
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else setPseudoFull(true);
  }, [pseudoFull, ref]);

  return { full: nativeFull || pseudoFull, pseudoFull, toggle };
}
