"use client";

/** The theme setting: System (follows the device), Light or Dark. Lives in the map's layers menu. */

import { setThemePref, useThemePref, type ThemePref } from "@/lib/themeMode";

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function ThemeSetting() {
  const pref = useThemePref();
  return (
    <div className="flex flex-col gap-1.5 px-2 pt-1 pb-1.5">
      <span id="theme-h" className="text-[12px] font-semibold text-muted">
        Theme
      </span>
      <div role="radiogroup" aria-labelledby="theme-h" className="grid grid-cols-3 rounded-[10px] border border-edge-strong p-0.5">
        {OPTIONS.map((o) => {
          const on = pref === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setThemePref(o.value)}
              className={`h-8 cursor-pointer rounded-[8px] text-[13px] ${on ? "bg-sel font-semibold text-on-sel" : "font-medium text-soft hover:bg-card"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
