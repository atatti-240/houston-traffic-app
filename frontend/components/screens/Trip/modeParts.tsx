"use client";

/** Pieces shared by the Walk / Bike / Transit tabs. */

import type { ReactNode } from "react";

import type { MapScene } from "@/components/app/AppContext";

/** On a phone the sheet covers the lower 64% of the map: fit the route into the strip above it. */
export function sheetPadding(isDesktop: boolean): MapScene["fitPadding"] {
  if (isDesktop || typeof window === "undefined") return undefined;
  return { topLeft: [32, 28], bottomRight: [32, Math.round(window.innerHeight * 0.64) + 20] };
}

/** Backend / network errors in the app's words (the API's own messages are already plain). */
export function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Can't reach BlindSpot right now.";
  return msg;
}

export function BigLine({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="m-0 text-[32px] leading-[1.05] font-bold tracking-[-0.02em]">{title}</h1>
        {aside}
      </div>
      {children}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div className="h-9 w-48 animate-pulse rounded-lg bg-card" />
      <div className="h-4 w-64 animate-pulse rounded bg-card" />
      <div className="mt-2 h-32 animate-pulse rounded-[18px] bg-card" />
    </div>
  );
}

export function ErrorLine({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-[14px] text-heavy-text" role="alert">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="cursor-pointer text-[14px] font-medium text-accent">
          Try again
        </button>
      )}
    </p>
  );
}
